import { execa } from 'execa';
import { childEnv } from './child-env.js';
import type { DeployConfig } from '../config/deploy.js';
import type { ExitReason, JobRequest } from '../contract/schema.js';
import type { Workspace } from '../executor/types.js';

export const HARNESS_VERSION = 'deepseek-harness-0.1';

/** USD per 1M tokens. Estimates only — see the spec's trust boundary note. */
const RATE_IN_PER_MTOK = 0.14;
const RATE_OUT_PER_MTOK = 0.28;

export interface HarnessOutcome {
  summary: string;
  exitReason: ExitReason;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelId: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command in the repository worktree and return its combined output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

interface ChatCompletionBody {
  model?: string;
  choices: { finish_reason: string; message: ChatMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 408 request timeout, 429 rate limit, 499 client-closed, all 5xx. Other 4xx fail fast. */
const RETRYABLE_STATUS = new Set([408, 429, 499, 500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511]);
const BASE_BACKOFF_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;

/** Parse a Retry-After header (seconds or HTTP-date); null when absent/unparseable/past/negative. */
function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1_000;
    return ms > 0 ? ms : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const ms = date - now;
  return ms > 0 ? ms : null;
}

const SYSTEM_PROMPT = [
  'You are an Axon subagent working inside a disposable git worktree.',
  'Make the requested change by running shell commands with the run_shell tool.',
  'You have no push access; your work is returned as a diff of the worktree.',
  'When the task is complete, reply with a short summary and stop calling tools.',
].join(' ');

export class HarnessAdapter {
  private readonly endpoint: DeployConfig['endpoint'];
  private readonly fetchImpl: typeof fetch;
  private readonly onStep?: (step: number, costUsd: number) => void;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: {
    endpoint: DeployConfig['endpoint'];
    fetchImpl?: typeof fetch;
    onStep?: (step: number, costUsd: number) => void;
  }) {
    this.endpoint = opts.endpoint;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onStep = opts.onStep;
    this.requestTimeoutMs = opts.endpoint.requestTimeoutMs ?? 600_000;
    this.maxRetries = opts.endpoint.maxRetries ?? 3;
  }

  async run(ws: Workspace, job: JobRequest, signal: AbortSignal): Promise<HarnessOutcome> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: this.userPrompt(job) },
    ];

    let steps = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let modelId = this.endpoint.model;
    let summary = '';

    const cost = () => (tokensIn / 1e6) * RATE_IN_PER_MTOK + (tokensOut / 1e6) * RATE_OUT_PER_MTOK;
    const outcome = (exitReason: ExitReason): HarnessOutcome => ({
      summary, exitReason, steps, tokensIn, tokensOut, costUsd: cost(), modelId,
    });

    while (steps < job.constraints.max_harness_steps) {
      if (signal.aborted) return outcome('cancelled');

      // Attempt loop (spec §Design.2): retried attempts live INSIDE the step —
      // `steps += 1` and `onStep` fire only for a step that produces an
      // assistant message, so retries never inflate step counts or cost.
      let body: ChatCompletionBody | undefined;
      let attempts = 0;
      for (;;) {
        const started = Date.now();
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.endpoint.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.endpoint.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ model: this.endpoint.model, messages, tools: TOOLS }),
            // Job signal stays authoritative via AbortSignal.any: cancellation
            // and the pool wall-clock cut into a hung request immediately.
            signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
          });
        } catch {
          // Order is load-bearing (spec): job-signal abort FIRST → cancelled,
          // zero retries. Parent cancellation must never trigger retries.
          if (signal.aborted) return outcome('cancelled');
          if (!this.maybeRetry('timeout_request', '-', attempts, started)) return outcome('endpoint_error');
          await this.backoffSleep(attempts, signal, undefined);
          if (signal.aborted) return outcome('cancelled');
          attempts += 1;
          continue;
        }

        if (!response.ok) {
          const status = response.status;
          if (RETRYABLE_STATUS.has(status)) {
            if (!this.maybeRetry('http_error', String(status), attempts, started)) return outcome('endpoint_error');
            await this.backoffSleep(attempts, signal, response.headers.get('retry-after'));
            if (signal.aborted) return outcome('cancelled');
            attempts += 1;
            continue;
          }
          // Non-retryable 4xx (401/403/400/404/422…): fail fast.
          console.warn(`attempt ${attempts + 1}/${this.maxRetries + 1} failed: http_error status=${status} elapsed_ms=${Date.now() - started}`);
          return outcome('endpoint_error');
        }

        // Guard response.json() + choices[0]: a 200 with a malformed/truncated
        // body previously threw past all classification. Now retryable like 5xx.
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          if (!this.maybeRetry('parse_error', '200', attempts, started)) return outcome('endpoint_error');
          await this.backoffSleep(attempts, signal, undefined);
          if (signal.aborted) return outcome('cancelled');
          attempts += 1;
          continue;
        }
        body = parsed as ChatCompletionBody;
        if (!body.choices?.[0]) {
          if (!this.maybeRetry('empty_choices', '200', attempts, started)) return outcome('endpoint_error');
          await this.backoffSleep(attempts, signal, undefined);
          if (signal.aborted) return outcome('cancelled');
          attempts += 1;
          continue;
        }
        break;
      }

      steps += 1;
      const choice = body!.choices[0]!;
      modelId = body!.model ?? modelId;
      tokensIn += body!.usage?.prompt_tokens ?? 0;
      tokensOut += body!.usage?.completion_tokens ?? 0;
      this.onStep?.(steps, cost());
      messages.push(choice.message);

      const calls = choice.message.tool_calls ?? [];
      if (calls.length === 0) {
        summary = choice.message.content ?? '';
        return outcome('completed');
      }

      for (const call of calls) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await this.runTool(ws, call.function.arguments),
        });
      }

      if (signal.aborted) return outcome('cancelled');
    }

    return outcome('step_cap');
  }

  private userPrompt(job: JobRequest): string {
    const context = job.context
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');
    return context ? `${job.goal}\n\nContext files:\n${context}` : job.goal;
  }

  /**
   * Decide whether another attempt may run. Logs the failed attempt and
   * returns false (fail fast → endpoint_error) when the retry budget is spent.
   */
  private maybeRetry(failureClass: string, status: string, attempts: number, started: number): boolean {
    console.warn(
      `attempt ${attempts + 1}/${this.maxRetries + 1} failed: ${failureClass} status=${status} elapsed_ms=${Date.now() - started}`,
    );
    return attempts < this.maxRetries;
  }

  /**
   * Sleep between attempts: Retry-After when parseable (clamped ≤ 60s),
   * otherwise exponential 2/4/8s jittered ±20%. Aborts immediately on the
   * job signal; unparseable/past/negative Retry-After falls back to the
   * exponential schedule — never throws, never sleeps 0 ms.
   */
  private async backoffSleep(attempts: number, signal: AbortSignal, retryAfter?: string | null): Promise<void> {
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    const exponential = BASE_BACKOFF_MS * 2 ** attempts * jitter;
    const parsed = parseRetryAfter(retryAfter, Date.now());
    const ms = parsed !== null ? Math.min(parsed, MAX_RETRY_AFTER_MS) : Math.max(1, exponential);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async runTool(ws: Workspace, rawArgs: string): Promise<string> {
    if (!ws.dir) return 'error: this job has no workspace';
    let command: string;
    try {
      command = (JSON.parse(rawArgs) as { command: string }).command;
    } catch {
      return 'error: tool arguments were not valid JSON';
    }
    try {
      const { stdout, stderr } = await execa(command, {
        cwd: ws.dir,
        shell: true,
        timeout: 120_000,
        reject: false,
        all: false,
        // Spec §7 / C2: the job's shell gets an allowlisted environment, never
        // the worker's. extendEnv: false is the load-bearing part — without it
        // execa merges process.env back in and the scrub is a no-op.
        env: childEnv(process.env),
        extendEnv: false,
      });
      return `${stdout}\n${stderr}`.trim().slice(0, 16_000);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }
}

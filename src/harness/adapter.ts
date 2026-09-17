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

  constructor(opts: {
    endpoint: DeployConfig['endpoint'];
    fetchImpl?: typeof fetch;
    onStep?: (step: number, costUsd: number) => void;
  }) {
    this.endpoint = opts.endpoint;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onStep = opts.onStep;
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
      steps += 1;

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.endpoint.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.endpoint.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: this.endpoint.model, messages, tools: TOOLS }),
        });
      } catch {
        return outcome('endpoint_error');
      }
      if (!response.ok) return outcome('endpoint_error');

      const body = (await response.json()) as {
        model?: string;
        choices: { finish_reason: string; message: ChatMessage }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      modelId = body.model ?? modelId;
      tokensIn += body.usage?.prompt_tokens ?? 0;
      tokensOut += body.usage?.completion_tokens ?? 0;
      this.onStep?.(steps, cost());

      const choice = body.choices[0];
      if (!choice) return outcome('endpoint_error');
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

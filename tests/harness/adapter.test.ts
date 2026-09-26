import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessAdapter } from '../../src/harness/adapter.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';
import type { Workspace } from '../../src/executor/types.js';

const endpoint = {
  baseUrl: 'https://api.example/v1',
  model: 'deepseek/deepseek-chat',
  apiKey: 'test-key',
};

function job(over: Partial<JobRequest> = {}): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: 'j', repo: 'repo', ref: 'main', goal: 'write a file', context: [],
    constraints: { max_harness_steps: 3, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch', ...over,
  };
}

function ws(): Workspace {
  return { jobId: 'j', dir: mkdtempSync(join(tmpdir(), 'axon-har-')), repo: 'repo', ref: 'main' };
}

/** Builds a fetch stub returning a canned chat-completions response per call. */
function stubFetch(bodies: unknown[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** Builds a fetch stub returning a canned raw Response per call (status/headers as given). */
function stubResponses(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.body ?? 'nope', { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
}

function assistantDone(text: string) {
  return {
    model: 'deepseek/deepseek-chat',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function assistantToolCall(cmd: string) {
  return {
    model: 'deepseek/deepseek-chat',
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: cmd }) } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe('HarnessAdapter', () => {
  it('returns the assistant summary when the model stops', async () => {
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: stubFetch([assistantDone('all done')]) });
    const outcome = await adapter.run(ws(), job(), new AbortController().signal);
    expect(outcome.summary).toBe('all done');
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.steps).toBe(1);
  });

  it('accumulates token counts across steps', async () => {
    const adapter = new HarnessAdapter({
      endpoint, fetchImpl: stubFetch([assistantToolCall('true'), assistantDone('done')]),
    });
    const outcome = await adapter.run(ws(), job(), new AbortController().signal);
    expect(outcome.tokensIn).toBe(20);
    expect(outcome.tokensOut).toBe(10);
  });

  it('executes a tool call inside the workspace', async () => {
    const workspace = ws();
    const adapter = new HarnessAdapter({
      endpoint, fetchImpl: stubFetch([assistantToolCall('echo hi > FROM_TOOL.txt'), assistantDone('done')]),
    });
    await adapter.run(workspace, job(), new AbortController().signal);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(workspace.dir!, 'FROM_TOOL.txt'))).toBe(true);
  });

  it('stops at the step cap with exit reason step_cap', async () => {
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: stubFetch([assistantToolCall('true')]) });
    const outcome = await adapter.run(ws(), job({ constraints: { max_harness_steps: 2, timeout_seconds: 60, max_spend_usd: 1 } }), new AbortController().signal);
    expect(outcome.exitReason).toBe('step_cap');
    expect(outcome.steps).toBe(2);
  });

  it('stops with cancelled when the signal aborts between steps', async () => {
    const ac = new AbortController();
    const adapter = new HarnessAdapter({
      endpoint,
      fetchImpl: stubFetch([assistantToolCall('true')]),
      onStep: () => ac.abort(),
    });
    const outcome = await adapter.run(ws(), job(), ac.signal);
    expect(outcome.exitReason).toBe('cancelled');
  });

  it('reports per-step cost through onStep so the pool can enforce the job cap', async () => {
    const seen: number[] = [];
    const adapter = new HarnessAdapter({
      endpoint,
      fetchImpl: stubFetch([assistantToolCall('true'), assistantDone('done')]),
      onStep: (_n, costUsd) => seen.push(costUsd),
    });
    await adapter.run(ws(), job(), new AbortController().signal);
    expect(seen).toHaveLength(2);
    expect(seen.every((c) => c >= 0)).toBe(true);
  });

  it('passes an AbortSignal to fetchImpl so requests can be timed out or cancelled', async () => {
    const fetchImpl = stubFetch([assistantDone('x')]);
    await new HarnessAdapter({ endpoint, fetchImpl }).run(ws(), job(), new AbortController().signal);
    const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });

  it('never sends the api key in the request body', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(assistantDone('x')), { status: 200 }));
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: spy as unknown as typeof fetch });
    await adapter.run(ws(), job(), new AbortController().signal);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(String(init.body)).not.toContain('test-key');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('does not leak worker secrets into the job shell environment', async () => {
    process.env.AXON_NODE_TOKEN = 'leaked-token-value';
    process.env.GLM_API_KEY = 'leaked-endpoint-key';
    process.env.SSH_AUTH_SOCK = '/tmp/agent-should-not-be-forwarded.sock';
    try {
      const sent: string[] = [];
      const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
        sent.push((init as { body: string }).body);
        const bodies = [assistantToolCall('env'), assistantDone('done')];
        const body = bodies[Math.min(sent.length - 1, bodies.length - 1)];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const adapter = new HarnessAdapter({ endpoint, fetchImpl });
      await adapter.run(ws(), job(), new AbortController().signal);

      // The second request carries the tool result: what `env` printed in the job shell.
      const toolOutput = sent[1];
      expect(toolOutput).not.toContain('leaked-token-value');
      expect(toolOutput).not.toContain('leaked-endpoint-key');
      expect(toolOutput).not.toContain('agent-should-not-be-forwarded.sock');
      expect(toolOutput).toContain('PATH');
    } finally {
      delete process.env.AXON_NODE_TOKEN;
      delete process.env.GLM_API_KEY;
      delete process.env.SSH_AUTH_SOCK;
    }
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const fetchImpl = stubResponses([{ status: 500 }]);
    const adapter = new HarnessAdapter({ endpoint: { ...endpoint, maxRetries: 0 }, fetchImpl });
    const outcome = await adapter.run(ws(), job(), new AbortController().signal);
    expect(outcome.exitReason).toBe('endpoint_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HarnessAdapter retry + per-request timeout (spec #8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 500 then succeeds: steps reflect ONE step, onStep not called for the failed attempt', async () => {
    vi.useFakeTimers();
    const onStep = vi.fn();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(assistantDone('recovered')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch, onStep });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.summary).toBe('recovered');
    expect(outcome.steps).toBe(1);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a network rejection (fetchImpl throws once) with the same single-step semantics', async () => {
    vi.useFakeTimers();
    const onStep = vi.fn();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return new Response(JSON.stringify(assistantDone('back online')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch, onStep });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.steps).toBe(1);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 429 honoring Retry-After: 5 (fetch spacing matches the header, clamped ≤ 60s)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      fetchTimes.push(Date.now()); // fake Date.now under fake timers
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '5' } });
      return new Response(JSON.stringify(assistantDone('ok')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(70_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Retry-After: 5 → the adapter waits 5s (clamped at 60s max), NOT the 2s
    // exponential base (which with jitter can't exceed 2.4s).
    const gap = fetchTimes[1]! - fetchTimes[0]!;
    expect(gap).toBeGreaterThanOrEqual(5_000);
    expect(gap).toBeLessThanOrEqual(60_000);
  });

  it('honors a Retry-After HTTP-date (waits until the date, not the exponential base)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let calls = 0;
    const fetchTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      if (calls === 0) {
        fetchTimes.push(Date.now()); // fake Date.now under fake timers
        calls += 1;
        const retryAt = new Date(Date.now() + 5_000); // 5s in the future
        return new Response('slow down', { status: 429, headers: { 'retry-after': retryAt.toUTCString() } });
      }
      fetchTimes.push(Date.now());
      calls += 1;
      return new Response(JSON.stringify(assistantDone('ok')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(70_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const gap = fetchTimes[1]! - fetchTimes[0]!;
    expect(gap).toBeGreaterThanOrEqual(5_000);
    expect(gap).toBeLessThan(60_000);
  });

  it('clamps a huge Retry-After at 60s', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      fetchTimes.push(Date.now()); // fake Date.now under fake timers
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } });
      return new Response(JSON.stringify(assistantDone('ok')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(70_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    const gap = fetchTimes[1]! - fetchTimes[0]!;
    expect(gap).toBeGreaterThanOrEqual(60_000);
    expect(gap).toBeLessThan(70_000);
  });

  it('exhausts retries on a persistent 500 → endpoint_error with exactly maxRetries + 1 fetch calls', async () => {
    // Deliberate behavior change (spec item 10): this assertion was previously
    // a single fetch attempt; the retry ladder now makes 4 attempts before the
    // job ends as endpoint_error. (Single canonical persistent-500 test — the
    // duplicate was removed in review cycle 3, MINOR 6.)
    vi.useFakeTimers();
    const fetchImpl = stubResponses([{ status: 500 }]);
    const adapter = new HarnessAdapter({ endpoint, fetchImpl });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('endpoint_error');
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 + 3 retries (default maxRetries)
  });

  it('fails fast on 401: exactly 1 fetch call, endpoint_error, no retries', async () => {
    vi.useFakeTimers();
    const fetchImpl = stubResponses([{ status: 401 }]);
    const adapter = new HarnessAdapter({ endpoint, fetchImpl });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('endpoint_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('survives a 200 with malformed JSON body → retried, then success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('<html>gateway error page</html>', { status: 200 });
      return new Response(JSON.stringify(assistantDone('recovered')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.steps).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('survives a 200 with valid JSON but choices: [] → retried, then success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ model: 'deepseek/deepseek-chat', choices: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(assistantDone('recovered')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.steps).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('per-request timeout (spec item 8)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Real timers on purpose: AbortSignal.timeout (which the adapter combines
    // into the fetch signal) is a native timer vitest's fake clock does not
    // drive — under fake timers it never fires and the stub never rejects. A
    // short requestTimeoutMs keeps these tests fast and the behavior real.
    const requestTimeoutMs = 100;
    const makeTimedOutFetch = (failThrough: (calls: number) => boolean): typeof fetch => {
      const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
        const signal = init.signal!;
        if (failThrough(fetchImpl.mock.calls.length)) {
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const e = new Error('The operation was aborted due to timeout');
              e.name = 'TimeoutError';
              reject(e);
            }, { once: true });
          });
        }
        return new Response(JSON.stringify(assistantDone('finally')), { status: 200 });
      });
      return fetchImpl as unknown as typeof fetch;
    };

    it('fetchImpl rejects with a TimeoutError when its passed signal aborts; adapter retries then succeeds', async () => {
      const fetchImpl = makeTimedOutFetch((n) => n <= 2);
      const adapter = new HarnessAdapter({ endpoint: { ...endpoint, requestTimeoutMs }, fetchImpl });
      const outcome = await adapter.run(ws(), job(), new AbortController().signal);
      expect(outcome.exitReason).toBe('completed');
      expect(fetchImpl).toHaveBeenCalledTimes(3); // two timeouts, then success
    });

    it('a permanently-hanging endpoint (every attempt times out) ends endpoint_error, not timeout', async () => {
      const fetchImpl = makeTimedOutFetch(() => true);
      const adapter = new HarnessAdapter({ endpoint: { ...endpoint, requestTimeoutMs }, fetchImpl });
      const outcome = await adapter.run(ws(), job(), new AbortController().signal);
      expect(outcome.exitReason).toBe('endpoint_error'); // classified, never surfaced as 'timeout'
      expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 + 3 retries (default maxRetries)
    });
  });

  it('job-signal abort during a hung REQUEST → cancelled with ZERO additional fetch attempts', async () => {
    // Real timers on purpose: AbortSignal.any is not driven by fake timers, so
    // this exercises the actual combined-signal interplay in the adapter.
    // The stub rejects with `init.signal.reason` (how real fetch reports an
    // abort) so the test pins the "check signal.aborted FIRST" invariant even
    // if the rejection looks like a plausible retryable error.
    const ac = new AbortController();
    let hung = false;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      hung = true;
      await new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
      return new Response(JSON.stringify(assistantDone('never')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), ac.signal);
    await vi.waitFor(() => expect(hung).toBe(true));
    ac.abort();
    const outcome = await run;
    expect(outcome.exitReason).toBe('cancelled');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("unparseable Retry-After: 'banana' falls back to exponential backoff (no throw), then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchTimes: number[] = [];
    const fetchImpl = vi.fn(async () => {
      fetchTimes.push(Date.now()); // fake Date.now under fake timers
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': 'banana' } });
      return new Response(JSON.stringify(assistantDone('ok')), { status: 200 });
    });
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Exponential fallback (2s base, jittered ±20%), NOT a 0ms sleep and NOT a thrown error.
    const gap = fetchTimes[1]! - fetchTimes[0]!;
    expect(gap).toBeGreaterThanOrEqual(1_600);
    expect(gap).toBeLessThanOrEqual(2_400);
  });

  it('job-signal abort during backoff resolves promptly as cancelled (does not wait out the sleep)', async () => {
    // Real timers on purpose: the guarantee under test is that a REAL abort
    // listener cuts a REAL sleep short; fake timers would fake away exactly
    // the behavior being verified.
    const ac = new AbortController();
    const fetchImpl = stubResponses([{ status: 500 }]);
    const adapter = new HarnessAdapter({ endpoint, fetchImpl });
    const run = adapter.run(ws(), job(), ac.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const t0 = Date.now();
    ac.abort();
    const outcome = await run;
    const elapsed = Date.now() - t0;
    expect(outcome.exitReason).toBe('cancelled');
    expect(elapsed).toBeLessThan(2_000); // base backoff is 2s (jittered ±20%); the abort must cut it short
  });

  it('job-signal abort during a hung response BODY READ → cancelled promptly (never classified parse_error)', async () => {
    // Response whose body stream never closes: json() hangs until the job
    // signal aborts. Cancels must classify as cancelled BEFORE the parse_error
    // retry path (review MAJOR 1 / MINOR 6).
    const ac = new AbortController();
    const neverEndingBody = new ReadableStream<Uint8Array>({ start() {} }); // never enqueues, never closes
    const fetchImpl = vi.fn(async () => new Response(neverEndingBody, { status: 200 })) as unknown as typeof fetch;
    const adapter = new HarnessAdapter({ endpoint, fetchImpl });
    const run = adapter.run(ws(), job(), ac.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const t0 = Date.now();
    ac.abort();
    const outcome = await run;
    expect(outcome.exitReason).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // zero retries after cancellation
  });

  it('retries a 200 with a choice missing `message` (shape_error), then succeeds', async () => {
    // `null` body and `choices:[{}]` previously threw past all classification
    // (null.choices TypeError / undefined pushed into messages) — review
    // cycle-2 MAJOR 1. Both must retry like any other bad 200. The sequence
    // covers both: shape-error body first, then literal `null`, then success.
    vi.useFakeTimers();
    const bodies: unknown[] = [
      { model: 'deepseek/deepseek-chat', choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      null,
      assistantDone('recovered'),
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), { status: 200 }),
    ) as unknown as typeof fetch;
    const adapter = new HarnessAdapter({ endpoint, fetchImpl });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.summary).toBe('recovered');
    expect(outcome.steps).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // shape-error + null body + success
  });

  it('reports endpoint_error with 4 attempts (1 + 3 retries) when the endpoint returns a failure', async () => {
    // Deliberate behavior change (spec item 10): this test previously asserted
    // a single fetch attempt; the retry ladder now makes 4 attempts before
    // the job ends as endpoint_error.
    vi.useFakeTimers();
    const failing = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: failing });
    const run = adapter.run(ws(), job(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await run;
    expect(outcome.exitReason).toBe('endpoint_error');
    expect(failing).toHaveBeenCalledTimes(4);
  });
});

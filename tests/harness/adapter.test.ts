import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('reports endpoint_error when the endpoint returns a failure', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const adapter = new HarnessAdapter({ endpoint, fetchImpl: failing });
    const outcome = await adapter.run(ws(), job(), new AbortController().signal);
    expect(outcome.exitReason).toBe('endpoint_error');
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
});

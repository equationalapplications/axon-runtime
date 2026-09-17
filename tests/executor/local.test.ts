import { execa } from 'execa';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalExecutor } from '../../src/executor/local.js';
import type { DeployConfig } from '../../src/config/deploy.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

let originRepo: string;
let home: string;

beforeAll(async () => {
  originRepo = mkdtempSync(join(tmpdir(), 'axon-origin2-'));
  const git = (args: string[]) => execa('git', args, { cwd: originRepo });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Axon Test']);
  writeFileSync(join(originRepo, 'README.md'), '# origin\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
}, 30_000);

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'axon-local-')); });

function cfg(): DeployConfig {
  return {
    nodeId: 'n1', home, bearerToken: 'tok', maxConcurrentJobs: 2, repoAllowlist: [originRepo],
    ceilings: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
    nodeDailySpendUsd: 20,
    maxGoalBytes: 32_768, maxContextBytes: 1_048_576, maxInlinePatchBytes: 1_048_576, artifactTtlDays: 7,
    endpoint: { baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'test-endpoint-key' },
  };
}

function job(over: Partial<JobRequest> = {}): JobRequest {
  return {
    contract_version: CONTRACT_VERSION, job_id: 'local-a', repo: originRepo, ref: 'main',
    goal: 'create NEW.md', context: [],
    constraints: { max_harness_steps: 3, timeout_seconds: 60, max_spend_usd: 1 },
    output: 'patch', ...over,
  };
}

function stubFetch(bodies: unknown[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

const toolCall = (cmd: string) => ({
  model: 'm',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: cmd }) } }],
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const done = (text: string) => ({
  model: 'm',
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

describe('LocalExecutor', () => {
  it('reports its kind as local', () => {
    expect(new LocalExecutor(cfg()).kind).toBe('local');
  });

  it('prepares a worktree containing the repo', async () => {
    const ex = new LocalExecutor(cfg());
    const ws = await ex.prepare(job());
    expect(existsSync(join(ws.dir!, 'README.md'))).toBe(true);
    await ex.teardown(ws);
  });

  it('returns a unified diff of the subagent’s work', async () => {
    const ex = new LocalExecutor(cfg(), {
      fetchImpl: stubFetch([toolCall('echo hello > NEW.md'), done('created NEW.md')]),
    });
    const ws = await ex.prepare(job());
    const result = await ex.run(ws, job(), new AbortController().signal);
    expect(result.patch).toMatch(/^diff --git a\/NEW\.md b\/NEW\.md/m);
    expect(result.summary).toBe('created NEW.md');
    expect(result.exitReason).toBe('completed');
    await ex.teardown(ws);
  });

  it('returns no patch when the job asks for a report', async () => {
    const ex = new LocalExecutor(cfg(), { fetchImpl: stubFetch([done('nothing to change')]) });
    const reportJob = job({ output: 'report' });
    const ws = await ex.prepare(reportJob);
    const result = await ex.run(ws, reportJob, new AbortController().signal);
    expect(result.patch).toBeNull();
    expect(result.output).toBe('report');
    await ex.teardown(ws);
  });

  it('carries harness telemetry into the run result', async () => {
    const ex = new LocalExecutor(cfg(), { fetchImpl: stubFetch([done('ok')]) });
    const ws = await ex.prepare(job());
    const result = await ex.run(ws, job(), new AbortController().signal);
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(5);
    expect(result.harnessSteps).toBe(1);
    expect(result.harnessVersion).toMatch(/deepseek-harness/);
    await ex.teardown(ws);
  });

  it('removes the worktree on teardown', async () => {
    const ex = new LocalExecutor(cfg());
    const ws = await ex.prepare(job());
    await ex.teardown(ws);
    expect(existsSync(ws.dir!)).toBe(false);
  });

  it('aborts with budget_exceeded when the per-job cap is breached mid-run', async () => {
    const ex = new LocalExecutor(cfg(), {
      // A tiny cap plus token-bearing responses trips the cap on the first step.
      fetchImpl: stubFetch([toolCall('true'), done('ok')]),
    });
    const capped = job({ constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1e-9 } });
    const ws = await ex.prepare(capped);
    const result = await ex.run(ws, capped, new AbortController().signal);
    expect(result.exitReason).toBe('budget_exceeded');
    await ex.teardown(ws);
  });

  it('still returns the work in progress when the cap aborts the run', async () => {
    const ex = new LocalExecutor(cfg(), {
      fetchImpl: stubFetch([toolCall('echo partial > WIP.md'), done('ok')]),
    });
    const capped = job({ constraints: { max_harness_steps: 5, timeout_seconds: 60, max_spend_usd: 1e-9 } });
    const ws = await ex.prepare(capped);
    const result = await ex.run(ws, capped, new AbortController().signal);
    expect(result.patch).toContain('WIP.md');
    await ex.teardown(ws);
  });
});

describe('LocalExecutor onStep budget wiring (H1/H2)', () => {
  it('forwards each completed step with the job id and running cost', async () => {
    const onStep = vi.fn();
    const ex = new LocalExecutor(cfg(), {
      fetchImpl: stubFetch([toolCall('true'), done('ok')]),
      onStep,
    });
    const ws = await ex.prepare(job());
    await ex.run(ws, job(), new AbortController().signal);
    await ex.teardown(ws);
    expect(onStep).toHaveBeenCalled();
    expect(onStep.mock.calls[0][0]).toBe('local-a');
    expect(typeof onStep.mock.calls[0][1]).toBe('number');
    expect(typeof onStep.mock.calls[0][2]).toBe('number');
    // cost is cumulative per step and non-decreasing
    for (let i = 1; i < onStep.mock.calls.length; i++) {
      expect(onStep.mock.calls[i][2]).toBeGreaterThanOrEqual(onStep.mock.calls[i - 1][2]);
    }
  });
});

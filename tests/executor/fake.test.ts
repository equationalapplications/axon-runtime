import { describe, expect, it } from 'vitest';
import { FakeExecutor } from '../../src/executor/fake.js';
import { CONTRACT_VERSION, type JobRequest } from '../../src/contract/schema.js';

const req: JobRequest = {
  contract_version: CONTRACT_VERSION,
  job_id: '3f1a6b8e-0000-4000-8000-00000000000c',
  repo: 'git@github.com:example/project.git',
  ref: 'main',
  goal: 'echo me',
  context: [],
  constraints: { max_harness_steps: 10, timeout_seconds: 60, max_spend_usd: 1 },
  output: 'report',
};

describe('FakeExecutor', () => {
  it('reports its kind as fake', () => {
    expect(new FakeExecutor().kind).toBe('fake');
  });

  it('prepares a workspace with no directory on disk', async () => {
    const ws = await new FakeExecutor().prepare(req);
    expect(ws).toEqual({ jobId: req.job_id, dir: null });
  });

  it('echoes the goal back in the summary at zero cost', async () => {
    const ex = new FakeExecutor();
    const result = await ex.run(await ex.prepare(req), req, new AbortController().signal);
    expect(result.summary).toContain('echo me');
    expect(result.exitReason).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.patch).toBeNull();
  });

  it('returns a syntactically valid patch when output is patch', async () => {
    const ex = new FakeExecutor();
    const patchReq = { ...req, output: 'patch' as const };
    const result = await ex.run(await ex.prepare(patchReq), patchReq, new AbortController().signal);
    expect(result.patch).toMatch(/^diff --git /);
  });

  it('exits as cancelled when the signal is already aborted', async () => {
    const ex = new FakeExecutor();
    const ac = new AbortController();
    ac.abort();
    const result = await ex.run(await ex.prepare(req), req, ac.signal);
    expect(result.exitReason).toBe('cancelled');
  });
});

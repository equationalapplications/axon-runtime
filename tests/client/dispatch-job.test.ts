import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDispatchJob } from '../../src/client/dispatch-job.js';
import { JobRequestSchema } from '../../src/contract/schema.js';
import type { GuidanceItem } from '../../src/contract/schema.js';

function goalFile(content = 'ship the feature'): string {
  const dir = mkdtempSync(join(tmpdir(), 'axon-job-'));
  const file = join(dir, 'goal.md');
  writeFileSync(file, content);
  return file;
}

const input = {
  repo: 'git@github.com:example/project.git',
  ref: 'main',
  output: 'patch' as const,
  maxSteps: '40',
  timeout: '1800',
  maxSpend: '2',
};

describe('buildDispatchJob (the --guidance-file wiring)', () => {
  it('omits the guidance key entirely when no guidance is given (never sends [])', () => {
    const job = buildDispatchJob({ ...input, goalFile: goalFile() });
    expect('guidance' in job).toBe(false);
    expect(JobRequestSchema.safeParse(job).success).toBe(true);
  });

  it('carries parsed guidance items into the job when provided', () => {
    const guidance: GuidanceItem[] = [{ label: 'ADR-7', text: 'use the envelope helper' }];
    const job = buildDispatchJob({ ...input, goalFile: goalFile(), guidance });
    expect(job.guidance).toEqual(guidance);
    expect(JobRequestSchema.safeParse(job).success).toBe(true);
  });

  it('never sends guidance: [] — an empty file yields the absent key (D11)', () => {
    const job = buildDispatchJob({ ...input, goalFile: goalFile(), guidance: [] });
    expect('guidance' in job).toBe(false);
  });

  it('builds a schema-valid v3 job with goal text read verbatim', () => {
    const job = buildDispatchJob({ ...input, goalFile: goalFile('make the thing') });
    expect(job.goal).toBe('make the thing');
    expect(job.contract_version).toBe(3);
    expect(job.job_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HarnessAdapter } from '../../src/harness/adapter.js';
import { CONTRACT_VERSION } from '../../src/contract/schema.js';

/**
 * Runs only under AXON_LIVE=1 (see vitest.config.ts: `*.live.test.ts` is
 * excluded unless that flag is set). Costs real money against a real endpoint.
 */
describe.skipIf(process.env.AXON_LIVE !== '1')('HarnessAdapter (live)', () => {
  it('completes a trivial goal against the configured endpoint', async () => {
    const adapter = new HarnessAdapter({
      endpoint: {
        baseUrl: process.env.AXON_ENDPOINT_URL!,
        model: process.env.AXON_ENDPOINT_MODEL!,
        apiKey: process.env.AXON_ENDPOINT_API_KEY!,
      },
    });
    const ws = { jobId: 'live', dir: mkdtempSync(join(tmpdir(), 'axon-live-')), repo: 'r', ref: 'main' };
    const outcome = await adapter.run(
      ws,
      {
        contract_version: CONTRACT_VERSION, job_id: 'live', repo: 'r', ref: 'main',
        goal: 'Create a file named HELLO.txt containing the word hello, then stop.',
        context: [],
        constraints: { max_harness_steps: 6, timeout_seconds: 120, max_spend_usd: 0.5 },
        output: 'patch',
      },
      new AbortController().signal,
    );
    expect(outcome.exitReason).toBe('completed');
    expect(outcome.tokensIn).toBeGreaterThan(0);
  }, 120_000);
});

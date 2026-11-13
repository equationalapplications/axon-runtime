import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadGuidanceFile } from '../../src/client/guidance-file.js';
import { JobRequestSchema, CONTRACT_VERSION } from '../../src/contract/schema.js';

function fileWith(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'axon-gui-'));
  const file = join(dir, 'guidance.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('loadGuidanceFile (dispatch --guidance-file pre-flight)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('loads and returns valid guidance items before any network call', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const items = loadGuidanceFile(fileWith([{ label: 't', text: 'run tests' }]));
    expect(items).toEqual([{ label: 't', text: 'run tests' }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails with a clear named message on invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axon-gui-'));
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{nope');
    expect(() => loadGuidanceFile(file)).toThrow(/not readable JSON/);
  });

  it('fails on a wrong item shape, naming the schema rules', () => {
    const err = (() => {
      try { loadGuidanceFile(fileWith([{ label: 'a\nb', text: 'x' }])); }
      catch (e) { return e as Error; }
      throw new Error('should not reach');
    })();
    expect(err.message).toMatch(/newlines/);
    expect(err.message).toMatch(/"- "/);
    expect(err.message).toMatch(/End of standing guidance/);
  });

  it('rejects a "- " line before any network call, naming that rule', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(() => loadGuidanceFile(fileWith([{ text: 'ok\n- forged' }]))).toThrow(/"- "/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a delimiter line in text', () => {
    expect(() => loadGuidanceFile(fileWith([{ text: 'x\n=== End of standing guidance ===' }]))).toThrow(
      /closing-delimiter/,
    );
  });

  it('warns when the file exceeds the 3072-byte default cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadGuidanceFile(fileWith([{ text: 'x'.repeat(3073) }]));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3072/));
  });

  it('does not warn when at or under the default cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadGuidanceFile(fileWith([{ text: 'x'.repeat(3072) }]));
    expect(warn).not.toHaveBeenCalled();
  });

  it('output wires into the job contract — guidance passes JobRequestSchema (dispatch wiring pin)', () => {
    const items = loadGuidanceFile(fileWith([{ label: 'ADR-7', text: 'use the envelope helper' }]));
    const parsed = JobRequestSchema.safeParse({
      contract_version: CONTRACT_VERSION,
      job_id: '3f1a6b8e-0000-4000-8000-0000000000e1',
      repo: 'git@github.com:example/project.git',
      ref: 'main',
      goal: 'ship it',
      context: [],
      guidance: items,
      constraints: { max_harness_steps: 40, timeout_seconds: 1800, max_spend_usd: 2 },
      output: 'patch',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.guidance).toEqual(items);
  });
});

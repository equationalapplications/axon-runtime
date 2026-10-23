import { describe, expect, it } from 'vitest';
import { describeExtraSystemPrompt } from '../src/worker.js';

describe('describeExtraSystemPrompt', () => {
  it('reports presence with a byte count', () => {
    expect(describeExtraSystemPrompt({ extraSystemPrompt: 'HOUSE RULES' })).toBe('set (11 bytes)');
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 3 CJK characters = 9 UTF-8 bytes.
    expect(describeExtraSystemPrompt({ extraSystemPrompt: '字字字' })).toBe('set (9 bytes)');
  });

  it('reports unset when no addendum is configured', () => {
    expect(describeExtraSystemPrompt({})).toBe('unset');
    expect(describeExtraSystemPrompt({ extraSystemPrompt: undefined })).toBe('unset');
  });

  it('never leaks the configured wording (AC6)', () => {
    // AC6 is asserted at the helper level by design: startup logging in
    // src/worker.ts is a thin describeExtraSystemPrompt call, and the
    // no-logging-of-config property is covered by this wording canary
    // (Tier 3 review m2b, 2026-10-22 — noted, not spied on).
    const canary = 'SUPER-SECRET-DEPLOY-WORDING';
    const out = describeExtraSystemPrompt({ extraSystemPrompt: canary });
    expect(out).not.toContain(canary);
    expect(out).not.toContain('SECRET');
  });
});

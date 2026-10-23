import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Genericity gate (DSH×CT groundwork spec, AC5 + AC7):
 * - src/ never names the consumer (the public runtime stays consumer-free);
 * - the whole tracked tree carries no private internal usage details
 *   (host names, private network addresses, private repo paths).
 *
 * Private tokens are stored ONLY as SHA-256 digests so this public test
 * never publishes the very strings it guards (Tier 3 review finding M1,
 * 2026-10-22; M1 genericity ruling 2026-10-21). Detections:
 * - generic RFC 1918 address match (public knowledge, kept inline);
 * - exact-token match: whitespace/quote-delimited tokens are hashed and
 *   compared against the digest set below (catches bare private host
 *   names and `org/repo` paths in prose, YAML, and shell files);
 * - additional literals may be supplied at runtime via the
 *   AXON_PRIVATE_TOKENS env var (comma-separated substrings) without
 *   ever committing them.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RFC1918_ADDRESS =
  /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/;

const PRIVATE_TOKEN_SHA256 = new Set([
  '6b35652ff6be871479dfcfdf51d594da73736dcba7db10fb1591e125e1943838',
  'a78a9c4f74c5b814423c5af47fd7a5e52c726125ccbcbc067c18acac23f2bb59',
]);

const ENV_PRIVATE_TOKENS = () =>
  (process.env.AXON_PRIVATE_TOKENS ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function trackedFiles(): string[] {
  return execSync('git ls-files', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function carriesPrivateDetail(text: string): boolean {
  if (RFC1918_ADDRESS.test(text)) return true;
  for (const token of text.split(/[\s"'`,;:=()[\]{}|]+/)) {
    // Strip edge punctuation so prose like "host-01." still matches a
    // stored digest; punctuation inside host names and org/repo paths stays.
    const clean = token.replace(/^[.,!?]+|[.,!?]+$/g, '');
    if (clean && PRIVATE_TOKEN_SHA256.has(sha256(clean))) return true;
  }
  return ENV_PRIVATE_TOKENS().some((needle) => text.includes(needle));
}

describe('genericity gate', () => {
  it('keeps consumer naming out of src/', () => {
    const offenders: string[] = [];
    for (const file of execSync('git ls-files src', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      if (/curated[-_]thoughts/.test(text) || /\bCT\b/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps private internal usage details out of every tracked file', () => {
    const offenders: string[] = [];
    for (const rel of trackedFiles()) {
      if (carriesPrivateDetail(readFileSync(join(repoRoot, rel), 'utf8'))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects private details in shell/YAML assignment form', () => {
    // Driven through the env-var path so this public test never publishes
    // a real private token; the digest path shares the same tokenizer
    // (CodeRabbit minor on 09b0464: `=` must act as a delimiter).
    process.env.AXON_PRIVATE_TOKENS = 'assignment-probe-value';
    try {
      expect(carriesPrivateDetail('HOST=assignment-probe-value')).toBe(true);
      expect(carriesPrivateDetail('HOST: assignment-probe-value')).toBe(true);
      expect(carriesPrivateDetail('export HOST="assignment-probe-value"')).toBe(true);
      expect(carriesPrivateDetail('totally unrelated prose')).toBe(false);
    } finally {
      delete process.env.AXON_PRIVATE_TOKENS;
    }
  });
});

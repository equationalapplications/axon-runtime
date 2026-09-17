import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/service/artifacts.js';

const A = '3f1a6b8e-0000-4000-8000-0000000000b1';
let home: string;
let store: ArtifactStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'axon-art-'));
  store = new ArtifactStore(home);
});

describe('ArtifactStore', () => {
  it('round-trips a written artifact', () => {
    const id = store.write(A, 'patch.diff', 'diff --git a/x b/x');
    expect(store.read(A, id)).toBe('diff --git a/x b/x');
  });

  it('returns undefined for an unknown artifact', () => {
    expect(store.read(A, 'nope')).toBeUndefined();
  });

  it('refuses an artifact id that escapes the job directory', () => {
    store.write(A, 'patch.diff', 'x');
    expect(store.read(A, '../../../etc/passwd')).toBeUndefined();
  });

  it('keeps artifacts from different jobs separate', () => {
    const B = '3f1a6b8e-0000-4000-8000-0000000000b2';
    const idA = store.write(A, 'a-patch.diff', 'a');
    store.write(B, 'b-patch.diff', 'b');
    expect(store.read(B, idA)).toBeUndefined();
  });

  it('refuses an artifact id containing intermediate path segments', () => {
    // Simulate a nested file created outside the flattening write() path.
    mkdirSync(join(home, 'artifacts', A, 'sub'), { recursive: true });
    writeFileSync(join(home, 'artifacts', A, 'sub', 'patch.diff'), 'x', 'utf8');
    expect(store.read(A, 'sub/patch.diff')).toBeUndefined();
  });

  it('refuses degenerate artifact names on write', () => {
    expect(() => store.write(A, '', 'x')).toThrow();
    expect(() => store.write(A, '/', 'x')).toThrow();
    expect(() => store.write(A, 'a/b/..', 'x')).toThrow();
  });
});

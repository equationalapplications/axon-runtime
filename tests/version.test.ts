import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNTIME_VERSION } from '../src/worker.js';

describe('RUNTIME_VERSION', () => {
  it('matches the package.json version — never a hardcoded literal', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(pkg.version);
  });
});

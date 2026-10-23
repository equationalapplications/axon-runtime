import { describe, expect, it } from 'vitest';
import { allowlistEntryError, isRepoAllowed } from '../../src/config/allowlist.js';

describe('isRepoAllowed', () => {
  const list = ['git@github.com:example/project.git', 'https://github.com/acme/*', 'git@github.com:acme/*'];

  it('matches exact entries by exact string only', () => {
    expect(isRepoAllowed('git@github.com:example/project.git', list)).toBe(true);
    expect(isRepoAllowed('git@github.com:example/project', list)).toBe(false);
    expect(isRepoAllowed('https://github.com/example/project.git', list)).toBe(false);
  });

  it('lets a trailing /* admit any one repository under the prefix', () => {
    expect(isRepoAllowed('https://github.com/acme/api.git', list)).toBe(true);
    expect(isRepoAllowed('https://github.com/acme/Synapse_Tree', list)).toBe(true);
    expect(isRepoAllowed('git@github.com:acme/web-app.git', list)).toBe(true);
  });

  it.each([
    ['another owner', 'https://github.com/acmecorp/api.git'],
    ['a nested path', 'https://github.com/acme/api/extra.git'],
    ['parent traversal', 'https://github.com/acme/../other/api.git'],
    ['a dot-led name', 'https://github.com/acme/.hidden'],
    ['an option-like name', 'https://github.com/acme/-upload-pack=touch'],
    ['userinfo smuggling', 'https://github.com/acme/x@evil.example/y'],
    ['a query string', 'https://github.com/acme/api?x=1'],
    ['an empty name', 'https://github.com/acme/'],
    ['the bare prefix', 'https://github.com/acme'],
  ])('refuses %s', (_label, repo) => {
    expect(isRepoAllowed(repo, list)).toBe(false);
  });

  it('never treats an exact entry as a prefix', () => {
    expect(isRepoAllowed('git@github.com:example/project.git2', list)).toBe(false);
  });
});

describe('allowlistEntryError', () => {
  it('accepts exact entries and a final /*', () => {
    expect(allowlistEntryError('git@github.com:example/project.git')).toBeUndefined();
    expect(allowlistEntryError('https://github.com/acme/*')).toBeUndefined();
  });

  it.each(['*', '/*', 'https://github.com/acme*', 'https://github.com/*/api.git', 'https://github.com/acme/**'])(
    'rejects %s',
    (entry) => {
      expect(allowlistEntryError(entry)).toMatch(/wildcard must be the final "\/\*"/);
    },
  );
});

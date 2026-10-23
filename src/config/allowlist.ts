/**
 * Repo allowlist matching. An entry is either an exact repo URL or a prefix
 * ending in `/*`, which admits every repository directly under that prefix:
 * `https://github.com/acme/*` matches `https://github.com/acme/api.git` but not
 * `https://github.com/acme/api/extra`, `https://github.com/acme/../other`, or
 * `https://github.com/acme/x@evil.example/y`.
 */

/** One repository name: what `*` may stand for. No `/`, `@`, `:` or leading `.`/`-`. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function allowlistEntryError(entry: string): string | undefined {
  const star = entry.indexOf('*');
  if (star === -1) return undefined;
  if (star !== entry.length - 1 || !entry.endsWith('/*') || entry.length < 3) {
    return `repo_allowlist entry ${JSON.stringify(entry)}: a wildcard must be the final "/*"`;
  }
  return undefined;
}

export function isRepoAllowed(repo: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    if (!entry.endsWith('/*')) return entry === repo;
    const prefix = entry.slice(0, -1);
    return repo.startsWith(prefix) && SEGMENT.test(repo.slice(prefix.length));
  });
}

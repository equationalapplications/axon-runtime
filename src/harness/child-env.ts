/**
 * The environment a job's shell is allowed to see (spec §7, decision C2).
 *
 * An allowlist, not a blocklist: a blocklist silently leaks whatever secret is
 * added next. SSH_AUTH_SOCK is excluded deliberately — forwarding the operator's
 * agent socket into a job would let it authenticate as the operator.
 */
export const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

export function childEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    CHILD_ENV_ALLOWLIST.filter((k) => parent[k] !== undefined).map((k) => [k, parent[k] as string]),
  );
}

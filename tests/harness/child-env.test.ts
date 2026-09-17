import { describe, expect, it } from 'vitest';
import { CHILD_ENV_ALLOWLIST, childEnv } from '../../src/harness/child-env.js';

describe('childEnv', () => {
  it('passes through allowlisted variables', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/var/axon', TZ: 'UTC' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/var/axon', TZ: 'UTC' });
  });

  it('drops the node bearer token and the endpoint key', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      AXON_NODE_TOKEN: 'secret-token',
      AXON_ENDPOINT_KEY: 'secret-key',
      GLM_API_KEY: 'secret-key',
    });
    expect(env.AXON_NODE_TOKEN).toBeUndefined();
    expect(env.AXON_ENDPOINT_KEY).toBeUndefined();
    expect(env.GLM_API_KEY).toBeUndefined();
  });

  it('is an allowlist, so an unknown future secret cannot leak', () => {
    const env = childEnv({ PATH: '/usr/bin', AXON_SOME_FUTURE_SECRET: 'nope' });
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('drops SSH_AUTH_SOCK even when the parent has one', () => {
    const env = childEnv({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/tmp/agent.sock' });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it('omits allowlisted names that are absent rather than setting undefined', () => {
    const env = childEnv({ PATH: '/usr/bin' });
    expect('HOME' in env).toBe(false);
  });

  it('exposes the allowlist so tests and reviewers can see it', () => {
    expect([...CHILD_ENV_ALLOWLIST]).toEqual(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDeployConfig } from '../../src/config/deploy.js';

const raw = {
  node_id: 'node-01',
  home: '/home/axon',
  bearer_token_env: 'AXON_NODE_TOKEN',
  max_concurrent_jobs: 2,
  repo_allowlist: ['git@github.com:example/project.git'],
  ceilings: { max_harness_steps: 60, timeout_seconds: 3600, max_spend_usd: 5 },
  node_daily_spend_usd: 20,
  endpoint: { base_url: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', api_key_env: 'AXON_ENDPOINT_KEY' },
};

function writeConfig(patch: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'axon-cfg-'));
  const file = join(dir, 'node.json');
  writeFileSync(file, JSON.stringify({ ...raw, ...patch }));
  return file;
}

const env = { AXON_NODE_TOKEN: 'tok', AXON_ENDPOINT_KEY: 'key' } as NodeJS.ProcessEnv;

describe('loadDeployConfig', () => {
  it('resolves secrets from the environment by name', () => {
    const cfg = loadDeployConfig(writeConfig(), env);
    expect(cfg.bearerToken).toBe('tok');
    expect(cfg.endpoint.apiKey).toBe('key');
  });

  it('applies documented defaults', () => {
    const cfg = loadDeployConfig(writeConfig(), env);
    expect(cfg.artifactTtlDays).toBe(7);
    expect(cfg.maxInlinePatchBytes).toBe(1_048_576);
    expect(cfg.maxGoalBytes).toBe(32_768);
    expect(cfg.maxContextBytes).toBe(1_048_576);
  });

  it('honors explicit non-default byte/TTL overrides', () => {
    const cfg = loadDeployConfig(
      writeConfig({ max_goal_bytes: 4096, max_context_bytes: 2048, max_inline_patch_bytes: 1024, artifact_ttl_days: 30 }),
      env,
    );
    expect(cfg.maxGoalBytes).toBe(4096);
    expect(cfg.maxContextBytes).toBe(2048);
    expect(cfg.maxInlinePatchBytes).toBe(1024);
    expect(cfg.artifactTtlDays).toBe(30);
  });

  it('throws when a named secret is absent from the environment', () => {
    expect(() => loadDeployConfig(writeConfig(), {} as NodeJS.ProcessEnv)).toThrow(/AXON_NODE_TOKEN/);
  });

  it('distinguishes an empty-string secret from an absent one', () => {
    expect(() => loadDeployConfig(writeConfig(), { AXON_NODE_TOKEN: '' } as NodeJS.ProcessEnv)).toThrow(
      /empty string/,
    );
  });

  it('rejects an inline api_key inside the endpoint object', () => {
    expect(() =>
      loadDeployConfig(
        writeConfig({ endpoint: { ...raw.endpoint, api_key: 'oops' } }),
        env,
      ),
    ).toThrow(/api_key/);
  });

  it('rejects a config carrying an inline secret value', () => {
    expect(() => loadDeployConfig(writeConfig({ bearer_token: 'oops' }), env)).toThrow(/bearer_token/);
  });
});

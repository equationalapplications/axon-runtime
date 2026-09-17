import { execa } from 'execa';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../../src/executor/workspace.js';

let originRepo: string;
let home: string;
let wm: WorkspaceManager;

/** A real local git repo standing in for a remote. No network needed. */
beforeAll(async () => {
  originRepo = mkdtempSync(join(tmpdir(), 'axon-origin-'));
  const git = (args: string[]) => execa('git', args, { cwd: originRepo });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Axon Test']);
  writeFileSync(join(originRepo, 'README.md'), '# origin\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
}, 30_000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'axon-ws-'));
  wm = new WorkspaceManager(home);
});

describe('WorkspaceManager', () => {
  it('creates a bare mirror on first sync', async () => {
    const path = await wm.syncMirror(originRepo);
    expect(existsSync(join(path, 'HEAD'))).toBe(true);
  });

  it('reuses the same mirror path on a second sync', async () => {
    expect(await wm.syncMirror(originRepo)).toBe(await wm.syncMirror(originRepo));
  });

  it('checks out the requested ref into a job worktree', async () => {
    const ws = await wm.create('job-a', originRepo, 'main');
    expect(existsSync(join(ws.dir!, 'README.md'))).toBe(true);
  });

  it('gives two concurrent jobs distinct worktrees off one mirror', async () => {
    const [a, b] = await Promise.all([
      wm.create('job-a', originRepo, 'main'),
      wm.create('job-b', originRepo, 'main'),
    ]);
    expect(a.dir).not.toBe(b.dir);
    expect(existsSync(a.dir!)).toBe(true);
    expect(existsSync(b.dir!)).toBe(true);
  });

  it('produces a unified diff of uncommitted work', async () => {
    const ws = await wm.create('job-a', originRepo, 'main');
    writeFileSync(join(ws.dir!, 'NEW.md'), 'hello\n');
    const patch = await wm.diff(ws);
    expect(patch).toMatch(/^diff --git a\/NEW\.md b\/NEW\.md/m);
    expect(patch).toContain('+hello');
  });

  it('produces an empty diff when nothing changed', async () => {
    expect(await wm.diff(await wm.create('job-a', originRepo, 'main'))).toBe('');
  });

  // Regression: execa strips the final newline by default, which produced a
  // patch git refuses with "corrupt patch at line N".
  it('returns a patch that ends in a newline so git can apply it', async () => {
    const ws = await wm.create('job-a', originRepo, 'main');
    writeFileSync(join(ws.dir!, 'NEW.md'), 'hello\n');
    const patch = await wm.diff(ws);
    expect(patch.endsWith('\n')).toBe(true);

    const target = await wm.create('job-b', originRepo, 'main');
    const patchFile = join(home, 'regression.patch');
    writeFileSync(patchFile, patch);
    await expect(
      execa('git', ['apply', '--check', patchFile], { cwd: target.dir! }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it('removes the worktree and deregisters it from the mirror', async () => {
    const ws = await wm.create('job-a', originRepo, 'main');
    await wm.remove(ws);
    expect(existsSync(ws.dir!)).toBe(false);
    const { stdout } = await execa('git', ['worktree', 'list'], { cwd: await wm.syncMirror(originRepo) });
    expect(stdout).not.toContain('job-a');
  });
});

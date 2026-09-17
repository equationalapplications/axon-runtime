import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from './types.js';

export class WorkspaceManager {
  /** In-flight mirror syncs, so concurrent creates share one clone/fetch. */
  private readonly syncing = new Map<string, Promise<string>>();

  constructor(private readonly home: string) {}

  mirrorPath(repo: string): string {
    const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
    return join(this.home, 'cache', `${hash}.git`);
  }

  /** Clone the bare mirror on first use, fetch on every use after. */
  syncMirror(repo: string): Promise<string> {
    const path = this.mirrorPath(repo);
    const inflight = this.syncing.get(path);
    if (inflight) return inflight;
    const sync = this.doSyncMirror(repo, path).finally(() => this.syncing.delete(path));
    this.syncing.set(path, sync);
    return sync;
  }

  private async doSyncMirror(repo: string, path: string): Promise<string> {
    mkdirSync(join(this.home, 'cache'), { recursive: true });
    if (!existsSync(path)) {
      await execa('git', ['clone', '--mirror', repo, path]);
    } else {
      await execa('git', ['fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], { cwd: path });
    }
    return path;
  }

  async create(jobId: string, repo: string, ref: string): Promise<Workspace> {
    const mirror = await this.syncMirror(repo);
    const dir = join(this.home, 'workspaces', jobId);
    mkdirSync(join(this.home, 'workspaces'), { recursive: true });
    await execa('git', ['worktree', 'add', '--detach', dir, ref], { cwd: mirror });
    await execa('git', ['config', 'user.email', 'axon@localhost'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'Axon Worker'], { cwd: dir });
    return { jobId, dir, repo, ref };
  }

  /** Unified diff of the worktree against its checked-out commit, staged or not. */
  async diff(ws: Workspace): Promise<string> {
    if (!ws.dir) return '';
    await execa('git', ['add', '-A'], { cwd: ws.dir });
    // stripFinalNewline (execa's default) would eat git's trailing newline and
    // yield a patch git itself rejects with "corrupt patch at line N".
    const { stdout } = await execa('git', ['diff', '--cached', '--binary'], {
      cwd: ws.dir,
      stripFinalNewline: false,
    });
    return stdout;
  }

  async remove(ws: Workspace): Promise<void> {
    if (!ws.dir) return;
    rmSync(ws.dir, { recursive: true, force: true });
    if (ws.repo) {
      const mirror = this.mirrorPath(ws.repo);
      if (existsSync(mirror)) {
        await execa('git', ['worktree', 'prune'], { cwd: mirror }).catch(() => undefined);
      }
    }
  }
}

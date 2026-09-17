import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JobStore } from '../state/store.js';

export interface SweepResult {
  interrupted: string[];
  workspacesRemoved: string[];
  artifactsPurged: string[];
}

export function sweepOnStartup(opts: {
  home: string;
  store: JobStore;
  artifactTtlDays: number;
  now?: Date;
}): SweepResult {
  const now = opts.now ?? new Date();
  const interrupted = opts.store.recoverInterrupted();

  const workspacesRemoved: string[] = [];
  const wsRoot = join(opts.home, 'workspaces');
  if (existsSync(wsRoot)) {
    for (const entry of readdirSync(wsRoot)) {
      const rec = opts.store.get(entry);
      if (rec && rec.status === 'running') continue;
      rmSync(join(wsRoot, entry), { recursive: true, force: true });
      workspacesRemoved.push(entry);
    }
  }

  const artifactsPurged: string[] = [];
  const artRoot = join(opts.home, 'artifacts');
  const ttlMs = opts.artifactTtlDays * 86_400_000;
  if (existsSync(artRoot)) {
    for (const entry of readdirSync(artRoot)) {
      const path = join(artRoot, entry);
      if (now.getTime() - statSync(path).mtimeMs > ttlMs) {
        rmSync(path, { recursive: true, force: true });
        artifactsPurged.push(entry);
      }
    }
  }

  return { interrupted, workspacesRemoved, artifactsPurged };
}

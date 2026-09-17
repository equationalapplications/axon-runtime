import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Input contract: `jobId` is a zod-validated UUID and artifact ids are single
 * path segments (no '/'); both originate from validated request paths. write()
 * flattens `name` via basename() and rejects names that flatten to nothing,
 * so the store is safe even if a future caller skips upstream validation.
 */
export class ArtifactStore {
  constructor(private readonly home: string) {}

  dirFor(jobId: string): string {
    return join(this.home, 'artifacts', jobId);
  }

  write(jobId: string, name: string, content: string): string {
    const id = basename(name);
    if (id === '' || id === '.' || id === '..') {
      throw new Error(`degenerate artifact name: ${JSON.stringify(name)}`);
    }
    const dir = this.dirFor(jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id), content, 'utf8');
    return id;
  }

  read(jobId: string, artifactId: string): string | undefined {
    if (artifactId.includes('/')) return undefined;
    const dir = resolve(this.dirFor(jobId));
    const path = resolve(join(dir, artifactId));
    if (!path.startsWith(dir + '/')) return undefined;
    if (!existsSync(path)) return undefined;
    return readFileSync(path, 'utf8');
  }
}

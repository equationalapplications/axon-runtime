import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { DeployConfig } from '../config/deploy.js';
import { CONTRACT_VERSION } from '../contract/schema.js';
import type { ArtifactStore } from './artifacts.js';
import type { JobPool } from './pool.js';

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ServerOptions {
  cfg: DeployConfig;
  pool: JobPool;
  artifacts: ArtifactStore;
  runtimeVersion: string;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/healthz') return;
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !tokenMatches(provided, opts.cfg.bearerToken)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/nodeinfo', async () => ({
    node_id: opts.cfg.nodeId,
    contract_version: CONTRACT_VERSION,
    runtime_version: opts.runtimeVersion,
    active_jobs: opts.pool.activeCount(),
    max_concurrent_jobs: opts.cfg.maxConcurrentJobs,
  }));

  app.post('/jobs', async (req, reply) => {
    const result = opts.pool.submit(req.body);
    return reply.code(result.status === 'accepted' ? 202 : 400).send(result);
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const envelope = opts.pool.envelope(req.params.id);
    if (envelope) return envelope;
    if (opts.pool.isRunning(req.params.id)) {
      return reply.code(200).send({ job_id: req.params.id, status: 'running' });
    }
    return reply.code(404).send({ error: 'unknown job' });
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (req, reply) => {
    if (!opts.pool.cancel(req.params.id)) {
      return reply.code(404).send({ error: 'job is not running' });
    }
    return reply.code(202).send({ job_id: req.params.id, status: 'cancelling' });
  });

  app.get<{ Params: { id: string }; Querystring: { id?: string } }>(
    '/jobs/:id/artifact',
    async (req, reply) => {
      const artifactId = req.query.id;
      if (!artifactId) return reply.code(400).send({ error: 'missing artifact id' });
      const content = opts.artifacts.read(req.params.id, artifactId);
      if (content === undefined) return reply.code(404).send({ error: 'unknown artifact' });
      return reply.type('text/plain').send(content);
    },
  );

  return app;
}

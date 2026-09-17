import { randomUUID } from 'node:crypto';
import { EnvelopeSchema, type Envelope, type JobRequest } from '../contract/schema.js';
import type { SubmitResult } from '../contract/schema.js';

export type { SubmitResult };

export function newJobId(): string {
  return randomUUID();
}

export interface NodeInfo {
  node_id: string;
  contract_version: number;
  runtime_version: string;
  active_jobs: number;
  max_concurrent_jobs: number;
}

export class AxonClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: { baseUrl: string; token: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) throw new Error(`axon: 401 unauthorized against ${this.baseUrl}`);
    return res;
  }

  async dispatch(job: JobRequest): Promise<SubmitResult> {
    const res = await this.call('/jobs', { method: 'POST', body: JSON.stringify(job) });
    if (res.status !== 202 && res.status !== 400) {
      throw new Error(`axon: unexpected ${res.status} dispatching job`);
    }
    return (await res.json()) as SubmitResult;
  }

  async status(jobId: string): Promise<Envelope | { status: 'running' }> {
    const res = await this.call(`/jobs/${jobId}`);
    if (res.status === 404) throw new Error(`axon: unknown job ${jobId}`);
    const body = (await res.json()) as unknown;
    if ((body as { status?: string }).status === 'running') return { status: 'running' };
    return EnvelopeSchema.parse(body);
  }

  async wait(jobId: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<Envelope> {
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      try {
        const current = await this.status(jobId);
        if (current.status !== 'running') return current as Envelope;
      } catch {
        // transient (job not visible yet / unknown): keep polling until the deadline
      }
      if (Date.now() >= deadline) throw new Error(`axon: timed out waiting for job ${jobId}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    return (await this.call(`/jobs/${jobId}/cancel`, { method: 'POST' })).status === 202;
  }

  async nodeinfo(): Promise<NodeInfo> {
    return (await (await this.call('/nodeinfo')).json()) as NodeInfo;
  }

  async artifact(jobId: string, artifactId: string): Promise<string> {
    const res = await this.call(`/jobs/${jobId}/artifact?id=${encodeURIComponent(artifactId)}`);
    if (!res.ok) throw new Error(`axon: artifact ${artifactId} not found for job ${jobId}`);
    return await res.text();
  }
}

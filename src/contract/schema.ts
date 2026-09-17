import { z } from 'zod';

export const CONTRACT_VERSION = 2 as const;

export const JobStatusSchema = z.enum(['ok', 'error', 'timeout', 'rejected', 'interrupted']);

export const RejectReasonSchema = z.enum([
  'repo_not_allowlisted',
  'contract_unsupported',
  'malformed_payload',
  'limit_exceeded',
  'queue_full',
  'budget_exhausted',
]);

export const ExitReasonSchema = z.enum([
  'completed',
  'step_cap',
  'timeout',
  'budget_exceeded',
  'cancelled',
  'harness_error',
  'endpoint_error',
  'interrupted',
]);

export const ConstraintsSchema = z.object({
  max_harness_steps: z.number().int().positive(),
  timeout_seconds: z.number().int().positive(),
  max_spend_usd: z.number().positive(),
});

export const ContextFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const JobRequestSchema = z.object({
  contract_version: z.number().int(),
  job_id: z.string().uuid(),
  repo: z.string().min(1),
  ref: z.string().min(1),
  goal: z.string().min(1),
  context: z.array(ContextFileSchema).default([]),
  constraints: ConstraintsSchema,
  output: z.enum(['patch', 'report']),
});

export const TelemetrySchema = z.object({
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative(),
  harness_steps: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_estimate_usd: z.number().nonnegative(),
  exit_reason: ExitReasonSchema,
  node_id: z.string().min(1),
  executor: z.enum(['fake', 'local']),
  model_id: z.string(),
  endpoint_base_url: z.string(),
  runtime_version: z.string(),
  harness_version: z.string(),
});

export const ResultSchema = z.object({
  output: z.enum(['patch', 'report']),
  patch: z.string().nullable(),
  patch_artifact: z.string().nullable(),
  summary: z.string(),
});

export const EnvelopeSchema = z
  .object({
    contract_version: z.literal(CONTRACT_VERSION),
    job_id: z.string().uuid(),
    node_id: z.string().min(1),
    status: JobStatusSchema,
    reason: RejectReasonSchema.nullable(),
    error_detail: z.string().nullable(),
    result: ResultSchema.nullable(),
    telemetry: TelemetrySchema.nullable(),
  })
  .refine(
    (e) =>
      e.status === 'rejected'
        ? e.telemetry === null
        : e.status === 'interrupted'
          ? true // 'interrupted' retains telemetry up to its last checkpoint — legitimately none after a crash
          : e.telemetry !== null,
    {
      message: 'telemetry is required on every terminal status except rejected and interrupted',
      path: ['telemetry'],
    },
  )
  .refine((e) => (e.status === 'rejected' ? e.reason !== null : e.reason === null), {
    message: 'reason is set if and only if status is rejected',
    path: ['reason'],
  })
  .refine(
    (e) => (e.telemetry?.exit_reason === 'harness_error' ? e.error_detail !== null : e.error_detail === null),
    {
      message: 'error_detail is set if and only if telemetry.exit_reason is harness_error',
      path: ['error_detail'],
    },
  );

export type JobRequest = z.infer<typeof JobRequestSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Telemetry = z.infer<typeof TelemetrySchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type RejectReason = z.infer<typeof RejectReasonSchema>;
export type ExitReason = z.infer<typeof ExitReasonSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;

/** Reply shape shared by POST /jobs and the client's dispatch(). */
export interface SubmitResult {
  job_id: string;
  status: 'accepted' | 'rejected';
  reason?: RejectReason;
}

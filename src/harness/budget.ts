import type { DeployConfig } from '../config/deploy.js';
import { RejectError } from '../contract/errors.js';
import type { JobStore } from '../state/store.js';

export function startOfDayIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
export class BudgetGuard {
  constructor(
    private readonly store: JobStore,
    private readonly cfg: Pick<DeployConfig, 'nodeDailySpendUsd'>,
  ) {}

  /**
   * Admission is a read-then-decide against the node's rolling daily cap.
   * Callers must hold the pool's admission lock (Task 7) so two concurrent
   * dispatches cannot both pass a nearly-exhausted cap.
   */
  admit(): void {
    const spent = this.store.spendSince(startOfDayIso());
    if (spent >= this.cfg.nodeDailySpendUsd) {
      throw new RejectError(
        'budget_exhausted',
        `node daily cap of ${this.cfg.nodeDailySpendUsd} USD is spent`,
      );
    }
  }

  /**
   * Not atomic: addSpend() and checkpoint() are two separate writes. In
   * practice the durable spend row lands first (the daily cap never
   * undercounts), and a crash between the two costs at most one
   * checkpoint refresh of cost_usd, which record() re-derives from the
   * ledger — cost_usd is a cache of the spend ledger, never a source of truth.
   */
  record(jobId: string, usd: number): void {
    if (usd < 0) {
      throw new Error(`negative spend amount: ${usd} USD; costs only accumulate`);
    }
    this.store.addSpend(jobId, usd); // durable first: the daily cap never undercounts
    const total = (this.store.get(jobId)?.costUsd ?? 0) + usd;
    this.store.checkpoint(jobId, { costUsd: total });
  }

  jobSpend(jobId: string): number {
    return this.store.get(jobId)?.costUsd ?? 0;
  }
}

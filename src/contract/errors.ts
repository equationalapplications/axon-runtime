import type { RejectReason } from './schema.js';

export class RejectError extends Error {
  constructor(readonly reason: RejectReason, message: string) {
    super(message);
    this.name = 'RejectError';
  }
}

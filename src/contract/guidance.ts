import type { GuidanceItem } from './schema.js';

/** The line that closes the rendered guidance block. Item text must never contain it. */
export const GUIDANCE_END_LINE = '=== End of standing guidance ===';

/** Single source of truth for the guidance cap default (deploy.ts schema + CLI warning). */
export const DEFAULT_MAX_GUIDANCE_BYTES = 3072;

/** Raw UTF-8 bytes of labels + texts (no rendering overhead) — the number the cap is measured against. */
export function guidanceBytes(items: GuidanceItem[]): number {
  return items.reduce(
    (n, it) => n + Buffer.byteLength(it.label ?? '', 'utf8') + Buffer.byteLength(it.text, 'utf8'),
    0,
  );
}

/** Renders guidance for the worker prompt; returns '' when absent or empty (caller then renders nothing). */
export function renderGuidance(items: GuidanceItem[] | undefined): string {
  if (!items || items.length === 0) return '';
  const lines = ['Standing guidance (verbatim, from the dispatcher):'];
  for (const it of items) {
    lines.push(it.label !== undefined ? `- [${it.label}] ${it.text}` : `- ${it.text}`);
  }
  lines.push(GUIDANCE_END_LINE);
  return lines.join('\n');
}

/**
 * Validator-level guidance rules shared by the worker and the client CLI.
 * Returns a specific error message on the first violation, or null when clean.
 */
export function validateGuidanceItems(items: GuidanceItem[], capBytes: number): string | null {
  for (const [i, it] of items.entries()) {
    const where = it.label !== undefined ? `guidance item ${i} ("${it.label}")` : `guidance item ${i}`;
    if (it.text.includes(GUIDANCE_END_LINE)) {
      return `${where}: text must not contain the closing-delimiter line "${GUIDANCE_END_LINE}"`;
    }
    if (it.text.split('\n').some((line) => line.startsWith('- '))) {
      return `${where}: no text line may begin with "- " (it would forge a guidance item boundary)`;
    }
  }
  const bytes = guidanceBytes(items);
  if (bytes > capBytes) {
    return `guidance exceeds ${capBytes} bytes (${bytes} bytes of raw label+text)`;
  }
  return null;
}

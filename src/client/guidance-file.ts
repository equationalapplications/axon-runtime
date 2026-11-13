import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { guidanceBytes, validateGuidanceItems } from '../contract/guidance.js';
import { GuidanceItemSchema, type GuidanceItem } from '../contract/schema.js';

/**
 * Client-side pre-flight for `dispatch --guidance-file`: reads and validates
 * the guidance file BEFORE any network call, raising a clear, named error that
 * spells out every content rule (including the no-leading-"- " and
 * closing-delimiter rules). Warns when the file exceeds the 3,072-byte default
 * cap — the node's own max_guidance_bytes has the final say at submit time.
 */
export function loadGuidanceFile(path: string): GuidanceItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`axon: --guidance-file ${path} is not readable JSON: ${(err as Error).message}`);
  }
  const parsed = z.array(GuidanceItemSchema).safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? 'invalid payload';
    throw new Error(
      `axon: --guidance-file ${path} is not a valid guidance file. ` +
        'Expected an array of items shaped { label?, text } where label is a non-empty ' +
        'single-line string and text is non-empty, not whitespace-only, and multi-line is allowed. ' +
        `Content rules: no text line may begin with "- " and no text may contain the ` +
        `closing-delimiter line "=== End of standing guidance ===". ` +
        `First schema error: ${detail}`,
    );
  }
  const ruleError = validateGuidanceItems(parsed.data, Number.POSITIVE_INFINITY);
  if (ruleError !== null) throw new Error(`axon: --guidance-file ${path}: ${ruleError}`);
  const bytes = guidanceBytes(parsed.data);
  if (bytes > 3072) {
    console.warn(`axon: warning: guidance in ${path} is ${bytes} bytes, over the 3072-byte default cap; ` +
      'submit will be rejected unless the node raised max_guidance_bytes');
  }
  return parsed.data;
}

import type { z } from 'zod';
import { InvalidModelOutputError } from '../core/errors.js';

/**
 * Extracts a JSON object from model output. Tolerates code fences and short
 * preambles (common with local models) but never guesses beyond the outermost
 * balanced object.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to balanced-brace extraction.
  }
  const start = candidate.indexOf('{');
  if (start === -1) throw new InvalidModelOutputError('model output contains no JSON object');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch (error) {
          throw new InvalidModelOutputError(`model output JSON is malformed: ${(error as Error).message}`);
        }
      }
    }
  }
  throw new InvalidModelOutputError('model output JSON object is not closed');
}

/** Parses and validates model output against a Zod schema. */
export function parseModelJson<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  const raw = extractJsonObject(text);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InvalidModelOutputError(`model output failed schema validation: ${issues}`);
  }
  return result.data;
}

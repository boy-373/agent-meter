import type { TokenUsage } from './types.js';

/**
 * Pull real token usage out of a provider response.
 *
 * Every provider puts the counts somewhere slightly different with slightly
 * different names. Rather than make callers normalise by hand — and get it
 * wrong for the one provider they rarely use — `extractUsage` tries each known
 * shape and returns the first that yields both an input and an output count.
 *
 * One semantic detail drives the whole design: `TokenUsage.inputTokens` is the
 * **uncached** input. `computeCost` prices input, cache-read and cache-write
 * separately and sums them, so providers that report a single `prompt_tokens`
 * total (OpenAI, Gemini, most Chinese OpenAI-compatible endpoints) have the
 * cached portion subtracted here. Anthropic already separates them, so its
 * numbers map across unchanged.
 */

type Bag = Record<string, unknown>;

function isBag(v: unknown): v is Bag {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function at(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isBag(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/** `total - part`, floored at 0 — guards against providers that report nonsense. */
function subtract(total: number | undefined, part: number | undefined): number | undefined {
  if (total === undefined) return undefined;
  if (part === undefined) return total;
  return Math.max(0, total - part);
}

interface Reader {
  readonly shape: string;
  read(u: Bag): TokenUsage | undefined;
}

/**
 * Order matters only for shapes that could both match. `deepseek` is checked
 * before `openai` because DeepSeek responses carry both `prompt_tokens` and the
 * cache-hit/miss split; the split is strictly more informative.
 */
const READERS: readonly Reader[] = [
  {
    shape: 'anthropic',
    read(u) {
      const input = num(u['input_tokens']);
      const output = num(u['output_tokens']);
      if (input === undefined || output === undefined) return undefined;
      const usage: TokenUsage = { inputTokens: input, outputTokens: output };
      const cacheRead = num(u['cache_read_input_tokens']);
      const cacheWrite = num(u['cache_creation_input_tokens']);
      if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
      if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
      return usage;
    },
  },
  {
    shape: 'deepseek',
    read(u) {
      const hit = num(u['prompt_cache_hit_tokens']);
      const miss = num(u['prompt_cache_miss_tokens']);
      const output = num(u['completion_tokens']);
      if (output === undefined) return undefined;
      if (hit === undefined && miss === undefined) return undefined;
      const input = miss ?? subtract(num(u['prompt_tokens']), hit);
      if (input === undefined) return undefined;
      const usage: TokenUsage = { inputTokens: input, outputTokens: output };
      if (hit !== undefined) usage.cacheReadTokens = hit;
      return usage;
    },
  },
  {
    shape: 'openai',
    read(u) {
      const prompt = num(u['prompt_tokens']);
      const completion = num(u['completion_tokens']);
      if (prompt === undefined || completion === undefined) return undefined;
      const details = u['prompt_tokens_details'];
      const cached =
        (isBag(details) ? num(details['cached_tokens']) : undefined) ?? num(u['cached_tokens']);
      const input = subtract(prompt, cached) ?? prompt;
      const usage: TokenUsage = { inputTokens: input, outputTokens: completion };
      if (cached !== undefined) usage.cacheReadTokens = cached;
      return usage;
    },
  },
  {
    shape: 'gemini',
    read(u) {
      const prompt = num(u['promptTokenCount']);
      const candidates = num(u['candidatesTokenCount']);
      if (prompt === undefined || candidates === undefined) return undefined;
      const cached = num(u['cachedContentTokenCount']);
      const input = subtract(prompt, cached) ?? prompt;
      const usage: TokenUsage = { inputTokens: input, outputTokens: candidates };
      if (cached !== undefined) usage.cacheReadTokens = cached;
      return usage;
    },
  },
  {
    shape: 'ollama',
    read(u) {
      const input = num(u['prompt_eval_count']);
      const output = num(u['eval_count']);
      if (input === undefined || output === undefined) return undefined;
      return { inputTokens: input, outputTokens: output };
    },
  },
];

/** Where a usage object tends to live, most specific first. */
const CONTAINER_PATHS: readonly (readonly string[])[] = [
  ['usage'],
  ['usageMetadata'],
  ['output', 'usage'],
  ['response', 'usage'],
  ['data', 'usage'],
  ['result', 'usage'],
  ['meta', 'usage'],
  ['meta', 'tokens'],
];

export interface ExtractedUsage {
  usage: TokenUsage;
  /** Reader that matched, e.g. "openai". Useful in logs. */
  shape: string;
  /** Dotted path to the object that matched, or "(root)". */
  path: string;
}

/**
 * Like `extractUsage` but also reports which shape matched and where — handy
 * when a provider changes its response and the numbers quietly go to zero.
 */
export function extractUsageWithProvenance(payload: unknown): ExtractedUsage | undefined {
  // A batch response: the interesting counts are on the last element.
  if (Array.isArray(payload)) {
    for (let i = payload.length - 1; i >= 0; i -= 1) {
      const hit = extractUsageWithProvenance(payload[i]);
      if (hit) return hit;
    }
    return undefined;
  }

  for (const path of CONTAINER_PATHS) {
    const candidate = at(payload, path);
    if (!isBag(candidate)) continue;
    for (const reader of READERS) {
      const usage = reader.read(candidate);
      if (usage) return { usage, shape: reader.shape, path: path.join('.') };
    }
  }

  // Some callers pass the usage object itself rather than the whole response.
  if (isBag(payload)) {
    for (const reader of READERS) {
      const usage = reader.read(payload);
      if (usage) return { usage, shape: reader.shape, path: '(root)' };
    }
  }

  return undefined;
}

/**
 * Return normalised usage, or `undefined` when the payload carries none.
 *
 * Returning `undefined` rather than zeros is deliberate: a caller that cannot
 * measure a call should know it, not silently book a zero-cost event.
 */
export function extractUsage(payload: unknown): TokenUsage | undefined {
  return extractUsageWithProvenance(payload)?.usage;
}

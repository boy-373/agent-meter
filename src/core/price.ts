import type { CostBreakdown, MicroCny, ModelPrice, TokenUsage } from './types.js';

/** Denominator used by all per-MTok prices. */
const TOKENS_PER_MTOK = 1_000_000n;

/**
 * Multiply a token count by a per-MTok price and round half-up to whole micro-CNY.
 *
 * All arithmetic stays in BigInt so repeated pricing of the same usage is
 * bit-for-bit identical (the M1 exit criterion).
 */
export function priceTokens(tokens: number, perMTok: MicroCny): MicroCny {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
  if (perMTok === 0n) return 0n;
  const t = BigInt(Math.trunc(tokens));
  const num = t * perMTok;
  const q = num / TOKENS_PER_MTOK;
  const r = num % TOKENS_PER_MTOK;
  // Round half up on the absolute value, then re-apply the sign.
  const half = TOKENS_PER_MTOK / 2n;
  const rounded = r >= half ? q + 1n : q;
  return perMTok < 0n ? -rounded : rounded;
}

/** Compute a full cost breakdown for one usage against one price. */
export function computeCost(price: ModelPrice, usage: TokenUsage): CostBreakdown {
  const input = priceTokens(usage.inputTokens, price.inputPerMTok);
  const output = priceTokens(usage.outputTokens, price.outputPerMTok);
  const cacheRead = priceTokens(usage.cacheReadTokens ?? 0, price.cacheReadPerMTok ?? price.inputPerMTok);
  const cacheWrite = priceTokens(
    usage.cacheWriteTokens ?? 0,
    price.cacheWritePerMTok ?? price.inputPerMTok,
  );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * Normalise a model id for matching: lowercase, strip a leading provider
 * namespace ("openai/gpt-4o" -> "gpt-4o") and a trailing version suffix
 * introduced by "-v" or "@".
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const at = m.indexOf('@');
  if (at > 0) m = m.slice(0, at);
  return m;
}

/** Lookup result with the matched key, so callers can log provenance. */
export interface PriceMatch {
  price: ModelPrice;
  matchedKey: string;
  /** true when the match came from an exact id rather than a prefix. */
  exact: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertPrice(price: ModelPrice): void {
  if (!normalizeModelId(price.model)) {
    throw new TypeError('ModelPrice.model must be non-empty');
  }
  if (price.inputPerMTok < 0n || price.outputPerMTok < 0n) {
    throw new RangeError(`negative price for model "${price.model}"`);
  }
  if (price.cacheReadPerMTok !== undefined && price.cacheReadPerMTok < 0n) {
    throw new RangeError(`negative cacheReadPerMTok for model "${price.model}"`);
  }
  if (price.cacheWritePerMTok !== undefined && price.cacheWritePerMTok < 0n) {
    throw new RangeError(`negative cacheWritePerMTok for model "${price.model}"`);
  }
  if (!DATE_RE.test(price.updatedAt)) {
    throw new TypeError(`ModelPrice.updatedAt must be YYYY-MM-DD, got "${price.updatedAt}"`);
  }
  if (!price.source) {
    throw new TypeError(`ModelPrice.source is required for model "${price.model}"`);
  }
}

/**
 * A price table with longest-prefix matching and runtime overrides.
 *
 * Matching order:
 *   1. exact override id
 *   2. exact built-in id
 *   3. longest registered prefix of the requested id — overrides win at the
 *      same prefix length, so a contract rate for `qwen3.7-plus` also covers
 *      `qwen3.7-plus-2026-05-26`
 */
export class PriceTable {
  private readonly prices = new Map<string, ModelPrice>();
  private readonly overrides = new Map<string, ModelPrice>();
  /** Prefixes sorted by descending length so the first hit is the longest. */
  private prefixes: string[] = [];

  constructor(initial: readonly ModelPrice[] = []) {
    for (const p of initial) this.set(p);
  }

  /** Register or replace a price. */
  set(price: ModelPrice): this {
    assertPrice(price);
    const key = normalizeModelId(price.model);
    this.prices.set(key, { ...price, model: key });
    this.rebuildPrefixes();
    return this;
  }

  /** Register several prices at once. */
  setMany(list: readonly ModelPrice[]): this {
    for (const p of list) this.set(p);
    return this;
  }

  /**
   * Override a price at runtime without touching the built-in table.
   * Overrides are matched exactly (after normalisation) and win over built-ins.
   */
  setOverride(price: ModelPrice): this {
    assertPrice(price);
    const key = normalizeModelId(price.model);
    this.overrides.set(key, { ...price, model: key });
    this.rebuildPrefixes();
    return this;
  }

  /** Remove a runtime override. */
  clearOverride(model: string): boolean {
    const removed = this.overrides.delete(normalizeModelId(model));
    if (removed) this.rebuildPrefixes();
    return removed;
  }

  /** Rebuild the longest-first prefix list from built-ins and overrides. */
  private rebuildPrefixes(): void {
    const keys = new Set<string>([...this.prices.keys(), ...this.overrides.keys()]);
    this.prefixes = [...keys].sort((a, b) => b.length - a.length || a.localeCompare(b));
  }

  /** Number of registered built-in prices. */
  get size(): number {
    return this.prices.size;
  }

  /** All registered model ids (built-ins plus overrides). */
  models(): string[] {
    return [...new Set([...this.prices.keys(), ...this.overrides.keys()])].sort();
  }

  /** Resolve a price for a model id, or `undefined` when unknown. */
  match(model: string): PriceMatch | undefined {
    const key = normalizeModelId(model);
    if (!key) return undefined;

    const ov = this.overrides.get(key);
    if (ov) return { price: ov, matchedKey: key, exact: true };

    const exact = this.prices.get(key);
    if (exact) return { price: exact, matchedKey: key, exact: true };

    for (const prefix of this.prefixes) {
      if (!key.startsWith(prefix)) continue;
      const price = this.overrides.get(prefix) ?? this.prices.get(prefix);
      if (price) return { price, matchedKey: prefix, exact: false };
    }
    return undefined;
  }

  /** Price a usage, returning `undefined` when the model is unknown. */
  cost(model: string, usage: TokenUsage): (CostBreakdown & { matchedKey: string }) | undefined {
    const hit = this.match(model);
    if (!hit) return undefined;
    return { ...computeCost(hit.price, usage), matchedKey: hit.matchedKey };
  }

  /** Throw when any registered price looks stale relative to `now`. */
  stalePrices(now: Date, maxAgeDays = 90): ModelPrice[] {
    const cutoff = now.getTime() - maxAgeDays * 86_400_000;
    const stale: ModelPrice[] = [];
    for (const p of this.prices.values()) {
      const t = Date.parse(p.updatedAt);
      if (Number.isNaN(t) || t < cutoff) stale.push(p);
    }
    return stale;
  }
}

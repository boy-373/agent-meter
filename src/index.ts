import { evaluateBudget, evaluateWithFallback, isBlocking, type EvaluateResult, type UsedByScope } from './core/budget.js';
import { buildRecord, validateRecord, UsageRecordError, type BuildRecordInput } from './core/record.js';
import { extractUsageWithProvenance } from './core/usage.js';
import { PriceTable, computeCost } from './core/price.js';
import { ReservationEngine, type ReserveInput, type ReserveOutcome } from './core/reserve.js';
import { decisionFingerprint } from './core/fingerprint.js';
import type {
  BudgetPolicy,
  BudgetScope,
  CostBreakdown,
  MicroCny,
  ModelPrice,
  TokenUsage,
  UsageRecord,
} from './core/types.js';
import { toMicroCny, fromMicroCny, sumMicro } from './core/types.js';
import { MemoryStore } from './store/memory.js';
import { scopeWindow, type Query, type Store, type Summary } from './store/types.js';
import { BUILTIN_PRICES } from './data/model-prices.js';

export interface MeterOptions {
  /** Storage backend. Defaults to a fresh MemoryStore. */
  store?: Store;
  /** Price table, or a plain price list to build one from. Defaults to the built-in table. */
  prices?: PriceTable | readonly ModelPrice[];
  /** Static policies keyed by principal id. */
  policies?: Record<string, BudgetPolicy>;
  /** Dynamic policy resolver; wins over `policies`. */
  policyResolver?: (principalId: string) => BudgetPolicy | undefined;
  /** Clock override, for tests. */
  now?: () => number;
}

/** Options for `Meter.wrapCall`. */
export interface WrapCallOptions {
  /** Who pays. Required. */
  principalId: string;
  /** Task grouping, e.g. an agent run id. */
  taskId?: string;
  /** Record kind. Defaults to `"llm"`. */
  kind?: string;
  /** Model id used for pricing. Without it the record books zero cost. */
  model?: string;
  /**
   * How much to hold before the call. **Must be positive.**
   *
   * This is a hold, not a cap: if the real cost lands under it the difference is
   * released; if it lands over it, the call already happened and `wrapCall`
   * throws *after* writing the record. Give yourself headroom — an unused
   * estimate costs nothing, an insufficient one costs an exception.
   */
  estimate: MicroCny;
  /** Extra metadata copied onto the record. */
  meta?: Record<string, unknown>;
  /** Abort the call after this many milliseconds. */
  timeoutMs?: number;
  /** Called with the settled record, for logging. */
  onRecord?: (record: UsageRecord) => void;
}

/** What `Meter.wrapCall` hands back. */
export interface WrapCallResult<T> {
  /** Whatever `fn` returned, untouched. */
  result: T;
  /** The reservation that was held and then settled. */
  reservationId: string;
  /** Usage pulled from the response, when a known shape matched. */
  usage?: TokenUsage;
  /** The settled record. Always present — an unmeasurable call books zero. */
  record: UsageRecord;
}

/**
 * Facade over pricing, metering, budgeting and reservations.
 *
 * ```ts
 * const meter = new Meter({ policies: { 'user-1': policy } });
 * const { reservation } = await meter.reserve({ principalId: 'user-1', amount: toMicroCny('0.02'), taskId: 't1' });
 * const cost = meter.price('qwen-max', usage);
 * await meter.settle(reservation.id, cost, { principalId: 'user-1', kind: 'chat', model: 'qwen-max', usage });
 * ```
 */
export class Meter {
  readonly store: Store;
  readonly prices: PriceTable;
  private readonly policies: Record<string, BudgetPolicy>;
  private readonly policyResolver?: (principalId: string) => BudgetPolicy | undefined;
  private readonly engine: ReservationEngine;
  private readonly now: () => number;

  constructor(opts: MeterOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.prices =
      opts.prices instanceof PriceTable
        ? opts.prices
        : new PriceTable(opts.prices ?? BUILTIN_PRICES);
    this.policies = opts.policies ?? {};
    if (opts.policyResolver) this.policyResolver = opts.policyResolver;
    this.now = opts.now ?? (() => Date.now());
    this.engine = new ReservationEngine(this.store, (id) => this.policy(id));
  }

  /** Resolve the policy for a principal. */
  policy(principalId: string): BudgetPolicy | undefined {
    if (this.policyResolver) return this.policyResolver(principalId);
    return this.policies[principalId];
  }

  /** Register or replace a policy at runtime. */
  setPolicy(policy: BudgetPolicy): void {
    this.policies[policy.principalId] = policy;
  }

  /** Price a token usage. Throws when the model is unknown. */
  price(model: string, usage: TokenUsage): CostBreakdown {
    const hit = this.prices.match(model);
    if (!hit) {
      throw new Error(
        `unknown model "${model}"; register it with meter.prices.set({...}) or pass a provider-reported cost`,
      );
    }
    return computeCost(hit.price, usage);
  }

  /** Non-throwing price lookup. */
  tryPrice(model: string, usage: TokenUsage): CostBreakdown | undefined {
    const hit = this.prices.match(model);
    if (!hit) return undefined;
    return computeCost(hit.price, usage);
  }

  /** Pure budget check, no reservation. */
  async check(input: ReserveInput): Promise<EvaluateResult> {
    return this.engine.check(input);
  }

  /** Reserve before a call. Throws on deny / approval-required. */
  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    return this.engine.reserve(input);
  }

  /**
   * Settle a reservation with the actual cost and persist the usage record.
   * `recordInput` is optional; when omitted only the reservation is settled.
   */
  async settle(
    reservationId: string,
    actualCost: MicroCny | { cost: MicroCny; record?: UsageRecord },
    recordInput?: Omit<BuildRecordInput, 'cost'>,
  ): Promise<UsageRecord | undefined> {
    // Two accepted shapes, because the object form reads better at call sites:
    //   settle(id, cost, recordInput?)          — positional
    //   settle(id, { cost, record })            — object
    let cost: MicroCny;
    let record: UsageRecord | undefined;
    if (typeof actualCost === 'object' && actualCost !== null) {
      cost = actualCost.cost;
      record = actualCost.record;
    } else {
      cost = actualCost;
      if (recordInput) record = buildRecord({ ...recordInput, cost });
    }
    await this.engine.settle(reservationId, {
      cost,
      ...(record ? { record } : {}),
    });
    return record;
  }

  /** Release a reservation without spending. */
  async release(reservationId: string): Promise<void> {
    await this.engine.release(reservationId);
  }

  /** Record a completed usage event directly, without a reservation. */
  /**
   * Write a usage record. When `model` and `usage` are supplied and no cost is
   * given, the built-in price table fills it in — so the common path is one call.
   */
  async record(input: BuildRecordInput): Promise<UsageRecord> {
    let { cost, breakdown } = input;
    if (cost === undefined && breakdown === undefined && input.model && input.usage) {
      const priced = this.tryPrice(input.model, input.usage);
      if (priced) {
        breakdown = priced;
        cost = priced.total;
      }
    }
    const record = buildRecord({
      ...input,
      ...(cost !== undefined ? { cost } : {}),
      ...(breakdown !== undefined ? { breakdown } : {}),
    });
    await this.store.record(record);
    return record;
  }

  /** Persist an externally built record after validation. */
  async recordRaw(record: UsageRecord): Promise<void> {
    validateRecord(record);
    await this.store.record(record);
  }

  /** Consumed amount for a principal in a scope window. */
  async used(principalId: string, scope: BudgetScope, opts: { taskId?: string } = {}): Promise<MicroCny> {
    const w = scopeWindow(scope, { now: this.now(), ...(opts.taskId ? { taskId: opts.taskId } : {}) });
    return this.store.used(principalId, w);
  }

  /** Consumed + held amount per scope, suitable for `evaluateBudget`. */
  async snapshot(principalId: string, taskId?: string): Promise<UsedByScope> {
    return this.engine.snapshot(principalId, taskId, this.now());
  }

  /** Re-evaluate a policy against current usage (for dashboards). */
  async evaluate(principalId: string, requested: MicroCny = 0n, taskId?: string): Promise<EvaluateResult> {
    const policy = this.policy(principalId);
    const at = this.now();
    const used = await this.engine.snapshot(principalId, taskId, at);
    return evaluateWithFallback(
      () => evaluateBudget({ policy, used, requested, at }),
      policy,
      at,
    );
  }

  /** Query stored records. */
  async query(filter: Query): Promise<UsageRecord[]> {
    return this.store.query(filter);
  }

  /** Aggregate stored records. */
  async summary(filter: Query): Promise<Summary> {
    return this.store.summary(filter);
  }

  /**
   * Reserve → call → extract usage → price → settle, in one call.
   *
   * ```ts
   * const { result, record } = await meter.wrapCall(
   *   (signal) => client.chat.completions.create({ model: 'qwen3.7-plus', messages }, { signal }),
   *   {
   *     principalId: 'user_42',
   *     taskId: 'task_abc',
   *     model: 'qwen3.7-plus',
   *     estimate: toMicroCny('0.20'),
   *   },
   * );
   * ```
   *
   * The call never happens if the budget denies the hold — that is the point.
   * If `fn` throws, the hold is released. If the response carries no recognisable
   * usage, the call is booked at zero cost with `meta.usageMissing` so the gap is
   * visible in the audit trail instead of silently absent.
   */
  async wrapCall<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options: WrapCallOptions,
  ): Promise<WrapCallResult<T>> {
    const { principalId, taskId, kind = 'llm', model, estimate, meta, timeoutMs, onRecord } = options;
    if (!principalId) throw new Error('wrapCall: principalId is required');
    if (estimate <= 0n) {
      throw new Error(
        'wrapCall: estimate must be a positive MicroCny — a zero hold is denied once the budget is used up',
      );
    }

    const { reservation } = await this.reserve({
      principalId,
      amount: estimate,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    if (!reservation) throw new Error('wrapCall: reserve returned no reservation');

    const controller = new AbortController();
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(
            () => controller.abort(new Error(`wrapCall: timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        : undefined;

    const startedAt = this.now();
    let result: T;
    try {
      result = await fn(controller.signal);
    } catch (err) {
      // Nothing billable happened — hand the hold back.
      await this.release(reservation.id);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const endedAt = this.now();

    const extracted = extractUsageWithProvenance(result);
    const usage = extracted?.usage;

    let record: UsageRecord;
    if (extracted) {
      const breakdown = model ? this.tryPrice(model, extracted.usage) : undefined;
      record = buildRecord({
        principalId,
        kind,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(model !== undefined ? { model } : {}),
        usage: extracted.usage,
        cost: breakdown?.total ?? 0n,
        startedAt,
        endedAt,
        meta: {
          ...meta,
          usageShape: extracted.shape,
          usagePath: extracted.path,
          ...(breakdown ? {} : { unpriced: true }),
        },
      });
    } else {
      record = buildRecord({
        principalId,
        kind,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(model !== undefined ? { model } : {}),
        cost: 0n,
        startedAt,
        endedAt,
        meta: { ...meta, usageMissing: true },
      });
    }

    try {
      await this.settle(reservation.id, { cost: record.cost, record });
    } catch (err) {
      // Real cost exceeded the hold. `settle` validates before it writes, so
      // nothing reached the store yet — but the spend is real, so keep the
      // record and free the hold.
      await this.release(reservation.id);
      await this.recordRaw(record);
      const wrapped = new Error(
        `wrapCall: actual cost ${record.cost} exceeds the ${estimate} hold on ${reservation.id}. ` +
          'The usage record was written; raise the estimate.',
      ) as Error & { cause?: unknown; record?: UsageRecord };
      wrapped.cause = err;
      wrapped.record = record;
      throw wrapped;
    }

    onRecord?.(record);
    return {
      result,
      reservationId: reservation.id,
      usage,
      record,
    };
  }

  /** Flush buffered stores. */
  async close(): Promise<void> {
    await this.store.close?.();
  }
}

// Re-export the public surface.
export {
  PriceTable,
  computeCost,
  priceTokens,
  normalizeModelId,
} from './core/price.js';
export type { PriceMatch } from './core/price.js';
export {
  evaluateBudget,
  evaluateWithFallback,
  isBlocking,
  DEFAULT_WARN_RATIO,
} from './core/budget.js';
export type { EvaluateInput, EvaluateResult, UsedByScope } from './core/budget.js';
export { buildRecord, validateRecord, UsageRecordError, randomRecordId } from './core/record.js';
export type { BuildRecordInput } from './core/record.js';
export { extractUsage, extractUsageWithProvenance } from './core/usage.js';
export type { ExtractedUsage } from './core/usage.js';
export {
  ReservationEngine,
  BudgetDeniedError,
  ApprovalRequiredError,
} from './core/reserve.js';
export type { ReserveInput, ReserveOutcome } from './core/reserve.js';
export {
  canonicalJson,
  decisionFingerprint,
  policySnapshot,
  usedSnapshot,
  shortHash,
} from './core/fingerprint.js';
export type { FingerprintInput } from './core/fingerprint.js';
export { toMicroCny, fromMicroCny, sumMicro, MICRO_PER_CNY } from './core/types.js';
export type {
  BudgetAction,
  BudgetLimit,
  BudgetPolicy,
  BudgetScope,
  CostBreakdown,
  Decision,
  DecisionVerdict,
  MicroCny,
  ModelPrice,
  ReasonCode,
  Reservation,
  ReservationState,
  TokenUsage,
  UsageDelta,
  UsageRecord,
} from './core/types.js';

export { MemoryStore } from './store/memory.js';
export { JsonlStore } from './store/jsonl.js';
export type { JsonlStoreOptions } from './store/jsonl.js';
export { HttpStore } from './store/http.js';
export type { HttpStoreOptions } from './store/http.js';
export {
  scopeWindow,
  inWindow,
  matches,
  emptySummary,
  addToSummary,
} from './store/types.js';
export type { Query, ScopeWindow, Store, Summary } from './store/types.js';

export { BUILTIN_PRICES, PRICE_TABLE_VERSION, PRICE_TABLE_UPDATED_AT } from './data/model-prices.js';

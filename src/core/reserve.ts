import { evaluateBudget, type EvaluateResult, type UsedByScope } from './budget.js';
import { buildRecord } from './record.js';
import { shortHash } from './fingerprint.js';
import type { BudgetPolicy, BudgetScope, MicroCny, Reservation, UsageRecord } from './types.js';
import type { Store } from '../store/types.js';
import { scopeWindow } from '../store/types.js';

/** Error raised when a reservation cannot be granted. */
export class BudgetDeniedError extends Error {
  readonly decision: EvaluateResult;
  constructor(decision: EvaluateResult) {
    super(`budget denied: ${decision.reasonCode} — ${decision.reasons.join('; ')}`);
    this.name = 'BudgetDeniedError';
    this.decision = decision;
  }
}

/** Error raised when the policy asks for human approval. */
export class ApprovalRequiredError extends Error {
  readonly decision: EvaluateResult;
  constructor(decision: EvaluateResult) {
    super(`approval required: ${decision.reasons.join('; ')}`);
    this.name = 'ApprovalRequiredError';
    this.decision = decision;
  }
}

/** Simple promise-chain mutex to keep reserve/settle atomic in-process. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface ReserveInput {
  principalId: string;
  /** Estimated cost to hold. */
  amount: MicroCny;
  taskId?: string;
  /** Model the caller intends to use, used for the fingerprint and downshift. */
  model?: string;
  /** Override the policy; otherwise the meter's registered policy is used. */
  policy?: BudgetPolicy;
  /** Epoch ms override. */
  at?: number;
}

export interface ReserveOutcome {
  /** Granted reservation, when verdict was allow. */
  reservation?: Reservation;
  decision: EvaluateResult;
}

/**
 * Reserve → settle → release engine.
 *
 * Concurrency: `reserve` computes used + held inside a mutex, so N parallel
 * reservations against the same principal cannot collectively exceed the limit
 * (the M3 exit criterion).
 */
export class ReservationEngine {
  private readonly store: Store;
  private readonly mutex = new Mutex();
  private readonly policyFor: (principalId: string) => BudgetPolicy | undefined;

  constructor(store: Store, policyFor: (principalId: string) => BudgetPolicy | undefined) {
    this.store = store;
    this.policyFor = policyFor;
  }

  /** Read used + held per scope for a principal. */
  async snapshot(principalId: string, taskId: string | undefined, now: number): Promise<UsedByScope> {
    const scopes: BudgetScope[] = ['task', 'daily', 'monthly', 'total'];
    const out: Partial<Record<BudgetScope, MicroCny>> = {};
    for (const scope of scopes) {
      if (scope === 'task' && !taskId) continue;
      const w = scopeWindow(scope, { now, ...(taskId ? { taskId } : {}) });
      const [used, held] = await Promise.all([
        this.store.used(principalId, w),
        this.store.held(principalId, w),
      ]);
      out[scope] = used + held;
    }
    return out;
  }

  /** Pure pre-check: no reservation is created. */
  async check(input: ReserveInput): Promise<EvaluateResult> {
    const at = input.at ?? Date.now();
    const policy = input.policy ?? this.policyFor(input.principalId);
    const used = await this.snapshot(input.principalId, input.taskId, at);
    return evaluateBudget({
      policy,
      used,
      requested: input.amount,
      ...(input.model !== undefined ? { model: input.model } : {}),
      at,
    });
  }

  /** Reserve an amount. Throws `BudgetDeniedError` / `ApprovalRequiredError`. */
  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    return this.mutex.run(async () => {
      const at = input.at ?? Date.now();
      const policy = input.policy ?? this.policyFor(input.principalId);
      const used = await this.snapshot(input.principalId, input.taskId, at);
      const decision = evaluateBudget({
        policy,
        used,
        requested: input.amount,
        ...(input.model !== undefined ? { model: input.model } : {}),
        at,
      });

      if (decision.verdict === 'deny') throw new BudgetDeniedError(decision);
      if (decision.verdict === 'require_approval') throw new ApprovalRequiredError(decision);

      const reservation: Reservation = {
        id: `rs_${shortHash(
          [input.principalId, input.taskId ?? '', input.amount.toString(), at, decision.fingerprint].join('|'),
          16,
        )}`,
        principalId: input.principalId,
        amount: input.amount,
        state: 'held',
        createdAt: at,
      };
      if (input.taskId !== undefined) reservation.taskId = input.taskId;
      const stored = await this.store.reserve(reservation);
      return { reservation: stored, decision };
    });
  }

  /**
   * Settle a reservation and, when a record is supplied, persist it.
   *
   * `actual` may be less than the reserved amount; the difference is released
   * implicitly because only settled reservations count toward `used`.
   */
  async settle(id: string, actual: { cost: MicroCny; record?: UsageRecord }): Promise<void> {
    await this.mutex.run(async () => {
      const held = await this.store.getReservation(id);
      if (!held) throw new Error(`settle: unknown reservation "${id}"`);
      if (held.state !== 'held') throw new Error(`settle: reservation "${id}" is ${held.state}`);
      if (actual.cost > held.amount) {
        throw new Error(
          `settle: actual cost ${actual.cost} exceeds reserved ${held.amount} for "${id}"`,
        );
      }
      await this.store.settle(id, { cost: actual.cost });
      // `used()` is derived from records, so a settle without an explicit
      // record still has to leave one behind — otherwise the spend would be
      // visible in `held()` but never in `used()`.
      const record =
        actual.record ??
        buildRecord({
          principalId: held.principalId,
          ...(held.taskId !== undefined ? { taskId: held.taskId } : {}),
          kind: 'unattributed',
          cost: actual.cost,
          startedAt: held.createdAt,
          endedAt: Date.now(),
          meta: { reservationId: id },
        });
      await this.store.record(record);
    });
  }

  /** Release a reservation without spending. */
  async release(id: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.store.release(id);
    });
  }
}

import type {
  BudgetScope,
  MicroCny,
  Reservation,
  UsageDelta,
  UsageRecord,
} from '../core/types.js';

/** Time window derived from a budget scope. */
export interface ScopeWindow {
  scope: BudgetScope;
  /** Inclusive start, epoch ms. 0 means "from the beginning". */
  from: number;
  /** Exclusive end, epoch ms. Number.MAX_SAFE_INTEGER means "no end". */
  to: number;
  /** Required when scope === "task". */
  taskId?: string;
}

/** Query filter shared by `query` and `summary`. */
export interface Query {
  principalId?: string;
  taskId?: string;
  kind?: string;
  model?: string;
  /** Inclusive epoch ms. */
  from?: number;
  /** Exclusive epoch ms. */
  to?: number;
  limit?: number;
}

/** Aggregated view of matching records. */
export interface Summary {
  count: number;
  cost: MicroCny;
  byModel: Record<string, { count: number; cost: MicroCny }>;
  byKind: Record<string, { count: number; cost: MicroCny }>;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Storage contract.
 *
 * Implementations must be safe for concurrent callers within one process.
 * Cross-process safety is implementation-defined.
 */
export interface Store {
  /** Persist one usage record. */
  record(r: UsageRecord): Promise<void>;

  /** Create or persist a reservation. Returns the stored copy. */
  reserve(r: Reservation): Promise<Reservation>;

  /** Mark a reservation settled with the actual amount. */
  settle(id: string, actual: UsageDelta): Promise<void>;

  /** Release a reservation without spending. */
  release(id: string): Promise<void>;

  /** Fetch one reservation. */
  getReservation(id: string): Promise<Reservation | undefined>;

  /** Amount already consumed for a principal in a window. */
  used(principalId: string, window: ScopeWindow): Promise<MicroCny>;

  /** Amount currently held by open reservations for a principal in a window. */
  held(principalId: string, window: ScopeWindow): Promise<MicroCny>;

  /** Matching records, newest first. */
  query(filter: Query): Promise<UsageRecord[]>;

  /** Aggregate matching records. */
  summary(filter: Query): Promise<Summary>;

  /** Optional flush hook for buffered stores. */
  close?(): Promise<void>;
}

/** Build the time window for a scope. */
export function scopeWindow(
  scope: BudgetScope,
  opts: { now?: number; taskId?: string } = {},
): ScopeWindow {
  const now = opts.now ?? Date.now();
  switch (scope) {
    case 'task': {
      if (!opts.taskId) throw new TypeError('scopeWindow: taskId is required for scope "task"');
      return { scope, from: 0, to: Number.MAX_SAFE_INTEGER, taskId: opts.taskId };
    }
    case 'daily': {
      const d = new Date(now);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return { scope, from: start, to: start + 86_400_000 };
    }
    case 'monthly': {
      const d = new Date(now);
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      return { scope, from: start, to: end };
    }
    case 'total':
    default:
      return { scope: 'total', from: 0, to: Number.MAX_SAFE_INTEGER };
  }
}

/** Does a record fall inside a window? */
export function inWindow(r: UsageRecord, w: ScopeWindow): boolean {
  if (w.taskId !== undefined && r.taskId !== w.taskId) return false;
  const t = r.endedAt || r.startedAt;
  return t >= w.from && t < w.to;
}

/** Empty summary. */
export function emptySummary(): Summary {
  return { count: 0, cost: 0n, byModel: {}, byKind: {}, inputTokens: 0, outputTokens: 0 };
}

/** Fold a record into a summary accumulator. */
export function addToSummary(s: Summary, r: UsageRecord): void {
  s.count += 1;
  s.cost += r.cost;
  const model = r.model ?? '(none)';
  const m = s.byModel[model] ?? { count: 0, cost: 0n };
  m.count += 1;
  m.cost += r.cost;
  s.byModel[model] = m;
  const kind = r.kind || '(none)';
  const k = s.byKind[kind] ?? { count: 0, cost: 0n };
  k.count += 1;
  k.cost += r.cost;
  s.byKind[kind] = k;
  s.inputTokens += r.usage?.inputTokens ?? 0;
  s.outputTokens += r.usage?.outputTokens ?? 0;
}

/** Does a record match a query filter? */
export function matches(r: UsageRecord, f: Query): boolean {
  if (f.principalId !== undefined && r.principalId !== f.principalId) return false;
  if (f.taskId !== undefined && r.taskId !== f.taskId) return false;
  if (f.kind !== undefined && r.kind !== f.kind) return false;
  if (f.model !== undefined && r.model !== f.model) return false;
  const t = r.endedAt || r.startedAt;
  if (f.from !== undefined && t < f.from) return false;
  if (f.to !== undefined && t >= f.to) return false;
  return true;
}

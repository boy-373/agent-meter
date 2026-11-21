/**
 * Core type definitions for @pianam/agent-meter.
 *
 * Design rules:
 *  - Amounts are integer micro-CNY (1e-6 CNY). Never floats.
 *  - The kernel knows nothing about "points", "credits", or brand names.
 *  - The kernel does no authentication and no fund settlement.
 */

/** Integer micro-CNY. 1_000_000n === 1 CNY. */
export type MicroCny = bigint;

/** Money helpers. */
export const MICRO_PER_CNY = 1_000_000n;

/** Convert a decimal CNY string/number to micro-CNY (round half up). */
export function toMicroCny(value: string | number | bigint): MicroCny {
  if (typeof value === 'bigint') return value * MICRO_PER_CNY;
  const s = typeof value === 'number' ? value.toFixed(6) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) throw new TypeError(`invalid money value: ${String(value)}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = BigInt(m[2] as string);
  const fracRaw = (m[3] ?? '').padEnd(12, '0');
  const frac = BigInt(fracRaw);
  const scale = 10n ** 12n;
  // micro = (int * 1e6) + round(frac / 1e6)
  const base = intPart * MICRO_PER_CNY;
  const fracMicro = (frac + scale / (MICRO_PER_CNY * 2n)) / (scale / MICRO_PER_CNY);
  return sign * (base + fracMicro);
}

/** Render micro-CNY as a plain decimal CNY string. */
export function fromMicroCny(micro: MicroCny): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const intPart = abs / MICRO_PER_CNY;
  const fracPart = abs % MICRO_PER_CNY;
  const frac = fracPart.toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

/** Sum helper that never overflows into float. */
export function sumMicro(values: Iterable<MicroCny>): MicroCny {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

/**
 * Price for a single model, expressed in micro-CNY per million tokens.
 *
 * `source` and `updatedAt` are mandatory: an out-of-date price is a correctness
 * bug, so callers must be able to detect staleness.
 */
export interface ModelPrice {
  /** Canonical model id, e.g. "qwen-max", "deepseek-chat". */
  model: string;
  /** micro-CNY per 1M input tokens. */
  inputPerMTok: MicroCny;
  /** micro-CNY per 1M output tokens. */
  outputPerMTok: MicroCny;
  /** micro-CNY per 1M cache-read tokens. Defaults to input price when absent. */
  cacheReadPerMTok?: MicroCny;
  /** micro-CNY per 1M cache-write tokens. Defaults to input price when absent. */
  cacheWritePerMTok?: MicroCny;
  /** ISO date (YYYY-MM-DD) the price was last verified. */
  updatedAt: string;
  /** Where the price came from, e.g. "dashscope-public-price". */
  source: string;
  /** Optional free-form note. */
  note?: string;
}

/** Token usage as reported by a provider. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost breakdown in micro-CNY. */
export interface CostBreakdown {
  input: MicroCny;
  output: MicroCny;
  cacheRead: MicroCny;
  cacheWrite: MicroCny;
  total: MicroCny;
}

// ---------------------------------------------------------------------------
// Usage records
// ---------------------------------------------------------------------------

/** A single billable event. */
export interface UsageRecord {
  /** Stable unique id for this record. */
  id: string;
  /** Who caused the spend: user id, agent id, tenant id — opaque to the kernel. */
  principalId: string;
  /** Free-form task grouping, e.g. an agent run id. */
  taskId?: string;
  /** What kind of work this was, e.g. "chat", "seo-scan". */
  kind: string;
  /** Model used, if any. */
  model?: string;
  /** Token usage, if the event was an LLM call. */
  usage?: TokenUsage;
  /** Non-token countable units (tool calls, API calls, pages, etc.). */
  units?: Record<string, number>;
  /** Final cost in micro-CNY. Real provider cost wins over local estimate. */
  cost: MicroCny;
  /** True when `cost` came from the provider rather than a local price table. */
  costIsAuthoritative?: boolean;
  /** Wall-clock start of the event, epoch milliseconds. */
  startedAt: number;
  /** Wall-clock end, epoch milliseconds. */
  endedAt: number;
  /** Extra structured metadata; must be JSON-serialisable. */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Budget window scopes. */
export type BudgetScope = 'task' | 'daily' | 'monthly' | 'total';

/** What happens when a limit is reached. */
/**
 * What to do when a limit is reached.
 *   warn      -> allow, flag it
 *   downshift -> allow, suggest a cheaper model
 *   approval  -> park the call for a human (require_approval)
 *   cutoff    -> deny
 */
export type BudgetAction = 'warn' | 'downshift' | 'cutoff' | 'approval';

/** One limit line. */
export interface BudgetLimit {
  scope: BudgetScope;
  /** Hard ceiling in micro-CNY. */
  limit: MicroCny;
  /** Ratio at which `warn` fires. Default 0.8. */
  warnRatio?: number;
  /** Action taken at 100%. Default "cutoff". */
  onExceed?: BudgetAction;
  /** Cheaper model to switch to when `downshift` fires. */
  downshiftModel?: string;
}

/** A complete policy for one principal. */
export interface BudgetPolicy {
  principalId: string;
  limits: BudgetLimit[];
  /** When true, decisions are recorded but never enforced. */
  shadow?: boolean;
  /** Behaviour when the policy cannot be evaluated. Default "fail_closed". */
  onEvalError?: 'fail_closed' | 'fail_open';
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Three-state decision. */
export type DecisionVerdict = 'allow' | 'require_approval' | 'deny';

/** Stable machine-readable reason codes. */
export type ReasonCode =
  | 'ok'
  | 'shadow_allow'
  | 'warn_threshold'
  | 'limit_reached'
  | 'reservation_exceeds_limit'
  | 'approval_required'
  | 'policy_missing'
  | 'policy_eval_error'
  | 'principal_blocked';

/** A decision with a replayable fingerprint. */
export interface Decision {
  verdict: DecisionVerdict;
  reasonCode: ReasonCode;
  reasons: string[];
  /** sha256 over (principalId, policySnapshot, usedSnapshot, requested, timestamp). */
  fingerprint: string;
  /** Budget lines that triggered the decision. */
  triggered: BudgetLimit[];
  /** Suggested model when verdict is allow via downshift. */
  downshiftTo?: string;
  /** Epoch ms. */
  at: number;
}

/** Reservation lifecycle states. */
export type ReservationState = 'held' | 'settled' | 'released';

/** A pre-authorised spend. */
export interface Reservation {
  id: string;
  principalId: string;
  taskId?: string;
  /** Amount held. */
  amount: MicroCny;
  state: ReservationState;
  createdAt: number;
  /** Actual amount settled, when state === "settled". */
  settledAmount?: MicroCny;
  settledAt?: number;
}

/** A usage delta applied at settlement. */
export interface UsageDelta {
  cost: MicroCny;
  usage?: TokenUsage;
  units?: Record<string, number>;
}

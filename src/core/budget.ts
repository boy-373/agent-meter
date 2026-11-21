import { decisionFingerprint, policySnapshot, usedSnapshot } from './fingerprint.js';
import type {
  BudgetAction,
  BudgetLimit,
  BudgetPolicy,
  BudgetScope,
  Decision,
  MicroCny,
  ReasonCode,
} from './types.js';

/** Default warn threshold. */
export const DEFAULT_WARN_RATIO = 0.8;

/** Ratio as an integer percentage basis (0..n), computed without floats. */
function ratioBp(used: MicroCny, limit: MicroCny): number {
  if (limit <= 0n) return used > 0n ? 10_000 : 0;
  if (used <= 0n) return 0;
  const bp = (used * 10_000n) / limit;
  return bp > 100_000n ? 100_000 : Number(bp);
}

function warnBp(limit: BudgetLimit): number {
  const r = limit.warnRatio ?? DEFAULT_WARN_RATIO;
  if (!Number.isFinite(r) || r <= 0) return 0;
  if (r >= 1) return 10_000;
  return Math.round(r * 10_000);
}

/** Used amounts keyed by scope. */
export type UsedByScope = Readonly<Partial<Record<BudgetScope, MicroCny>>>;

/** Input for a budget evaluation. */
export interface EvaluateInput {
  policy: BudgetPolicy | undefined;
  /** Already-consumed amounts per scope. */
  used: UsedByScope;
  /** Amount about to be spent; 0 for a pure pre-check. */
  requested?: MicroCny;
  /** Model the caller intends to use. */
  model?: string;
  /** Epoch ms, defaults to Date.now(). */
  at?: number;
}

/** Result of a budget evaluation. */
export interface EvaluateResult extends Decision {
  /** Effective action for each triggered limit. */
  actions: BudgetAction[];
}

function emptyDecision(at: number, verdict: Decision['verdict'], reasonCode: ReasonCode, reasons: string[], fingerprint = ''): EvaluateResult {
  return { verdict, reasonCode, reasons, fingerprint, triggered: [], actions: [], at };
}

/**
 * Evaluate a budget policy against already-consumed amounts plus an optional
 * pending request.
 *
 * Precedence: deny > require_approval > downshift > warn > allow.
 * When `policy.shadow` is true the *effective* verdict is always `allow`, but
 * the original verdict is preserved in `reasons` and `triggered` for auditing.
 */
export function evaluateBudget(input: EvaluateInput): EvaluateResult {
  const at = input.at ?? Date.now();
  const requested = input.requested ?? 0n;
  const { policy } = input;

  if (!policy) {
    return emptyDecision(at, 'allow', 'policy_missing', ['no policy configured for principal'], '');
  }

  const limits = policy.limits ?? [];
  if (limits.length === 0) {
    return emptyDecision(at, 'allow', 'policy_missing', ['policy has no limits'], '');
  }

  const usedMap = new Map<string, MicroCny>();
  for (const scope of ['task', 'daily', 'monthly', 'total'] as BudgetScope[]) {
    const v = input.used[scope];
    if (v !== undefined) usedMap.set(scope, v);
  }

  const triggered: BudgetLimit[] = [];
  const reasons: string[] = [];
  const actions: BudgetAction[] = [];
  let verdict: Decision['verdict'] = 'allow';
  let reasonCode: ReasonCode = 'ok';
  let downshiftTo: string | undefined;

  for (const limit of limits) {
    const used = input.used[limit.scope] ?? 0n;
    const projected = used + requested;
    const bp = ratioBp(projected, limit.limit);
    const warn = warnBp(limit);
    const onExceed = limit.onExceed ?? 'cutoff';

    if (bp >= 10_000) {
      triggered.push(limit);
      const over = projected > limit.limit;
      reasons.push(
        `${limit.scope} budget ${over ? 'exceeded' : 'reached'}: projected ${projected} / limit ${limit.limit} micro-CNY`,
      );
      actions.push(onExceed);
      if (onExceed === 'cutoff') {
        verdict = 'deny';
        reasonCode = requested > 0n ? 'reservation_exceeds_limit' : 'limit_reached';
      } else if (onExceed === 'approval') {
        // A deny from another scope always wins over a park.
        if (verdict !== 'deny') {
          verdict = 'require_approval';
          reasonCode = 'approval_required';
        }
      } else if (onExceed === 'downshift') {
        if (verdict === 'allow') {
          verdict = 'allow';
          reasonCode = 'limit_reached';
          downshiftTo = limit.downshiftModel;
        }
      } else if (verdict === 'allow' && reasonCode === 'ok') {
        reasonCode = 'warn_threshold';
      }
    } else if (bp >= warn) {
      triggered.push(limit);
      reasons.push(
        `${limit.scope} budget at ${(bp / 100).toFixed(2)}% of limit ${limit.limit} micro-CNY`,
      );
      actions.push('warn');
      if (verdict === 'allow' && reasonCode === 'ok') reasonCode = 'warn_threshold';
    }
  }

  const fingerprint = decisionFingerprint({
    principalId: policy.principalId,
    policySnapshot: policySnapshot(limits),
    usedSnapshot: usedSnapshot(usedMap),
    requested,
    ...(input.model !== undefined ? { model: input.model } : {}),
    at,
  });

  const result: EvaluateResult = {
    verdict,
    reasonCode,
    reasons,
    fingerprint,
    triggered,
    actions,
    at,
    ...(downshiftTo !== undefined ? { downshiftTo } : {}),
  };

  if (policy.shadow && verdict !== 'allow') {
    return {
      ...result,
      verdict: 'allow',
      reasonCode: 'shadow_allow',
      reasons: [`[shadow] would have been "${verdict}" (${reasonCode})`, ...reasons],
    };
  }

  return result;
}

/**
 * Wrap an evaluation in fail-closed / fail-open semantics.
 * Used when the caller cannot build a reliable snapshot (e.g. store failure).
 */
export function evaluateWithFallback(
  evaluate: () => EvaluateResult,
  policy: BudgetPolicy | undefined,
  at: number,
): EvaluateResult {
  try {
    return evaluate();
  } catch (err) {
    const mode = policy?.onEvalError ?? 'fail_closed';
    const msg = err instanceof Error ? err.message : String(err);
    if (mode === 'fail_open') {
      return emptyDecision(at, 'allow', 'policy_eval_error', [`policy evaluation failed (fail_open): ${msg}`], '');
    }
    return emptyDecision(
      at,
      'deny',
      'policy_eval_error',
      [`policy evaluation failed (fail_closed): ${msg}`],
      '',
    );
  }
}

/** Convenience: is this verdict blocking? */
export function isBlocking(d: Decision): boolean {
  return d.verdict === 'deny' || d.verdict === 'require_approval';
}

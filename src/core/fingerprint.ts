import { createHash } from 'node:crypto';
import type { BudgetLimit, MicroCny } from './types.js';

/**
 * Deterministic JSON serialisation: object keys sorted, bigint rendered as a
 * decimal string, undefined dropped. Two structurally equal inputs always
 * produce byte-identical output, which is what makes fingerprints replayable.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'undefined':
        return 'null';
      case 'boolean':
        return v ? 'true' : 'false';
      case 'number':
        return Number.isFinite(v) ? String(v) : 'null';
      case 'bigint':
        return `"${v.toString()}"`;
      case 'string':
        return JSON.stringify(v);
      case 'function':
      case 'symbol':
        return 'null';
      default:
        break;
    }
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown> | unknown[];
      if (seen.has(obj)) throw new TypeError('canonicalJson: circular reference');
      seen.add(obj);
      try {
        if (Array.isArray(obj)) return `[${obj.map(walk).join(',')}]`;
        const keys = Object.keys(obj as Record<string, unknown>).sort();
        const parts: string[] = [];
        for (const k of keys) {
          const val = (obj as Record<string, unknown>)[k];
          if (val === undefined) continue;
          parts.push(`${JSON.stringify(k)}:${walk(val)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(obj);
      }
    }
    return 'null';
  };

  return walk(value);
}

/** Stable snapshot of a policy's limits, used inside fingerprints. */
export function policySnapshot(limits: readonly BudgetLimit[]): string[] {
  return [...limits]
    .map((l) =>
      canonicalJson({
        scope: l.scope,
        limit: l.limit.toString(),
        warnRatio: l.warnRatio ?? null,
        onExceed: l.onExceed ?? null,
        downshiftModel: l.downshiftModel ?? null,
      }),
    )
    .sort();
}

/** Snapshot of used amounts keyed by scope. */
export function usedSnapshot(used: ReadonlyMap<string, MicroCny>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...used.keys()].sort()) {
    out[key] = (used.get(key) ?? 0n).toString();
  }
  return out;
}

/** Inputs that together fully determine a decision. */
export interface FingerprintInput {
  principalId: string;
  /** Sorted canonical limit snapshots. */
  policySnapshot: string[];
  /** Used amount per scope, rendered as decimal strings. */
  usedSnapshot: Record<string, string>;
  /** Amount being requested (0 for a pure pre-check). */
  requested: MicroCny;
  /** Model the request intends to use. */
  model?: string;
  /** Epoch ms; decisions at different times may legitimately differ. */
  at: number;
}

/**
 * Compute the sha256 decision fingerprint.
 *
 * The same (principal, policy, used, requested, model, timestamp) always yields
 * the same hash, so an audit trail can be replayed exactly.
 */
export function decisionFingerprint(input: FingerprintInput): string {
  const payload = canonicalJson({
    v: 1,
    principalId: input.principalId,
    policy: input.policySnapshot,
    used: input.usedSnapshot,
    requested: input.requested.toString(),
    model: input.model ?? null,
    at: input.at,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Short hash helper for record ids. */
export function shortHash(input: string, length = 12): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length);
}

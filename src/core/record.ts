import { randomUUID } from 'node:crypto';
import { shortHash } from './fingerprint.js';
import type { CostBreakdown, MicroCny, TokenUsage, UsageRecord } from './types.js';

/** Input accepted by `buildRecord`. */
export interface BuildRecordInput {
  principalId: string;
  kind: string;
  /** Explicit id; generated when absent. */
  id?: string;
  taskId?: string;
  model?: string;
  usage?: TokenUsage;
  units?: Record<string, number>;
  /** Cost in micro-CNY. Either this or `breakdown` must be provided. */
  cost?: MicroCny;
  breakdown?: CostBreakdown;
  /** Set true when the cost came from the provider rather than a local table. */
  costIsAuthoritative?: boolean;
  startedAt?: number;
  endedAt?: number;
  meta?: Record<string, unknown>;
}

/** Validation failure with a machine-readable code. */
export class UsageRecordError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UsageRecordError';
    this.code = code;
  }
}

function assertNonNegative(name: string, v: bigint): void {
  if (v < 0n) throw new UsageRecordError('negative_cost', `${name} must be >= 0, got ${v}`);
}

function assertCount(name: string, v: number | undefined): void {
  if (v === undefined) return;
  if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new UsageRecordError('invalid_count', `${name} must be a non-negative integer, got ${String(v)}`);
  }
}

/**
 * Build a validated `UsageRecord`.
 *
 * Deterministic ids: when `id` is absent the id is derived from the event's
 * identity so replaying the same event twice produces the same id (dedupe-friendly)
 * unless `meta.nonce` is supplied.
 */
export function buildRecord(input: BuildRecordInput): UsageRecord {
  if (!input.principalId) throw new UsageRecordError('missing_principal', 'principalId is required');
  if (!input.kind) throw new UsageRecordError('missing_kind', 'kind is required');

  const startedAt = input.startedAt ?? Date.now();
  const endedAt = input.endedAt ?? startedAt;
  if (endedAt < startedAt) {
    throw new UsageRecordError('invalid_time', `endedAt (${endedAt}) precedes startedAt (${startedAt})`);
  }

  let cost: MicroCny;
  if (input.cost !== undefined) {
    cost = input.cost;
  } else if (input.breakdown !== undefined) {
    cost = input.breakdown.total;
  } else {
    throw new UsageRecordError('missing_cost', 'either cost or breakdown is required');
  }
  assertNonNegative('cost', cost);

  if (input.usage) {
    assertCount('usage.inputTokens', input.usage.inputTokens);
    assertCount('usage.outputTokens', input.usage.outputTokens);
    assertCount('usage.cacheReadTokens', input.usage.cacheReadTokens);
    assertCount('usage.cacheWriteTokens', input.usage.cacheWriteTokens);
  }

  const id =
    input.id ??
    `ur_${shortHash(
      [
        input.principalId,
        input.taskId ?? '',
        input.kind,
        input.model ?? '',
        startedAt,
        endedAt,
        cost.toString(),
        input.usage ? `${input.usage.inputTokens}:${input.usage.outputTokens}` : '',
        typeof input.meta?.['nonce'] === 'string' ? (input.meta['nonce'] as string) : '',
      ].join('|'),
      16,
    )}`;

  const record: UsageRecord = {
    id,
    principalId: input.principalId,
    kind: input.kind,
    cost,
    startedAt,
    endedAt,
  };
  if (input.taskId !== undefined) record.taskId = input.taskId;
  if (input.model !== undefined) record.model = input.model;
  if (input.usage !== undefined) record.usage = { ...input.usage };
  if (input.units !== undefined) record.units = { ...input.units };
  if (input.costIsAuthoritative !== undefined) record.costIsAuthoritative = input.costIsAuthoritative;
  if (input.meta !== undefined) record.meta = { ...input.meta };

  return record;
}

/** Random id generator, exported for callers that prefer non-deterministic ids. */
export function randomRecordId(): string {
  return `ur_${randomUUID().replace(/-/g, '')}`;
}

/** Validate an externally-produced record before storing it. */
export function validateRecord(r: UsageRecord): void {
  if (!r.id) throw new UsageRecordError('missing_id', 'record.id is required');
  if (!r.principalId) throw new UsageRecordError('missing_principal', 'record.principalId is required');
  if (!r.kind) throw new UsageRecordError('missing_kind', 'record.kind is required');
  assertNonNegative('record.cost', r.cost);
  if (!Number.isFinite(r.startedAt) || !Number.isFinite(r.endedAt)) {
    throw new UsageRecordError('invalid_time', 'startedAt and endedAt must be finite epoch ms');
  }
  if (r.endedAt < r.startedAt) {
    throw new UsageRecordError('invalid_time', `endedAt (${r.endedAt}) precedes startedAt (${r.startedAt})`);
  }
}

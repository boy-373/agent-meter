/**
 * Thin adapters. Zero runtime dependencies — Express, Fastify, Koa and plain
 * `node:http` all expose the handful of shapes used here, so nothing is
 * imported from a framework package.
 *
 * The adapter's whole job is: turn an HTTP request into a `ReserveInput`, run
 * the kernel, and map the verdict onto a response. It does not authenticate,
 * does not look up prices, does not know what a "credit" is.
 */

import type { BudgetPolicy, MicroCny } from '../core/types.js';
import { fromMicroCny } from '../core/types.js';
import type { ReserveInput } from '../core/reserve.js';
import { ApprovalRequiredError, BudgetDeniedError } from '../core/reserve.js';
import type { EvaluateResult } from '../core/budget.js';
import type { Meter } from '../index.js';

/** Minimal request shape (Express / Fastify / raw http all satisfy it). */
export interface HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
}

/** Minimal response shape. */
export interface HttpResponseLike {
  statusCode?: number;
  status?(code: number): unknown;
  setHeader?(name: string, value: string): unknown;
  json?(body: unknown): unknown;
  send?(body: unknown): unknown;
  end?(body?: unknown): unknown;
}

export interface AdapterOptions {
  /** Derive the principal from the request. Return `undefined` to reject. */
  principalFrom: (req: HttpRequestLike) => string | undefined;
  /** Derive the task id from the request, if the caller scopes by task. */
  taskFrom?: (req: HttpRequestLike) => string | undefined;
  /** Requested amount in `micro_cny`. */
  amountFrom?: (req: HttpRequestLike) => MicroCny;
  /** Model id for downshift decisions. */
  modelFrom?: (req: HttpRequestLike) => string | undefined;
  /** Per-principal policy lookup. */
  policyFor?: (principalId: string) => BudgetPolicy | undefined;
  /** Default requested amount when `amountFrom` is absent. */
  defaultAmount?: MicroCny;
}

function send(res: HttpResponseLike, status: number, body: unknown): void {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    res.status(status);
    res.json(body);
    return;
  }
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
  if (typeof res.statusCode === 'number' || res.statusCode === undefined) res.statusCode = status;
  if (typeof res.end === 'function') {
    res.end(JSON.stringify(body));
    return;
  }
  if (typeof res.send === 'function') res.send(JSON.stringify(body));
}

/** Serialize a decision into a stable JSON body. */
export function decisionBody(decision: EvaluateResult): Record<string, unknown> {
  const body: Record<string, unknown> = {
    verdict: decision.verdict,
    reasonCode: decision.reasonCode,
    reasons: decision.reasons,
    fingerprint: decision.fingerprint,
    at: decision.at,
    actions: decision.actions,
  };
  if (decision.downshiftTo) body.downshiftTo = decision.downshiftTo;
  if (decision.triggered.length > 0) {
    body.triggered = decision.triggered.map((l) => ({
      scope: l.scope,
      limit: fromMicroCny(l.limit),
      onExceed: l.onExceed ?? 'cutoff',
    }));
  }
  return body;
}

export interface ReserveHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Framework-agnostic handler. Returns `{ status, body }` so callers can wire it
 * into any framework, or use {@link expressReserve} for the Express shape.
 *
 *   200  allowed, reservation held   `{ verdict: 'allow', reservationId, amount }`
 *   402  denied                      `{ verdict: 'deny', reasonCode, ... }`
 *   403  approval required           `{ verdict: 'require_approval', ... }`
 *   400  malformed request
 */
export async function handleReserve(
  meter: Meter,
  req: HttpRequestLike,
  options: AdapterOptions,
): Promise<ReserveHandlerResult> {
  const principalId = options.principalFrom(req);
  if (!principalId) {
    return { status: 400, body: { error: 'missing_principal', message: 'principalFrom() returned undefined' } };
  }

  const taskId = options.taskFrom?.(req);
  const model = options.modelFrom?.(req);
  const amount = options.amountFrom?.(req) ?? options.defaultAmount ?? 0n;

  const input: ReserveInput = {
    principalId,
    amount,
    ...(taskId ? { taskId } : {}),
    ...(model ? { model } : {}),
  };
  if (options.policyFor) {
    const policy = options.policyFor(principalId);
    if (policy) input.policy = policy;
  }

  try {
    const { reservation, decision } = await meter.reserve(input);
    return {
      status: 200,
      body: {
        ...decisionBody(decision),
        reservationId: reservation?.id ?? null,
        amount: fromMicroCny(amount),
      },
    };
  } catch (err) {
    if (err instanceof BudgetDeniedError) {
      return { status: 402, body: decisionBody(err.decision) };
    }
    if (err instanceof ApprovalRequiredError) {
      return { status: 403, body: decisionBody(err.decision) };
    }
    throw err;
  }
}

/**
 * Express-style middleware factory.
 *
 * ```ts
 * app.post('/api/v1/run', expressReserve(meter, {
 *   principalFrom: (req) => req.headers['x-principal'] as string,
 *   defaultAmount: toMicroCny('0.01'),
 * }), runHandler);
 * ```
 */
export function expressReserve(meter: Meter, options: AdapterOptions) {
  return async function reserveMiddleware(
    req: HttpRequestLike,
    res: HttpResponseLike,
    next?: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const { status, body } = await handleReserve(meter, req, options);
      send(res, status, body);
    } catch (err) {
      if (next) {
        next(err);
        return;
      }
      send(res, 500, {
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

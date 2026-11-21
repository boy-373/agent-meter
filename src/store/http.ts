import type { MicroCny, Reservation, UsageDelta, UsageRecord } from '../core/types.js';
import {
  addToSummary,
  emptySummary,
  inWindow,
  matches,
  type Query,
  type ScopeWindow,
  type Store,
  type Summary,
} from './types.js';

export interface HttpStoreOptions {
  /** Base URL of the meter service, e.g. "https://meter.example.com". */
  baseUrl: string;
  /** Bearer token sent as `Authorization`. */
  token?: string;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Max records buffered before a forced flush. Default 200. */
  batchSize?: number;
  /** Flush interval in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Max retry attempts per flush. Default 5. */
  maxRetries?: number;
  /** Base backoff in ms. Default 250. */
  backoffMs?: number;
  /** Inject a fetch implementation (useful for tests). */
  fetchImpl?: typeof fetch;
}

interface WireRecord extends Omit<UsageRecord, 'cost'> {
  cost: string;
}

function toWire(r: UsageRecord): WireRecord {
  return { ...r, cost: r.cost.toString() };
}

/**
 * Remote store that batches usage records and retries with exponential backoff.
 *
 * Reads (`used`, `held`, `query`, `summary`) are proxied to the server; writes
 * are buffered. `close()` flushes.
 */
export class HttpStore implements Store {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private buffer: UsageRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> = Promise.resolve();

  constructor(opts: HttpStoreOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) this.headers['authorization'] = `Bearer ${opts.token}`;
    this.batchSize = opts.batchSize ?? 200;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.backoffMs = opts.backoffMs ?? 250;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch(() => {
          /* errors surface on close() or the next explicit flush */
        });
      }, this.flushIntervalMs);
      // Do not keep the process alive just for flushing.
      this.timer.unref?.();
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
        });
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
        }
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxRetries) break;
        const delay = this.backoffMs * 2 ** attempt + Math.floor(Math.random() * this.backoffMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async record(r: UsageRecord): Promise<void> {
    this.buffer.push(r);
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  /** Send everything buffered. Safe to call concurrently. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return this.inflight;
    const batch = this.buffer;
    this.buffer = [];
    this.inflight = this.inflight.then(async () => {
      try {
        await this.request<{ ok: true }>('/records', {
          method: 'POST',
          body: JSON.stringify({ records: batch.map(toWire) }),
        });
      } catch (err) {
        // Put the batch back so a later flush can retry.
        this.buffer = [...batch, ...this.buffer];
        throw err;
      }
    });
    return this.inflight;
  }

  async reserve(r: Reservation): Promise<Reservation> {
    const res = await this.request<{ reservation: Reservation & { amount: string } }>('/reservations', {
      method: 'POST',
      body: JSON.stringify({ ...r, amount: r.amount.toString() }),
    });
    const out = res.reservation;
    return { ...out, amount: BigInt(out.amount) };
  }

  async settle(id: string, actual: UsageDelta): Promise<void> {
    await this.request<{ ok: true }>(`/reservations/${encodeURIComponent(id)}/settle`, {
      method: 'POST',
      body: JSON.stringify({ cost: actual.cost.toString(), usage: actual.usage, units: actual.units }),
    });
  }

  async release(id: string): Promise<void> {
    await this.request<{ ok: true }>(`/reservations/${encodeURIComponent(id)}/release`, {
      method: 'POST',
      body: '{}',
    });
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    try {
      const res = await this.request<{ reservation: (Reservation & { amount: string }) | null }>(
        `/reservations/${encodeURIComponent(id)}`,
      );
      if (!res.reservation) return undefined;
      return { ...res.reservation, amount: BigInt(res.reservation.amount) };
    } catch {
      return undefined;
    }
  }

  private windowQuery(principalId: string, window: ScopeWindow): string {
    const p = new URLSearchParams({
      principalId,
      scope: window.scope,
      from: String(window.from),
      to: String(window.to),
    });
    if (window.taskId !== undefined) p.set('taskId', window.taskId);
    return p.toString();
  }

  async used(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    const res = await this.request<{ used: string }>(`/used?${this.windowQuery(principalId, window)}`);
    return BigInt(res.used);
  }

  async held(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    const res = await this.request<{ held: string }>(`/held?${this.windowQuery(principalId, window)}`);
    return BigInt(res.held);
  }

  async query(filter: Query): Promise<UsageRecord[]> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined) p.set(k, String(v));
    }
    const res = await this.request<{ records: WireRecord[] }>(`/records?${p.toString()}`);
    return res.records.map((r) => ({ ...r, cost: BigInt(r.cost) }));
  }

  async summary(filter: Query): Promise<Summary> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) {
      if (v !== undefined) p.set(k, String(v));
    }
    const res = await this.request<{
      summary: Omit<Summary, 'cost' | 'byModel' | 'byKind'> & {
        cost: string;
        byModel: Record<string, { count: number; cost: string }>;
        byKind: Record<string, { count: number; cost: string }>;
      };
    }>(`/summary?${p.toString()}`);
    const s = res.summary;
    const out = emptySummary();
    out.count = s.count;
    out.cost = BigInt(s.cost);
    out.inputTokens = s.inputTokens;
    out.outputTokens = s.outputTokens;
    for (const [k, v] of Object.entries(s.byModel)) out.byModel[k] = { count: v.count, cost: BigInt(v.cost) };
    for (const [k, v] of Object.entries(s.byKind)) out.byKind[k] = { count: v.count, cost: BigInt(v.cost) };
    return out;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush().catch(() => {
      /* caller can inspect the buffer length */
    });
    await this.inflight.catch(() => {});
  }

  /** Records still waiting to be sent. */
  get pending(): number {
    return this.buffer.length;
  }
}

// Re-export helpers so a server built on this package can reuse the same
// filtering semantics as the local stores.
export { addToSummary, emptySummary, inWindow, matches };

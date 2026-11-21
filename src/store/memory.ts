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

/**
 * In-process store. Fast, zero configuration, and the reference implementation
 * every other store is tested against. Data is lost on process exit.
 */
export class MemoryStore implements Store {
  private records: UsageRecord[] = [];
  private ids = new Set<string>();
  private reservations = new Map<string, Reservation>();

  async record(r: UsageRecord): Promise<void> {
    // Idempotent by id: replaying the same event must not double-count.
    if (this.ids.has(r.id)) return;
    this.ids.add(r.id);
    this.records.push(r);
  }

  async reserve(r: Reservation): Promise<Reservation> {
    const stored: Reservation = { ...r };
    this.reservations.set(stored.id, stored);
    return { ...stored };
  }

  async settle(id: string, actual: UsageDelta): Promise<void> {
    const r = this.reservations.get(id);
    if (!r) throw new Error(`settle: unknown reservation "${id}"`);
    if (r.state !== 'held') throw new Error(`settle: reservation "${id}" is ${r.state}, not held`);
    r.state = 'settled';
    r.settledAmount = actual.cost;
    r.settledAt = Date.now();
  }

  async release(id: string): Promise<void> {
    const r = this.reservations.get(id);
    if (!r) throw new Error(`release: unknown reservation "${id}"`);
    if (r.state !== 'held') return;
    r.state = 'released';
    r.settledAt = Date.now();
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    const r = this.reservations.get(id);
    return r ? { ...r } : undefined;
  }

  async used(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    let total = 0n;
    for (const r of this.records) {
      if (r.principalId !== principalId) continue;
      if (!inWindow(r, window)) continue;
      total += r.cost;
    }
    return total;
  }

  async held(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    let total = 0n;
    for (const r of this.reservations.values()) {
      if (r.principalId !== principalId) continue;
      if (r.state !== 'held') continue;
      if (window.taskId !== undefined && r.taskId !== window.taskId) continue;
      if (r.createdAt < window.from || r.createdAt >= window.to) continue;
      total += r.amount;
    }
    return total;
  }

  async query(filter: Query): Promise<UsageRecord[]> {
    const out = this.records.filter((r) => matches(r, filter));
    out.sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }

  async summary(filter: Query): Promise<Summary> {
    const s = emptySummary();
    for (const r of this.records) {
      if (matches(r, filter)) addToSummary(s, r);
    }
    return s;
  }

  /** Test helper: drop everything. */
  reset(): void {
    this.records = [];
    this.ids.clear();
    this.reservations.clear();
  }
}

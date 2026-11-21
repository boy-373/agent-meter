import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

interface SerializedRecord extends Omit<UsageRecord, 'cost'> {
  cost: string;
}

interface SerializedReservation extends Omit<Reservation, 'amount' | 'settledAmount'> {
  amount: string;
  settledAmount?: string;
}

interface JournalLine {
  t: 'record' | 'reserve' | 'settle' | 'release';
  at: number;
  payload: SerializedRecord | SerializedReservation | { id: string; settledAmount?: string };
}

function serRecord(r: UsageRecord): SerializedRecord {
  return { ...r, cost: r.cost.toString() };
}

function deRecord(r: SerializedRecord): UsageRecord {
  return { ...r, cost: BigInt(r.cost) };
}

function serReservation(r: Reservation): SerializedReservation {
  const out: SerializedReservation = {
    id: r.id,
    principalId: r.principalId,
    amount: r.amount.toString(),
    state: r.state,
    createdAt: r.createdAt,
  };
  if (r.taskId !== undefined) out.taskId = r.taskId;
  if (r.settledAmount !== undefined) out.settledAmount = r.settledAmount.toString();
  if (r.settledAt !== undefined) out.settledAt = r.settledAt;
  return out;
}

function deReservation(r: SerializedReservation): Reservation {
  const out: Reservation = {
    id: r.id,
    principalId: r.principalId,
    amount: BigInt(r.amount),
    state: r.state,
    createdAt: r.createdAt,
  };
  if (r.taskId !== undefined) out.taskId = r.taskId;
  if (r.settledAmount !== undefined) out.settledAmount = BigInt(r.settledAmount);
  if (r.settledAt !== undefined) out.settledAt = r.settledAt;
  return out;
}

export interface JsonlStoreOptions {
  /** Path to the journal file. */
  path: string;
  /** Load the existing journal into memory on first use. Default true. */
  load?: boolean;
}

/**
 * Append-only JSONL journal with an in-memory index.
 *
 * Chosen over SQLite as the default durable store because it needs no native
 * dependency: the package stays zero-runtime-dependency and works on any Node 18+.
 * Every mutation is one line, so a crash truncates at most the last line.
 */
export class JsonlStore implements Store {
  private readonly path: string;
  private records: UsageRecord[] = [];
  private ids = new Set<string>();
  private reservations = new Map<string, Reservation>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: JsonlStoreOptions) {
    this.path = opts.path;
    if (opts.load !== false) {
      // Loading is lazy but must complete before the first read.
      this.ready = this.load();
    } else {
      this.ready = Promise.resolve();
      this.loaded = true;
    }
  }

  private ready: Promise<void>;

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as JournalLine);
        } catch {
          // A torn final line is expected after a crash; ignore it.
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, '', { flag: 'a' });
    }
    this.loaded = true;
  }

  private apply(line: JournalLine): void {
    switch (line.t) {
      case 'record': {
        const r = deRecord(line.payload as SerializedRecord);
        if (!this.ids.has(r.id)) {
          this.ids.add(r.id);
          this.records.push(r);
        }
        break;
      }
      case 'reserve': {
        const r = deReservation(line.payload as SerializedReservation);
        this.reservations.set(r.id, r);
        break;
      }
      case 'settle': {
        const p = line.payload as { id: string; settledAmount: string };
        const r = this.reservations.get(p.id);
        if (r) {
          r.state = 'settled';
          r.settledAmount = BigInt(p.settledAmount);
          r.settledAt = line.at;
        }
        break;
      }
      case 'release': {
        const p = line.payload as { id: string };
        const r = this.reservations.get(p.id);
        if (r) {
          r.state = 'released';
          r.settledAt = line.at;
        }
        break;
      }
      default:
        break;
    }
  }

  private async append(line: JournalLine): Promise<void> {
    await this.ready;
    this.apply(line);
    const text = JSON.stringify(line) + '\n';
    // Serialise writes so concurrent callers cannot interleave bytes.
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, text, 'utf8');
    });
    return this.queue;
  }

  async record(r: UsageRecord): Promise<void> {
    // Idempotent by id: replaying the same event must not double-count.
    if (this.ids.has(r.id)) return;
    await this.append({ t: 'record', at: Date.now(), payload: serRecord(r) });
  }

  async reserve(r: Reservation): Promise<Reservation> {
    await this.append({ t: 'reserve', at: Date.now(), payload: serReservation(r) });
    return { ...r };
  }

  async settle(id: string, actual: UsageDelta): Promise<void> {
    await this.ready;
    const r = this.reservations.get(id);
    if (!r) throw new Error(`settle: unknown reservation "${id}"`);
    if (r.state !== 'held') throw new Error(`settle: reservation "${id}" is ${r.state}, not held`);
    await this.append({
      t: 'settle',
      at: Date.now(),
      payload: { id, settledAmount: actual.cost.toString() },
    });
  }

  async release(id: string): Promise<void> {
    await this.ready;
    const r = this.reservations.get(id);
    if (!r) throw new Error(`release: unknown reservation "${id}"`);
    if (r.state !== 'held') return;
    await this.append({ t: 'release', at: Date.now(), payload: { id } });
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    await this.ready;
    const r = this.reservations.get(id);
    return r ? { ...r } : undefined;
  }

  async used(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    await this.ready;
    let total = 0n;
    for (const r of this.records) {
      if (r.principalId !== principalId) continue;
      if (!inWindow(r, window)) continue;
      total += r.cost;
    }
    return total;
  }

  async held(principalId: string, window: ScopeWindow): Promise<MicroCny> {
    await this.ready;
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
    await this.ready;
    const out = this.records.filter((r) => matches(r, filter));
    out.sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt));
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }

  async summary(filter: Query): Promise<Summary> {
    await this.ready;
    const s = emptySummary();
    for (const r of this.records) {
      if (matches(r, filter)) addToSummary(s, r);
    }
    return s;
  }

  async close(): Promise<void> {
    await this.queue;
  }

  /** True once the journal has been read. */
  get isLoaded(): boolean {
    return this.loaded;
  }
}

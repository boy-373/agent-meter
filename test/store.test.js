import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemoryStore,
  JsonlStore,
  buildRecord,
  scopeWindow,
  toMicroCny,
} from '../dist/index.js';

const CNY = (v) => toMicroCny(v);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-meter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function rec(overrides = {}) {
  return buildRecord({
    principalId: 'u1',
    kind: 'chat',
    cost: CNY('0.5'),
    startedAt: 1_000,
    endedAt: 2_000,
    ...overrides,
  });
}

const DAY = scopeWindow('daily', { now: new Date('2026-11-20T10:00:00Z') });

// ---------------------------------------------------------------- MemoryStore

test('memory store sums records inside a window', async () => {
  const store = new MemoryStore();
  await store.record(rec({ endedAt: Date.parse('2026-11-20T01:00:00Z') }));
  await store.record(rec({ endedAt: Date.parse('2026-11-20T02:00:00Z'), cost: CNY('0.25') }));
  // Outside the UTC day — must not count.
  await store.record(rec({ endedAt: Date.parse('2026-11-19T23:59:59Z') }));

  assert.equal(await store.used('u1', DAY), CNY('0.75'));
});

test('memory store is idempotent by record id', async () => {
  const store = new MemoryStore();
  const r = rec({ endedAt: Date.parse('2026-11-20T01:00:00Z') });
  await store.record(r);
  await store.record(r);
  await store.record({ ...r });
  assert.equal(await store.used('u1', DAY), CNY('0.5'));
});

test('memory store separates held from used', async () => {
  const store = new MemoryStore();
  await store.reserve({
    id: 'rs_1',
    principalId: 'u1',
    amount: CNY('0.3'),
    state: 'held',
    createdAt: Date.parse('2026-11-20T01:00:00Z'),
  });
  assert.equal(await store.used('u1', DAY), 0n);
  assert.equal(await store.held('u1', DAY), CNY('0.3'));

  await store.settle('rs_1', { cost: CNY('0.1') });
  assert.equal(await store.held('u1', DAY), 0n);
});

test('memory store summary breaks down by model and kind', async () => {
  const store = new MemoryStore();
  await store.record(rec({ model: 'qwen3.7-plus', kind: 'chat', cost: CNY('0.2') }));
  await store.record(rec({ model: 'qwen3.7-plus', kind: 'embed', cost: CNY('0.3') }));
  await store.record(rec({ model: 'deepseek-v4-flash', kind: 'chat', cost: CNY('0.1') }));

  const s = await store.summary({});
  assert.equal(s.count, 3);
  assert.equal(s.cost, CNY('0.6'));
  assert.equal(s.byModel['qwen3.7-plus'].cost, CNY('0.5'));
  assert.equal(s.byModel['qwen3.7-plus'].count, 2);
  assert.equal(s.byKind.chat.cost, CNY('0.3'));
});

// ------------------------------------------------------------------ JsonlStore

test('jsonl store survives a restart', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'usage.jsonl');

  const a = new JsonlStore({ path });
  await a.record(rec({ endedAt: Date.parse('2026-11-20T01:00:00Z') }));
  await a.record(rec({ endedAt: Date.parse('2026-11-20T02:00:00Z'), cost: CNY('0.25') }));
  await a.reserve({
    id: 'rs_1',
    principalId: 'u1',
    amount: CNY('0.4'),
    state: 'held',
    createdAt: Date.parse('2026-11-20T03:00:00Z'),
  });
  await a.close();

  const b = new JsonlStore({ path });
  assert.equal(await b.used('u1', DAY), CNY('0.75'));
  assert.equal(await b.held('u1', DAY), CNY('0.4'));

  await b.settle('rs_1', { cost: CNY('0.4') });
  await b.close();

  const c = new JsonlStore({ path });
  assert.equal(await c.held('u1', DAY), 0n);
  const rs = await c.getReservation('rs_1');
  assert.equal(rs.state, 'settled');
  assert.equal(rs.settledAmount, CNY('0.4'));
  await c.close();
});

test('jsonl store tolerates a torn trailing line', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'torn.jsonl');

  const a = new JsonlStore({ path });
  await a.record(rec({ endedAt: Date.parse('2026-11-20T01:00:00Z') }));
  await a.close();

  // Simulate a crash mid-append: half a JSON object on the last line.
  await appendFile(path, '{"t":"record","at":1,"payl', 'utf8');

  const b = new JsonlStore({ path });
  assert.equal(await b.used('u1', DAY), CNY('0.5'));
  await b.close();
});

test('jsonl store treats a missing file as empty', async (t) => {
  const dir = await tempDir(t);
  const store = new JsonlStore({ path: join(dir, 'never-written.jsonl') });
  assert.equal(await store.used('u1', DAY), 0n);
  assert.deepEqual(await store.query({}), []);
  await store.close();
});

test('jsonl store keeps bigint precision on disk', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'precise.jsonl');

  // 0.000001 CNY — one micro-cny, the smallest unit the kernel represents.
  const a = new JsonlStore({ path });
  await a.record(rec({ cost: 1n, endedAt: Date.parse('2026-11-20T01:00:00Z') }));
  await a.close();

  const raw = await readFile(path, 'utf8');
  assert.match(raw, /"cost":"1"/);

  const b = new JsonlStore({ path });
  assert.equal(await b.used('u1', DAY), 1n);
  await b.close();
});

test('jsonl store is idempotent by record id across reloads', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'dup.jsonl');
  const r = rec({ endedAt: Date.parse('2026-11-20T01:00:00Z') });

  const a = new JsonlStore({ path });
  await a.record(r);
  await a.record(r);
  await a.close();

  const b = new JsonlStore({ path });
  await b.record(r);
  assert.equal(await b.used('u1', DAY), CNY('0.5'));
  assert.equal((await b.query({})).length, 1);
  await b.close();
});

test('jsonl store serialises concurrent appends without interleaving', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'concurrent.jsonl');
  const store = new JsonlStore({ path });

  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.record(
        rec({ cost: 1n, meta: { nonce: String(i) }, endedAt: Date.parse('2026-11-20T01:00:00Z') }),
      ),
    ),
  );
  await store.close();

  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 50);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }

  const b = new JsonlStore({ path });
  assert.equal(await b.used('u1', DAY), 50n);
  await b.close();
});

// ------------------------------------------------------------------ 边界

test('a hand-written journal line still loads', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'manual.jsonl');
  await writeFile(
    path,
    JSON.stringify({
      t: 'record',
      at: 1,
      payload: {
        id: 'ur_manual',
        principalId: 'u1',
        kind: 'chat',
        cost: '250000',
        startedAt: 1,
        endedAt: Date.parse('2026-11-20T01:00:00Z'),
      },
    }) + '\n',
    'utf8',
  );

  const store = new JsonlStore({ path });
  assert.equal(await store.used('u1', DAY), CNY('0.25'));
  await store.close();
});

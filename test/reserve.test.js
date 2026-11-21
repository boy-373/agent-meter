import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Meter,
  MemoryStore,
  ReservationEngine,
  BudgetDeniedError,
  ApprovalRequiredError,
  toMicroCny,
  fromMicroCny,
  scopeWindow,
  buildRecord,
} from '../dist/index.js';

const CNY = (v) => toMicroCny(v);

function engineFor(store, limits, extra = {}) {
  const policy = { principalId: 'u1', limits, ...extra };
  return new ReservationEngine(store, () => policy);
}

test('a single reservation holds the requested amount', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation, decision } = await engine.reserve({ principalId: 'u1', amount: CNY('0.2') });
  assert.equal(decision.verdict, 'allow');
  assert.ok(reservation);
  assert.equal(reservation.state, 'held');
  assert.equal(fromMicroCny(reservation.amount), '0.2');

  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.held('u1', window), CNY('0.2'));
  assert.equal(await store.used('u1', window), 0n);
});

test('ten concurrent fan-out tasks cannot exceed the cap', async () => {
  // M3 exit criterion: 10 concurrent tasks, actual spend <= limit.
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);

  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      engine.reserve({ principalId: 'u1', amount: CNY('0.15'), taskId: `task-${i}` }),
    ),
  );

  const ok = results.filter((r) => r.status === 'fulfilled');
  const denied = results.filter((r) => r.status === 'rejected');

  assert.equal(ok.length, 6, `expected 6 reservations to fit, got ${ok.length}`);
  assert.equal(denied.length, 4);
  for (const d of denied) {
    assert.ok(d.reason instanceof BudgetDeniedError);
    assert.equal(d.reason.decision.verdict, 'deny');
  }

  const window = scopeWindow('total', { now: Date.now() });
  const held = await store.held('u1', window);
  assert.equal(held, CNY('0.9'));
  assert.ok(held <= CNY('1'), 'held amount must never exceed the cap');

  // Settle every granted reservation; spend must stay under the cap too.
  for (const r of ok) {
    await engine.settle(r.value.reservation.id, { cost: CNY('0.15') });
  }
  const used = await store.used('u1', window);
  assert.equal(used, CNY('0.9'));
  assert.equal(await store.held('u1', window), 0n);
  assert.ok(used <= CNY('1'));
});

test('settling below the reserved amount frees the remainder', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation } = await engine.reserve({ principalId: 'u1', amount: CNY('0.5') });
  await engine.settle(reservation.id, { cost: CNY('0.05') });

  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.used('u1', window), CNY('0.05'));
  assert.equal(await store.held('u1', window), 0n);

  // The freed headroom is reusable.
  const again = await engine.reserve({ principalId: 'u1', amount: CNY('0.9') });
  assert.equal(again.decision.verdict, 'allow');
});

test('settling above the reserved amount is rejected', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation } = await engine.reserve({ principalId: 'u1', amount: CNY('0.1') });
  await assert.rejects(() => engine.settle(reservation.id, { cost: CNY('0.2') }), /exceed|reserved/i);
});

test('release returns the whole reservation to the pool', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation } = await engine.reserve({ principalId: 'u1', amount: CNY('0.5') });
  await engine.release(reservation.id);

  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.held('u1', window), 0n);
  assert.equal(await store.used('u1', window), 0n);

  const after = await store.getReservation(reservation.id);
  assert.equal(after.state, 'released');
});

test('settling twice is rejected', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation } = await engine.reserve({ principalId: 'u1', amount: CNY('0.1') });
  await engine.settle(reservation.id, { cost: CNY('0.1') });
  await assert.rejects(
    () => engine.settle(reservation.id, { cost: CNY('0.1') }),
    /settled|state|held/i,
  );
});

test('approval limits park the call instead of denying it', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [
    { scope: 'total', limit: CNY('0.1'), onExceed: 'approval' },
  ]);
  await assert.rejects(
    () => engine.reserve({ principalId: 'u1', amount: CNY('0.5') }),
    (err) => {
      assert.ok(err instanceof ApprovalRequiredError);
      assert.equal(err.decision.verdict, 'require_approval');
      assert.equal(err.decision.reasonCode, 'approval_required');
      return true;
    },
  );
  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.held('u1', window), 0n, 'a parked call must not hold budget');
});

test('shadow mode lets the call through while logging the intent', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('0.1') }], { shadow: true });
  const { reservation, decision } = await engine.reserve({ principalId: 'u1', amount: CNY('5') });
  assert.equal(decision.verdict, 'allow');
  assert.equal(decision.reasonCode, 'shadow_allow');
  assert.ok(reservation);
});

test('check() never holds budget', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const d = await engine.check({ principalId: 'u1', amount: CNY('0.5') });
  assert.equal(d.verdict, 'allow');
  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.held('u1', window), 0n);
});

test('reservation ids are deterministic for identical inputs', async () => {
  const at = 1_800_000_000_000;
  const a = await engineFor(new MemoryStore(), [{ scope: 'total', limit: CNY('1') }]).reserve({
    principalId: 'u1',
    amount: CNY('0.1'),
    taskId: 't1',
    at,
  });
  const b = await engineFor(new MemoryStore(), [{ scope: 'total', limit: CNY('1') }]).reserve({
    principalId: 'u1',
    amount: CNY('0.1'),
    taskId: 't1',
    at,
  });
  assert.equal(a.reservation.id, b.reservation.id);
});

test('snapshot sums used and held per scope', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [
    { scope: 'task', limit: CNY('1') },
    { scope: 'total', limit: CNY('10') },
  ]);
  await engine.reserve({ principalId: 'u1', amount: CNY('0.2'), taskId: 't1' });
  await engine.settle(
    (await engine.reserve({ principalId: 'u1', amount: CNY('0.3'), taskId: 't1' })).reservation.id,
    { cost: CNY('0.1') },
  );

  const snap = await engine.snapshot('u1', 't1', Date.now());
  assert.equal(snap.task, CNY('0.3')); // 0.2 held + 0.1 used
  assert.equal(snap.total, CNY('0.3'));
});

test('a meter facade wires pricing, reservation and records together', async () => {
  const store = new MemoryStore();
  const meter = new Meter({
    store,
    policies: {
      u1: {
        principalId: 'u1',
        limits: [{ scope: 'total', limit: CNY('1') }],
      },
    },
  });

  const usage = { inputTokens: 1000, outputTokens: 500 };
  const cost = meter.price('qwen3.7-plus', usage);
  assert.equal(fromMicroCny(cost.total), '0.006');

  const { reservation } = await meter.reserve({ principalId: 'u1', amount: CNY('0.01') });
  const record = await meter.settle(reservation.id, cost.total, {
    principalId: 'u1',
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage,
  });
  assert.ok(record);
  assert.equal(record.cost, cost.total);

  const summary = await meter.summary({ principalId: 'u1' });
  assert.equal(summary.count, 1);
  assert.equal(summary.cost, cost.total);
  assert.equal(await meter.used('u1', 'total'), cost.total);
});

test('unknown models make the meter throw a helpful error', () => {
  const meter = new Meter();
  assert.throws(() => meter.price('no-such-model', { inputTokens: 1, outputTokens: 1 }), /unknown model/);
  assert.equal(meter.tryPrice('no-such-model', { inputTokens: 1, outputTokens: 1 }), undefined);
});

test('a reservation can carry a usage record atomically', async () => {
  const store = new MemoryStore();
  const engine = engineFor(store, [{ scope: 'total', limit: CNY('1') }]);
  const { reservation } = await engine.reserve({ principalId: 'u1', amount: CNY('0.05') });
  const record = buildRecord({
    principalId: 'u1',
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage: { inputTokens: 100, outputTokens: 100 },
    cost: CNY('0.001'),
  });
  await engine.settle(reservation.id, { cost: CNY('0.001'), record });
  const window = scopeWindow('total', { now: Date.now() });
  assert.equal(await store.used('u1', window), CNY('0.001'));
  assert.equal((await store.query({ principalId: 'u1' })).length, 1);
});

test('cleanup: no temp files left behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-meter-reserve-'));
  await writeFile(join(dir, 'x.txt'), 'ok', 'utf8');
  assert.equal(await readFile(join(dir, 'x.txt'), 'utf8'), 'ok');
  await rm(dir, { recursive: true, force: true });
});

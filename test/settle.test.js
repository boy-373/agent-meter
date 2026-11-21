import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Meter,
  MemoryStore,
  BUILTIN_PRICES,
  toMicroCny,
  fromMicroCny,
} from '../dist/index.js';

const CNY = (v) => toMicroCny(v);

function freshMeter() {
  const store = new MemoryStore();
  const meter = new Meter({ store, prices: BUILTIN_PRICES });
  meter.setPolicy({
    principalId: 'u1',
    limits: [{ scope: 'total', limit: CNY('10.00'), onExceed: 'cutoff' }],
  });
  return { store, meter };
}

test('settle accepts the object form { cost, record }', async () => {
  const { meter } = freshMeter();
  const { reservation } = await meter.reserve({ principalId: 'u1', amount: CNY('0.20'), taskId: 't1' });
  const record = await meter.record({
    principalId: 'u1',
    taskId: 't1',
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage: { inputTokens: 1200, outputTokens: 480 },
  });

  await meter.settle(reservation.id, { cost: record.cost, record });

  assert.equal(typeof record.cost, 'bigint');
  assert.equal(record.cost, CNY('0.00624'));
  assert.equal(await meter.used('u1', 'total'), record.cost);
});

test('settle accepts the positional form (id, cost)', async () => {
  const { meter } = freshMeter();
  const { reservation } = await meter.reserve({ principalId: 'u1', amount: CNY('0.20'), taskId: 't2' });

  await meter.settle(reservation.id, CNY('0.005'));

  // The engine leaves an unattributed record behind, so used() sees the spend.
  assert.equal(await meter.used('u1', 'total'), CNY('0.005'));
  assert.equal(fromMicroCny(await meter.used('u1', 'total')), '0.005');
});

test('settle accepts the positional form (id, cost, recordInput)', async () => {
  const { meter } = freshMeter();
  const { reservation } = await meter.reserve({ principalId: 'u1', amount: CNY('0.20'), taskId: 't3' });

  const rec = await meter.settle(reservation.id, CNY('0.00624'), {
    principalId: 'u1',
    taskId: 't3',
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage: { inputTokens: 1200, outputTokens: 480 },
  });

  assert.ok(rec);
  assert.equal(rec.cost, CNY('0.00624'));
  assert.equal(await meter.used('u1', 'total'), CNY('0.00624'));
});

test('used() returns bigint, never a string', async () => {
  const { meter } = freshMeter();
  await meter.record({
    principalId: 'u1',
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage: { inputTokens: 1200, outputTokens: 480 },
  });
  const v = await meter.used('u1', 'total');
  assert.equal(typeof v, 'bigint');
  assert.equal(fromMicroCny(v), '0.00624');
});

test('settle rejects an actual cost above the hold', async () => {
  const { meter } = freshMeter();
  const { reservation } = await meter.reserve({ principalId: 'u1', amount: CNY('0.01'), taskId: 't4' });
  await assert.rejects(
    () => meter.settle(reservation.id, CNY('0.02')),
    /exceeds reserved/,
  );
});

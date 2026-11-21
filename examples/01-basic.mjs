// 01 — Thirty seconds: reserve → call → settle.
//
//   node examples/01-basic.mjs
//
// Every amount is a bigint in micro-CNY (1 micro_cny = 0.000001 CNY).
// `toMicroCny('0.20')` turns a human string into that unit without float math.

import {
  Meter,
  MemoryStore,
  BUILTIN_PRICES,
  toMicroCny,
  fromMicroCny,
} from 'agent-meter-kernel';

const meter = new Meter({
  store: new MemoryStore(),   // swap for JsonlStore / HttpStore in production
  prices: BUILTIN_PRICES,     // 44 Chinese models, longest-prefix match
});

meter.setPolicy({
  principalId: 'user_42',
  limits: [
    { scope: 'daily', limit: toMicroCny('5.00'), onExceed: 'cutoff' },
    { scope: 'total', limit: toMicroCny('100.00'), warnRatio: 0.8, onExceed: 'approval' },
  ],
});

// 1) Hold an estimate BEFORE you spend.
const { reservation } = await meter.reserve({
  principalId: 'user_42',
  amount: toMicroCny('0.20'),
  taskId: 'task_abc',
});
console.log('reserved:', reservation.id, 'for', fromMicroCny(reservation.amount), 'CNY');

// 2) Make the model call here. We fake it.
const usage = { inputTokens: 1200, outputTokens: 480 };

// 3) Settle at the real cost — `record` prices the usage and writes the audit line.
const record = await meter.record({
  principalId: 'user_42',
  taskId: 'task_abc',
  kind: 'chat',
  model: 'qwen3.7-plus',
  usage,
});
await meter.settle(reservation.id, { cost: record.cost, record });

console.log('actual cost:', fromMicroCny(record.cost), 'CNY');
console.log('used today :', fromMicroCny(await meter.used('user_42', 'daily')), 'CNY');
console.log('used total :', fromMicroCny(await meter.used('user_42', 'total')), 'CNY');

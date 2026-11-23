// 02 — The budget is enforced BEFORE the call, not reported after it.
//
//   node examples/02-cutoff.mjs
//
// A `cutoff` limit makes `reserve()` throw BudgetDeniedError. Nothing was spent.

import {
  Meter,
  MemoryStore,
  BUILTIN_PRICES,
  toMicroCny,
  fromMicroCny,
  BudgetDeniedError,
  ApprovalRequiredError,
} from '@boy-373/agent-meter';

const meter = new Meter({ store: new MemoryStore(), prices: BUILTIN_PRICES });

meter.setPolicy({
  principalId: 'user_7',
  limits: [{ scope: 'daily', limit: toMicroCny('0.01'), onExceed: 'cutoff' }],
});

// Ask for more than the whole daily budget.
try {
  await meter.reserve({ principalId: 'user_7', amount: toMicroCny('0.02'), taskId: 'task_x' });
  console.log('BUG: reservation should have been denied');
} catch (err) {
  if (err instanceof BudgetDeniedError) {
    const d = err.decision;
    console.log('denied as expected');
    console.log('  verdict    :', d.verdict);
    console.log('  reasonCode :', d.reasonCode);
    console.log('  reasons    :', d.reasons.join(' | '));
    for (const t of d.triggered) {
      console.log(`  triggered  : scope=${t.scope} limit=${fromMicroCny(t.limit)} CNY action=${t.onExceed}`);
    }
  } else {
    throw err;
  }
}

// An `approval` limit does not throw BudgetDeniedError — it asks a human.
meter.setPolicy({
  principalId: 'user_8',
  limits: [{ scope: 'total', limit: toMicroCny('0.01'), warnRatio: 0.8, onExceed: 'approval' }],
});

try {
  await meter.reserve({ principalId: 'user_8', amount: toMicroCny('0.02'), taskId: 'task_y' });
  console.log('BUG: approval should have been required');
} catch (err) {
  if (err instanceof ApprovalRequiredError) {
    console.log('approval required — route this to a human, then retry');
    console.log('  reasons:', err.decision.reasons.join(' | '));
  } else {
    throw err;
  }
}

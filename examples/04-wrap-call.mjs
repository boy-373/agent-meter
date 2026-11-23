// 04 — Wrap a real model call: reserve, call, measure, settle — one call site.
//
//   node examples/04-wrap-call.mjs
//
// `wrapCall` does the four steps you would otherwise forget one of:
//   1. hold an estimate before spending anything
//   2. run your function
//   3. pull the token counts out of whatever shape the provider returned
//   4. price it and settle
//
// The provider call is faked here so the example runs offline. Swap the body of
// `callModel` for your real client and nothing else changes.

import {
  Meter, MemoryStore, BUILTIN_PRICES, toMicroCny, fromMicroCny,
  BudgetDeniedError, extractUsage,
} from '@boy-373/agent-meter';

const meter = new Meter({ store: new MemoryStore(), prices: BUILTIN_PRICES });

meter.setPolicy({
  principalId: 'user_42',
  limits: [{ scope: 'daily', limit: toMicroCny('0.05'), onExceed: 'cutoff' }],
});

/** Pretend to be an OpenAI-compatible endpoint. */
async function callModel(messages) {
  return {
    id: 'chatcmpl-demo',
    choices: [{ message: { role: 'assistant', content: '先把钱算清楚，再调模型。' } }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 480,
      prompt_tokens_details: { cached_tokens: 800 },
    },
    _echo: messages.length,
  };
}

async function runOnce(taskId) {
  const { result, record, usage } = await meter.wrapCall(
    (signal) => callModel([{ role: 'user', content: '预算怎么管？' }]),
    {
      principalId: 'user_42',
      taskId,
      kind: 'chat',
      model: 'qwen3.7-plus',
      estimate: toMicroCny('0.02'), // pessimistic on purpose — the surplus is released
      timeoutMs: 10_000,
    },
  );
  console.log(
    `${taskId}: cost=${fromMicroCny(record.cost)} CNY`,
    `in=${usage.inputTokens} out=${usage.outputTokens} cache=${usage.cacheReadTokens ?? 0}`,
    `| ${result.choices[0].message.content}`,
  );
}

// Each call costs 0.00624 CNY and holds 0.02 up front, so the daily 0.05 limit
// runs out at call 6 — and it runs out *before* the call, not after.
for (let i = 1; i <= 8; i += 1) {
  try {
    await runOnce(`task_${i}`);
  } catch (err) {
    if (err instanceof BudgetDeniedError) {
      console.log(`task_${i}: refused before spending — ${err.decision.reasons[0]}`);
      break;
    }
    throw err;
  }
}

console.log('used today:', fromMicroCny(await meter.used('user_42', 'daily')), 'CNY');

// If you only want the numbers and already have the response in hand:
const bare = extractUsage({ usage: { input_tokens: 300, output_tokens: 120 } });
console.log('extractUsage alone:', bare);

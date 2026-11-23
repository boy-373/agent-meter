# Examples

Four files, no build step, no framework. Run them straight from the repo after
`npm install && npm run build`, or from any project that has the package:

```bash
npm i @boy-373/agent-meter
```

| File | What it shows | Run |
|---|---|---|
| `01-basic.mjs` | reserve → call → settle, with the real cost from the price table | `node examples/01-basic.mjs` |
| `02-cutoff.mjs` | `cutoff` throws before you spend; `approval` asks a human | `node examples/02-cutoff.mjs` |
| `03-server.mjs` | plain `node:http` service, 402 when the budget is gone | `node examples/03-server.mjs` |
| `04-wrap-call.mjs` | one-call wrapper: hold → call → measure → settle | `node examples/04-wrap-call.mjs` |

## 01 — the loop

```js
const { reservation } = await meter.reserve({ principalId, amount: toMicroCny('0.20'), taskId });
// … call the model …
const record = await meter.record({ principalId, taskId, kind: 'chat', model: 'qwen3.7-plus', usage });
await meter.settle(reservation.id, { cost: record.cost, record });
```

`reserve` holds an estimate **before** the call. `record` prices the actual
usage against the table. `settle` swaps the hold for the real number. If the
process dies between reserve and settle, the hold stays visible in `held()` and
can be released — nothing is silently lost.

## 02 — the two refusals

- `BudgetDeniedError` → HTTP **402**, nothing was spent. Use it when the limit
  is a hard stop.
- `ApprovalRequiredError` → HTTP **403**, route to a human and retry. Use it
  when overspend should be a decision, not a failure.

Both carry `decision.triggered[]` — the exact budget lines that fired, with the
limit amount and the action taken. That is what you show in the UI.

## 03 — HTTP in ~60 lines

```js
const { status, body } = await handleReserve(meter, req, {
  principalFrom: (r) => r.headers['x-principal'],
  amountFrom: () => toMicroCny('0.01'),
  policyFor,
});
if (status !== 200) return reply(status, body);   // 402 / 403 / 400
// … do the work, then record + settle …
```

`handleReserve` is framework-agnostic — it returns `{ status, body }` and never
touches the response object. `expressReserve` is the same thing wrapped as
Express middleware.

## 04 — one call site

`wrapCall` collapses the whole loop into one function, and the model never runs
if the budget refuses the hold.

```js
const { result, record, usage } = await meter.wrapCall(
  (signal) => client.chat.completions.create({ model: 'qwen3.7-plus', messages }, { signal }),
  {
    principalId: 'user_42',
    taskId: 'task_1',
    model: 'qwen3.7-plus',
    estimate: toMicroCny('0.02'),  // pessimistic on purpose; the surplus is released
    timeoutMs: 10_000,
  },
);
```

Four things it handles so you don't have to:

1. **Hold** the estimate before spending anything.
2. **Run** your function, passing it an `AbortSignal` wired to `timeoutMs`.
3. **Measure** — `extractUsage` reads the token counts out of whatever shape the
   provider returned (OpenAI, Anthropic, Gemini, DeepSeek, DashScope, Ollama),
   normalising so `inputTokens` never double-counts cached tokens.
4. **Settle** at the real cost, releasing whatever the hold over-reserved.

The failure paths are the interesting part:

| Situation | What happens |
|---|---|
| Budget denies the hold | `fn` is never called; `BudgetDeniedError` surfaces |
| `fn` throws | the hold is released, nothing is recorded |
| Response has no recognisable usage | booked at zero with `meta.usageMissing` |
| Model not in the price table | booked at zero with `meta.unpriced` |
| Real cost exceeds the hold | record is written, hold released, error thrown with `.record` |

That last one is the one people trip over: an estimate that is too small does not
cap the spend, it just makes the spend louder. Give headroom.

## Money

Every amount is a `bigint` in **micro-CNY** (1 micro_cny = 0.000001 CNY).
`toMicroCny('0.20')` parses a human string without float error; `fromMicroCny(x)`
turns it back into a display string. Do the math in bigint, format at the edge.

## Stores

| Store | Use it when |
|---|---|
| `MemoryStore` | tests, single-process demos, throwaway scripts |
| `JsonlStore` | one process, durable audit trail you can `tail -f` |
| `HttpStore` | many processes against one accounting service |

Swap by constructor argument — the rest of the code does not change.

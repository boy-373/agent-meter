# agent-meter-kernel

**A budget enforcement kernel for AI agents.** Not another token counter — a thing that
decides *whether the next call is allowed to happen*, and leaves an audit trail when it isn't.

Zero runtime dependencies. TypeScript types included. Node 18+.

```bash
npm i agent-meter-kernel
```

---

## Why

Everyone can count tokens. The hard part is the moment before the call:

- A fan-out of ten parallel agents each thinks it has budget left, and together they blow
  through the cap.
- A runaway loop burns ¥40 overnight and nobody notices until the bill arrives.
- Finance asks "who spent this ¥3,000 and on what" and the answer lives in a log file
  nobody can replay.

`agent-meter-kernel` is the small, boring, correct piece that sits in front of the model call:

```
check ──▶ reserve ──▶ call the model ──▶ settle
           │                                │
           └── denied / parked ─────────────┘
```

---

## Thirty seconds

```ts
import { Meter, JsonlStore, BUILTIN_PRICES, toMicroCny } from 'agent-meter-kernel';

const meter = new Meter({
  store: new JsonlStore({ path: './usage.jsonl' }),
  prices: BUILTIN_PRICES,
});

meter.setPolicy({
  principalId: 'user_42',
  limits: [
    { scope: 'daily', limit: toMicroCny('5.00'), onExceed: 'cutoff' },
    { scope: 'total', limit: toMicroCny('100.00'), warnRatio: 0.8, onExceed: 'approval' },
  ],
});

// Before the call: hold an estimate.
const { reservation } = await meter.reserve({
  principalId: 'user_42',
  amount: toMicroCny('0.20'),
  taskId: 'task_abc',
});

// Make the call…
const usage = { inputTokens: 1200, outputTokens: 480 };

// After the call: settle at the real cost. `record` prices the usage against
// the table and writes the audit line in one step.
const record = await meter.record({
  principalId: 'user_42',
  taskId: 'task_abc',
  kind: 'chat',
  model: 'qwen3.7-plus',
  usage,
});

await meter.settle(reservation.id, { cost: record.cost, record });
```

If the budget is exhausted, `reserve()` throws `BudgetDeniedError` **before** you spend
anything. If the policy says a human should decide, it throws `ApprovalRequiredError` with
the full decision attached.

Runnable, dependency-free examples live in [`examples/`](./examples):

```bash
node examples/01-basic.mjs      # reserve → call → settle
node examples/02-cutoff.mjs     # 402 vs 403, nothing spent
node examples/03-server.mjs     # plain node:http, 402 when the budget is gone
node examples/04-wrap-call.mjs  # hold → call → measure → settle in one function
```

---

## One call site

`reserve` / `record` / `settle` are three steps because real systems need them to
be separable — a retry, a queue, a crash between any two of them. Most call sites
don't, so there is `wrapCall`:

```ts
const { result, record, usage } = await meter.wrapCall(
  (signal) => client.chat.completions.create({ model: 'qwen3.7-plus', messages }, { signal }),
  {
    principalId: 'user_42',
    taskId: 'task_abc',
    model: 'qwen3.7-plus',
    estimate: toMicroCny('0.20'),
    timeoutMs: 10_000,
  },
);
```

It holds the estimate, runs your function, pulls the token counts out of whatever
shape the provider returned, prices them, and settles. **The model never runs if
the budget refuses the hold.**

`extractUsage` is exported on its own too, for when you already have the response:

```ts
import { extractUsage } from 'agent-meter-kernel';

extractUsage(openaiResponse);   // { inputTokens, outputTokens, cacheReadTokens }
extractUsage(anthropicResponse);
extractUsage(geminiResponse);
extractUsage(dashscopeNativeResponse);
extractUsage(ollamaResponse);
```

One detail it gets right so you don't have to: `inputTokens` is always the
**uncached** input. OpenAI and Gemini report a single prompt total that includes
cached tokens; those are split apart here. Anthropic already separates them.

If the response carries no counts it recognises, `wrapCall` books the call at zero
with `meta.usageMissing` rather than dropping it — a gap you can query for beats a
gap you can't see.

## The five ideas

### 1. Money is `bigint` micro-CNY

`1 micro_cny = 0.000001 CNY`. Every amount in the kernel is a `bigint` in that unit.
No floats, no rounding drift, no `0.1 + 0.2 !== 0.3` in your ledger.

```ts
toMicroCny('0.01')    // 10000n
fromMicroCny(10000n)  // '0.01'
```

### 2. Reserve, then settle

A count-only budget check is racy: ten parallel tasks read "¥0.90 of ¥1.00 used", all
conclude they fit, and together overspend. `agent-meter-kernel` holds an estimate under a mutex
before the call, so concurrent fan-out sees `used + held` and cannot collectively cross
the line.

```ts
await Promise.all(tenTasks.map(() => meter.reserve({ principalId, amount })));
// Exactly as many succeed as the remaining budget allows. Not one more.
```

### 3. Three verdicts, one fingerprint

```ts
type DecisionVerdict = 'allow' | 'require_approval' | 'deny';
```

Every decision carries a `sha256` fingerprint over a canonical snapshot of
`(policy, used, requested, model, timestamp)`. Same inputs → same fingerprint → the decision
is replayable and auditable after the fact.

### 4. Fail closed

If policy evaluation throws, the default is **deny**, not allow. A budget guard that fails
open is decoration. Override with `onEvalError: 'fail_open'` when availability matters more
than the cap — but choose it on purpose.

### 5. Shadow mode

Roll a policy out without enforcing it:

```ts
meter.setPolicy({ ...policy, shadow: true });
```

The decision is still computed and logged (`reasonCode: 'shadow_allow'`, with the verdict it
*would* have returned), but the call always proceeds. Run it for a week, look at the
fingerprints, then take the training wheels off.

---

## Scopes and actions

| Scope | Window |
|---|---|
| `task` | one `taskId`, forever |
| `daily` | UTC calendar day |
| `monthly` | UTC calendar month |
| `total` | all time |

| `onExceed` | Effect |
|---|---|
| `warn` | allow, flag it |
| `downshift` | allow, suggest `downshiftModel` |
| `approval` | park the call → `require_approval` |
| `cutoff` | deny |

When several scopes trip at once, severity wins: **deny > require_approval > downshift > warn**.
Every tripped limit is reported in `decision.triggered`.

---

## Stores

| Store | Use it for |
|---|---|
| `MemoryStore` | tests, single-process demos |
| `JsonlStore` | the default. Append-only journal, crash-tolerant, greppable |
| `HttpStore` | remote ledger; batches writes, retries with exponential backoff |

`JsonlStore` tolerates a torn last line (a crash mid-append) and is idempotent by record id,
so replaying the same event never double-counts.

```ts
import { JsonlStore } from 'agent-meter-kernel/store/jsonl';
```

---

## Prices

`BUILTIN_PRICES` ships **44 models** across Qwen, DeepSeek, Doubao, GLM, Kimi and MiniMax,
in CNY per million tokens, each entry carrying its `source` URL and `updatedAt` date.

Matching is longest-prefix, so `qwen3.7-plus` also covers `qwen3.7-plus-2026-05-26`:

```ts
table.match('qwen3.7-plus-2026-05-26');
// { price: <qwen3.7-plus>, matchedKey: 'qwen3.7-plus', exact: false }
```

**Prices move.** They are a convenience, not a contract. Override at runtime with your own
contracted rates, and use `stalePrices()` to catch entries older than 90 days:

```ts
table.setOverride({ model: 'qwen3.7-plus', inputPerMTok: 1_500_000n, outputPerMTok: 6_000_000n, updatedAt: '2026-11-20', source: 'contract' });
table.stalePrices(new Date());
```

Tiered pricing (short/long context) is represented by the first tier, with the full ladder
noted in `note`. Metering a call against the wrong tier is a rounding error you can fix by
overriding the entry.

---

## CLI

```bash
agent-meter models                        # list the built-in price table
agent-meter price qwen3.7-plus -i 1200 -o 480
agent-meter used --principal user_42 --scope daily --store ./usage.jsonl
agent-meter summary --store ./usage.jsonl
```

---

## Design boundaries

Deliberate non-goals, so the kernel stays small:

- **No credits.** The kernel knows `micro_cny`. If your product sells points, convert at the
  edge — the exchange rate is a business rule, not a metering rule.
- **No authentication.** `principalId` is whatever your app says it is. Auth belongs to your app.
- **No revenue split.** Platform/developer payouts are commercial policy, not metering.
- **No framework coupling.** The core has never heard of Express, Fastify or Hono.
- **No runtime dependencies.** `node:crypto` and `node:fs/promises`, that's the whole list.

---

## Status

| Stage | State |
|---|---|
| M0 — package, types, build | done |
| M1 — metering kernel, price table, stores, tests | done (96 tests) |
| M2 — real token capture from provider responses | done (`extractUsage`, `wrapCall`) |
| M3 — budget control under concurrency | core done, integration pending |
| M4 — approval workflow | decision layer done, no UI |
| M7 — capability gateway (payments, ICP) | deliberately not started |

The Express adapter ships (`agent-meter-kernel/adapters/express`), but it is deliberately
thin: no auth, no price lookup, no notion of a "credit". Wire your own principal resolution
and policy lookup into it.

Not implemented yet: SQLite store, streaming helpers, an approval UI.

---

## License

MIT © 2026 pianam

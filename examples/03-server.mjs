// 03 — A tiny HTTP service that refuses to spend money it does not have.
//
//   node examples/03-server.mjs
//   curl -s -H 'x-principal: user_42' localhost:8787/run
//   curl -s -H 'x-principal: user_42' localhost:8787/run    # repeat until 402
//
// Zero framework dependencies: plain node:http + the framework-agnostic handler.
// Drop `expressReserve` into Express instead if you already have it installed.

import http from 'node:http';
import {
  Meter,
  MemoryStore,
  BUILTIN_PRICES,
  toMicroCny,
  fromMicroCny,
} from 'agent-meter-kernel';
import { handleReserve } from 'agent-meter-kernel/adapters/express';

const PORT = Number(process.env.PORT ?? 8787);
const ESTIMATE = toMicroCny('0.01');   // what one /run is expected to cost

const meter = new Meter({
  // MemoryStore keeps the demo zero-setup. In production swap in:
  //   new JsonlStore({ path: './usage.jsonl' })   // one process, durable audit
  //   new HttpStore({ url: 'https://…' })          // many processes, one ledger
  store: new MemoryStore(),
  prices: BUILTIN_PRICES,
});

// One policy for everyone, just to keep the demo short.
const policies = new Map();
function policyFor(principalId) {
  if (!policies.has(principalId)) {
    policies.set(principalId, {
      principalId,
      limits: [{ scope: 'total', limit: toMicroCny('0.03'), onExceed: 'cutoff' }],
    });
  }
  return policies.get(principalId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname !== '/run') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  // 1) Ask the kernel for permission to spend.
  const { status, body } = await handleReserve(
    meter,
    { headers: req.headers, body: null, query: Object.fromEntries(url.searchParams) },
    {
      principalFrom: (r) => (typeof r.headers['x-principal'] === 'string' ? r.headers['x-principal'] : undefined),
      taskFrom: () => url.searchParams.get('task') ?? undefined,
      amountFrom: () => ESTIMATE,
      modelFrom: () => 'qwen3.7-plus',
      policyFor,
    },
  );

  if (status !== 200) {
    // 402 = out of budget, 403 = needs approval. Neither one spent a cent.
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // 2) We have a reservation — do the work.
  const principalId = req.headers['x-principal'];
  const record = await meter.record({
    principalId,
    taskId: url.searchParams.get('task') ?? undefined,
    kind: 'chat',
    model: 'qwen3.7-plus',
    usage: { inputTokens: 1200, outputTokens: 480 },
  });

  // 3) Settle at the real cost.
  await meter.settle(body.reservationId, { cost: record.cost, record });

  const used = await meter.used(principalId, 'total');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ...body,
    cost: fromMicroCny(record.cost),
    usedTotal: fromMicroCny(used),
  }));
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
  console.log(`try: curl -s -H 'x-principal: user_42' localhost:${PORT}/run`);
  console.log('the 5th call returns 402 — budget is 0.03 CNY, each call costs 0.00624 CNY');
});

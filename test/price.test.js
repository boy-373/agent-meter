import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PriceTable,
  BUILTIN_PRICES,
  PRICE_TABLE_VERSION,
  PRICE_TABLE_UPDATED_AT,
  computeCost,
  priceTokens,
  normalizeModelId,
  toMicroCny,
  fromMicroCny,
  sumMicro,
} from '../dist/index.js';

test('toMicroCny parses decimals without float drift', () => {
  assert.equal(toMicroCny('0.01'), 10_000n);
  assert.equal(toMicroCny('0.025'), 25_000n);
  assert.equal(toMicroCny('12'), 12_000_000n);
  assert.equal(toMicroCny(2), 2_000_000n);
  assert.equal(toMicroCny(0), 0n);
  // 0.1 + 0.2 style traps must stay exact.
  assert.equal(toMicroCny('0.1') + toMicroCny('0.2'), toMicroCny('0.3'));
  // Rounding: 7 decimal places rounds half up.
  assert.equal(toMicroCny('0.0000005'), 1n);
  assert.equal(toMicroCny('0.0000004'), 0n);
});

test('toMicroCny rejects malformed input', () => {
  assert.throws(() => toMicroCny('abc'));
  assert.throws(() => toMicroCny('1.2.3'));
  assert.throws(() => toMicroCny(NaN));
  assert.throws(() => toMicroCny(Infinity));
});

test('fromMicroCny renders exact decimal strings', () => {
  assert.equal(fromMicroCny(10_000n), '0.01');
  assert.equal(fromMicroCny(0n), '0');
  assert.equal(fromMicroCny(12_000_000n), '12');
  assert.equal(fromMicroCny(25_000n), '0.025');
  assert.equal(fromMicroCny(1n), '0.000001');
});

test('sumMicro accumulates bigint totals', () => {
  assert.equal(sumMicro([10_000n, 25_000n, 0n]), 35_000n);
  assert.equal(sumMicro([]), 0n);
});

test('priceTokens rounds half up and clamps non-positive input', () => {
  // 1 token at 1 CNY/MTok = 1 micro_cny exactly.
  assert.equal(priceTokens(1, 1_000_000n), 1n);
  // 0.5 micro rounds up.
  assert.equal(priceTokens(1, 500_000n), 1n);
  // 0.4 micro rounds down.
  assert.equal(priceTokens(1, 400_000n), 0n);
  assert.equal(priceTokens(0, 1_000_000n), 0n);
  assert.equal(priceTokens(-5, 1_000_000n), 0n);
  assert.equal(priceTokens(1_000_000, 0n), 0n);
});

test('computeCost splits input / output / cache channels', () => {
  const price = {
    model: 'test',
    inputPerMTok: 2_000_000n, // 2 CNY/MTok
    outputPerMTok: 8_000_000n, // 8 CNY/MTok
    cacheReadPerMTok: 400_000n, // 0.4 CNY/MTok
    updatedAt: '2026-11-20',
    source: 'test',
  };
  const cost = computeCost(price, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 });
  assert.equal(cost.input, 2_000n); // 1000 * 2 / 1e6 * 1e6 = 2000 micro = 0.002
  assert.equal(cost.output, 4_000n);
  assert.equal(cost.cacheRead, 800n);
  assert.equal(cost.total, 6_800n);
  assert.equal(fromMicroCny(cost.total), '0.0068');
});

test('computeCost falls back to input price when cache rate is absent', () => {
  const price = {
    model: 'test',
    inputPerMTok: 1_000_000n,
    outputPerMTok: 2_000_000n,
    updatedAt: '2026-11-20',
    source: 'test',
  };
  const cost = computeCost(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
  assert.equal(cost.cacheRead, 1_000_000n);
});

test('normalizeModelId strips provider prefix, version suffix and case', () => {
  assert.equal(normalizeModelId('Qwen/Qwen3.7-Plus'), 'qwen3.7-plus');
  assert.equal(normalizeModelId('qwen3.7-plus@2026-05-26'), 'qwen3.7-plus');
  assert.equal(normalizeModelId('  DeepSeek-Chat  '), 'deepseek-chat');
  assert.equal(normalizeModelId('doubao-seed-1.6-250615'), 'doubao-seed-1.6-250615');
});

test('the built-in table is populated and dated', () => {
  assert.ok(BUILTIN_PRICES.length >= 29, `expected >= 29 models, got ${BUILTIN_PRICES.length}`);
  assert.match(PRICE_TABLE_VERSION, /^\d{4}\.\d{2}\.\d{2}$/);
  assert.match(PRICE_TABLE_UPDATED_AT, /^\d{4}-\d{2}-\d{2}$/);
  for (const p of BUILTIN_PRICES) {
    assert.ok(p.model.length > 0, 'model id must be non-empty');
    assert.ok(p.inputPerMTok >= 0n, `${p.model}: input price must be non-negative`);
    assert.ok(p.outputPerMTok >= 0n, `${p.model}: output price must be non-negative`);
    assert.match(p.updatedAt, /^\d{4}-\d{2}-\d{2}$/, `${p.model}: updatedAt must be a date`);
    assert.ok(p.source.startsWith('https://'), `${p.model}: source must be a URL`);
  }
});

test('every built-in model resolves to itself exactly', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  assert.equal(table.size, BUILTIN_PRICES.length);
  for (const p of BUILTIN_PRICES) {
    const hit = table.match(p.model);
    assert.ok(hit, `${p.model} should resolve`);
    assert.equal(hit.matchedKey, p.model);
    assert.equal(hit.exact, true);
  }
});

test('prefix matching resolves dated and versioned model ids', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  const cases = [
    ['qwen3.7-plus-2026-05-26', 'qwen3.7-plus'],
    ['qwen3.7-flash-2026-07-15', 'qwen3.7-flash'],
    ['qwen3.8-max-0902', 'qwen3.8-max'],
    ['doubao-seed-1.6-250615', 'doubao-seed-1.6'],
    ['doubao-seed-1.6-flash-250828', 'doubao-seed-1.6-flash'],
    ['doubao-pro-32k-240828', 'doubao-pro-32k'],
    ['glm-4.7-flashx-251222', 'glm-4.7-flashx'],
    ['deepseek-v4-flash-260425', 'deepseek-v4-flash'],
    ['moonshot-v1-128k', 'moonshot-v1-128k'],
    ['kimi-k2.6', 'kimi-k2.6'],
  ];
  for (const [input, expected] of cases) {
    const hit = table.match(input);
    assert.ok(hit, `${input} should resolve`);
    assert.equal(hit.matchedKey, expected, `${input} -> ${hit.matchedKey}, expected ${expected}`);
  }
});

test('longest prefix wins over a shorter competitor', () => {
  const table = new PriceTable([
    { model: 'abc', inputPerMTok: 1n, outputPerMTok: 1n, updatedAt: '2026-11-20', source: 'https://x' },
    { model: 'abc-flash', inputPerMTok: 2n, outputPerMTok: 2n, updatedAt: '2026-11-20', source: 'https://x' },
  ]);
  assert.equal(table.match('abc-flash-2026')?.matchedKey, 'abc-flash');
  assert.equal(table.match('abc-pro-2026')?.matchedKey, 'abc');
});

test('runtime overrides beat both exact and prefix matches', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  const before = table.match('qwen3.7-plus');
  assert.equal(before.price.inputPerMTok, 2_000_000n);

  table.setOverride({
    model: 'qwen3.7-plus',
    inputPerMTok: 1_000_000n,
    outputPerMTok: 4_000_000n,
    updatedAt: '2026-11-20',
    source: 'contract-rate',
  });
  const after = table.match('qwen3.7-plus');
  assert.equal(after.price.inputPerMTok, 1_000_000n);
  assert.equal(after.exact, true);

  // Prefix matches also honour the override.
  assert.equal(table.match('qwen3.7-plus-2026-05-26').price.inputPerMTok, 1_000_000n);

  assert.equal(table.clearOverride('qwen3.7-plus'), true);
  assert.equal(table.match('qwen3.7-plus').price.inputPerMTok, 2_000_000n);
  assert.equal(table.clearOverride('qwen3.7-plus'), false);
});

test('set() rejects negative or empty prices', () => {
  const table = new PriceTable();
  assert.throws(() => table.set({ model: '', inputPerMTok: 1n, outputPerMTok: 1n, updatedAt: '2026-11-20', source: 'x' }));
  assert.throws(() => table.set({ model: 'a', inputPerMTok: -1n, outputPerMTok: 1n, updatedAt: '2026-11-20', source: 'x' }));
  assert.throws(() => table.set({ model: 'a', inputPerMTok: 1n, outputPerMTok: 1n, updatedAt: 'yesterday', source: 'x' }));
});

test('unknown models return undefined rather than throwing', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  assert.equal(table.match('totally-unknown-model-xyz'), undefined);
  assert.equal(table.cost('totally-unknown-model-xyz', { inputTokens: 100, outputTokens: 100 }), undefined);
});

test('repeated pricing of the same usage is bit-identical', () => {
  // M1 exit criterion: re-pricing the same batch yields zero error.
  const table = new PriceTable(BUILTIN_PRICES);
  const usage = { inputTokens: 123_457, outputTokens: 67_891, cacheReadTokens: 9_999 };
  const first = table.cost('qwen3.7-plus', usage);
  assert.ok(first);
  for (let i = 0; i < 10_000; i += 1) {
    const again = table.cost('qwen3.7-plus', usage);
    assert.equal(again.total, first.total, `drift at iteration ${i}`);
    assert.equal(again.input, first.input);
    assert.equal(again.output, first.output);
  }
});

test('a large batch sums without float drift', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  const usage = { inputTokens: 1000, outputTokens: 500 };
  const unit = table.cost('deepseek-v4-flash', usage).total;
  const costs = [];
  for (let i = 0; i < 100_000; i += 1) costs.push(unit);
  const total = sumMicro(costs);
  assert.equal(total, unit * 100_000n);
});

test('stalePrices flags entries older than the threshold', () => {
  const table = new PriceTable([
    { model: 'old', inputPerMTok: 1n, outputPerMTok: 1n, updatedAt: '2026-01-01', source: 'https://x' },
    { model: 'fresh', inputPerMTok: 1n, outputPerMTok: 1n, updatedAt: '2026-11-20', source: 'https://x' },
  ]);
  const stale = table.stalePrices(new Date('2026-11-20T00:00:00Z'), 90);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].model, 'old');
});

test('the built-in table itself is not stale', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  const stale = table.stalePrices(new Date(`${PRICE_TABLE_UPDATED_AT}T00:00:00Z`), 1);
  assert.equal(stale.length, 0, 'every entry should carry the table date');
});

test('models() lists every registered key', () => {
  const table = new PriceTable(BUILTIN_PRICES);
  const models = table.models();
  assert.equal(models.length, BUILTIN_PRICES.length);
  assert.ok(models.includes('deepseek-v4-pro'));
});

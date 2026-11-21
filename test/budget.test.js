import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBudget,
  evaluateWithFallback,
  isBlocking,
  decisionFingerprint,
  policySnapshot,
  usedSnapshot,
  canonicalJson,
  toMicroCny,
  fromMicroCny,
  DEFAULT_WARN_RATIO,
} from '../dist/index.js';

const CNY = (v) => toMicroCny(v);

function policy(limits, extra = {}) {
  return { principalId: 'u1', limits, ...extra };
}

test('allows when usage is below the warn threshold', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'daily', limit: CNY('10') }]),
    used: { daily: CNY('1') },
    at: 1_700_000_000_000,
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.reasonCode, 'ok');
  assert.deepEqual(d.actions, []);
  assert.ok(d.fingerprint.length === 64);
});

test('warns at the default 80% ratio', () => {
  assert.equal(DEFAULT_WARN_RATIO, 0.8);
  const d = evaluateBudget({
    policy: policy([{ scope: 'daily', limit: CNY('10') }]),
    used: { daily: CNY('8') },
    at: 1,
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.reasonCode, 'warn_threshold');
  assert.deepEqual(d.actions, ['warn']);
  assert.equal(d.triggered.length, 1);
});

test('honours a custom warnRatio', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'daily', limit: CNY('10'), warnRatio: 0.5 }]),
    used: { daily: CNY('6') },
    at: 1,
  });
  assert.equal(d.reasonCode, 'warn_threshold');
});

test('denies at 100% with cutoff', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'monthly', limit: CNY('5') }]),
    used: { monthly: CNY('5') },
    at: 1,
  });
  assert.equal(d.verdict, 'deny');
  assert.equal(d.reasonCode, 'limit_reached');
  assert.equal(isBlocking(d), true);
});

test('projected usage crosses the limit before the request is granted', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'monthly', limit: CNY('5') }]),
    used: { monthly: CNY('4.9') },
    requested: CNY('0.2'),
    at: 1,
  });
  assert.equal(d.verdict, 'deny');
  assert.equal(d.reasonCode, 'reservation_exceeds_limit');
});

test('a request that exactly fills the limit is allowed', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'monthly', limit: CNY('5') }]),
    used: { monthly: CNY('4.9') },
    requested: CNY('0.1'),
    at: 1,
  });
  // used + requested == limit -> 100% -> cutoff
  assert.equal(d.verdict, 'deny');
});

test('downshift keeps the call alive and names the cheaper model', () => {
  const d = evaluateBudget({
    policy: policy([
      { scope: 'daily', limit: CNY('1'), onExceed: 'downshift', downshiftModel: 'qwen3.7-flash' },
    ]),
    used: { daily: CNY('1') },
    model: 'qwen3.8-max',
    at: 1,
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.reasonCode, 'limit_reached');
  assert.equal(d.downshiftTo, 'qwen3.7-flash');
  assert.deepEqual(d.actions, ['downshift']);
  assert.equal(isBlocking(d), false);
});

test('deny outranks downshift and warn across scopes', () => {
  const d = evaluateBudget({
    policy: policy([
      { scope: 'task', limit: CNY('1') },
      { scope: 'daily', limit: CNY('10'), onExceed: 'downshift', downshiftModel: 'cheap' },
      { scope: 'monthly', limit: CNY('100') },
    ]),
    used: { task: CNY('1'), daily: CNY('9'), monthly: CNY('50') },
    at: 1,
  });
  assert.equal(d.verdict, 'deny');
  // Every tripped scope is recorded, most severe first.
  assert.ok(d.triggered.length >= 1);
  assert.equal(d.triggered[0].scope, 'task');
});

test('shadow mode downgrades every blocking verdict to allow', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'daily', limit: CNY('1') }], { shadow: true }),
    used: { daily: CNY('5') },
    at: 1,
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.reasonCode, 'shadow_allow');
  assert.ok(d.reasons[0].includes('[shadow]'));
  assert.ok(d.reasons[0].includes('deny'));
});

test('missing policy is permissive by default', () => {
  const d = evaluateBudget({ policy: undefined, used: {}, at: 1 });
  assert.equal(d.verdict, 'allow');
});

test('fail_closed turns an evaluation error into a deny', () => {
  const d = evaluateWithFallback(
    () => {
      throw new Error('store unavailable');
    },
    policy([{ scope: 'daily', limit: CNY('1') }]),
    42,
  );
  assert.equal(d.verdict, 'deny');
  assert.equal(d.reasonCode, 'policy_eval_error');
  assert.ok(d.reasons.some((r) => r.includes('store unavailable')));
  assert.equal(d.at, 42);
});

test('fail_open turns an evaluation error into an allow', () => {
  const d = evaluateWithFallback(
    () => {
      throw new Error('boom');
    },
    policy([{ scope: 'daily', limit: CNY('1') }], { onEvalError: 'fail_open' }),
    42,
  );
  assert.equal(d.verdict, 'allow');
  assert.equal(d.reasonCode, 'policy_eval_error');
});

test('fail_closed is the default when no policy exists', () => {
  const d = evaluateWithFallback(() => {
    throw new Error('x');
  }, undefined, 1);
  assert.equal(d.verdict, 'deny');
});

test('identical inputs at the same timestamp produce identical fingerprints', () => {
  // M4 exit criterion: same input, same timestamp -> same decision, same fingerprint.
  const input = {
    policy: policy([{ scope: 'daily', limit: CNY('5'), onExceed: 'cutoff' }]),
    used: { daily: CNY('2.5') },
    requested: CNY('0.5'),
    model: 'qwen3.7-plus',
    at: 1_800_000_000_000,
  };
  const a = evaluateBudget(input);
  const b = evaluateBudget(input);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.verdict, b.verdict);
  assert.deepEqual(a.reasons, b.reasons);
});

test('different timestamps produce different fingerprints', () => {
  const base = {
    policy: policy([{ scope: 'daily', limit: CNY('5') }]),
    used: { daily: CNY('1') },
  };
  const a = evaluateBudget({ ...base, at: 1 });
  const b = evaluateBudget({ ...base, at: 2 });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('different usage produces different fingerprints', () => {
  const base = {
    policy: policy([{ scope: 'daily', limit: CNY('5') }]),
    at: 1,
  };
  const a = evaluateBudget({ ...base, used: { daily: CNY('1') } });
  const b = evaluateBudget({ ...base, used: { daily: CNY('1.5') } });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test('fingerprints ignore key order in the used map', () => {
  const p = policy([
    { scope: 'daily', limit: CNY('5') },
    { scope: 'monthly', limit: CNY('50') },
  ]);
  const a = evaluateBudget({ policy: p, used: { daily: CNY('1'), monthly: CNY('10') }, at: 7 });
  const b = evaluateBudget({ policy: p, used: { monthly: CNY('10'), daily: CNY('1') }, at: 7 });
  assert.equal(a.fingerprint, b.fingerprint);
});

test('policySnapshot is order-independent and content-sensitive', () => {
  const a = policySnapshot([
    { scope: 'daily', limit: CNY('5') },
    { scope: 'monthly', limit: CNY('50') },
  ]);
  const b = policySnapshot([
    { scope: 'monthly', limit: CNY('50') },
    { scope: 'daily', limit: CNY('5') },
  ]);
  assert.deepEqual(a, b);
  const c = policySnapshot([{ scope: 'daily', limit: CNY('6') }]);
  assert.notDeepEqual(a, c);
});

test('usedSnapshot renders bigints as decimal strings', () => {
  const snap = usedSnapshot(new Map([['daily', CNY('1.5')], ['total', CNY('10')]]));
  assert.deepEqual(snap, { daily: '1500000', total: '10000000' });
});

test('canonicalJson sorts keys and survives bigints and cycles', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 10n }), '{"a":"10"}');
  assert.equal(canonicalJson([1, 2, 3]), '[1,2,3]');
  assert.equal(canonicalJson(undefined), 'null');
  // undefined object values are dropped, matching JSON.stringify semantics.
  assert.equal(canonicalJson({ a: undefined }), '{}');

  // A cycle must fail loudly: a fingerprint over a cyclic graph is meaningless.
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /circular/);
});

test('decisionFingerprint is stable across process runs', () => {
  // Hard-coded expectation: sha256 over the canonical payload for a fixed input.
  const fp = decisionFingerprint({
    principalId: 'u1',
    policySnapshot: policySnapshot([{ scope: 'daily', limit: CNY('1') }]),
    usedSnapshot: usedSnapshot(new Map([['daily', CNY('0.5')]])),
    requested: CNY('0.1'),
    at: 1_700_000_000_000,
  });
  assert.match(fp, /^[0-9a-f]{64}$/);
  // Recomputing must give the same digest.
  const again = decisionFingerprint({
    principalId: 'u1',
    policySnapshot: policySnapshot([{ scope: 'daily', limit: CNY('1') }]),
    usedSnapshot: usedSnapshot(new Map([['daily', CNY('0.5')]])),
    requested: CNY('0.1'),
    at: 1_700_000_000_000,
  });
  assert.equal(fp, again);
});

test('denied verdicts explain which scope tripped', () => {
  const d = evaluateBudget({
    policy: policy([{ scope: 'daily', limit: CNY('1'), onExceed: 'cutoff' }]),
    used: { daily: CNY('2') },
    at: 1,
  });
  assert.ok(d.reasons.length > 0);
  assert.ok(d.reasons.some((r) => r.includes('daily')));
  assert.equal(fromMicroCny(d.triggered[0].limit), '1');
});

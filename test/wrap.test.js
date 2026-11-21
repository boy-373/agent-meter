import test from 'node:test';
import assert from 'node:assert/strict';

import { Meter, MemoryStore, BUILTIN_PRICES, toMicroCny, fromMicroCny } from '../dist/index.js';

const CNY = (v) => toMicroCny(v);

function freshMeter(limits) {
  const meter = new Meter({ store: new MemoryStore(), prices: BUILTIN_PRICES });
  meter.setPolicy({
    principalId: 'u1',
    limits: limits ?? [{ scope: 'total', limit: CNY('10.00'), onExceed: 'cutoff' }],
  });
  return meter;
}

/** A fake provider response in OpenAI shape. */
function fakeResponse(inputTokens = 1200, outputTokens = 480) {
  return {
    choices: [{ message: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  };
}

test('wrapCall reserves, calls, prices, and settles', async () => {
  const meter = freshMeter();
  let called = false;
  const { result, record, usage } = await meter.wrapCall(
    async () => {
      called = true;
      return fakeResponse();
    },
    { principalId: 'u1', taskId: 't1', model: 'qwen3.7-plus', estimate: CNY('0.20') },
  );

  assert.equal(called, true);
  assert.equal(result.choices[0].message.content, 'hello');
  assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 480 });
  assert.equal(record.cost, CNY('0.00624'));
  assert.equal(fromMicroCny(await meter.used('u1', 'total')), '0.00624');
  assert.equal(record.meta.usageShape, 'openai');
  assert.equal(record.meta.usagePath, 'usage');
});

test('wrapCall does not call the model when the budget denies the hold', async () => {
  const meter = freshMeter([{ scope: 'total', limit: CNY('0.01'), onExceed: 'cutoff' }]);
  let called = false;
  await assert.rejects(
    () =>
      meter.wrapCall(
        async () => {
          called = true;
          return fakeResponse();
        },
        { principalId: 'u1', model: 'qwen3.7-plus', estimate: CNY('0.20') },
      ),
    /budget/i,
  );
  assert.equal(called, false, 'the model must not run when the hold is denied');
  assert.equal(await meter.used('u1', 'total'), 0n);
});

test('wrapCall releases the hold when the call throws', async () => {
  const meter = freshMeter();
  await assert.rejects(
    () =>
      meter.wrapCall(
        async () => {
          throw new Error('upstream 500');
        },
        { principalId: 'u1', model: 'qwen3.7-plus', estimate: CNY('0.20') },
      ),
    /upstream 500/,
  );
  // Nothing was recorded and nothing is still held.
  assert.equal(await meter.used('u1', 'total'), 0n);
  assert.equal((await meter.query({ principalId: 'u1' })).length, 0);
});

test('wrapCall books zero and flags usageMissing when no counts are found', async () => {
  const meter = freshMeter();
  const { record, usage } = await meter.wrapCall(async () => ({ choices: [{ message: { content: 'x' } }] }), {
    principalId: 'u1',
    taskId: 't2',
    model: 'qwen3.7-plus',
    estimate: CNY('0.20'),
  });
  assert.equal(usage, undefined);
  assert.equal(record.cost, 0n);
  assert.equal(record.meta.usageMissing, true);
  assert.equal(await meter.used('u1', 'total'), 0n);
});

test('wrapCall flags unpriced when the model is not in the table', async () => {
  const meter = freshMeter();
  const { record } = await meter.wrapCall(async () => fakeResponse(), {
    principalId: 'u1',
    model: 'no-such-model-xyz',
    estimate: CNY('0.20'),
  });
  assert.equal(record.cost, 0n);
  assert.equal(record.meta.unpriced, true);
  assert.equal(record.usage.inputTokens, 1200);
});

test('wrapCall throws after writing the record when the real cost exceeds the hold', async () => {
  const meter = freshMeter();
  let thrown;
  try {
    await meter.wrapCall(async () => fakeResponse(), {
      principalId: 'u1',
      taskId: 't3',
      model: 'qwen3.7-plus',
      estimate: CNY('0.001'), // 1000 micro, actual is 6240 micro
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected an error');
  assert.match(thrown.message, /exceeds the/);
  assert.equal(thrown.record.cost, CNY('0.00624'));

  // The spend is real, so it stays on the ledger; the hold is gone.
  assert.equal(fromMicroCny(await meter.used('u1', 'total')), '0.00624');
  const records = await meter.query({ principalId: 'u1' });
  assert.equal(records.length, 1);
});

test('wrapCall rejects a non-positive estimate up front', async () => {
  const meter = freshMeter();
  await assert.rejects(
    () => meter.wrapCall(async () => fakeResponse(), { principalId: 'u1', estimate: 0n }),
    /estimate must be a positive/,
  );
});

test('wrapCall honours timeoutMs and releases the hold', async () => {
  const meter = freshMeter();
  await assert.rejects(
    () =>
      meter.wrapCall(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
        { principalId: 'u1', model: 'qwen3.7-plus', estimate: CNY('0.20'), timeoutMs: 30 },
      ),
    /timed out after 30ms/,
  );
  assert.equal(await meter.used('u1', 'total'), 0n);
});

test('wrapCall writes the audit record exactly once', async () => {
  const meter = freshMeter();
  const seen = [];
  await meter.wrapCall(async () => fakeResponse(), {
    principalId: 'u1',
    taskId: 't4',
    model: 'qwen3.7-plus',
    estimate: CNY('0.20'),
    onRecord: (r) => seen.push(r),
  });
  assert.equal(seen.length, 1);
  assert.equal((await meter.query({ principalId: 'u1' })).length, 1, 'no duplicate record from settle');
});

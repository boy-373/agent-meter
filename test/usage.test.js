import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUsage, extractUsageWithProvenance } from '../dist/index.js';

test('OpenAI shape: prompt/completion with cached detail subtracted', () => {
  const res = {
    id: 'chatcmpl-1',
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 480,
      total_tokens: 1680,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  };
  const u = extractUsage(res);
  assert.deepEqual(u, { inputTokens: 400, outputTokens: 480, cacheReadTokens: 800 });
});

test('OpenAI shape without cached detail leaves input untouched', () => {
  const u = extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 20 } });
  assert.deepEqual(u, { inputTokens: 100, outputTokens: 20 });
});

test('DeepSeek shape prefers the cache hit/miss split', () => {
  const res = {
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 480,
      prompt_cache_hit_tokens: 1000,
      prompt_cache_miss_tokens: 200,
    },
  };
  const hit = extractUsageWithProvenance(res);
  assert.equal(hit.shape, 'deepseek');
  assert.deepEqual(hit.usage, { inputTokens: 200, outputTokens: 480, cacheReadTokens: 1000 });
});

test('DeepSeek shape falls back to prompt_tokens minus hit when miss is absent', () => {
  const u = extractUsage({
    usage: { prompt_tokens: 500, completion_tokens: 50, prompt_cache_hit_tokens: 300 },
  });
  assert.deepEqual(u, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 300 });
});

test('Anthropic shape keeps cache read and write separate', () => {
  const res = {
    usage: {
      input_tokens: 300,
      output_tokens: 120,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 150,
    },
  };
  const u = extractUsage(res);
  assert.deepEqual(u, {
    inputTokens: 300,
    outputTokens: 120,
    cacheReadTokens: 900,
    cacheWriteTokens: 150,
  });
});

test('Gemini shape uses usageMetadata and subtracts cached content', () => {
  const res = {
    usageMetadata: {
      promptTokenCount: 2000,
      candidatesTokenCount: 300,
      cachedContentTokenCount: 1500,
    },
  };
  const u = extractUsage(res);
  assert.deepEqual(u, { inputTokens: 500, outputTokens: 300, cacheReadTokens: 1500 });
});

test('DashScope native shape lives under output.usage', () => {
  const res = { output: { usage: { input_tokens: 77, output_tokens: 33 } } };
  const hit = extractUsageWithProvenance(res);
  assert.equal(hit.path, 'output.usage');
  assert.deepEqual(hit.usage, { inputTokens: 77, outputTokens: 33 });
});

test('Ollama shape uses prompt_eval_count / eval_count', () => {
  const u = extractUsage({ prompt_eval_count: 64, eval_count: 16 });
  assert.deepEqual(u, { inputTokens: 64, outputTokens: 16 });
});

test('array payload takes the last element that carries usage', () => {
  const chunks = [
    { choices: [{ delta: { content: 'hi' } }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const u = extractUsage(chunks);
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 5 });
});

test('a payload with no usage returns undefined, not zeros', () => {
  assert.equal(extractUsage({ choices: [{ message: { content: 'hi' } }] }), undefined);
  assert.equal(extractUsage(null), undefined);
  assert.equal(extractUsage('nope'), undefined);
  assert.equal(extractUsage({ usage: {} }), undefined);
});

test('numeric strings are accepted', () => {
  const u = extractUsage({ usage: { prompt_tokens: '120', completion_tokens: '30' } });
  assert.deepEqual(u, { inputTokens: 120, outputTokens: 30 });
});

test('negative and non-finite counts are rejected', () => {
  assert.equal(extractUsage({ usage: { prompt_tokens: -1, completion_tokens: 10 } }), undefined);
  assert.equal(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: NaN } }), undefined);
});

test('a cached count larger than the prompt total clamps input to zero', () => {
  const u = extractUsage({
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 500 } },
  });
  assert.equal(u.inputTokens, 0);
  assert.equal(u.cacheReadTokens, 500);
});

test('provenance reports the shape that matched', () => {
  assert.equal(extractUsageWithProvenance({ usage: { input_tokens: 1, output_tokens: 1 } }).shape, 'anthropic');
  assert.equal(extractUsageWithProvenance({ usage: { prompt_tokens: 1, completion_tokens: 1 } }).shape, 'openai');
  assert.equal(
    extractUsageWithProvenance({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }).shape,
    'gemini',
  );
});

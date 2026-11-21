/**
 * Built-in price table for Chinese LLM providers.
 *
 * All prices are in **CNY per 1,000,000 tokens**, converted to integer
 * `micro_cny` at load time. Every entry carries the `source` URL it was read
 * from and the date it was read, so `PriceTable.stalePrices()` can flag entries
 * that have drifted past a freshness threshold.
 *
 * ## Read this before trusting a number
 *
 * Vendor pricing changes constantly — promotions, tiered context pricing,
 * batch discounts, cache-hit rates. This table stores **tier 1** (the shortest
 * context band, no batch, no cache) as the single reference rate for each
 * model. When a vendor charges by context length, the `note` field records the
 * higher bands. For production billing you should:
 *
 *   1. Run `PriceTable.stalePrices()` on a schedule and refresh.
 *   2. Prefer provider-reported cost (`costIsAuthoritative: true`) when the
 *      vendor returns one, instead of re-deriving it locally.
 *   3. Override any entry with `prices.setOverride({...})` without forking.
 *
 * Every figure below was read from the vendor's own pricing page on
 * {@link PRICE_TABLE_UPDATED_AT}.
 */

import { toMicroCny, type ModelPrice } from '../core/types.js';

const cny = (value: string | number): bigint => toMicroCny(value);

/** Table schema version; bump when the shape or semantics change. */
export const PRICE_TABLE_VERSION = '2026.11.20';

/** Date (UTC) the figures below were read from the vendors' pricing pages. */
export const PRICE_TABLE_UPDATED_AT = '2026-11-20';

const SRC = {
  bailian: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  deepseek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  ark: 'https://www.volcengine.com/docs/82379/1544106',
  bigmodel: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
  kimi: 'https://platform.kimi.com/docs/pricing/chat-v1',
  minimax: 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
} as const;

const UPDATED = PRICE_TABLE_UPDATED_AT;

function entry(
  model: string,
  inputPerMTok: string | number,
  outputPerMTok: string | number,
  source: string,
  extra: Partial<ModelPrice> = {},
): ModelPrice {
  const price: ModelPrice = {
    model,
    inputPerMTok: cny(inputPerMTok),
    outputPerMTok: cny(outputPerMTok),
    updatedAt: UPDATED,
    source,
  };
  if (extra.cacheReadPerMTok !== undefined) price.cacheReadPerMTok = extra.cacheReadPerMTok;
  if (extra.cacheWritePerMTok !== undefined) price.cacheWritePerMTok = extra.cacheWritePerMTok;
  if (extra.note !== undefined) price.note = extra.note;
  return price;
}

/**
 * Alibaba Cloud Model Studio (DashScope / Bailian), China mainland.
 * Tiered by input length; tier 1 shown.
 */
const QWEN: ModelPrice[] = [
  entry('qwen3.8-max', '12', '36', SRC.bailian, {
    note: 'Flagship 2.4T MoE. Tiered: 32K-256K 18/54, 256K-1M 36/108. Cache read 1.5.',
  }),
  entry('qwen3.7-max', '12', '36', SRC.bailian, {
    note: 'Tiered by input length; 256K context. Cache read ~1.5.',
  }),
  entry('qwen3.7-plus', '2', '8', SRC.bailian, {
    note: 'Multimodal agent model. Tiered: 256K band 4/16. Cache read ~0.4.',
  }),
  entry('qwen3.7-flash', '0.2', '0.8', SRC.bailian, {
    note: 'Tiered: 32K-256K 0.6/2.4, 256K-1M 1.2/4.8. Batch is half price.',
  }),
  entry('qwen3.8-2.4t-a95b', '3', '12', SRC.bailian, {
    note: 'Open-weight 2.4T MoE flagship (Aug 2026). 1M context.',
  }),
  entry('qwen3-vl-plus', '1', '10', SRC.bailian, {
    note: 'Vision-language. Tiered: 32K-128K 1.5/15, 128K-256K 3/30. Cache read 0.2/0.3/0.6.',
  }),
  entry('qwen3-vl-flash', '0.6', '6', SRC.bailian, {
    note: 'Vision-language, 128K. Cache read 0.12.',
  }),
  entry('qwen3-coder-plus', '4', '16', SRC.bailian, {
    note: 'Tiered: 32K 6/24, 128K 10/40, 256K 20/200. Cache read 0.8.',
  }),
  entry('qwen3-coder-flash', '1', '4', SRC.bailian, {
    note: 'Tiered: 32K 1.5/6, 128K 2.5/10, 256K 5/50. Cache read 0.2.',
  }),
  entry('qwen-vl-plus', '0.8', '2', SRC.bailian, {
    note: 'Legacy vision model, no tiering.',
  }),
  entry('qwen-mt-plus', '1.8', '5.4', SRC.bailian, {
    note: 'Translation model.',
  }),
  entry('qwen-mt-flash', '0.7', '1.95', SRC.bailian, {
    note: 'Translation model.',
  }),
];

/**
 * DeepSeek. `deepseek-chat` / `deepseek-reasoner` are legacy aliases that map
 * to the non-thinking / thinking modes of `deepseek-v4-flash`.
 */
const DEEPSEEK: ModelPrice[] = [
  entry('deepseek-v4-flash', '1', '2', SRC.deepseek, {
    cacheReadPerMTok: cny('0.02'),
    note: '1M context, 384K max output. Cache hit is 1/50 of miss price.',
  }),
  entry('deepseek-v4-pro', '3', '6', SRC.deepseek, {
    cacheReadPerMTok: cny('0.025'),
    note: '1M context. Promo pricing settled at 1/4 of list (3/6); cache hit 0.025.',
  }),
  entry('deepseek-chat', '1', '2', SRC.deepseek, {
    cacheReadPerMTok: cny('0.02'),
    note: 'Legacy alias -> deepseek-v4-flash, non-thinking mode. Deprecated name.',
  }),
  entry('deepseek-reasoner', '1', '2', SRC.deepseek, {
    cacheReadPerMTok: cny('0.02'),
    note: 'Legacy alias -> deepseek-v4-flash, thinking mode. Deprecated name.',
  }),
];

/**
 * ByteDance Volcano Ark (Doubao). Ark bills by input-length band with a
 * separate short-output / long-output split on the 1.6 generation.
 */
const DOUBAO: ModelPrice[] = [
  entry('doubao-pro-32k', '0.8', '2', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
    note: 'Mainline 32K. Cache storage 0.017/MTok/hour.',
  }),
  entry('doubao-pro-128k', '5', '9', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
  }),
  entry('doubao-lite-32k', '0.3', '0.6', SRC.ark, {
    cacheReadPerMTok: cny('0.06'),
  }),
  entry('doubao-lite-128k', '0.8', '1', SRC.ark, {
    cacheReadPerMTok: cny('0.06'),
  }),
  entry('doubao-1.5-pro-32k', '0.8', '2', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
  }),
  entry('doubao-1.5-lite-32k', '0.15', '0.3', SRC.ark, {
    cacheReadPerMTok: cny('0.06'),
  }),
  entry('doubao-1.5-pro-256k', '5', '9', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
  }),
  entry('doubao-seed-1.6', '0.8', '2', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
    note: 'Short output (<=200 tok) band. Long output 8.00. Bands: 32K-128K 1.2/16, 128K-256K 2.4/24.',
  }),
  entry('doubao-seed-1.6-thinking', '0.8', '8', SRC.ark, {
    cacheReadPerMTok: cny('0.16'),
    note: 'Thinking mode. Bands: 32K-128K 1.2/16, 128K-256K 2.4/24.',
  }),
  entry('doubao-seed-1.6-flash', '0.15', '1.5', SRC.ark, {
    cacheReadPerMTok: cny('0.03'),
    note: 'Bands: 32K-128K 0.3/3.',
  }),
  entry('doubao-seed-evolving', '6', '30', SRC.ark, {
    cacheReadPerMTok: cny('1.2'),
    note: 'Cache storage 0.017/MTok/hour.',
  }),
];

/**
 * Zhipu AI (BigModel). GLM prices split on both input band and output length
 * for the 4.7 generation; tier 1 (short input, short output) shown.
 */
const GLM: ModelPrice[] = [
  entry('glm-5', '4', '18', SRC.bigmodel, {
    cacheReadPerMTok: cny('1'),
    note: 'Input [0,32K).',
  }),
  entry('glm-4.7', '2', '8', SRC.bigmodel, {
    cacheReadPerMTok: cny('0.4'),
    note: 'Short output band. Long output (>=0.2K) 3/14; input [32K,200K) 4/16.',
  }),
  entry('glm-4.7-flashx', '0.5', '3', SRC.bigmodel, {
    cacheReadPerMTok: cny('0.1'),
    note: '200K context.',
  }),
  entry('glm-4.7-flash', '0', '0', SRC.bigmodel, {
    cacheReadPerMTok: 0n,
    note: 'Free tier. 200K context.',
  }),
  entry('glm-4.5-air', '0.8', '2', SRC.bigmodel, {
    cacheReadPerMTok: cny('0.16'),
    note: 'Short output band. Long output 0.8/6; input [32K,128K) 1.2/8.',
  }),
  entry('glm-4-plus', '5', '5', SRC.bigmodel, {
    cacheReadPerMTok: cny('2.5'),
    note: '128K context, flat rate.',
  }),
  entry('glm-4-air', '0.5', '0.5', SRC.bigmodel, {
    cacheReadPerMTok: cny('0.25'),
    note: 'GLM-4-Air-250414, 128K.',
  }),
  entry('glm-4-long', '1', '1', SRC.bigmodel, {
    cacheReadPerMTok: cny('0.5'),
    note: '1M context.',
  }),
  entry('glm-4.6v', '1', '3', SRC.bigmodel, {
    note: 'Vision. Input [32K,128K) 2/6.',
  }),
];

/** Moonshot AI (Kimi). */
const KIMI: ModelPrice[] = [
  entry('kimi-k2.6', '6.5', '27', SRC.kimi, {
    cacheReadPerMTok: cny('1.1'),
    note: '256K context. Strong long-horizon coding / agent execution.',
  }),
  entry('kimi-k2.5', '4', '21', SRC.kimi, {
    cacheReadPerMTok: cny('0.7'),
    note: '256K. Vision + text, thinking / non-thinking.',
  }),
  entry('moonshot-v1-8k', '2', '10', SRC.kimi, {
    note: 'Legacy V1 generation, 8K window.',
  }),
  entry('moonshot-v1-32k', '5', '20', SRC.kimi, {
    note: 'Legacy V1 generation, 32K window.',
  }),
  entry('moonshot-v1-128k', '10', '30', SRC.kimi, {
    note: 'Legacy V1 generation, 128K window.',
  }),
];

/** MiniMax. M3 has a permanent 50% discount; the discounted rate is stored. */
const MINIMAX: ModelPrice[] = [
  entry('minimax-m3', '2.1', '8.4', SRC.minimax, {
    cacheReadPerMTok: cny('0.42'),
    note: '<=512K input, permanent 50% off list (4.20/16.80). >512K: 4.20/16.80 discounted from 8.40/33.60.',
  }),
  entry('minimax-m2.7', '2.1', '8.4', SRC.minimax, {
    cacheReadPerMTok: cny('0.42'),
    cacheWritePerMTok: cny('2.625'),
  }),
  entry('minimax-abab8', '2', '6', SRC.minimax, {
    note: '256K context, linear MoE. Listed rate as of 2026-03-15; verify on platform.',
  }),
];

/**
 * The built-in table: 40 models across six Chinese providers.
 * Pass this to `new PriceTable(BUILTIN_PRICES)` — `Meter` does it for you.
 */
export const BUILTIN_PRICES: readonly ModelPrice[] = [
  ...QWEN,
  ...DEEPSEEK,
  ...DOUBAO,
  ...GLM,
  ...KIMI,
  ...MINIMAX,
];

/** Grouped view, useful for docs and CLI listings. */
export const PRICES_BY_PROVIDER = {
  qwen: QWEN,
  deepseek: DEEPSEEK,
  doubao: DOUBAO,
  glm: GLM,
  kimi: KIMI,
  minimax: MINIMAX,
} as const;

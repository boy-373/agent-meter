#!/usr/bin/env node
/**
 * agent-meter CLI — inspect price tables, usage and budgets without writing code.
 *
 *   agent-meter models [--json]
 *   agent-meter price <model> --input 1200 --output 800
 *   agent-meter used --principal <id> [--scope daily|monthly|total|task] [--task <id>] [--store ./data/usage.jsonl]
 *   agent-meter summary [--principal <id>] [--store ./data/usage.jsonl] [--json]
 *   agent-meter budget --principal <id> --limit 5 [--scope monthly] [--store ...]
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { PriceTable } from '../core/price.js';
import { computeCost } from '../core/price.js';
import { BUILTIN_PRICES, PRICE_TABLE_VERSION, PRICE_TABLE_UPDATED_AT } from '../data/model-prices.js';
import { MemoryStore } from '../store/memory.js';
import { JsonlStore } from '../store/jsonl.js';
import { scopeWindow, type Store } from '../store/types.js';
import { evaluateBudget } from '../core/budget.js';
import { toMicroCny, fromMicroCny, type BudgetScope } from '../core/types.js';

const HELP = `agent-meter — budget enforcement and usage metering for AI agents

USAGE
  agent-meter <command> [options]

COMMANDS
  models                     List every model in the built-in price table
  price <model>              Price a token usage against the table
  used                       Show consumed amount for a principal
  summary                    Aggregate stored usage records
  budget                     Evaluate a budget limit against current usage
  help                       Show this message

COMMON OPTIONS
  --store <path>             JSONL journal path (omit to read nothing)
  --json                     Machine-readable output
  --principal <id>           Principal / user id
  --scope <s>                task | daily | monthly | total (default: total)
  --task <id>                Task id (required for --scope task)
  --input <n>                Input tokens
  --output <n>               Output tokens
  --cache-read <n>           Cache-hit input tokens
  --limit <cny>              Budget limit in CNY, e.g. 5 or 0.5
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function openStore(path: string | undefined): Promise<Store> {
  if (!path) return new MemoryStore();
  if (!existsSync(path)) return new MemoryStore();
  return new JsonlStore({ path });
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  for (const row of rows) {
    process.stdout.write(
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ') + '\n',
    );
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      store: { type: 'string' },
      json: { type: 'boolean', default: false },
      principal: { type: 'string', short: 'p' },
      scope: { type: 'string', short: 's' },
      task: { type: 'string', short: 't' },
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      'cache-read': { type: 'string', short: 'c' },
      limit: { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];

  if (!command || command === 'help' || values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'models') {
    const table = new PriceTable(BUILTIN_PRICES);
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            version: PRICE_TABLE_VERSION,
            updatedAt: PRICE_TABLE_UPDATED_AT,
            models: BUILTIN_PRICES.map((p) => ({
              model: p.model,
              inputPerMTok: fromMicroCny(p.inputPerMTok),
              outputPerMTok: fromMicroCny(p.outputPerMTok),
              cacheReadPerMTok: p.cacheReadPerMTok === undefined ? null : fromMicroCny(p.cacheReadPerMTok),
              source: p.source,
              updatedAt: p.updatedAt,
              note: p.note ?? null,
            })),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    const rows: string[][] = [['MODEL', 'IN / MTok', 'OUT / MTok', 'CACHE HIT']];
    for (const p of BUILTIN_PRICES) {
      rows.push([
        p.model,
        fromMicroCny(p.inputPerMTok),
        fromMicroCny(p.outputPerMTok),
        p.cacheReadPerMTok === undefined ? '-' : fromMicroCny(p.cacheReadPerMTok),
      ]);
    }
    rows.push([]);
    rows.push([`${table.size} models`, `table ${PRICE_TABLE_VERSION}`, `read ${PRICE_TABLE_UPDATED_AT}`]);
    printTable(rows);
    return;
  }

  if (command === 'price') {
    const model = positionals[1];
    if (!model) fail('price requires a model name, e.g. `agent-meter price qwen3.7-plus`');
    const table = new PriceTable(BUILTIN_PRICES);
    const hit = table.match(model);
    if (!hit) fail(`unknown model "${model}" — run \`agent-meter models\` to see the table`);
    const usage = {
      inputTokens: Number(values.input ?? 0),
      outputTokens: Number(values.output ?? 0),
      ...(values['cache-read'] ? { cacheReadTokens: Number(values['cache-read']) } : {}),
    };
    const cost = computeCost(hit.price, usage);
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            model,
            matchedKey: hit.matchedKey,
            exact: hit.exact,
            usage,
            cost: {
              input: fromMicroCny(cost.input),
              output: fromMicroCny(cost.output),
              cacheRead: fromMicroCny(cost.cacheRead),
              cacheWrite: fromMicroCny(cost.cacheWrite),
              total: fromMicroCny(cost.total),
            },
            totalMicroCny: cost.total.toString(),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    process.stdout.write(
      [
        `model        ${model}  (matched "${hit.matchedKey}"${hit.exact ? '' : ', prefix'})`,
        `input        ${usage.inputTokens} tok  ->  ${fromMicroCny(cost.input)} CNY`,
        `output       ${usage.outputTokens} tok  ->  ${fromMicroCny(cost.output)} CNY`,
        `cache read   ${usage.cacheReadTokens ?? 0} tok  ->  ${fromMicroCny(cost.cacheRead)} CNY`,
        `total        ${fromMicroCny(cost.total)} CNY  (${cost.total} micro_cny)`,
      ].join('\n') + '\n',
    );
    return;
  }

  if (command === 'used') {
    const principal = values.principal;
    if (!principal) fail('used requires --principal <id>');
    const scope = (values.scope ?? 'total') as BudgetScope;
    if (!['task', 'daily', 'monthly', 'total'].includes(scope)) fail(`invalid --scope "${scope}"`);
    if (scope === 'task' && !values.task) fail('--scope task requires --task <id>');
    const store = await openStore(values.store);
    const window = scopeWindow(scope, { now: Date.now(), ...(values.task ? { taskId: values.task } : {}) });
    const amount = await store.used(principal, window);
    const held = await store.held(principal, window);
    await store.close?.();
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            principal,
            scope,
            from: new Date(window.from).toISOString(),
            to: new Date(window.to).toISOString(),
            used: fromMicroCny(amount),
            held: fromMicroCny(held),
            usedMicroCny: amount.toString(),
            heldMicroCny: held.toString(),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    process.stdout.write(
      [
        `principal  ${principal}`,
        `scope      ${scope}`,
        `used       ${fromMicroCny(amount)} CNY`,
        `held       ${fromMicroCny(held)} CNY`,
      ].join('\n') + '\n',
    );
    return;
  }

  if (command === 'summary') {
    const store = await openStore(values.store);
    const summary = await store.summary({
      ...(values.principal ? { principalId: values.principal } : {}),
    });
    await store.close?.();
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            count: summary.count,
            cost: fromMicroCny(summary.cost),
            inputTokens: summary.inputTokens,
            outputTokens: summary.outputTokens,
            byModel: Object.fromEntries(
              Object.entries(summary.byModel).map(([k, v]) => [k, { count: v.count, cost: fromMicroCny(v.cost) }]),
            ),
            byKind: Object.fromEntries(
              Object.entries(summary.byKind).map(([k, v]) => [k, { count: v.count, cost: fromMicroCny(v.cost) }]),
            ),
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    process.stdout.write(
      [
        `records    ${summary.count}`,
        `cost       ${fromMicroCny(summary.cost)} CNY`,
        `tokens     ${summary.inputTokens} in / ${summary.outputTokens} out`,
        '',
      ].join('\n'),
    );
    const rows: string[][] = [['MODEL', 'COUNT', 'COST CNY']];
    for (const [model, v] of Object.entries(summary.byModel).sort((a, b) => (b[1].cost > a[1].cost ? 1 : -1))) {
      rows.push([model, String(v.count), fromMicroCny(v.cost)]);
    }
    printTable(rows);
    return;
  }

  if (command === 'budget') {
    const principal = values.principal;
    if (!principal) fail('budget requires --principal <id>');
    if (!values.limit) fail('budget requires --limit <cny>, e.g. --limit 5');
    const scope = (values.scope ?? 'monthly') as BudgetScope;
    const store = await openStore(values.store);
    const window = scopeWindow(scope, { now: Date.now(), ...(values.task ? { taskId: values.task } : {}) });
    const used = await store.used(principal, window);
    const held = await store.held(principal, window);
    await store.close?.();
    const limit = toMicroCny(values.limit);
    const decision = evaluateBudget({
      policy: {
        principalId: principal,
        limits: [{ scope, limit, warnRatio: 0.8, onExceed: 'cutoff' }],
      },
      used: { [scope]: used + held },
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
      return;
    }
    process.stdout.write(
      [
        `principal  ${principal}`,
        `scope      ${scope}`,
        `used       ${fromMicroCny(used + held)} / ${fromMicroCny(limit)} CNY`,
        `verdict    ${decision.verdict}  (${decision.reasonCode})`,
        `fingerprint ${decision.fingerprint}`,
      ].join('\n') + '\n',
    );
    return;
  }

  fail(`unknown command "${command}" — run \`agent-meter help\``);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Keep `readFile` referenced for future `--from` support without tripping lint.
void readFile;

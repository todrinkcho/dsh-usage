/*
 * Host-side integration check for the model-share payload.
 *
 * Loads the real @todrink/dsh-usage host half, boots it against a minimal
 * Cordis stand-in and drives its own HTTP route with a Connection envelope, so
 * the numbers below come from the production code path over real local logs.
 * Run with the DSH runtime Node (it carries zstd):
 *   <resources>/runtime/primary-runtime/dependencies/node/bin/node.exe _verify/host-models.mjs
 */
import { apply } from '../index.js';

const routes = [];
const ctx = {
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  connection: { admit: () => ({ ok: true }) },
  get: () => undefined,
};

apply(ctx, { budgetCny: 100, debugFile: '', devReload: false });
const route = routes.find((entry) => entry.path === '/usage-stats');
if (!route) throw new Error('usage-stats route not registered');

async function call(endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'verify', method: endpoint, payload });
  const req = {
    url: `/usage-stats/${endpoint}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
  const res = {
    headersSent: false,
    writeHead(code, headers) {
      this.status = code;
      this.headers = headers;
      this.headersSent = true;
    },
    end(text) {
      this.text = text;
    },
  };
  await route.handler(req, res);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${String(res.text).slice(0, 200)}`);
  const envelope = JSON.parse(res.text);
  if (envelope.type !== 'server-response') throw new Error('unexpected envelope');
  if (!envelope.result.ok) throw new Error('call failed: ' + JSON.stringify(envelope.result.error));
  return envelope.result.value;
}

const started = Date.now();
const overview = await call('overview', { days: 30 });
const daily = overview.modelDaily;
if (!Array.isArray(daily) || daily.length === 0) throw new Error('modelDaily missing from the payload');

const problems = [];
const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
const beijingKey = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const today = beijingKey(Date.now());
const startOf = (days) => beijingKey(Date.now() - (days - 1) * 86400_000);

/* 1. every bucket is provider × model, unique per day ---------------------- */
for (const day of daily) {
  const keys = day.models.map((entry) => `${entry.provider}\u0000${entry.model}`);
  if (new Set(keys).size !== keys.length) problems.push(`${day.date}: duplicate provider/model bucket`);
  if (day.models.some((entry) => typeof entry.provider !== 'string')) problems.push(`${day.date}: bucket without provider`);
  if (day.models.some((entry) => !Number.isFinite(entry.totalTokens))) problems.push(`${day.date}: non-numeric tokens`);
}

/* 2. the daily buckets add up to the timeline (same events, same filter) --- */
const sumModels = (rows) => rows.reduce((acc, entry) => acc + entry.totalTokens, 0);
const sumEvents = (rows) => rows.reduce((acc, entry) => acc + entry.events, 0);
const modelTokens = daily.reduce((acc, day) => acc + sumModels(day.models), 0);
const modelEvents = daily.reduce((acc, day) => acc + sumEvents(day.models), 0);
const timelineTokens = overview.timeline.daily.reduce((acc, day) => acc + day.tokens.total, 0);
const timelineEvents = overview.timeline.daily.reduce((acc, day) => acc + day.events, 0);
if (modelTokens !== timelineTokens) problems.push(`tokens: modelDaily ${modelTokens} != timeline ${timelineTokens}`);
if (modelEvents !== timelineEvents) problems.push(`events: modelDaily ${modelEvents} != timeline ${timelineEvents}`);

/* 3. per-day cost agrees with the timeline day bucket --------------------- */
for (const day of daily) {
  const timelineDay = overview.timeline.daily.find((entry) => entry.date === day.date);
  if (!timelineDay) {
    problems.push(`${day.date}: day missing from the timeline`);
    continue;
  }
  const cost = day.models.reduce((acc, entry) => acc + entry.costCny, 0);
  if (!near(cost, timelineDay.costCny, 1e-3)) problems.push(`${day.date}: cost ${cost} != ${timelineDay.costCny}`);
}

/* 4. windows the browser can ask for are non-empty and ordered -------------- */
const windows = [3, 7, 14, 30];
const summary = [];
for (const days of windows) {
  const from = days === 0 ? '' : startOf(days);
  const rows = daily.filter((day) => from === '' || day.date >= from);
  const tokens = rows.reduce((acc, day) => acc + sumModels(day.models), 0);
  const cost = rows.reduce((acc, day) => acc + day.models.reduce((sum, entry) => sum + entry.costCny, 0), 0);
  summary.push({ window: days, from: from || '(all)', activeDays: rows.length, tokens, cost: Math.round(cost * 100) / 100 });
  if (tokens <= 0) problems.push(`${days}d window has no tokens`);
  if (from !== '' && rows.some((day) => day.date < from)) problems.push(`${days}d window includes an older day`);
}
if (!daily.some((day) => day.date === today)) problems.push('today has no bucket (expected when running late at night)');

console.log(`scan took ${((Date.now() - started) / 1000).toFixed(1)}s · days=${daily.length} · rows today=${daily.at(-1)?.models.length ?? 0}`);
for (const row of summary) {
  console.log(`  window ${String(row.window).padStart(2)}d  from ${row.from}  activeDays=${String(row.activeDays).padStart(2)}  tokens=${String(row.tokens).padStart(11)}  ¥${row.cost}`);
}
const latest = daily.at(-1);
for (const entry of latest.models.slice(0, 8)) {
  const share = (100 * entry.totalTokens) / sumModels(latest.models);
  console.log(`  ${entry.date ?? latest.date}  ${(entry.provider || '(none)').padEnd(18)} ${entry.model.padEnd(30)} ${share.toFixed(1).padStart(5)}%  ¥${entry.costCny}`);
}

if (problems.length > 0) {
  console.error('FAIL:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('host model-share checks: PASS');

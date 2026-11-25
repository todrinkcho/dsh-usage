/**
 * @todrink/dsh-usage — Host half.
 *
 * Reads the Harness's real local session data (projection cache + committed
 * session logs), estimates cost with the official DeepSeek CNY price list
 * (peak / off-peak), samples CPU and memory, and serves it to the Client half
 * through an authenticated HTTP prefix route.
 *
 * Reads are confined to $DSH_HOME. The only writes are the optional debug
 * snapshot configured by `debugFile` (empty by default; development only).
 */
import { readFile, readdir, stat, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, cpus, totalmem, freemem, uptime as osUptime, platform, release, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { createHash } from 'node:crypto';

const zstdDecompressSync =
  typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined;

const NS = 'usage-stats';
const CHANNEL = '/usage-stats';
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai, no DST
const HOUR_MS = 60 * 60 * 1000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FRAME_BATCH = 8;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_WARNINGS = 40;

/** Official list prices, CNY per 1,000,000 tokens. */
const DEFAULT_PRICES = {
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
};

const DEFAULTS = {
  budgetCny: 100,
  budgetPeriod: 'month',
  includeSubagents: true,
  timelineDays: 30,
  refreshSeconds: 30,
  debugFile: '',
  devReload: false,
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.input + source.output + source.cacheRead + source.cacheWrite;
  return target;
}

function tokensTotal(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function clampTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const clamped = {
    input: Math.max(0, Number(tokens.input) || 0),
    output: Math.max(0, Number(tokens.output) || 0),
    cacheRead: Math.max(0, Number(tokens.cacheRead) || 0),
    cacheWrite: Math.max(0, Number(tokens.cacheWrite) || 0),
  };
  clamped.total = tokensTotal(clamped);
  return clamped;
}

function beijingDateKey(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function beijingHourKey(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 13);
}

function beijingMonthKey(ms) {
  return beijingDateKey(ms).slice(0, 7);
}

/** Peak = Mon–Fri 09:00–12:00 / 14:00–18:00 Beijing time (holidays ignored). */
function isPeak(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

function mergePrices(overrides) {
  const table = {};
  for (const [model, value] of Object.entries(DEFAULT_PRICES)) {
    table[model] = { label: value.label, peak: { ...value.peak }, offPeak: { ...value.offPeak } };
  }
  if (overrides && typeof overrides === 'object') {
    for (const [model, value] of Object.entries(overrides)) {
      if (!value || typeof value !== 'object') continue;
      const base = table[model] ?? {
        label: model,
        peak: { ...DEFAULT_PRICES['deepseek-flash'].peak },
        offPeak: { ...DEFAULT_PRICES['deepseek-flash'].offPeak },
      };
      for (const band of ['peak', 'offPeak']) {
        if (!value[band] || typeof value[band] !== 'object') continue;
        for (const key of ['cacheHit', 'cacheMiss', 'output']) {
          const numeric = Number(value[band][key]);
          if (Number.isFinite(numeric) && numeric >= 0) base[band][key] = numeric;
        }
      }
      if (typeof value.label === 'string' && value.label.trim() !== '') base.label = value.label;
      table[model] = base;
    }
  }
  return table;
}

function ratesFor(table, model) {
  return table[model] ?? table['deepseek-flash'] ?? DEFAULT_PRICES['deepseek-flash'];
}

function eventCost(tokens, model, time, prices) {
  const rates = ratesFor(prices, model);
  const band = isPeak(time) ? rates.peak : rates.offPeak;
  return (
    (tokens.input * band.cacheMiss +
      tokens.cacheWrite * band.cacheMiss +
      tokens.cacheRead * band.cacheHit +
      tokens.output * band.output) /
    1_000_000
  );
}

function waitForLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function hashPrefix(buffer) {
  return createHash('sha1').update(buffer.subarray(0, Math.min(1024, buffer.length))).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* zstd log decoding                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Session logs are a concatenation of independent zstd frames. Node's zstd
 * decoder stops after the first frame, so split at frame magic bytes and
 * decode each frame separately. Yields to the event loop between batches so a
 * cold read of a large store never stalls the Host for long.
 */
async function decodeFrames(buffer, baseOffset) {
  const texts = [];
  const ranges = [];
  let skipped = 0;
  let failed = 0;
  let position = 0;
  while (position < buffer.length) {
    const magic = buffer.indexOf(ZSTD_MAGIC, position);
    if (magic < 0) {
      skipped += buffer.length - position;
      break;
    }
    if (magic > position) skipped += magic - position;
    const next = buffer.indexOf(ZSTD_MAGIC, magic + 4);
    const end = next < 0 ? buffer.length : next;
    try {
      texts.push(zstdDecompressSync(buffer.subarray(magic, end)).toString('utf8'));
      ranges.push({ start: baseOffset + magic, end: baseOffset + end });
    } catch {
      failed += 1;
      if (next < 0) break; /* an incomplete trailing frame */
      position = next;
      continue;
    }
    position = end;
    if (ranges.length % FRAME_BATCH === 0) await waitForLoop();
  }
  return { text: texts.join(''), ranges, skipped, failed };
}

function eventTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cacheReadTokens) || 0);
  const cacheWrite = Math.max(0, Number(usage.cacheWriteTokens) || 0);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function parseLogText(text, fallbackId) {
  const events = [];
  let header;
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (raw === '') continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!header && record.type === 'session') {
      header = record;
      continue;
    }
    if (record.type !== 'assistant/message') continue;
    const usage = eventTokensFromUsage(record.data?.usage ?? record.data?.message?.usage);
    if (!usage) continue;
    const source = record.data?.message?.source ?? {};
    events.push({
      t: Number(record.time) || 0,
      turn: Number(record.data?.turn) || 0,
      step: Number(record.data?.step) || 0,
      model: typeof source.model === 'string' ? source.model : '',
      provider: typeof source.provider === 'string' ? source.provider : '',
      tokens: usage,
    });
  }
  if (!header && fallbackId) header = { id: fallbackId };
  return { header, events };
}

/* -------------------------------------------------------------------------- */
/* CPU monitor                                                                */
/* -------------------------------------------------------------------------- */

function cpuTimes() {
  return cpus().map((core) => ({ ...core.times }));
}

function cpuTotals(times) {
  return times.reduce(
    (acc, t) => {
      acc.user += t.user;
      acc.nice += t.nice;
      acc.sys += t.sys;
      acc.idle += t.idle;
      acc.irq += t.irq;
      return acc;
    },
    { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  );
}

function busyFromTimes(times) {
  return times.user + times.nice + times.sys + times.irq;
}

function createCpuMonitor(intervalMs) {
  const historyLimit = 90;
  const state = { history: [], prev: null, latest: null, warming: true };

  function sample() {
    const now = Date.now();
    const times = cpuTimes();
    const total = cpuTotals(times);
    const usage = process.cpuUsage();
    const entry = {
      at: now,
      cores: times.length,
      perCore: [],
      systemUsagePct: 0,
      processCpuPctOneCore: 0,
      processCpuPctMachine: 0,
    };
    if (state.prev) {
      const prev = state.prev;
      const elapsedMs = Math.max(1, now - prev.at);
      const busy = busyFromTimes(total) - busyFromTimes(prev.total);
      const all =
        total.user - prev.total.user +
        total.nice - prev.total.nice +
        total.sys - prev.total.sys +
        total.idle - prev.total.idle +
        total.irq - prev.total.irq;
      entry.systemUsagePct = all > 0 ? Math.min(100, Math.max(0, (busy / all) * 100)) : 0;
      entry.perCore = times.map((t, index) => {
        const p = prev.times[index] ?? t;
        const coreBusy = t.user - p.user + t.nice - p.nice + t.sys - p.sys + t.irq - p.irq;
        const coreAll = coreBusy + (t.idle - p.idle);
        return coreAll > 0 ? Math.min(100, Math.max(0, (coreBusy / coreAll) * 100)) : 0;
      });
      const userUs = usage.user - prev.proc.user;
      const sysUs = usage.system - prev.proc.system;
      const pctOneCore = ((userUs + sysUs) / 1000 / elapsedMs) * 100;
      entry.processCpuPctOneCore = Math.max(0, pctOneCore);
      entry.processCpuPctMachine = Math.max(0, Math.min(100, pctOneCore / Math.max(1, times.length)));
      state.warming = false;
      state.history.push({
        at: now,
        system: round(entry.systemUsagePct, 2),
        process: round(entry.processCpuPctMachine, 3),
      });
      if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
    }
    state.prev = { at: now, total, times, proc: { user: usage.user, system: usage.system } };
    state.latest = entry;
  }

  sample(); // prime: topology only, no deltas yet
  const warmTimer = setTimeout(sample, Math.min(400, Math.floor(intervalMs / 2)));
  if (typeof warmTimer.unref === 'function') warmTimer.unref();
  const timer = setInterval(sample, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearTimeout(warmTimer);
      clearInterval(timer);
    },
    snapshot() {
      const memTotal = totalmem();
      const memFree = freemem();
      const procMem = process.memoryUsage();
      const latest = state.latest ?? {
        at: Date.now(),
        cores: cpus().length,
        perCore: [],
        systemUsagePct: 0,
        processCpuPctOneCore: 0,
        processCpuPctMachine: 0,
      };
      const cores = latest.cores || cpus().length;
      return {
        at: latest.at,
        sampledAt: Date.now(),
        intervalMs,
        warming: state.warming,
        system: {
          usagePct: round(latest.systemUsagePct, 2),
          cores,
          perCore: latest.perCore.map((value, index) => ({ core: index, usagePct: round(value, 2) })),
          model: cpus()[0]?.model ?? 'unknown',
          platform: platform(),
          release: release(),
          uptimeSec: Math.round(osUptime()),
          loadavg: platform() === 'win32' ? null : loadavg().map((value) => round(value, 2)),
        },
        memory: {
          totalBytes: memTotal,
          freeBytes: memFree,
          usedBytes: memTotal - memFree,
          usedPct: memTotal > 0 ? round(((memTotal - memFree) / memTotal) * 100, 2) : 0,
        },
        process: {
          pid: process.pid,
          cpuPctOneCore: round(Math.min(latest.processCpuPctOneCore, cores * 100), 2),
          cpuPctMachine: round(latest.processCpuPctMachine, 3),
          rssBytes: procMem.rss,
          heapUsedBytes: procMem.heapUsed,
          heapTotalBytes: procMem.heapTotal,
          uptimeSec: Math.round(process.uptime()),
          nodeVersion: process.versions.node,
        },
        history: state.history.slice(),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Session data store                                                         */
/* -------------------------------------------------------------------------- */

function workspaceTitle(path) {
  if (!path) return '未知工作区';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function cleanTitle(title, cwd, id) {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (trimmed !== '') return trimmed;
  return `${workspaceTitle(cwd)} · ${id.slice(-6)}`;
}

function createStore(config) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const projectionsDir = join(home, 'storages', 'session_projcache', 'sessions');
  const sessionsRoot = join(home, 'sessions');
  const workspaceFile = join(home, 'storages', 'workspace.json');
  const prices = mergePrices(config.prices);

  const logCache = new Map();
  const projectionCache = new Map();
  let indexCache = { at: 0, logs: new Map(), projections: [], workspace: null };

  async function listProjections() {
    try {
      const names = await readdir(projectionsDir);
      return names.filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
  }

  async function listLogs() {
    const logs = new Map();
    let workspaceDirs = [];
    try {
      workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true });
    } catch {
      return logs;
    }
    const workspaceNames = workspaceDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const workspaceName of workspaceNames) {
      const workspacePath = join(sessionsRoot, workspaceName);
      let sessionDirs = [];
      try {
        sessionDirs = await readdir(workspacePath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs.filter((entry) => entry.isDirectory())) {
        const id = sessionDir.name;
        if (logs.has(id)) continue;
        const candidate = join(workspacePath, id, 'session.v4.jsonl.zstd');
        try {
          const info = await stat(candidate);
          if (info.isFile()) logs.set(id, { path: candidate, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          /* no log for this session yet */
        }
      }
    }
    return logs;
  }

  async function readWorkspaceState() {
    try {
      const parsed = JSON.parse(await readFile(workspaceFile, 'utf8'));
      const archived = new Set(parsed?.global?.archivedSessionIds ?? []);
      const workspaces = parsed?.tables?.workspaces ?? {};
      const byPath = new Map();
      const bySession = new Map();
      for (const workspace of Object.values(workspaces)) {
        if (!workspace || typeof workspace.path !== 'string') continue;
        byPath.set(workspace.path, workspace.title ?? workspace.path);
        for (const id of workspace.sessionIds ?? []) bySession.set(id, workspace.path);
      }
      return { archived, byPath, bySession };
    } catch {
      return { archived: new Set(), byPath: new Map(), bySession: new Map() };
    }
  }

  async function refreshIndex() {
    const now = Date.now();
    if (now >= indexCache.at && now - indexCache.at < 5000) return indexCache;
    const [projections, logs, workspace] = await Promise.all([listProjections(), listLogs(), readWorkspaceState()]);
    indexCache = { at: Date.now(), projections, logs, workspace };
    return indexCache;
  }

  async function readProjection(file) {
    const path = join(projectionsDir, file);
    const id = file.slice(0, -'.json'.length);
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    const sig = `${info.mtimeMs}:${info.size}`;
    const cached = projectionCache.get(id);
    if (cached && cached.sig === sig) return cached.value;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      const record = parsed?.record ?? {};
      const rows = record.rows ?? {};
      const totals = rows.tokenUsage?.val?.totals ?? null;
      const stats = rows.sessionStats?.val ?? null;
      const lastUsed = rows.modelSelection?.val?.lastUsed ?? null;
      const value = {
        id,
        createdAt: Number(record.identity?.createdAt) || 0,
        cwd: typeof record.identity?.cwd === 'string' ? record.identity.cwd : '',
        title: typeof rows.title?.val === 'string' ? rows.title.val : '',
        lastPromptAt: Number(rows.sessionListMetadata?.val?.lastPromptAt) || 0,
        tokens: totals
          ? {
              input: Math.max(0, Number(totals.uncachedInputTokens) || 0),
              output: Math.max(0, Number(totals.outputTokens) || 0),
              cacheRead: Math.max(0, Number(totals.cacheReadTokens) || 0),
              cacheWrite: Math.max(0, Number(totals.cacheWriteTokens) || 0),
            }
          : null,
        stats: stats
          ? {
              turns: Number(stats.turns) || 0,
              steps: Number(stats.steps) || 0,
              llmMs: Number(stats.llmMs) || 0,
              toolMs: Number(stats.toolMs) || 0,
            }
          : null,
        model: typeof lastUsed?.model === 'string' ? lastUsed.model : '',
        provider: typeof lastUsed?.provider === 'string' ? lastUsed.provider : '',
        isSubagent: Boolean(rows.subagent?.val?.identity) || !id.startsWith('session-'),
      };
      projectionCache.set(id, { sig, value });
      return value;
    } catch {
      return null;
    }
  }

  async function readLog(id, info) {
    const cached = logCache.get(info.path);
    const canAppend =
      cached &&
      !cached.unsupported &&
      info.size >= cached.size &&
      info.mtimeMs >= cached.mtimeMs &&
      cached.lastOffset <= info.size;
    let base = canAppend
      ? cached
      : { header: undefined, events: [], frames: 0, skipped: 0, failed: 0, lastOffset: 0, size: 0, mtimeMs: 0 };
    let file;
    try {
      file = await readFile(info.path);
    } catch {
      return cached ?? null;
    }
    if (canAppend && cached.hash !== undefined && hashPrefix(file) !== cached.hash) {
      base = { header: undefined, events: [], frames: 0, skipped: 0, failed: 0, lastOffset: 0, size: 0, mtimeMs: 0 };
    }
    if (zstdDecompressSync === undefined) {
      return {
        header: base.header,
        events: base.events,
        frames: base.frames,
        skipped: base.skipped,
        failed: base.failed,
        lastOffset: base.lastOffset,
        size: file.length,
        unsupported: true,
      };
    }
    const from = base.lastOffset;
    let decoded = { text: '', ranges: [], skipped: 0, failed: 0 };
    if (file.length > from) decoded = await decodeFrames(file.subarray(from), from);
    let header = base.header;
    const events = base.events;
    if (decoded.text !== '') {
      const parsed = parseLogText(decoded.text, id);
      if (!header && parsed.header) header = parsed.header;
      for (const event of parsed.events) events.push(event);
    }
    const lastOffset =
      decoded.ranges.length > 0 ? decoded.ranges[decoded.ranges.length - 1].end : base.lastOffset;
    const value = {
      header,
      events,
      frames: base.frames + decoded.ranges.length,
      skipped: base.skipped + decoded.skipped,
      failed: base.failed + decoded.failed,
      lastOffset,
      size: file.length,
      mtimeMs: info.mtimeMs,
      hash: hashPrefix(file),
      unsupported: false,
    };
    logCache.set(info.path, value);
    return value;
  }

  async function loadSessions() {
    const index = await refreshIndex();
    const ids = new Set();
    for (const file of index.projections) ids.add(file.slice(0, -'.json'.length));
    for (const id of index.logs.keys()) ids.add(id);
    const sessions = [];
    const warnings = [];
    await mapLimit([...ids].sort(), 4, async (id) => {
      const projection = await readProjection(`${id}.json`);
      const logInfo = index.logs.get(id);
      const log = logInfo ? await readLog(id, logInfo) : null;
      if (!projection && !log) {
        warnings.push(`会话 ${id.slice(-8)}：既无投影缓存也无日志`);
        return;
      }
      const header = log?.header ?? {};
      const fallbackTokens = projection?.tokens ? clampTokens(projection.tokens) : null;
      const modelFallback = projection?.model || 'deepseek-flash';
      const providerFallback = projection?.provider || '';
      const createdAt = projection?.createdAt || Number(header.createdAt) || 0;
      const cwd = projection?.cwd || (typeof header.cwd === 'string' ? header.cwd : '');
      const isSubagent = Boolean(projection?.isSubagent) || Number(header.delegationDepth) > 0;
      const events = (log?.events ?? [])
        .filter((event) => event.t > 0)
        .sort((a, b) => a.t - b.t)
        .map((event) => ({
          t: event.t,
          turn: event.turn,
          step: event.step,
          model: event.model || modelFallback,
          provider: event.provider || providerFallback,
          tokens: event.tokens,
          peak: isPeak(event.t),
          synthetic: false,
        }));

      if (logInfo) {
        if (log === null) warnings.push(`会话 ${id.slice(-8)}：日志无法读取`);
        else if (log.unsupported) warnings.push(`会话 ${id.slice(-8)}：当前 Node 不支持 zstd，改用投影缓存总量`);
        else if (log.frames === 0 && log.size > 0) warnings.push(`会话 ${id.slice(-8)}：日志中没有可解码的 zstd 帧`);
        else if (log.failed > 0) warnings.push(`会话 ${id.slice(-8)}：${log.failed} 个日志帧解码失败（可能仍在写入）`);
      } else if (projection) {
        warnings.push(`会话 ${id.slice(-8)}：没有会话日志，改用投影缓存总量`);
      }

      const logTokens = emptyTokens();
      for (const event of events) addTokens(logTokens, event.tokens);
      const lastKnownTime =
        Math.max(
          projection?.lastPromptAt || 0,
          projection?.createdAt || 0,
          events.length > 0 ? events[events.length - 1].t : 0,
          createdAt,
        ) || Date.now();

      if (events.length === 0) {
        if (!fallbackTokens || fallbackTokens.total === 0) {
          if (projection || logInfo) warnings.push(`会话 ${id.slice(-8)}：没有可用的 token 记录`);
          return;
        }
        events.push({
          t: lastKnownTime,
          turn: 0,
          step: 0,
          model: modelFallback,
          provider: providerFallback,
          tokens: fallbackTokens,
          peak: isPeak(lastKnownTime),
          synthetic: true,
        });
      } else if (fallbackTokens) {
        /*
         * The projection cache is refreshed at turn boundaries, so a live
         * session's log can be ahead of it; retry/title requests can also be
         * billed without an assistant/message record. Add one adjustment event
         * for any positive per-field difference: every view then derives from
         * this one reconciled event stream, so totals never disagree.
         */
        const delta = {
          input: Math.max(0, fallbackTokens.input - logTokens.input),
          output: Math.max(0, fallbackTokens.output - logTokens.output),
          cacheRead: Math.max(0, fallbackTokens.cacheRead - logTokens.cacheRead),
          cacheWrite: Math.max(0, fallbackTokens.cacheWrite - logTokens.cacheWrite),
        };
        const deltaTotal = tokensTotal(delta);
        if (deltaTotal > 0) {
          events.push({
            t: lastKnownTime,
            turn: 0,
            step: 0,
            model: modelFallback,
            provider: providerFallback,
            tokens: { ...delta, total: deltaTotal },
            peak: isPeak(lastKnownTime),
            synthetic: true,
          });
          const targetTotal = Math.max(logTokens.total + deltaTotal, 1);
          if (deltaTotal / targetTotal > 0.5) {
            warnings.push(
              `会话 ${id.slice(-8)}：日志与投影缓存差异较大（${Math.round((deltaTotal / targetTotal) * 100)}% 来自缓存补差）`,
            );
          }
        }
      }

      events.sort((a, b) => a.t - b.t);
      const tokens = emptyTokens();
      const costByModel = new Map();
      let costCny = 0;
      let peakEvents = 0;
      let peakTokens = 0;
      for (const event of events) {
        const cost = eventCost(event.tokens, event.model, event.t, prices);
        event.costCny = cost;
        addTokens(tokens, event.tokens);
        costCny += cost;
        const bucket = costByModel.get(event.model) ?? {
          model: event.model,
          tokens: emptyTokens(),
          costCny: 0,
          events: 0,
        };
        addTokens(bucket.tokens, event.tokens);
        bucket.costCny += cost;
        bucket.events += 1;
        costByModel.set(event.model, bucket);
        if (event.peak) {
          peakEvents += 1;
          peakTokens += event.tokens.total;
        }
      }

      const lastActiveAt = events.length > 0 ? events[events.length - 1].t : lastKnownTime;
      const archived = index.workspace.archived.has(id);
      const workspacePath = index.workspace.bySession.get(id) ?? cwd;
      sessions.push({
        id,
        title: cleanTitle(projection?.title, cwd, id),
        cwd,
        workspace: index.workspace.byPath.get(workspacePath) ?? workspaceTitle(workspacePath),
        workspacePath,
        isSubagent,
        archived,
        createdAt: createdAt || lastKnownTime,
        lastActiveAt,
        turns:
          projection?.stats?.turns ??
          new Set(events.filter((event) => event.turn > 0).map((event) => event.turn)).size,
        steps: projection?.stats?.steps ?? events.filter((event) => !event.synthetic).length,
        llmMs: projection?.stats?.llmMs ?? 0,
        toolMs: projection?.stats?.toolMs ?? 0,
        models: [...costByModel.keys()].sort(),
        tokens,
        costCny,
        costByModel: [...costByModel.values()],
        events: events.length,
        peakEvents,
        peakTokens,
        events_data: events,
      });
    });

    const livePaths = new Set([...index.logs.values()].map((entry) => entry.path));
    for (const path of logCache.keys()) if (!livePaths.has(path)) logCache.delete(path);
    const liveProjections = new Set(index.projections.map((file) => file.slice(0, -'.json'.length)));
    for (const id of projectionCache.keys()) if (!liveProjections.has(id)) projectionCache.delete(id);

    sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return { sessions, warnings, home };
  }

  return { loadSessions, prices, home };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

function buildTimeline(sessions) {
  const daily = new Map();
  const hourly = new Map();
  const now = Date.now();
  for (const session of sessions) {
    for (const event of session.events_data) {
      const dayKey = beijingDateKey(event.t);
      const day = daily.get(dayKey) ?? { date: dayKey, tokens: emptyTokens(), costCny: 0, events: 0 };
      addTokens(day.tokens, event.tokens);
      day.costCny += event.costCny;
      day.events += 1;
      daily.set(dayKey, day);
      if (now - event.t < 48 * HOUR_MS) {
        const hourKey = beijingHourKey(event.t);
        const hour = hourly.get(hourKey) ?? { hour: hourKey, tokens: emptyTokens(), costCny: 0, events: 0 };
        addTokens(hour.tokens, event.tokens);
        hour.costCny += event.costCny;
        hour.events += 1;
        hourly.set(hourKey, hour);
      }
    }
  }
  return {
    daily: [...daily.values()].map((entry) => ({ ...entry, costCny: round(entry.costCny, 6) })),
    hourly: [...hourly.values()].map((entry) => ({ ...entry, costCny: round(entry.costCny, 6) })),
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export const name = '@todrink/dsh-usage';
export const inject = ['connection', 'webServer'];

export function apply(ctx, rawConfig) {
  const supplied = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const configWarnings = [];
  const budgetCnyRaw = Number(supplied.budgetCny ?? DEFAULTS.budgetCny);
  const budgetCny = Number.isFinite(budgetCnyRaw) && budgetCnyRaw >= 0 ? budgetCnyRaw : DEFAULTS.budgetCny;
  if (!Number.isFinite(budgetCnyRaw) || budgetCnyRaw < 0) configWarnings.push('budgetCny 无效，已使用默认值 100');
  const budgetPeriod = supplied.budgetPeriod === 'all' ? 'all' : 'month';
  if (supplied.budgetPeriod !== undefined && supplied.budgetPeriod !== 'month' && supplied.budgetPeriod !== 'all') {
    configWarnings.push('budgetPeriod 仅支持 month|all，已使用 month');
  }
  const includeSubagents = supplied.includeSubagents !== false;
  const refreshMs = Math.max(5, Math.min(3600, Number(supplied.refreshSeconds) || 30)) * 1000;
  const config = { ...DEFAULTS, ...supplied, budgetCny, budgetPeriod, includeSubagents };
  const store = createStore(config);
  const cpu = createCpuMonitor(2000);
  const debugFile = typeof supplied.debugFile === 'string' ? supplied.debugFile.trim() : '';
  const debugBytes = new Map();

  ctx.effect(() => () => cpu.stop(), 'usage-stats: cpu sampler');

  let overviewCache = null;
  let sessionsMemo = { at: 0, promise: null, value: null };
  let debugQueue = Promise.resolve();

  function debugWrite(file, text, append = false) {
    if (debugFile === '') return;
    const target = `${debugFile}${file}`;
    debugQueue = debugQueue
      .then(async () => {
        if (append) {
          const size = debugBytes.get(target) ?? 0;
          if (size > 512 * 1024) return;
          debugBytes.set(target, size + Buffer.byteLength(text));
          await appendFile(target, text);
          return;
        }
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, text);
        await rename(temporary, target);
      })
      .catch(() => {});
  }

  function debugLog(entry) {
    if (debugFile === '') return;
    debugWrite('.requests.log', `${JSON.stringify({ at: Date.now(), ...entry })}\n`, true);
  }

  function loadSessionsMemo() {
    const now = Date.now();
    if (sessionsMemo.value && now >= sessionsMemo.at && now - sessionsMemo.at < 5000) {
      return Promise.resolve(sessionsMemo.value);
    }
    if (sessionsMemo.promise) return sessionsMemo.promise;
    sessionsMemo.promise = store
      .loadSessions()
      .then((value) => {
        sessionsMemo = { at: Date.now(), promise: null, value };
        return value;
      })
      .catch((error) => {
        sessionsMemo = { at: 0, promise: null, value: null };
        throw error;
      });
    return sessionsMemo.promise;
  }

  async function computeOverview({ days } = {}) {
    const { sessions, warnings } = await loadSessionsMemo();
    const pricing = store.prices;
    const now = Date.now();
    const visible = sessions.filter((session) => includeSubagents || !session.isSubagent);
    const timeline = buildTimeline(visible);
    const summaryTokens = emptyTokens();
    const modelSummary = new Map();
    const modelDaily = new Map();
    const todayKey = beijingDateKey(now);
    const monthKey = beijingMonthKey(now);
    let costTotal = 0;
    let costToday = 0;
    let costMonth = 0;
    let tokensToday = 0;
    let events = 0;
    let peakTokens = 0;
    let firstSessionAt = 0;
    let lastActivityAt = 0;
    for (const session of visible) {
      addTokens(summaryTokens, session.tokens);
      costTotal += session.costCny;
      events += session.events;
      firstSessionAt = firstSessionAt === 0 ? session.createdAt : Math.min(firstSessionAt, session.createdAt);
      lastActivityAt = Math.max(lastActivityAt, session.lastActiveAt);
      for (const contribution of session.costByModel) {
        const bucket =
          modelSummary.get(contribution.model) ??
          { model: contribution.model, tokens: emptyTokens(), costCny: 0, events: 0 };
        addTokens(bucket.tokens, contribution.tokens);
        bucket.costCny += contribution.costCny;
        bucket.events += contribution.events;
        modelSummary.set(contribution.model, bucket);
      }
      for (const event of session.events_data) {
        if (beijingDateKey(event.t) === todayKey) {
          costToday += event.costCny;
          tokensToday += event.tokens.total;
        }
        if (beijingMonthKey(event.t) === monthKey) {
          costMonth += event.costCny;
        }
        /*
         * Per-day, per-provider/model buckets. The browser aggregates any
         * window (3/7/14/30 days) from these, so switching the range costs no
         * extra scan. Model ids repeat across providers, so the key is both.
         */
        const eventDay = beijingDateKey(event.t);
        const provider = event.provider || '';
        const pairKey = `${provider}\u0000${event.model}`;
        let dayMap = modelDaily.get(eventDay);
        if (dayMap === undefined) {
          dayMap = new Map();
          modelDaily.set(eventDay, dayMap);
        }
        const dayBucket = dayMap.get(pairKey) ?? {
          provider,
          model: event.model,
          totalTokens: 0,
          costCny: 0,
          events: 0,
        };
        dayBucket.totalTokens += event.tokens.total;
        dayBucket.costCny += event.costCny;
        dayBucket.events += 1;
        dayMap.set(pairKey, dayBucket);
        if (event.peak) peakTokens += event.tokens.total;
      }
    }
    const activeDays = new Set(timeline.daily.map((entry) => entry.date)).size;
    const last7 = timeline.daily.slice(-7);
    const last7Cost = last7.reduce((sum, entry) => sum + entry.costCny, 0);
    const dailyAverage = last7.length > 0 ? last7Cost / last7.length : 0;
    const beijingNow = new Date(now + TZ_OFFSET_MS);
    const daysInMonth = new Date(
      Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const usedForBudget = budgetPeriod === 'month' ? costMonth : costTotal;
    const priceNow = isPeak(now);
    const flashRates = ratesFor(pricing, 'deepseek-flash');
    const band = priceNow ? flashRates.peak : flashRates.offPeak;
    const fallbackModels = [...modelSummary.keys()].filter((model) => pricing[model] === undefined);
    const allWarnings = [...configWarnings, ...warnings];
    if (fallbackModels.length > 0) {
      allWarnings.push(`未配置价格的模型按 deepseek-flash 单价估算：${fallbackModels.join(', ')}`);
    }
    return {
      generatedAt: now,
      timezone: 'Asia/Shanghai',
      currency: 'CNY',
      store: { home: store.home, refreshMs },
      summary: {
        sessions: visible.length,
        mainSessions: visible.filter((session) => !session.isSubagent).length,
        subagentSessions: visible.filter((session) => session.isSubagent).length,
        events,
        activeDays,
        tokens: summaryTokens,
        totalTokens: summaryTokens.total,
        costCny: round(costTotal, 6),
        costTodayCny: round(costToday, 6),
        costThisMonthCny: round(costMonth, 6),
        tokensToday,
        firstSessionAt,
        lastActivityAt,
        peakTokenShare: summaryTokens.total > 0 ? round(peakTokens / summaryTokens.total, 4) : 0,
        avgCostPerSessionCny: visible.length > 0 ? round(costTotal / visible.length, 6) : 0,
        avgTokensPerSession: visible.length > 0 ? Math.round(summaryTokens.total / visible.length) : 0,
        budget: {
          amountCny: budgetCny,
          period: budgetPeriod,
          usedCny: round(usedForBudget, 6),
          remainingCny: round(Math.max(0, budgetCny - usedForBudget), 6),
          usedPct: budgetCny > 0 ? round(Math.min(1, usedForBudget / budgetCny), 4) : 0,
          overBudget: usedForBudget > budgetCny,
          projectedMonthCny: round(dailyAverage * daysInMonth, 6),
        },
        price: {
          model: 'deepseek-flash',
          label: flashRates.label,
          peak: priceNow,
          rates: { ...band },
          currency: 'CNY',
          unit: 'per 1M tokens',
          fallbackModels,
          note: '按 DeepSeek 官方价目表估算；高峰时段为北京时间周一至周五 09:00–12:00、14:00–18:00（不含法定节假日调整）。',
        },
      },
      timeline: {
        days: Math.max(7, Math.min(365, Number(days) || Number(config.timelineDays) || 30)),
        ...timeline,
      },
      byModel: [...modelSummary.values()]
        .map((entry) => ({
          model: entry.model,
          label: pricing[entry.model]?.label ?? entry.model,
          estimated: pricing[entry.model] === undefined,
          tokens: entry.tokens,
          totalTokens: entry.tokens.total,
          costCny: round(entry.costCny, 6),
          events: entry.events,
        }))
        .sort((a, b) => b.costCny - a.costCny),
      /*
       * Per-day usage split by provider × model. The dashboard's pie sums a
       * window out of this, so the range switch is a client-side filter and
       * the payload stays independent of the selected range.
       */
      modelDaily: [...modelDaily.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, map]) => ({
          date,
          models: [...map.values()]
            .map((entry) => ({
              provider: entry.provider,
              model: entry.model,
              label: pricing[entry.model]?.label ?? entry.model,
              estimated: pricing[entry.model] === undefined,
              totalTokens: entry.totalTokens,
              costCny: round(entry.costCny, 6),
              events: entry.events,
            }))
            .sort((a, b) => b.totalTokens - a.totalTokens),
        })),
      sessions: visible.map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        workspace: session.workspace,
        workspacePath: session.workspacePath,
        isSubagent: session.isSubagent,
        archived: session.archived,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        turns: session.turns,
        steps: session.steps,
        llmMs: session.llmMs,
        toolMs: session.toolMs,
        models: session.models,
        tokens: session.tokens,
        totalTokens: session.tokens.total,
        costCny: round(session.costCny, 6),
        costByModel: session.costByModel.map((entry) => ({
          model: entry.model,
          costCny: round(entry.costCny, 6),
          tokens: entry.tokens,
          events: entry.events,
        })),
        events: session.events,
        peakEvents: session.peakEvents,
        peakShare: session.tokens.total > 0 ? round(session.peakTokens / session.tokens.total, 4) : 0,
        source: session.events_data.some((event) => event.synthetic) ? 'reconciled' : 'log',
        costPerTurnCny:
          session.turns > 0 ? round(session.costCny / session.turns, 6) : round(session.costCny, 6),
        costPerTokenCny: session.tokens.total > 0 ? round(session.costCny / session.tokens.total, 9) : 0,
      })),
      prices: Object.fromEntries(
        Object.entries(pricing).map(([model, value]) => [model, { label: value.label, ...value, currency: 'CNY' }]),
      ),
      cpu: cpu.snapshot(),
      warnings: allWarnings.slice(0, MAX_WARNINGS),
    };
  }

  async function overview(payload = {}) {
    const now = Date.now();
    if (overviewCache && now >= overviewCache.at && now - overviewCache.at < refreshMs && overviewCache.value) {
      return { ...overviewCache.value, cpu: cpu.snapshot() };
    }
    if (overviewCache?.promise) return overviewCache.promise;
    const promise = computeOverview(payload && typeof payload === 'object' ? payload : {})
      .then((value) => {
        overviewCache = { at: Date.now(), promise: null, value };
        if (debugFile !== '') debugWrite('', JSON.stringify(value, null, 2));
        return value;
      })
      .catch((error) => {
        overviewCache = { at: 0, promise: null, value: null };
        throw error;
      });
    overviewCache = { at: now, promise, value: null };
    return promise;
  }

  async function sessionDetail(payload = {}) {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const { sessions } = await loadSessionsMemo();
    const session = sessions.find((entry) => entry.id === id);
    if (!session) return null;
    const events = session.events_data
      .slice()
      .sort((a, b) => a.t - b.t)
      .map((event) => ({
        t: event.t,
        turn: event.turn,
        step: event.step,
        model: event.model,
        peak: event.peak,
        synthetic: event.synthetic,
        tokens: event.tokens,
        costCny: round(event.costCny, 6),
      }));
    const turns = new Map();
    for (const event of events) {
      const key = event.turn || 0;
      const bucket = turns.get(key) ?? {
        turn: key,
        start: event.t,
        end: event.t,
        tokens: emptyTokens(),
        costCny: 0,
        events: 0,
      };
      bucket.start = Math.min(bucket.start, event.t);
      bucket.end = Math.max(bucket.end, event.t);
      addTokens(bucket.tokens, event.tokens);
      bucket.costCny += event.costCny;
      bucket.events += 1;
      turns.set(key, bucket);
    }
    return {
      generatedAt: Date.now(),
      session: {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        workspace: session.workspace,
        isSubagent: session.isSubagent,
        archived: session.archived,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        turns: session.turns,
        steps: session.steps,
        models: session.models,
        tokens: session.tokens,
        totalTokens: session.tokens.total,
        costCny: round(session.costCny, 6),
        events: session.events,
        costByModel: session.costByModel.map((entry) => ({
          model: entry.model,
          costCny: round(entry.costCny, 6),
          tokens: entry.tokens,
          events: entry.events,
        })),
      },
      events,
      turns: [...turns.values()]
        .map((entry) => ({ ...entry, costCny: round(entry.costCny, 6) }))
        .sort((a, b) => a.turn - b.turn),
    };
  }

  async function handleCall(endpoint, payload) {
    debugLog({ endpoint, payload });
    try {
      if (endpoint === 'overview') {
        return { ok: true, value: await overview(payload && typeof payload === 'object' ? payload : {}) };
      }
      if (endpoint === 'session') {
        const value = await sessionDetail(payload && typeof payload === 'object' ? payload : {});
        if (value === null) {
          return {
            ok: false,
            error: { code: `${NS}/unknown-session`, message: '会话不存在或已被清理', details: {} },
          };
        }
        return { ok: true, value };
      }
      return { ok: false, error: { code: `${NS}/unknown-endpoint`, message: `未知接口 ${endpoint}`, details: {} } };
    } catch (error) {
      return {
        ok: false,
        error: { code: `${NS}/failed`, message: error instanceof Error ? error.message : String(error), details: {} },
      };
    }
  }

  /*
   * Authenticated prefix route. The browser posts the Connection RPC envelope
   * here; the route answers with the server-response envelope the client
   * carrier parses. Authentication reuses Connection's own admission, so no
   * data leaves the browser/session trust boundary.
   */
  ctx.effect(() => {
    const route = {
      kind: 'prefix',
      path: CHANNEL,
      handler: async (request, response) => {
        try {
          const admission = ctx.connection.admit(request);
          if ('rejection' in admission) {
            response.writeHead(admission.rejection);
            response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
            return;
          }
          const url = new URL(request.url ?? '/', 'http://dsh.invalid');
          if (!url.pathname.startsWith(`${CHANNEL}/`)) {
            response.writeHead(404);
            response.end();
            return;
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          const contentType = request.headers['content-type'];
          if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
            response.writeHead(415);
            response.end('content type must be application/json');
            return;
          }
          const chunks = [];
          let received = 0;
          for await (const chunk of request) {
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
              response.writeHead(413, { connection: 'close' });
              response.end('request body too large');
              return;
            }
            chunks.push(chunk);
          }
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            response.writeHead(400);
            response.end('invalid JSON');
            return;
          }
          const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid';
          const endpoint = url.pathname.slice(CHANNEL.length + 1);
          const endpointValid = /^[A-Za-z0-9_$.-]+$/.test(endpoint);
          const envelopeValid =
            body?.type === 'client-request' &&
            typeof body.method === 'string' &&
            body.method === endpoint &&
            endpointValid;
          const result = envelopeValid
            ? await handleCall(endpoint, body.payload)
            : { ok: false, error: { code: `${NS}/bad-request`, message: 'invalid request envelope', details: {} } };
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          response.end(JSON.stringify({ type: 'server-response', rpcId, result }));
        } catch {
          if (!response.headersSent) response.writeHead(500);
          response.end('usage-stats handler failure');
        }
      },
    };
    return ctx.webServer.register(route);
  }, 'usage-stats: authenticated HTTP route');

  if (debugFile !== '') {
    debugWrite(
      '.activation.json',
      JSON.stringify({ event: 'activated', at: Date.now(), home: store.home, config }, null, 2),
    );
  }

  if (config.devReload === true) installDevReload(ctx);
}

/**
 * Development-only: private package files are linked, so a browser refresh is
 * not enough to pick up new Client code. Watch this package and ask HMR to
 * recompose the profile, which republishes the Client module graph live.
 */
function installDevReload(ctx) {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = ['client.js', 'index.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg'].map(
    (file) => join(dir, file),
  );
  const signatures = new Map();
  let running = false;
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (running) return;
      let dirty = false;
      for (const file of files) {
        try {
          const info = await stat(file);
          const sig = `${info.mtimeMs}:${info.size}`;
          const previous = signatures.get(file);
          if (previous !== undefined && previous !== sig) dirty = true;
          signatures.set(file, sig);
        } catch {
          /* file removed */
        }
      }
      if (!dirty) return;
      const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined;
      if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') return;
      running = true;
      try {
        await hmr.runExclusive(() => hmr.reconcileProfile());
      } catch {
        /* a broken intermediate edit is reported by HMR; the next edit retries */
      } finally {
        running = false;
      }
    }, 800);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'usage-stats: dev reload watcher');
}

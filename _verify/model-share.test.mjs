import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const here = new URL('.', import.meta.url);
const src = readFileSync(new URL('../client.js', here), 'utf8');

const instrumented = src
  .replace(
    'const { useEffect, useMemo, useRef, useState } = React;',
    [
      'const { useEffect, useMemo, useRef, useState } = React;',
      '    globalThis.__internals = {',
      '      ModelShareCard, PriceStrip, buildModelColors, normalizeRange,',
      '      get dictionary() { return dictionary; },',
      '      get MODEL_PALETTE() { return MODEL_PALETTE; },',
      '    };',
    ].join('\n'),
  );
assert.notEqual(instrumented, src, 'instrumentation did not apply');

/* --- a deliberately small React stand-in: only what the module uses -------- */
let hookCells = [];
let hookIndex = 0;
let pendingRender = null;

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const merged = { ...(props || {}), children: children.length <= 1 ? children[0] : children };
    /* invoke function components so the tree is real markup, not a stub node */
    if (typeof type === 'function') return type(merged);
    return { type, props: merged };
  },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useRef(value) { return { current: value }; },
  useState(initial) {
    const cell = hookIndex++;
    if (hookCells[cell] === undefined) hookCells[cell] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const value = typeof next === 'function' ? next(hookCells[cell]) : next;
      if (Object.is(value, hookCells[cell])) return;
      hookCells[cell] = value;
      hookIndex = 0;
      if (pendingRender) pendingRender();
    };
    return [hookCells[cell], set];
  },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
};

const sandbox = {
  React,
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Symbol,
  JSON,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  Map,
  Set,
  window: null,
  document: { documentElement: { lang: 'zh-CN' }, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'zh-CN' },
};
sandbox.globalThis = sandbox;
sandbox.window = {
  __ModuleLoader__: { load: (mod) => { sandbox.__mod = mod; } },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: sandbox.navigator,
  location: { search: '' },
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 0,
  clearInterval() {},
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

vm.createContext(sandbox);
vm.runInContext(instrumented, sandbox, { filename: 'client.js' });

const mod = sandbox.__mod;
assert.ok(mod && typeof mod.factory === 'function', 'module loader captured');
const plugin = mod.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});
assert.equal(typeof plugin.apply, 'function');

const { ModelShareCard, PriceStrip, MODEL_PALETTE, buildModelColors, dictionary, normalizeRange } = sandbox.__internals;

/* 0. locale tables stay in sync, and the range switch only offers 3/7/14/30 - */
{
  const zhKeys = Object.keys(dictionary.zh).sort();
  const enKeys = Object.keys(dictionary.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh/en key sets differ');
  for (const key of ['range.3', 'range.7', 'range.14', 'range.30']) {
    assert.ok(zhKeys.includes(key), 'missing locale key ' + key);
  }
  assert.deepEqual([0, 1, 3, 7, 14, 30, 60, null, 'x'].map(normalizeRange), [30, 30, 3, 7, 14, 30, 30, 30, 30]);
}

const t = (key, params) => {
  const template = dictionary.zh[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));
};

function render(data, range, colors) {
  hookCells = [];
  hookIndex = 0;
  let tree;
  const draw = () => {
    hookIndex = 0;
    tree = ModelShareCard({ t, data, range, colors });
  };
  pendingRender = draw;
  draw();
  return { get tree() { return tree; } };
}

const flat = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { for (const item of node) flat(item, out); return out; }
  if (typeof node === 'object') {
    out.push(node);
    flat(node.props?.children, out);
    return out;
  }
  return out;
};
const byClass = (tree, className) => flat(tree).filter((n) => n?.props?.className === className);
const textOf = (tree) => flat(tree).filter((n) => typeof n?.props?.children === 'string').map((n) => n.props.children).join(' ');

/* Beijing day keys, relative to today, the same way the module buckets them. */
const beijingKey = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const dayAgo = (days) => beijingKey(Date.now() - days * 86_400_000);

const model = (provider, name, tokens, cost, estimated = false) => ({
  provider,
  model: name,
  label: '',
  estimated,
  totalTokens: tokens,
  costCny: cost,
  events: 2,
});

const recentDay = {
  date: dayAgo(0),
  models: [
    model('deepseek-account', 'deepseek-flash', 6_000_000, 20),
    model('taocan', 'deepseek-v4.1-flash-1017', 2_000_000, 12),
    model('poteto', 'deepseek-v4.1-flash-1017', 1_000_000, 6),
    model('poteto', 'deepseek-v4.1-flash-1017-b300', 500_000, 3),
    model('astro', 'kimi-k3', 300_000, 1),
    model('poteto', 'hy4-flash', 200_000, 0.5, true),
    model('astro', 'qwen3.8-flash', 100_000, 0.3),
    model('astro', 'gpt-6-astra', 50_000, 0.2),
  ],
};
const twoDaysAgo = { date: dayAgo(2), models: [model('taocan', 'deepseek-v4.1-flash-1017', 1_000_000, 6)] };
const fourDaysAgo = { date: dayAgo(4), models: [model('cilai', 'deepseek-v4.1-flash-1017', 2_000_000, 12)] };
const tenDaysAgo = { date: dayAgo(10), models: [model('old-route', 'retired-model', 9_000_000, 9, true)] };

const data = {
  summary: {},
  byModel: [
    { model: 'deepseek-flash', totalTokens: 6_000_000, costCny: 20 },
    { model: 'deepseek-v4.1-flash-1017', totalTokens: 3_000_000, costCny: 18 },
    { model: 'deepseek-v4.1-flash-1017-b300', totalTokens: 500_000, costCny: 3 },
  ],
  modelDaily: [tenDaysAgo, fourDaysAgo, twoDaysAgo, recentDay],
};

/* 1. the 3-day window drops anything older than today-2 -------------------- */
{
  const view = render(data, 3);
  const rows = byClass(view.tree, 'us-mrow');
  const names = rows.map((row) => byClass(row, 'us-mname')[0].props.children);
  assert.equal(names.includes('≈ retired-model'), false, '10-day-old model must be out of the 3d window');
  assert.equal(names.includes('V4.1 Flash'), true);
  assert.match(textOf(view.tree), /近 3 天/, 'header names the 3-day window');

  /* the sum only covers the 3-day window: 8 rows + the 2-day-old route */
  const shares = rows.map((row) => Number.parseFloat(byClass(row, 'us-mshare')[0].props.children));
  const sum = shares.reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 100) < 1.5, `shares should sum to ~100%, got ${sum}`);
}

/* 2. widening the range brings the old model back -------------------------- */
{
  const view = render(data, 30);
  const names = byClass(view.tree, 'us-mrow').map((row) => byClass(row, 'us-mname')[0].props.children);
  assert.ok(names.includes('≈ retired-model'), '30d window includes the old model');
  assert.match(textOf(view.tree), /近 30 天/);
}

/* 3. rows carry provider + model, full name, tokens, cost, share ----------- */
{
  const view = render(data, 7);
  const rows = byClass(view.tree, 'us-mrow');
  const first = rows[0];
  assert.equal(byClass(first, 'us-mprov')[0].props.children, 'deepseek-account');
  assert.equal(byClass(first, 'us-mval')[0].props.children, '600.0万');
  assert.equal(byClass(first, 'us-mcost')[0].props.children, '¥20.00');
  const providers = rows.map((row) => byClass(row, 'us-mprov')[0].props.children);
  assert.ok(providers.filter((value) => value === 'poteto').length >= 2, 'provider shown per row');
  assert.ok(rows.some((row) => byClass(row, 'us-mname')[0].props.children === '≈ hy4-flash'), 'unpriced model keeps the ≈ marker');
}

/* 4. the ring has one slice per row and covers the whole circle ------------ */
{
  const view = render(data, 3);
  const slices = flat(view.tree).filter((n) => n?.props?.['data-us'] === 'slice');
  const rows = byClass(view.tree, 'us-mrow');
  assert.equal(slices.length, rows.length, 'one slice per row');
  const covered = slices.reduce((acc, slice) => {
    const [len] = String(slice.props.strokeDasharray).split(' ');
    return acc + Number.parseFloat(len) + 1.5;
  }, 0);
  const circumference = 2 * Math.PI * 76;
  assert.ok(Math.abs(covered - circumference) < 1, `slices should cover the ring: ${covered} vs ${circumference}`);
  assert.match(textOf(view.tree), /Token 合计/);
}

/* 5. hovering a slice shows tokens and money in the tooltip ---------------- */
{
  const view = render(data, 3);
  const slices = flat(view.tree).filter((n) => n?.props?.['data-us'] === 'slice');
  slices[1].props.onPointerEnter();
  slices[1].props.onPointerMove({
    clientX: 120,
    clientY: 90,
    currentTarget: { ownerSVGElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 214, height: 214 }) } },
  });
  const tooltip = byClass(view.tree, 'us-tooltip')[0];
  assert.ok(tooltip, 'tooltip rendered on hover');
  const text = textOf(tooltip);
  assert.ok(text.includes('V4.1 Flash'), 'tooltip names the model');
  assert.ok(text.includes('taocan'), 'tooltip names the provider');
  assert.ok(text.includes('300.0万'), 'tooltip shows the windowed token total');
  assert.ok(text.includes('¥18.00'), 'tooltip shows the windowed cost');
  slices[1].props.onPointerLeave();
  assert.equal(byClass(view.tree, 'us-tooltip').length, 0, 'tooltip gone after leaving');
}

/* 6. the cost switch re-sorts and re-weights ------------------------------- */
{
  const view = render(data, 3);
  const segmented = flat(view.tree).find((n) => n?.props?.role === 'group');
  const costButton = segmented.props.children.find((child) => child.props.children === '成本');
  assert.ok(costButton, 'cost option present');
  costButton.props.onClick();
  const rows = byClass(view.tree, 'us-mrow');
  const shares = rows.map((row) => Number.parseFloat(byClass(row, 'us-mshare')[0].props.children));
  const sum = shares.reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 100) < 1.5, `cost shares should sum to ~100%, got ${sum}`);
  assert.match(textOf(view.tree), /成本合计/);
}

/* 7. more than nine pairs collapse into one merged slice ------------------ */
{
  const many = { summary: {}, modelDaily: [{ date: dayAgo(0), models: [] }] };
  for (let i = 0; i < 12; i += 1) many.modelDaily[0].models.push(model('p' + i, 'm' + i, 1_000_000 - i * 1000, i));
  const view = render(many, 7);
  const rows = byClass(view.tree, 'us-mrow');
  assert.equal(rows.length, 10, 'nine slices plus a merged row');
  assert.match(byClass(rows[9], 'us-mname')[0].props.children, /其他 3 个模型/);
}

/* 8. empty window --------------------------------------------------------- */
{
  const view = render({ summary: {}, modelDaily: [tenDaysAgo] }, 3);
  assert.match(textOf(view.tree), /所选时间范围内还没有模型用量/);
}

/* 9. older host (no modelDaily) falls back to its month/all-time split ---- */
{
  const legacy = {
    summary: {},
    modelsThisMonth: { month: '2026-11', totalTokens: 1_000_000, costCny: 4, events: 1, byModel: [model('deepseek-official', 'deepseek-flash', 1_000_000, 4)] },
  };
  const view = render(legacy, 7);
  const text = textOf(view.tree);
  assert.match(text, /全部时间/, 'legacy payload is labelled as all time');
  assert.match(text, /Flash/);
}

/* 10. reading order: top to bottom of column one, then column two --------- */
{
  const view = render(data, 3);
  const columns = byClass(view.tree, 'us-mcol');
  assert.equal(columns.length, 2, 'two legend columns');
  const perColumn = columns.map((column) => byClass(column, 'us-mrow').length);
  assert.deepEqual(perColumn, [4, 4], 'eight rows split four and four');
  const domRows = byClass(view.tree, 'us-mrow');
  assert.deepEqual(domRows.map((row) => row.props['data-us-rank']), [0, 1, 2, 3, 4, 5, 6, 7], 'DOM order is the ranking');
  const tokens = domRows.map((row) => byClass(row, 'us-mval')[0].props.children);
  assert.deepEqual(tokens, ['600.0万', '300.0万', '100.0万', '50.0万', '30.0万', '20.0万', '10.0万', '5.0万'], 'largest first, then continues in column two');
}

/* 11. one colour per model, shared by the pie, the strip and the detail --- */
{
  const colors = buildModelColors(data);
  assert.equal(colors.get('deepseek-flash'), MODEL_PALETTE[0], 'top model takes the first colour');
  assert.equal(colors.get('deepseek-v4.1-flash-1017'), MODEL_PALETTE[1]);
  assert.equal(colors.get('deepseek-v4.1-flash-1017-b300'), MODEL_PALETTE[2], 'top three keep distinct colours');

  const view = render(data, 3, colors);
  const dotOf = (row) => byClass(row, 'us-mdot')[0].props.style.background;
  const rows = byClass(view.tree, 'us-mrow');
  const byName = (name) => rows.filter((row) => byClass(row, 'us-mname')[0].props.children === name);
  assert.equal(dotOf(byName('Flash')[0]), MODEL_PALETTE[0], 'pie uses the family colour');
  assert.equal(dotOf(byName('deepseek-v4.1-flash-1017-b300')[0]), MODEL_PALETTE[2], 'third place keeps its own colour');

  const duplicates = byName('V4.1 Flash').map(dotOf);
  assert.equal(duplicates.length, 2, 'same model under two providers keeps both rows');
  assert.equal(duplicates[0], MODEL_PALETTE[1], 'first provider of a family gets the base colour');
  assert.ok(duplicates[1].includes(MODEL_PALETTE[1]), 'second provider keeps the same hue');
  assert.notEqual(duplicates[0], duplicates[1], 'and is still distinguishable');

  const strip = PriceStrip({ t, data, colors });
  const chipDot = (label) => {
    const chip = byClass(strip, 'us-chip').find((node) => String(node.props.children?.[1] ?? '').startsWith(label));
    assert.ok(chip, 'chip for ' + label);
    return chip.props.children[0].props.style.background;
  };
  assert.equal(chipDot('Flash'), MODEL_PALETTE[0], 'price strip agrees with the pie');
}

/* 12. no hook may run after Dashboard's early return (hook order) --------- */
{
  const start = src.indexOf('    function Dashboard(');
  const end = src.indexOf('    function LoadingState(');
  assert.ok(start >= 0 && end > start, 'Dashboard source found');
  const body = src.slice(start, end);
  const early = body.indexOf('if (!open) return null;');
  assert.ok(early >= 0, 'Dashboard keeps its closed early return');
  const hooksAfter = [...body.matchAll(/\buse[A-Z][A-Za-z]*\(/g)].filter((match) => match.index > early);
  assert.deepEqual(hooksAfter.map((match) => match[0]), [], 'a hook after the early return breaks opening the panel');
}

console.log('ModelShareCard render checks: PASS (12 groups)');

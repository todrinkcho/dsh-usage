/**
 * @todrink/dsh-usage — Client half.
 *
 * A compact live metric strip in the composer dock and a full analytics
 * overlay (shell.overlay): token / cost / budget KPIs, a stacked token or cost
 * per-model share ring, per-session drill-down with lazy turn details. Everything is computed by the Host half from real local
 * session logs and served over the authenticated Connection RPC channel.
 */
window.__ModuleLoader__.load({
  id: '@todrink/dsh-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    const NS = 'usage-stats';
    const CHANNEL = '/usage-stats';
    const PILL_POLL_MS = 30_000;
    const LIVE_POLL_MS = 3_000;
    const LS_BUDGET = 'dsh.usage-stats.budget.v1';
    const LS_RANGE = 'dsh.usage-stats.range.v1';
    /* The range switch offers these windows; anything else (e.g. an older "all") falls back to 30d. */
    const RANGE_OPTIONS = [3, 7, 14, 30];
    function normalizeRange(value) {
      const days = Number(value);
      return RANGE_OPTIONS.includes(days) ? days : 30;
    }

    /* --------------------------------------------------------------------- */
    /* helpers                                                               */
    /* --------------------------------------------------------------------- */

    const isZh = () => {
      const lang = (typeof document !== 'undefined' && document.documentElement.lang) || '';
      if (lang) return lang.toLowerCase().startsWith('zh');
      const nav = typeof navigator !== 'undefined' ? navigator.language : '';
      return String(nav || '').toLowerCase().startsWith('zh');
    };
    const localeTag = () => (isZh() ? 'zh-CN' : 'en-US');
    const numberFmt = (value) => {
      try {
        return new Intl.NumberFormat(localeTag()).format(value);
      } catch {
        return String(value);
      }
    };

    function compactTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      if (isZh()) {
        if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
        if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
        return String(Math.round(value));
      }
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return String(Math.round(value));
    }

    function exactTokens(value) {
      if (!Number.isFinite(value)) return '0';
      return numberFmt(Math.round(value));
    }

    function compactCny(value) {
      if (!Number.isFinite(value) || value <= 0) return '¥0';
      if (value < 0.01) return `¥${value.toFixed(4)}`;
      if (value < 1) return `¥${value.toFixed(3)}`;
      if (value < 100) return `¥${value.toFixed(2)}`;
      if (Number.isInteger(value)) return `¥${value.toFixed(0)}`;
      if (value < 1000) return `¥${value.toFixed(1)}`;
      return `¥${Math.round(value)}`;
    }

    function pct(value, digits = 0) {
      if (!Number.isFinite(value)) return '0%';
      return `${(value * 100).toFixed(digits)}%`;
    }

    function pctFromRatio(value) {
      if (!Number.isFinite(value) || value <= 0) return '0%';
      const asPercent = value * 100;
      if (asPercent < 1) return `${asPercent.toFixed(2)}%`;
      if (asPercent < 10) return `${asPercent.toFixed(1)}%`;
      return `${Math.round(asPercent)}%`;
    }

    function fmtDuration(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0s';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds.toFixed(1)}s`;
      const minutes = Math.floor(seconds / 60);
      const rest = Math.round(seconds - minutes * 60);
      if (minutes < 60) return `${minutes}m ${rest}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes - hours * 60}m`;
    }

    function fmtBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
    }

    function beijingDateKey(ms) {
      return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
    }

    function dateToUtc(key) {
      const [year, month, day] = key.split('-').map(Number);
      return Date.UTC(year, month - 1, day);
    }

    function addDays(key, delta) {
      return new Date(dateToUtc(key) + delta * 86_400_000).toISOString().slice(0, 10);
    }

    function fmtDateShort(key) {
      const [, month, day] = key.split('-');
      return `${month}-${day}`;
    }

    function fmtTime(ms) {
      try {
        return new Intl.DateTimeFormat(localeTag(), {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms));
      } catch {
        return new Date(ms).toTimeString().slice(0, 5);
      }
    }

    function fmtDateTime(ms) {
      try {
        return new Intl.DateTimeFormat(localeTag(), {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms));
      } catch {
        return new Date(ms).toLocaleString();
      }
    }

    function relTime(ms, now) {
      if (!Number.isFinite(ms) || ms <= 0) return '—';
      const diff = now - ms;
      if (diff < 60_000) return isZh() ? '刚刚' : 'just now';
      if (diff < 3_600_000) {
        const minutes = Math.floor(diff / 60_000);
        return isZh() ? `${minutes} 分钟前` : `${minutes}m ago`;
      }
      if (diff < 86_400_000) {
        const hours = Math.floor(diff / 3_600_000);
        return isZh() ? `${hours} 小时前` : `${hours}h ago`;
      }
      if (diff < 7 * 86_400_000) {
        const days = Math.floor(diff / 86_400_000);
        return isZh() ? `${days} 天前` : `${days}d ago`;
      }
      return fmtDateTime(ms);
    }

    const KNOWN_MODEL_LABELS = {
      'deepseek-flash': 'Flash',
      'deepseek-v4-pro': 'V4 Pro',
      'deepseek-v4.1-flash-1017': 'V4.1 Flash',
      'deepseek-v4-flash': 'V4 Flash',
      'deepseek-chat': 'Chat',
      'deepseek-reasoner': 'Reasoner',
      'kimi-k3': 'Kimi K3',
    };

    function modelLabel(model, label) {
      if (KNOWN_MODEL_LABELS[model]) return KNOWN_MODEL_LABELS[model];
      if (typeof label === 'string' && label.trim() !== '' && !/^deepseek flash$/i.test(label.trim())) {
        return label.trim();
      }
      return model;
    }

    function readLocal(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function writeLocal(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be unavailable */
      }
    }

    /* --------------------------------------------------------------------- */
    /* store                                                                 */
    /* --------------------------------------------------------------------- */

    const api = { rpc: null };
    const listeners = new Set();
    let state = {
      status: 'idle',
      data: null,
      error: null,
      at: 0,
      open: false,
      range: normalizeRange(readLocal(LS_RANGE, 30)),
      budget: readLocal(LS_BUDGET, null),
    };
    let inflight = null;

    function emit() {
      for (const listener of listeners) listener();
    }

    function setState(patch) {
      state = { ...state, ...patch };
      emit();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getState() {
      return state;
    }

    function useStore(selector) {
      return React.useSyncExternalStore(
        subscribe,
        () => selector(getState()),
        () => selector(getState()),
      );
    }

    async function call(endpoint, payload) {
      if (!api.rpc) throw new Error('connection unavailable');
      const result = await api.rpc.call(CHANNEL, endpoint, payload ?? {});
      if (!result || result.ok !== true) {
        throw new Error(result?.error?.message ?? 'usage service unavailable');
      }
      return result.value;
    }

    function refresh({ force = false, silent = false } = {}) {
      if (inflight) return inflight;
      const fresh = state.at > 0 && Date.now() - state.at < 5_000;
      if (fresh && !force) return Promise.resolve(state.data);
      if (!silent && !state.data) {
        setState({ status: 'loading', error: null });
      }
      inflight = call('overview', { days: 30 })
        .then((data) => {
          setState({ status: 'ready', data, error: null, at: Date.now() });
          return data;
        })
        .catch((error) => {
          const message = error?.message ?? String(error);
          setState({
            status: state.data ? 'ready' : 'error',
            error: message,
            at: state.data ? state.at : Date.now(),
          });
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    }

    function setOpen(open) {
      setState({ open });
    }

    function setRange(range) {
      const days = normalizeRange(range);
      writeLocal(LS_RANGE, days);
      setState({ range: days });
    }

    function setBudget(value) {
      const normalized = Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
      writeLocal(LS_BUDGET, normalized);
      setState({ budget: normalized });
    }

    const detailCache = new Map(); // id -> { at, data }

    async function loadDetail(id) {
      const cached = detailCache.get(id);
      if (cached && cached.data && Date.now() - cached.at < 60_000) return cached.data;
      const data = await call('session', { id });
      detailCache.set(id, { at: Date.now(), data });
      return data;
    }

    /* --------------------------------------------------------------------- */
    /* CSS                                                                   */
    /* --------------------------------------------------------------------- */

    const CSS = `
.us-pill{display:inline-flex;flex:0 0 auto;align-items:center;gap:9px;max-width:100%;padding:3px 9px 3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12.9px;line-height:20.2px;white-space:nowrap;transition:background .15s ease,border-color .15s ease}
.us-pill:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.us-pill:focus-visible{outline:2px solid var(--dsw-alias-link);outline-offset:2px}
.us-pill-spark{display:flex;align-items:center;flex:none;opacity:.85}
.us-pill-item{display:inline-flex;align-items:baseline;gap:5px;min-width:0}
.us-pill-k{color:var(--dsw-alias-label-tertiary);font-size:10.6px;font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.us-pill-value{color:var(--dsw-alias-label-primary);font-size:13.4px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.us-pill-sep{width:1px;height:11px;background:var(--dsw-alias-border-l2);flex:none}
.us-pill-budget{display:inline-flex;align-items:center;gap:5px}
.us-pill-budgetbar{width:34px;height:3px;border-radius:99px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.us-pill-budgetbar i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-link);transition:width .3s ease}
.us-pill-err{color:var(--dsw-alias-state-error-primary);font-weight:600}
.us-pill-chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:flex;transition:transform .15s ease}
.us-pill[aria-expanded="true"] .us-pill-chevron{transform:rotate(180deg)}
.us-skel{display:inline-block;height:10px;border-radius:4px;background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton) 25%,color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent) 50%,var(--dsw-alias-bg-skeleton) 75%);background-size:200% 100%;animation:us-shimmer 1.4s ease infinite}
@keyframes us-shimmer{0%{background-position:180% 0}100%{background-position:-60% 0}}

.us-overlay{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:22px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);animation:us-fade .16s ease-out}
.us-panel{--us-accent:var(--dsw-alias-link);--us-danger:var(--dsw-alias-state-error-primary);--us-success:var(--dsw-alias-state-success-primary);--us-text:var(--dsw-alias-label-primary);--us-text2:var(--dsw-alias-label-secondary);--us-muted:var(--dsw-alias-label-tertiary);--us-border:var(--dsw-alias-border-l2);--us-card:color-mix(in srgb,var(--dsw-alias-label-primary) 3.2%,var(--dsw-alias-bg-layer-1));--us-card-2:color-mix(in srgb,var(--dsw-alias-label-primary) 5.5%,var(--dsw-alias-bg-layer-1));position:relative;display:flex;flex-direction:column;width:min(1250px,100%);height:min(96vh,1010px);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);color:var(--us-text);box-shadow:0 32px 90px rgba(0,0,0,.32),0 2px 10px rgba(0,0,0,.14);overflow:hidden;animation:us-rise .18s ease-out}
@keyframes us-fade{from{opacity:0}to{opacity:1}}
@keyframes us-rise{from{opacity:0;transform:translateY(8px) scale(.992)}to{opacity:1;transform:none}}
.us-hd{display:flex;align-items:center;gap:14px;padding:15px 20px 14px;border-bottom:1px solid var(--us-border);flex:none}
.us-brand{display:flex;align-items:center;gap:10px;min-width:0}
.us-brandmark{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--us-accent) 12%,transparent);color:var(--us-accent);flex:none}
.us-title{font-size:16.8px;font-weight:650;letter-spacing:-.01em;margin:0;line-height:22.4px}
.us-sub{display:flex;align-items:center;gap:8px;margin-top:2px;color:var(--us-muted);font-size:12.3px;line-height:16.8px;flex-wrap:wrap}
.us-live{display:inline-flex;align-items:center;gap:4px;color:var(--us-success);font-weight:600}
.us-livedot{width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor;animation:us-pulse 2s ease-out infinite}
@keyframes us-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 45%,transparent)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.us-hd-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex:none}
.us-seg{display:inline-flex;align-items:center;gap:1px;padding:2px;border-radius:8px;background:var(--us-card);border:1px solid var(--us-border)}
.us-seg button{border:none;background:transparent;color:var(--us-muted);font:inherit;font-size:12.3px;line-height:17.9px;font-weight:500;padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}
.us-seg button:hover{color:var(--us-text);background:var(--dsw-alias-interactive-bg-hover)}
.us-seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--us-text);box-shadow:0 1px 3px rgba(0,0,0,.16),0 0 0 1px var(--us-border);font-weight:600}
.us-seg button:focus-visible{outline:2px solid var(--us-accent);outline-offset:1px}
.us-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--us-text2);cursor:pointer;transition:background .12s ease,color .12s ease}
.us-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--us-text)}
.us-iconbtn:focus-visible{outline:2px solid var(--us-accent);outline-offset:1px}
.us-iconbtn.us-spin svg{animation:us-rotate .8s linear infinite}
@keyframes us-rotate{to{transform:rotate(360deg)}}

.us-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:14px 20px 6px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin}
.us-scroll>*{flex:0 0 auto}
.us-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;flex:none}
.us-kpi{position:relative;display:flex;flex-direction:column;gap:5px;padding:9px 13px 8px;border:1px solid var(--us-border);border-radius:var(--dsw-radius-md);background:var(--us-card);overflow:hidden}
.us-kpi::after{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,var(--us-accent),transparent 72%);opacity:.55}
.us-kpi-hd{display:flex;align-items:center;gap:6px;color:var(--us-muted);font-size:11.2px;font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.us-kpi-hd svg{opacity:.75}
.us-kpi-v{display:flex;align-items:baseline;gap:6px;font-size:25.8px;line-height:29.1px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.us-kpi-v small{font-size:12.3px;font-weight:500;color:var(--us-muted);letter-spacing:0}
.us-kpi-sub{color:var(--us-muted);font-size:12.3px;line-height:16.8px;font-variant-numeric:tabular-nums}
.us-kpi-sub b{color:var(--us-text2);font-weight:600}
.us-kpi-tones{color:var(--us-text2)}
.us-breakbar{display:flex;height:5px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.us-breakbar i{display:block;height:100%}
.us-breaklegend{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:11.8px;color:var(--us-muted);line-height:15.7px}
.us-breaklegend span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.us-dot{width:5px;height:5px;border-radius:2px;flex:none;background:var(--us-accent)}
.us-budgetline{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.us-budgetval{display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:var(--us-text);font:inherit;font-size:24.6px;font-weight:680;letter-spacing:-.02em;padding:0;border-radius:5px;cursor:text;font-variant-numeric:tabular-nums}
.us-budgetval:hover{color:var(--us-accent)}
.us-budgetval:focus-visible{outline:2px solid var(--us-accent);outline-offset:2px}
.us-budgetval svg{color:var(--us-muted)}
.us-budgetinput{width:92px;font:inherit;font-size:22.4px;font-weight:680;color:var(--us-text);border:1px solid var(--us-accent);border-radius:6px;background:var(--dsw-alias-bg-layer-1);padding:1px 6px;outline:none;font-variant-numeric:tabular-nums}
.us-progress{position:relative;height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-3);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);overflow:visible}
.us-progress i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--us-accent) 65%,transparent),var(--us-accent));transition:width .35s ease}
.us-progress.us-over i{background:linear-gradient(90deg,color-mix(in srgb,var(--us-danger) 60%,transparent),var(--us-danger))}
.us-progress b{position:absolute;top:-2px;bottom:-2px;width:1.5px;border-radius:2px;background:var(--us-text2);opacity:.8}
.us-reset{border:none;background:transparent;color:var(--us-muted);font:inherit;font-size:11.2px;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.us-reset:hover{color:var(--us-text)}

.us-strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;border:1px solid var(--us-border);border-radius:10px;background:color-mix(in srgb,var(--us-accent) 4%,var(--us-card));font-size:12.3px;color:var(--us-text2);flex:none}
.us-band{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--us-text)}
.us-band i{width:6px;height:6px;border-radius:50%;background:var(--us-success);flex:none}
.us-band.us-peak i{background:var(--us-danger)}
.us-rates{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;color:var(--us-muted);font-variant-numeric:tabular-nums}
.us-rates b{color:var(--us-text2);font-weight:600}
.us-modelmix{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;margin-left:auto}
.us-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;background:var(--us-card-2);border:1px solid var(--us-border);color:var(--us-text2);font-size:11.8px;line-height:15.7px;white-space:nowrap}
.us-chip i{width:5px;height:5px;border-radius:50%;background:var(--us-accent);flex:none;opacity:.85}
.us-note{display:inline-flex;align-items:center;gap:5px;color:var(--us-muted);font-size:11.8px;min-width:0}
.us-note span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px}

.us-card{display:flex;flex-direction:column;border:1px solid var(--us-border);border-radius:var(--dsw-radius-md);background:var(--us-card);overflow:hidden}
.us-cardhd{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--us-border);flex:none;min-height:41px}
.us-cardtitle{font-size:13.4px;font-weight:620;letter-spacing:.01em;color:var(--us-text)}
.us-cardsub{color:var(--us-muted);font-size:11.8px}
.us-cardhd-right{display:flex;align-items:center;gap:6px;margin-left:auto}
.us-muted{color:var(--us-muted);font-size:12.3px}

.us-chartwrap{position:relative;padding:8px 10px 6px 2px}
.us-chart{display:block;width:100%;overflow:visible}
.us-chartbar{cursor:default;transition:opacity .12s ease}
.us-chartbar.us-dim{opacity:.45}
.us-axis{fill:var(--us-muted);font-size:10.6px;font-variant-numeric:tabular-nums}
.us-axis.us-today{fill:var(--us-text2);font-weight:600}
.us-gridline{stroke:var(--us-border);stroke-width:1;opacity:.55}
.us-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 14px 10px;color:var(--us-muted);font-size:11.8px}
.us-legend span{display:inline-flex;align-items:center;gap:5px}
.us-legend i{width:6px;height:6px;border-radius:2px;flex:none}
.us-tooltip{position:absolute;z-index:3;pointer-events:none;min-width:150px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.22);color:var(--us-text);font-size:12.3px;line-height:17.9px;font-variant-numeric:tabular-nums}
.us-tooltip .us-tt-hd{display:flex;justify-content:space-between;gap:14px;font-weight:600;margin-bottom:4px}
.us-tooltip .us-tt-hd span:last-child{color:var(--us-muted);font-weight:500}
.us-tooltip .us-tt-row{display:flex;justify-content:space-between;gap:14px;color:var(--us-text2)}
.us-tooltip .us-tt-row em{font-style:normal;display:inline-flex;align-items:center;gap:5px;color:var(--us-muted)}
.us-tooltip .us-tt-row b{font-weight:600}
.us-tooltip .us-tt-total{border-top:1px solid var(--us-border);margin-top:4px;padding-top:4px;display:flex;justify-content:space-between;gap:14px;font-weight:650}

.us-tablehd{display:grid;grid-template-columns:minmax(0,1fr) 74px 86px 72px 44px;gap:8px;align-items:center;padding:5px 12px;border-bottom:1px solid var(--us-border);background:var(--dsw-alias-bg-layer-1);position:sticky;top:0;z-index:1}
.us-sortbtn{border:none;background:transparent;color:var(--us-muted);font:inherit;font-size:11.2px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:2px 0;cursor:pointer;display:inline-flex;align-items:center;gap:3px;justify-content:flex-end;white-space:nowrap}
.us-sortbtn:first-child{justify-content:flex-start}
.us-sortbtn:hover{color:var(--us-text)}
.us-sortbtn[data-active="true"]{color:var(--us-text2)}
.us-sortbtn:focus-visible{outline:2px solid var(--us-accent);outline-offset:1px;border-radius:3px}
.us-rows{overflow:auto;overscroll-behavior:contain;flex:1;min-height:0;max-height:258px}
.us-row{border-bottom:1px solid color-mix(in srgb,var(--us-border) 70%,transparent)}
.us-row:last-child{border-bottom:none}
.us-rowmain{display:grid;grid-template-columns:minmax(0,1fr) 74px 86px 72px 44px;gap:8px;align-items:center;padding:7px 12px;cursor:pointer;transition:background .1s ease}
.us-rowmain:hover{background:var(--dsw-alias-interactive-bg-hover)}
.us-rowmain:focus-visible{outline:2px solid var(--us-accent);outline-offset:-2px}
.us-rowname{display:flex;align-items:center;gap:7px;min-width:0}
.us-expand{display:inline-flex;color:var(--us-muted);flex:none;transition:transform .14s ease}
.us-rowmain[aria-expanded="true"] .us-expand{transform:rotate(90deg)}
.us-rowtext{min-width:0;flex:1}
.us-rowtitle{display:flex;align-items:center;gap:6px;font-size:13.4px;font-weight:550;color:var(--us-text);line-height:17.9px;min-width:0}
.us-rowtitle span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.us-rowmeta{display:flex;align-items:center;gap:6px;color:var(--us-muted);font-size:11.2px;line-height:15.7px;margin-top:1px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.us-subtag{flex:none;font-size:10.1px;font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--us-muted);border:1px solid var(--us-border);border-radius:4px;padding:0 4px;line-height:14.6px}
.us-subtag.us-archived{color:var(--us-accent);border-color:color-mix(in srgb,var(--us-accent) 40%,var(--us-border))}
.us-cell{font-size:12.9px;color:var(--us-text2);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.us-cell.us-strong{color:var(--us-text);font-weight:600}
.us-rowshare{height:2px;background:transparent;margin:0 12px 5px}
.us-rowshare i{display:block;height:100%;border-radius:99px;background:color-mix(in srgb,var(--us-accent) 55%,transparent);transition:width .3s ease}
.us-empty{padding:26px 16px;text-align:center;color:var(--us-muted);font-size:13.4px}
.us-detail{padding:10px 13px 13px 30px;background:color-mix(in srgb,var(--us-accent) 3%,var(--us-card));border-top:1px dashed var(--us-border)}
.us-statgrid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:10px}
.us-stat{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--us-border);border-radius:7px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.us-stat .k{color:var(--us-muted);font-size:10.1px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.us-stat .v{font-size:13.4px;font-weight:600;color:var(--us-text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.us-detailcols{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:14px}
.us-minititle{display:flex;justify-content:space-between;align-items:center;color:var(--us-muted);font-size:10.6px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;margin-bottom:5px}
.us-turnchart{display:flex;align-items:flex-end;gap:2px;height:46px;padding-bottom:1px;border-bottom:1px solid var(--us-border)}
.us-turnbar{position:relative;flex:1;min-width:2px;max-width:16px;border-radius:2px 2px 0 0;background:color-mix(in srgb,var(--us-accent) 62%,transparent);transition:background .12s ease}
.us-turnbar:hover{background:var(--us-accent)}
.us-turnlabels{display:flex;justify-content:space-between;color:var(--us-muted);font-size:10.1px;margin-top:3px;font-variant-numeric:tabular-nums}
.us-modellist{display:flex;flex-direction:column;gap:5px}
.us-modelrow{display:grid;grid-template-columns:66px minmax(0,1fr) 44px;gap:6px;align-items:center;font-size:11.2px;color:var(--us-text2);font-variant-numeric:tabular-nums}
.us-modelrow .track{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-3);overflow:hidden;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.us-modelrow .track i{display:block;height:100%;border-radius:99px;background:var(--us-accent)}
.us-modelturn{display:flex;align-items:center;gap:6px;color:var(--us-muted);font-size:11.2px}

.us-modelbody{display:grid;grid-template-columns:214px minmax(0,1fr);gap:14px;align-items:center;padding:12px 14px 14px}
.us-donutwrap{position:relative;width:214px;height:214px;display:flex;align-items:center;justify-content:center}
.us-donut{width:214px;height:214px;overflow:visible}
.us-slice{cursor:default;transition:stroke-width .12s ease,opacity .12s ease}
.us-slice.us-dim{opacity:.35}
.us-donutcenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;pointer-events:none;text-align:center}
.us-donutcenter b{font-size:21.3px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:24.6px}
.us-donutcenter span{font-size:10.6px;color:var(--us-muted);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.us-donutcenter em{font-style:normal;font-size:11.8px;color:var(--us-text2);font-variant-numeric:tabular-nums;white-space:nowrap}
.us-mlegend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 20px;min-width:0;align-content:start}
.us-mcol{display:flex;flex-direction:column;gap:2px;min-width:0}
.us-mrow{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:3px 9px;align-items:center;font-size:12.3px;color:var(--us-muted);line-height:16.8px;font-variant-numeric:tabular-nums;min-width:0;padding:4px 5px;border-radius:6px;cursor:default;transition:background .1s ease}
.us-mrow.us-active{background:var(--dsw-alias-interactive-bg-hover)}
.us-mrow .us-mdot{width:8px;height:8px;border-radius:2px;flex:none;align-self:start;margin-top:5px}
.us-mrow .us-mcell{display:flex;align-items:baseline;gap:6px;min-width:0;flex-wrap:wrap}
.us-mrow .us-mname{color:var(--us-text);font-size:12.9px;line-height:16.8px;word-break:break-word;overflow-wrap:anywhere}
.us-mrow .us-mprov{font-size:10.6px;line-height:14.6px;color:var(--us-text2);border:1px solid var(--us-border);border-radius:4px;padding:0 4px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap;flex:none}
.us-mrow .us-mnums{display:flex;align-items:baseline;justify-content:flex-end;gap:10px;white-space:nowrap}
.us-mrow .us-mshare{text-align:right;font-weight:600;color:var(--us-text2);min-width:44px}
.us-mrow .us-mval{text-align:right;color:var(--us-text2);min-width:66px}
.us-mrow .us-mcost{text-align:right;min-width:64px}
.us-mempty{padding:16px 14px 18px;color:var(--us-muted);font-size:12.9px}
@media (max-width:900px){.us-modelbody{grid-template-columns:1fr;justify-items:center}.us-mlegend{grid-template-columns:1fr;width:100%}}
.us-detailload{display:flex;align-items:center;gap:8px;color:var(--us-muted);font-size:12.3px;padding:6px 0}
.us-skelrow{height:9px;border-radius:4px;background:var(--dsw-alias-bg-skeleton);flex:1}


.us-ft{display:flex;align-items:center;gap:12px;padding:8px 20px;border-top:1px solid var(--us-border);color:var(--us-muted);font-size:11.8px;flex:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,var(--dsw-alias-bg-layer-1))}
.us-ft .us-grow{flex:1;min-width:0}
.us-ft span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.us-warnings{position:relative}
.us-warnings summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--us-border);border-radius:999px;padding:2px 8px;color:var(--us-text2);font-size:11.2px}
.us-warnings summary::-webkit-details-marker{display:none}
.us-warnings[open] summary{background:var(--us-card-2)}
.us-warninglist{position:absolute;right:0;bottom:24px;z-index:5;width:min(460px,80vw);max-height:220px;overflow:auto;margin:0;padding:8px 10px;list-style:none;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.24);color:var(--us-text2);font-size:11.8px;line-height:16.8px}
.us-warninglist li{padding:3px 0;border-bottom:1px solid var(--us-border)}
.us-warninglist li:last-child{border-bottom:none}

.us-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:44px 20px;color:var(--us-muted);font-size:13.4px;text-align:center}
.us-errorbox{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--us-danger) 45%,var(--us-border));border-radius:9px;background:color-mix(in srgb,var(--us-danger) 6%,var(--us-card));color:var(--us-text);font-size:13.4px}
.us-errorbox .us-grow{flex:1;min-width:0}
.us-btn{border:1px solid var(--us-border);background:var(--dsw-alias-bg-layer-1);color:var(--us-text);font:inherit;font-size:12.3px;padding:4px 10px;border-radius:7px;cursor:pointer}
.us-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.us-btn:focus-visible{outline:2px solid var(--us-accent);outline-offset:1px}
.us-search{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:1px solid var(--us-border);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--us-muted)}
.us-search input{width:112px;border:none;outline:none;background:transparent;color:var(--us-text);font:inherit;font-size:12.3px}
.us-search input::placeholder{color:var(--us-muted)}
.us-search:focus-within{border-color:var(--us-accent)}

@media (max-width:1180px){.us-rows{max-height:320px}}
@media (max-width:900px){.us-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.us-strip{row-gap:5px}.us-modelmix{margin-left:0}.us-tablehd,.us-rowmain{grid-template-columns:minmax(0,1fr) 78px 74px}.us-tablehd .us-col-updated,.us-rowmain .us-cell.us-col-updated,.us-tablehd .us-col-turns,.us-rowmain .us-cell.us-col-turns{display:none}.us-statgrid{grid-template-columns:repeat(3,minmax(0,1fr))}.us-detailcols{grid-template-columns:1fr}.us-detail{padding:10px 10px 12px}}
@media (max-width:640px){.us-iconbtn{width:34px;height:34px}.us-hd{flex-wrap:wrap;align-items:flex-start;gap:8px;padding:12px 12px 10px}.us-brand{flex:1 1 100%}.us-sub{flex-wrap:nowrap;overflow:hidden}.us-subnote{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.us-hd-right{width:100%;margin-left:0;justify-content:flex-end}.us-cardhd{flex-wrap:wrap;row-gap:6px}.us-cardhd .us-legend{display:none}.us-ft{gap:6px}.us-ft-formula{display:none}.us-ft .us-grow{display:none}.us-rows{max-height:none}.us-overlay{padding:0;align-items:stretch}.us-panel{width:100%;height:100%;max-height:100%;border-radius:0;border:none}.us-hd{padding:11px 12px;gap:8px}.us-hd-right{gap:5px}.us-seg button{padding:3px 6px;font-size:11.2px}.us-scroll{padding:10px 10px 4px;gap:10px}.us-kpis{gap:7px}.us-kpi{padding:9px 10px 8px}.us-kpi-v{font-size:23.5px;line-height:26.9px}.us-rowmain{grid-template-columns:minmax(0,1fr) 66px 54px;gap:5px;padding:7px 9px}.us-tablehd{grid-template-columns:minmax(0,1fr) 66px 54px;padding:5px 9px}.us-tablehd .us-col-turns,.us-rowmain .us-cell.us-col-turns,.us-tablehd>span:empty{display:none}.us-rowshare{margin:0 9px 5px}.us-statgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.us-ft{padding:7px 10px;gap:8px}.us-note span{max-width:180px}.us-chartwrap{padding:6px 4px 4px 0}.us-pill{gap:6px;padding:2px 7px}.us-pill-k{font-size:10.1px}.us-pill-value{font-size:12.3px}.us-pill-spark{display:none}.us-pill-chevron{display:none}}
@media (prefers-reduced-motion:reduce){.us-overlay,.us-panel,.us-livedot,.us-skel,.us-iconbtn.us-spin svg,.us-progress i,.us-corebar i,.us-rowshare i{animation:none!important;transition:none!important}}
`;

    /* --------------------------------------------------------------------- */
    /* icons + primitives                                                    */
    /* --------------------------------------------------------------------- */

    function Icon({ name, size = 14, strokeWidth = 1.7 }) {
      const paths = {
        chart: ['M3 17V9', 'M9 17V4', 'M15 17v-6', 'M21 17V7'],
        tokens: ['M4 7h16', 'M4 12h10', 'M4 17h13'],
        sessions: ['M4 5h16v11H8l-4 4z', 'M8 9h8', 'M8 12h5'],
        cost: ['M12 3v18', 'M8 7h6a2.5 2.5 0 0 1 0 5H8h7a2.5 2.5 0 0 1 0 5H8'],
        wallet: ['M4 7h16v12H4z', 'M4 7l2-3h12l2 3', 'M15 13h3'],
        refresh: ['M20 11a8 8 0 1 0-2.3 6.3', 'M20 5v6h-6'],
        close: ['M6 6l12 12', 'M18 6 6 18'],
        search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5 20 20'],
        chevron: ['M7 9l5 5 5-5'],
        right: ['M9 7l5 5-5 5'],
        edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
        warn: ['M12 4l9 16H3z', 'M12 10v5', 'M12 17.5v.5'],
        info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8v.5'],
        pulse: ['M3 12h4l2-6 4 12 2-6h6'],
      };
      const list = paths[name] ?? paths.chart;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        list.map((d, index) => h('path', { key: index, d })),
      );
    }

    function Dot({ color }) {
      return h('i', { className: 'us-dot', style: color ? { background: color } : undefined });
    }

    function Segmented({ options, value, onChange, label, kind }) {
      return h(
        'div',
        { className: 'us-seg', role: 'group', 'aria-label': label },
        options.map((option) =>
          h(
            'button',
            {
              key: String(option.value),
              type: 'button',
              'aria-pressed': value === option.value,
              'data-us-range': kind === 'range' ? option.value : undefined,
              'data-us-chart-mode': kind === 'mode' ? option.value : undefined,
              'data-us-filter': kind === 'filter' ? option.value : undefined,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function Sparkline({ values, width = 46, height = 14, stroke = 'var(--dsw-alias-link)', fill = true }) {
      const points = (values ?? []).filter((value) => Number.isFinite(value));
      if (points.length < 2) return h('span', { style: { width, height, display: 'inline-block' } });
      const max = Math.max(...points, 1);
      const step = width / (points.length - 1);
      const coords = points.map((value, index) => [index * step, height - 1 - (value / max) * (height - 2)]);
      const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
      const area = `${line} L${width} ${height} L0 ${height} Z`;
      const last = coords[coords.length - 1];
      return h(
        'svg',
        { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': true, style: { display: 'block', overflow: 'visible' } },
        fill ? h('path', { d: area, fill: stroke, opacity: 0.07 }) : null,
        h('path', { d: line, fill: 'none', stroke, strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: last[0], cy: last[1], r: 1.6, fill: stroke }),
      );
    }

    /* --------------------------------------------------------------------- */
    /* Pill                                                                  */
    /* --------------------------------------------------------------------- */

    function Pill({ t: injectedT = (key) => key }) {
      const status = useStore((s) => s.status);
      const data = useStore((s) => s.data);
      const open = useStore((s) => s.open);
      const budgetOverride = useStore((s) => s.budget);
      const t = typeof injectedT === 'function' ? injectedT : (key) => key;

      useEffect(() => {
        refresh().catch(() => {});
        const timer = window.setInterval(() => refresh().catch(() => {}), PILL_POLL_MS);
        return () => window.clearInterval(timer);
      }, []);

      const summary = data?.summary;
      const budget = budgetOverride ?? summary?.budget?.amountCny ?? 0;
      const usedPct = summary && budget > 0 ? Math.min(1, summary.budget.usedCny / budget) : 0;
      const trend = useMemo(() => (data?.timeline?.daily ?? []).slice(-14).map((day) => day.tokens.total), [data]);
      const loading = !summary && status !== 'error';
      const rail = h(
        React.Fragment,
        null,
        h('span', { className: 'us-pill-spark', 'aria-hidden': true }, h(Sparkline, { values: trend, width: 42, height: 13 })),
      );

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'us-pill',
            onClick: () => setOpen(true),
            'aria-expanded': open,
            'aria-label': summary
              ? t('pill.aria', { tokens: compactTokens(summary.totalTokens), cost: compactCny(summary.costCny) })
              : t('pill.title'),
            title: t('pill.title'),
            'data-us': 'pill',
          },
          rail,
          loading
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'us-pill-k' }, t('pill.tokens')),
                h('span', { className: 'us-skel', style: { width: 46, height: 11 } }),
                h('span', { className: 'us-pill-sep' }),
                h('span', { className: 'us-pill-k' }, t('pill.cost')),
                h('span', { className: 'us-skel', style: { width: 36, height: 11 } }),
              )
            : status === 'error' && !summary
              ? h('span', { className: 'us-pill-err' }, t('pill.error'))
              : h(
                  React.Fragment,
                  null,
                  h(
                    'span',
                    { className: 'us-pill-item' },
                    h('span', { className: 'us-pill-k' }, t('pill.tokens')),
                    h('span', { className: 'us-pill-value' }, compactTokens(summary.totalTokens)),
                  ),
                  h('span', { className: 'us-pill-sep' }),
                  h(
                    'span',
                    { className: 'us-pill-item' },
                    h('span', { className: 'us-pill-k' }, t('pill.cost')),
                    h('span', { className: 'us-pill-value' }, compactCny(summary.costCny)),
                  ),
                  h('span', { className: 'us-pill-sep' }),
                  h(
                    'span',
                    { className: 'us-pill-budget' },
                    h('span', { className: 'us-pill-k' }, t('pill.budget')),
                    h('span', { className: 'us-pill-budgetbar', 'aria-hidden': true }, h('i', { style: { width: `${Math.round(usedPct * 100)}%` } })),
                    h('span', { className: 'us-pill-value' }, pct(usedPct)),
                  ),
                ),
          h('span', { className: 'us-pill-chevron', 'aria-hidden': true }, h(Icon, { name: 'chevron', size: 11, strokeWidth: 2 })),
        ),
      );
    }

    /* --------------------------------------------------------------------- */
    /* Dashboard: header / KPIs / price strip                                */
    /* --------------------------------------------------------------------- */

    function Dashboard({ t: injectedT = (key) => key }) {
      const t = typeof injectedT === 'function' ? injectedT : (key) => key;
      const open = useStore((s) => s.open);
      const status = useStore((s) => s.status);
      const data = useStore((s) => s.data);
      const error = useStore((s) => s.error);
      const range = useStore((s) => s.range);
      const budgetOverride = useStore((s) => s.budget);
      const [now, setNow] = useState(() => Date.now());
      const [refreshing, setRefreshing] = useState(false);
      const closeRef = useRef(null);

      useEffect(() => {
        if (!open) return undefined;
        refresh({ force: true }).catch(() => {});
        const live = window.setInterval(() => refresh({ silent: true }).catch(() => {}), LIVE_POLL_MS);
        const clock = window.setInterval(() => setNow(Date.now()), 5_000);
        return () => {
          window.clearInterval(live);
          window.clearInterval(clock);
        };
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          const target = event.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [open]);

      useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(() => closeRef.current?.focus(), 30);
        return () => window.clearTimeout(timer);
      }, [open]);

      if (!open) return null;
      const summary = data?.summary;
      const live = Boolean(data) && now - (data.generatedAt ?? 0) < 12_000;
      /* Not a hook on purpose: this runs after the early return above, and a
       * hook here would change the hook order the moment the panel opens. */
      const colors = buildModelColors(data ?? {});

      const onRefresh = () => {
        setRefreshing(true);
        refresh({ force: true })
          .catch(() => {})
          .finally(() => setRefreshing(false));
      };

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'div',
          {
            className: 'us-overlay',
            'data-us': 'overlay',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) setOpen(false);
            },
          },
          h(
            'div',
            { className: 'us-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'us-title', 'data-us': 'panel' },
            h(
              'header',
              { className: 'us-hd' },
              h(
                'div',
                { className: 'us-brand' },
                h('div', { className: 'us-brandmark', 'aria-hidden': true }, h(Icon, { name: 'chart', size: 17, strokeWidth: 2 })),
                h(
                  'div',
                  null,
                  h('h2', { className: 'us-title', id: 'us-title' }, t('panel.title')),
                  h(
                    'div',
                    { className: 'us-sub' },
                    h('span', { className: 'us-subnote' }, t('panel.sub')),
                    h('span', null, '·'),
                    live ? h('span', { className: 'us-live' }, h('i', { className: 'us-livedot' }), t('panel.live')) : h('span', null, t('panel.cached')),
                    h('span', null, '·'),
                    h('span', null, t('panel.updated', { time: data ? fmtTime(data.generatedAt) : '—' })),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'us-hd-right' },
                h(Segmented, {
                  label: t('range.label'),
                  kind: 'range',
                  value: range,
                  onChange: setRange,
                  options: [
                    { value: 3, label: t('range.3') },
                    { value: 7, label: t('range.7') },
                    { value: 14, label: t('range.14') },
                    { value: 30, label: t('range.30') },
                  ],
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'us-iconbtn' + (refreshing ? ' us-spin' : ''),
                    onClick: onRefresh,
                    'aria-label': t('panel.refresh'),
                    title: t('panel.refresh'),
                    'data-us': 'refresh',
                  },
                  h(Icon, { name: 'refresh', size: 14 }),
                ),
                h(
                  'button',
                  {
                    ref: closeRef,
                    type: 'button',
                    className: 'us-iconbtn',
                    onClick: () => setOpen(false),
                    'aria-label': t('panel.close'),
                    title: t('panel.close'),
                    'data-us': 'close',
                  },
                  h(Icon, { name: 'close', size: 15 }),
                ),
              ),
            ),
            h(
              'div',
              { className: 'us-scroll', 'data-us': 'scroll' },
              !summary
                ? h(LoadingState, { t, error, onRetry: onRefresh, status })
                : h(
                    React.Fragment,
                    null,
                    h(KpiGrid, { t, data, budgetOverride, now }),
                    h(ModelShareCard, { t, data, range, colors }),
                    h(PriceStrip, { t, data, colors }),
                    h(TimelineCard, { t, data, range }),
                    h(SessionsCard, { t, data, now, colors }),
                  ),
            ),
            h(Footer, { t, data, now, budgetOverride }),
          ),
        ),
      );
    }

    function LoadingState({ t, error, onRetry, status }) {
      if (error) {
        return h(
          'div',
          { className: 'us-errorbox', role: 'alert' },
          h(Icon, { name: 'warn', size: 15 }),
          h('div', { className: 'us-grow' }, t('panel.error'), ' — ', error),
          h('button', { type: 'button', className: 'us-btn', onClick: onRetry }, t('panel.retry')),
        );
      }
      return h(
        'div',
        { className: 'us-empty-state' },
        h('span', { className: 'us-skel', style: { width: 180, height: 12 } }),
        h('span', { className: 'us-skel', style: { width: 260, height: 10 } }),
        h('span', { className: 'us-skel', style: { width: 220, height: 10 } }),
        h('span', { style: { marginTop: 6 } }, status === 'refreshing' ? t('panel.refreshing') : t('panel.loading')),
      );
    }

    function KpiGrid({ t, data, budgetOverride, now }) {
      const summary = data.summary;
      const tokens = summary.tokens;
      const total = summary.totalTokens || tokens.total || 0;
      const inputPct = total > 0 ? tokens.input / total : 0;
      const outputPct = total > 0 ? tokens.output / total : 0;
      const cachePct = total > 0 ? tokens.cacheRead / total : 0;
      const budget = budgetOverride ?? summary.budget.amountCny;
      const budgetPct = budget > 0 ? summary.budget.usedCny / budget : 0;
      const projectedPct = budget > 0 ? summary.budget.projectedMonthCny / budget : 0;
      const over = summary.budget.usedCny > budget;

      return h(
        'div',
        { className: 'us-kpis', 'data-us': 'kpis' },
        h(
          'section',
          { className: 'us-kpi' },
          h('div', { className: 'us-kpi-hd' }, h(Icon, { name: 'tokens', size: 12 }), t('kpi.tokens')),
          h('div', { className: 'us-kpi-v', title: exactTokens(total) }, compactTokens(total), h('small', null, t('units.tokens'))),
          h(
            'div',
            { className: 'us-breakbar', 'aria-hidden': true },
            h('i', { style: { width: `${cachePct * 100}%`, background: 'color-mix(in srgb, var(--dsw-alias-link) 26%, var(--dsw-alias-bg-layer-3))' } }),
            h('i', { style: { width: `${inputPct * 100}%`, background: 'color-mix(in srgb, var(--dsw-alias-link) 58%, var(--dsw-alias-bg-layer-3))' } }),
            h('i', { style: { width: `${outputPct * 100}%`, background: 'var(--dsw-alias-link)' } }),
          ),
          h(
            'div',
            { className: 'us-breaklegend', title: t('kpi.cacheHint') },
            h('span', null, h(Dot, { color: 'color-mix(in srgb, var(--dsw-alias-link) 26%, var(--dsw-alias-bg-layer-3))' }), t('kpi.cache'), ' ', pctFromRatio(cachePct)),
            h('span', null, h(Dot, { color: 'color-mix(in srgb, var(--dsw-alias-link) 58%, var(--dsw-alias-bg-layer-3))' }), t('kpi.input'), ' ', pctFromRatio(inputPct)),
            h('span', null, h(Dot, { color: 'var(--dsw-alias-link)' }), t('kpi.output'), ' ', pctFromRatio(outputPct)),
          ),
          h('div', { className: 'us-kpi-sub' }, t('kpi.tokensSub', { today: compactTokens(summary.tokensToday || 0) })),
        ),
        h(
          'section',
          { className: 'us-kpi' },
          h('div', { className: 'us-kpi-hd' }, h(Icon, { name: 'sessions', size: 12 }), t('kpi.sessions')),
          h('div', { className: 'us-kpi-v' }, numberFmt(summary.sessions), h('small', null, t('kpi.sessionsUnit'))),
          h('div', { className: 'us-kpi-sub us-kpi-tones' }, t('kpi.sessionsSub', { main: summary.mainSessions, sub: summary.subagentSessions })),
          h('div', { className: 'us-kpi-sub' }, t('kpi.activeDays', { days: summary.activeDays }), ' · ', t('kpi.avgTokens', { value: compactTokens(summary.avgTokensPerSession) })),
          h('div', { className: 'us-kpi-sub' }, t('kpi.events', { events: numberFmt(summary.events) }), ' · ', t('kpi.lastActivity', { time: relTime(summary.lastActivityAt, now) })),
        ),
        h(
          'section',
          { className: 'us-kpi' },
          h('div', { className: 'us-kpi-hd' }, h(Icon, { name: 'cost', size: 12 }), t('kpi.cost')),
          h('div', { className: 'us-kpi-v', title: t('kpi.costHint') }, compactCny(summary.costCny)),
          h('div', { className: 'us-kpi-sub' }, t('kpi.today', { value: compactCny(summary.costTodayCny) }), ' · ', t('kpi.month', { value: compactCny(summary.costThisMonthCny) })),
          h('div', { className: 'us-kpi-sub' }, t('kpi.perSession', { value: compactCny(summary.avgCostPerSessionCny) }), ' · ', t('kpi.peakShare', { value: pctFromRatio(summary.peakTokenShare) })),
          h(
            'div',
            { className: 'us-kpi-sub' },
            h('span', { className: 'us-chip', title: t('kpi.priceHint') }, h('i', null), t('kpi.priceChip', { hit: summary.price?.rates?.cacheHit ?? 0, miss: summary.price?.rates?.cacheMiss ?? 0 })),
          ),
        ),
        h(BudgetCard, { t, summary, budget, budgetOverride, budgetPct, projectedPct, over }),
      );
    }

    function BudgetCard({ t, summary, budget, budgetOverride, budgetPct, projectedPct, over }) {
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState('');
      const inputRef = useRef(null);

      useEffect(() => {
        if (!editing) return;
        setDraft(String(budget));
        const timer = window.setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(timer);
      }, [editing]);

      const commit = (value) => {
        setEditing(false);
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) setBudget(parsed);
      };

      return h(
        'section',
        { className: 'us-kpi' },
        h(
          'div',
          { className: 'us-kpi-hd' },
          h(Icon, { name: 'wallet', size: 12 }),
          t('kpi.budget'),
          h(
            'span',
            { style: { marginLeft: 'auto', fontSize: 9, fontWeight: 500, letterSpacing: 0, textTransform: 'none', color: 'var(--us-muted)' } },
            summary.budget.period === 'all' ? t('kpi.budgetAll') : t('kpi.budgetMonth'),
          ),
        ),
        editing
          ? h('input', {
              ref: inputRef,
              className: 'us-budgetinput',
              type: 'number',
              min: '1',
              step: '10',
              value: draft,
              'aria-label': t('kpi.budgetEdit'),
              'data-us': 'budget-input',
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(draft),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commit(draft);
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setEditing(false);
                }
              },
            })
          : h(
              'button',
              { type: 'button', className: 'us-budgetval', onClick: () => setEditing(true), title: t('kpi.budgetEdit'), 'data-us': 'budget-value' },
              compactCny(budget),
              h(Icon, { name: 'edit', size: 11 }),
            ),
        h(
          'div',
          { className: 'us-budgetline' },
          h('div', { className: 'us-kpi-sub' }, t('kpi.budgetUsed', { used: compactCny(summary.budget.usedCny), amount: compactCny(budget) })),
          over ? h('span', { className: 'us-pill-err', style: { fontSize: 10 } }, t('kpi.overBudget')) : null,
        ),
        h(
          'div',
          {
            className: 'us-progress' + (over ? ' us-over' : ''),
            role: 'progressbar',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(Math.min(1, budgetPct) * 100),
          },
          h('i', { style: { width: `${Math.min(1, Math.max(0, budgetPct)) * 100}%` } }),
          projectedPct > 0 && projectedPct < 1.6
            ? h('b', { style: { left: `calc(${Math.min(100, projectedPct * 100)}% - 1px)` }, title: t('kpi.projectedHint') })
            : null,
        ),
        h(
          'div',
          { className: 'us-kpi-sub' },
          t('kpi.budgetRemain', { value: compactCny(Math.max(0, budget - summary.budget.usedCny)) }),
          ' · ',
          t('kpi.projected', { value: compactCny(summary.budget.projectedMonthCny) }),
          budgetOverride ? h('button', { type: 'button', className: 'us-reset', onClick: () => setBudget(null), style: { marginLeft: 6 } }, t('kpi.reset')) : null,
        ),
      );
    }

    const MODEL_PALETTE = [
      'var(--dsw-alias-link)',
      '#22a06b',
      '#e0a13b',
      '#a06bff',
      '#e5695f',
      '#2fb3c6',
      '#8ab4f8',
      '#c98bdb',
      '#7bc47f',
      '#d98b3a',
    ];
    const MODEL_OTHER_COLOR = 'color-mix(in srgb, var(--us-muted) 45%, transparent)';

    /*
     * One colour per model family, shared by the pie, the price strip and the
     * session detail, so a model reads the same everywhere. Ranking is by
     * all-time tokens, which keeps the top names stable while the range switch
     * changes.
     */
    function buildModelColors(data) {
      const order = [];
      const seen = new Set();
      const push = (model) => {
        if (typeof model !== 'string' || model === '' || seen.has(model)) return;
        seen.add(model);
        order.push(model);
      };
      for (const entry of [...(data?.byModel ?? [])].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0))) push(entry.model);
      for (const day of data?.modelDaily ?? []) for (const entry of day.models ?? []) push(entry.model);
      const map = new Map();
      order.forEach((model, index) => {
        if (index < MODEL_PALETTE.length) {
          map.set(model, MODEL_PALETTE[index]);
          return;
        }
        let hash = 0;
        for (let i = 0; i < model.length; i += 1) hash = (hash * 31 + model.charCodeAt(i)) | 0;
        map.set(model, MODEL_PALETTE[Math.abs(hash) % MODEL_PALETTE.length]);
      });
      return map;
    }

    function modelColor(colors, model) {
      const color = colors instanceof Map ? colors.get(model) : undefined;
      return color ?? 'var(--us-accent)';
    }

    /* Same family, different provider: keep the hue, dim it a step or two. */
    function modelColorVariant(color, level) {
      if (level <= 0) return color;
      const percent = level === 1 ? 58 : 40;
      return `color-mix(in srgb, ${color} ${percent}%, var(--dsw-alias-bg-layer-1))`;
    }
    const MODEL_MAX_SLICES = 9;
    const DONUT_RADIUS = 76;
    const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

    /* Aggregate the host's per-day provider/model buckets over the selected window. */
    function modelWindow(data, range, now) {
      const daily = Array.isArray(data.modelDaily) ? data.modelDaily : null;
      if (daily !== null) {
        const startKey = range > 0 ? addDays(beijingDateKey(now), -(range - 1)) : '';
        const acc = new Map();
        for (const day of daily) {
          if (startKey !== '' && day.date < startKey) continue;
          for (const entry of day.models ?? []) {
            const key = `${entry.provider ?? ''}\u0000${entry.model}`;
            const bucket =
              acc.get(key) ?? {
                provider: entry.provider ?? '',
                model: entry.model,
                label: entry.label ?? '',
                estimated: entry.estimated === true,
                totalTokens: 0,
                costCny: 0,
                events: 0,
              };
            bucket.totalTokens += entry.totalTokens ?? 0;
            bucket.costCny += entry.costCny ?? 0;
            bucket.events += entry.events ?? 0;
            bucket.estimated = bucket.estimated || entry.estimated === true;
            acc.set(key, bucket);
          }
        }
        const entries = [...acc.values()];
        return {
          entries,
          windowed: true,
          totalTokens: entries.reduce((sum, entry) => sum + entry.totalTokens, 0),
          costCny: entries.reduce((sum, entry) => sum + entry.costCny, 0),
        };
      }
      /* Older host: the month bucket, else the all-time split. */
      const legacy = data.modelsThisMonth;
      const entries = Array.isArray(legacy?.byModel) ? legacy.byModel : Array.isArray(data.byModel) ? data.byModel : [];
      return {
        entries,
        windowed: false,
        totalTokens: legacy?.totalTokens ?? entries.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
        costCny: legacy?.costCny ?? entries.reduce((sum, entry) => sum + (entry.costCny ?? 0), 0),
      };
    }

    /*
     * Model share for the current Beijing calendar month, split by provider as
     * well: one model id can be served by several configured routes, and only
     * the pair tells them apart. The host sends `modelsThisMonth` (events
     * bucketed by month); an older host only sends the all-time `byModel`, so
     * fall back to it and label the window accordingly. The pie is weighted by
     * tokens by default and by cost on demand.
     */
    function ModelShareCard({ t, data, range, colors }) {
      const [metric, setMetric] = useState('tokens');
      const [hover, setHover] = useState(null);
      const [pointer, setPointer] = useState(null);
      const view = modelWindow(data, range, Date.now());
      const entries = view.entries;
      const metricOf = (entry) => (metric === 'cost' ? entry.costCny ?? 0 : entry.totalTokens ?? 0);
      const total = entries.reduce((sum, entry) => sum + metricOf(entry), 0);
      const sorted = entries.slice().sort((a, b) => metricOf(b) - metricOf(a));
      const tail = sorted.slice(MODEL_MAX_SLICES);
      const familySeen = new Map();
      const rows = sorted.slice(0, MODEL_MAX_SLICES).map((entry) => {
        const seen = familySeen.get(entry.model) ?? 0;
        familySeen.set(entry.model, seen + 1);
        return {
        key: `${entry.provider ?? ''}\u0000${entry.model}`,
        provider: entry.provider ?? '',
        name: modelLabel(entry.model, entry.label),
        color: modelColorVariant(modelColor(colors, entry.model), seen),
        weight: metricOf(entry),
        tokens: entry.totalTokens ?? 0,
        costCny: entry.costCny ?? 0,
        events: entry.events ?? 0,
        estimated: entry.estimated === true,
        };
      });
      if (tail.length > 0) {
        rows.push({
          key: '__other',
          provider: '',
          name: t('models.other', { count: tail.length }),
          color: MODEL_OTHER_COLOR,
          weight: tail.reduce((sum, entry) => sum + metricOf(entry), 0),
          tokens: tail.reduce((sum, entry) => sum + (entry.totalTokens ?? 0), 0),
          costCny: tail.reduce((sum, entry) => sum + (entry.costCny ?? 0), 0),
          events: tail.reduce((sum, entry) => sum + (entry.events ?? 0), 0),
          estimated: tail.some((entry) => entry.estimated === true),
        });
      }
      const shareOf = (value) => (total > 0 ? value / total : 0);
      const windowTokens = view.totalTokens;
      const windowCost = view.costCny;
      const windowLabel = view.windowed && range > 0 ? t('range.' + range) : t('models.allTime');
      let cursor = 0;
      const slices = rows.map((row, index) => {
        const fraction = shareOf(row.weight);
        const slice = { ...row, index, fraction, offset: cursor };
        cursor += fraction;
        return slice;
      });
      const hovered = hover === null ? null : rows[hover];
      const centerValue = metric === 'cost' ? compactCny(windowCost) : compactTokens(windowTokens);

      return h(
        'section',
        { className: 'us-card', 'data-us': 'models' },
        h(
          'div',
          { className: 'us-cardhd' },
          h(Icon, { name: 'chart', size: 12 }),
          h('span', { className: 'us-cardtitle' }, t('models.title')),
          h(
            'span',
            { className: 'us-cardsub' },
            view.windowed
              ? t('models.sub', { window: windowLabel, tokens: compactTokens(windowTokens), cost: compactCny(windowCost) })
              : t('models.subAll', { tokens: compactTokens(windowTokens), cost: compactCny(windowCost) }),
          ),
          h(
            'div',
            { className: 'us-cardhd-right' },
            h(Segmented, {
              label: t('models.metric'),
              kind: 'models',
              value: metric,
              onChange: setMetric,
              options: [
                { value: 'tokens', label: t('models.byTokens') },
                { value: 'cost', label: t('models.byCost') },
              ],
            }),
          ),
        ),
        rows.length === 0
          ? h('div', { className: 'us-mempty' }, t('models.empty'))
          : h(
              'div',
              { className: 'us-modelbody' },
              h(
                'div',
                { className: 'us-donutwrap' },
                h(
                  'svg',
                  {
                    className: 'us-donut',
                    viewBox: '0 0 200 200',
                    role: 'img',
                    'aria-label': t('models.aria', {
                      count: rows.length,
                      window: windowLabel,
                      tokens: compactTokens(windowTokens),
                      cost: compactCny(windowCost),
                    }),
                  },
                  slices.map((slice) =>
                    h('circle', {
                      key: slice.key,
                      className: 'us-slice' + (hover !== null && hover !== slice.index ? ' us-dim' : ''),
                      cx: 100,
                      cy: 100,
                      r: DONUT_RADIUS,
                      fill: 'none',
                      stroke: slice.color,
                      strokeWidth: hover === slice.index ? 34 : 30,
                      strokeDasharray: `${Math.max(0.4, slice.fraction * DONUT_CIRCUMFERENCE - 1.5)} ${DONUT_CIRCUMFERENCE}`,
                      strokeDashoffset: -slice.offset * DONUT_CIRCUMFERENCE,
                      transform: 'rotate(-90 100 100)',
                      'data-us': 'slice',
                      onPointerEnter: () => setHover(slice.index),
                      onPointerLeave: () => {
                        setHover(null);
                        setPointer(null);
                      },
                      onPointerMove: (event) => {
                        const svg = event.currentTarget.ownerSVGElement;
                        if (!svg) return;
                        const rect = svg.getBoundingClientRect();
                        const scale = rect.width > 0 ? 200 / rect.width : 1;
                        setPointer({ x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale });
                      },
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'us-donutcenter' },
                  h('b', null, centerValue),
                  h('span', null, metric === 'cost' ? t('models.costTotal') : t('models.tokenTotal')),
                  h('em', null, windowLabel),
                ),
                hovered && pointer
                  ? h(
                      'div',
                      {
                        className: 'us-tooltip',
                        style: {
                          left: Math.max(4, Math.min(pointer.x + 12, 214 - 178)),
                          top: Math.max(4, Math.min(pointer.y - 12, 214 - 104)),
                        },
                      },
                      h(
                        'div',
                        { className: 'us-tt-hd' },
                        h('strong', null, hovered.name),
                        h('span', null, pctFromRatio(shareOf(hovered.weight))),
                      ),
                      hovered.provider
                        ? h('div', { className: 'us-tt-row' }, h('em', null, t('models.provider')), h('b', null, hovered.provider))
                        : null,
                      h('div', { className: 'us-tt-row' }, h('em', null, t('models.tokens')), h('b', null, compactTokens(hovered.tokens))),
                      h('div', { className: 'us-tt-row' }, h('em', null, t('models.cost')), h('b', null, compactCny(hovered.costCny))),
                      h('div', { className: 'us-tt-row' }, h('em', null, t('models.events')), h('b', null, numberFmt(hovered.events))),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'us-mlegend' },
                /*
                 * Sorted rows fill the first column top to bottom, then the
                 * second: two explicit columns instead of a row-major grid, so
                 * reading order matches the ranking.
                 */
                [rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))].map((column, columnIndex) =>
                  h(
                    'div',
                    { className: 'us-mcol', key: `col${columnIndex}` },
                    column.map((row) => {
                      const index = rows.indexOf(row);
                      return h(
                        'div',
                        {
                          className: 'us-mrow' + (hover === index ? ' us-active' : ''),
                          key: row.key,
                          'data-us': 'model-row',
                          'data-us-rank': index,
                          onPointerEnter: () => setHover(index),
                          onPointerLeave: () => setHover(null),
                          title: `${row.name}${row.provider ? ' · ' + row.provider : ''} · ${exactTokens(row.tokens)} tokens · ${compactCny(row.costCny)}`,
                        },
                        h('i', { className: 'us-mdot', style: { background: row.color } }),
                        h(
                          'span',
                          { className: 'us-mcell' },
                          h('span', { className: 'us-mname' }, row.estimated ? `≈ ${row.name}` : row.name),
                          row.provider ? h('span', { className: 'us-mprov' }, row.provider) : null,
                        ),
                        h(
                          'span',
                          { className: 'us-mnums' },
                          h('span', { className: 'us-mshare' }, pctFromRatio(shareOf(row.weight))),
                          h('span', { className: 'us-mval' }, compactTokens(row.tokens)),
                          h('span', { className: 'us-mcost' }, compactCny(row.costCny)),
                        ),
                      );
                    }),
                  ),
                ),
              ),
            ),
      );
    }

    function PriceStrip({ t, data, colors }) {
      const summary = data.summary;
      const price = summary.price ?? {};
      const peak = price.peak === true;
      const byModel = data.byModel ?? [];
      const fallbackModels = Array.isArray(summary.price?.fallbackModels) ? summary.price.fallbackModels : [];
      const totalCost = byModel.reduce((sum, entry) => sum + entry.costCny, 0) || 1;
      return h(
        'div',
        { className: 'us-strip', 'data-us': 'strip' },
        h(
          'span',
          { className: 'us-band' + (peak ? ' us-peak' : '') },
          h('i', null),
          peak ? t('price.peak') : t('price.offPeak'),
          h('span', { style: { color: 'var(--us-muted)', fontWeight: 500 } }, peak ? '2×' : '1×'),
        ),
        h(
          'span',
          { className: 'us-rates' },
          h('span', null, t('price.hit'), ' ', h('b', null, compactCny(price.rates?.cacheHit ?? 0)), t('price.perM')),
          h('span', null, t('price.miss'), ' ', h('b', null, compactCny(price.rates?.cacheMiss ?? 0)), t('price.perM')),
          h('span', null, t('price.out'), ' ', h('b', null, compactCny(price.rates?.output ?? 0)), t('price.perM')),
        ),
        h(
          'span',
          { className: 'us-modelmix' },
          byModel.slice(0, 4).map((entry) =>
            h(
              'span',
              { className: 'us-chip', key: entry.model, title: `${entry.model} · ${exactTokens(entry.totalTokens)} tokens` },
              h('i', { style: { background: modelColor(colors, entry.model) } }),
              `${entry.estimated ? '≈ ' : ''}${modelLabel(entry.model, entry.label)} ${pctFromRatio(entry.costCny / totalCost)}`,
            ),
          ),
          fallbackModels.length > 0
            ? h(
                'span',
                { className: 'us-chip', title: fallbackModels.join(', '), style: { borderStyle: 'dashed' } },
                h('i', null),
                t('price.estimated'),
              )
            : null,
        ),
        h('span', { className: 'us-note', title: price.note ?? '' }, h(Icon, { name: 'info', size: 11 }), h('span', null, t('price.note'))),
      );
    }

    /* --------------------------------------------------------------------- */
    /* Timeline                                                              */
    /* --------------------------------------------------------------------- */

    function buildDaily(entries, range, now) {
      const list = (entries ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
      if (list.length === 0) return [];
      const today = beijingDateKey(now);
      const last = list[list.length - 1].date > today ? list[list.length - 1].date : today;
      const first = list[0].date;
      const spanDays = Math.round((dateToUtc(last) - dateToUtc(first)) / 86_400_000) + 1;
      const earliest = spanDays > 200 ? addDays(last, -199) : first;
      const requested = range === 0 ? earliest : addDays(last, -(range - 1));
      const start = requested < first ? first : requested;
      const byDate = new Map(list.map((entry) => [entry.date, entry]));
      const out = [];
      for (let cursor = start; cursor <= last; cursor = addDays(cursor, 1)) {
        out.push(
          byDate.get(cursor) ?? {
            date: cursor,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            costCny: 0,
            events: 0,
          },
        );
        if (out.length > 200) break;
      }
      return out;
    }

    function niceMax(value, ticks = 4) {
      if (!Number.isFinite(value) || value <= 0) return 1;
      const rough = value / ticks;
      const power = 10 ** Math.floor(Math.log10(rough));
      const normalized = rough / power;
      const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * power;
      return step * ticks;
    }

    function useMeasuredWidth(ref) {
      const [width, setWidth] = useState(0);
      useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        const update = () => setWidth(node.clientWidth || 0);
        update();
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(update);
          observer.observe(node);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, []);
      return width;
    }

    function TimelineCard({ t, data, range }) {
      const [mode, setMode] = useState('tokens');
      const [hover, setHover] = useState(null);
      const wrapRef = useRef(null);
      const width = useMeasuredWidth(wrapRef);
      const now = Date.now();
      const days = useMemo(() => buildDaily(data.timeline?.daily, range, now), [data, range, now]);
      const isZhLocale = isZh();
      const chart = useMemo(() => {
        const height = 172;
        const padLeft = width && width < 520 ? 50 : 42;
        const padRight = 8;
        const padTop = 14;
        const padBottom = 22;
        const plotW = Math.max(80, (width || 900) - padLeft - padRight);
        const plotH = height - padTop - padBottom;
        const tokenMax = Math.max(1, ...days.map((day) => day.tokens.total));
        const costMax = Math.max(0.0001, ...days.map((day) => day.costCny));
        const max = mode === 'tokens' ? niceMax(tokenMax, 5) : niceMax(costMax, 5);
        const slot = plotW / Math.max(1, days.length);
        const barW = Math.max(3, Math.min(36, slot * (days.length > 24 ? 0.72 : 0.58)));
        const today = beijingDateKey(now);
        const bars = days.map((day, index) => ({
          day,
          index,
          x: padLeft + slot * index + (slot - barW) / 2,
          barW,
          cacheH: mode === 'tokens' ? (day.tokens.cacheRead / max) * plotH : 0,
          inputH: mode === 'tokens' ? (day.tokens.input / max) * plotH : 0,
          outputH: mode === 'tokens' ? (day.tokens.output / max) * plotH : 0,
          costH: mode === 'cost' ? (day.costCny / max) * plotH : 0,
          isToday: day.date === today,
        }));
        const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) => ({ value: max * fraction, y: padTop + plotH - plotH * fraction }));
        const labelStep = Math.max(1, Math.ceil(days.length / (width && width < 520 ? 4 : 7)));
        return { height, padLeft, padRight, padTop, padBottom, plotW, plotH, max, slot, barW, bars, ticks, labelStep };
      }, [days, width, mode, now]);

      const formatAxis = (value) => {
        if (mode === 'cost') return compactCny(value);
        if (!Number.isFinite(value)) return '0';
        if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 1 : 2)}亿`;
        if (value >= 1e4) return `${Math.round(value / 1e4)}万`;
        return String(Math.round(value));
      };
      const hoverDay = hover === null ? null : chart.bars[hover];
      const totalCost = days.reduce((sum, day) => sum + day.costCny, 0);

      if (days.length === 0 || days.every((day) => day.tokens.total === 0 && day.costCny === 0)) {
        return h(
          'section',
          { className: 'us-card' },
          h(
            'div',
            { className: 'us-cardhd' },
            h('span', { className: 'us-cardtitle' }, t('chart.title')),
            h(
              'div',
              { className: 'us-cardhd-right' },
              h(Segmented, {
                label: t('chart.mode'),
                kind: 'mode',
                value: mode,
                onChange: setMode,
                options: [
                  { value: 'tokens', label: t('chart.tokens') },
                  { value: 'cost', label: t('chart.cost') },
                ],
              }),
            ),
          ),
          h('div', { className: 'us-empty' }, t('chart.empty')),
        );
      }

      return h(
        'section',
        { className: 'us-card', 'data-us': 'chart-card' },
        h(
          'div',
          { className: 'us-cardhd' },
          h('span', { className: 'us-cardtitle' }, t('chart.title')),
          h('span', { className: 'us-cardsub' }, t('chart.sub', { count: days.filter((day) => day.tokens.total > 0).length, total: compactCny(totalCost) })),
          h(
            'div',
            { className: 'us-cardhd-right' },
            h(
              'div',
              { className: 'us-legend', style: { padding: 0 } },
              mode === 'tokens'
                ? [
                    h('span', { key: 'c' }, h('i', { style: { background: 'color-mix(in srgb, var(--dsw-alias-link) 26%, var(--dsw-alias-bg-layer-3))' } }), t('kpi.cache')),
                    h('span', { key: 'i' }, h('i', { style: { background: 'color-mix(in srgb, var(--dsw-alias-link) 58%, var(--dsw-alias-bg-layer-3))' } }), t('kpi.input')),
                    h('span', { key: 'o' }, h('i', { style: { background: 'var(--dsw-alias-link)' } }), t('kpi.output')),
                  ]
                : [h('span', { key: 'cost' }, h('i', { style: { background: 'var(--dsw-alias-link)' } }), t('chart.costLegend'))],
            ),
            h(Segmented, {
              label: t('chart.mode'),
              kind: 'mode',
              value: mode,
              onChange: setMode,
              options: [
                { value: 'tokens', label: t('chart.tokens') },
                { value: 'cost', label: t('chart.cost') },
              ],
            }),
          ),
        ),
        h(
          'div',
          { className: 'us-chartwrap', ref: wrapRef },
          h(
            'svg',
            {
              className: 'us-chart',
              viewBox: `0 0 ${Math.max(280, width || 900)} ${chart.height}`,
              height: chart.height,
              role: 'img',
              'aria-label': t('chart.aria', { days: days.length, tokens: compactTokens(days.reduce((sum, day) => sum + day.tokens.total, 0)), cost: compactCny(totalCost) }),
              onPointerMove: (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const scale = (width || 900) / rect.width;
                const x = (event.clientX - rect.left) * scale;
                const index = Math.round((x - chart.padLeft - chart.slot / 2) / chart.slot);
                setHover(index >= 0 && index < chart.bars.length ? index : null);
              },
              onPointerLeave: () => setHover(null),
            },
            chart.ticks.map((tick, index) =>
              h(
                'g',
                { key: `t${index}` },
                h('line', { className: 'us-gridline', x1: chart.padLeft, x2: chart.padLeft + chart.plotW, y1: tick.y, y2: tick.y }),
                h('text', { className: 'us-axis', x: chart.padLeft - 7, y: tick.y + 3, textAnchor: 'end' }, formatAxis(tick.value)),
              ),
            ),
            chart.bars.map((bar) => {
              const baseY = chart.padTop + chart.plotH;
              const dim = hover !== null && hover !== bar.index;
              if (mode === 'tokens') {
                const cacheY = baseY - bar.cacheH;
                const inputY = cacheY - bar.inputH;
                const outputY = inputY - bar.outputH;
                return h(
                  'g',
                  { key: bar.day.date, className: 'us-chartbar' + (dim ? ' us-dim' : ''), 'data-us': 'bar' },
                  hover === bar.index ? h('rect', { x: bar.x - 2, y: chart.padTop, width: bar.barW + 4, height: chart.plotH, fill: 'var(--dsw-alias-interactive-bg-hover)', rx: 4 }) : null,
                  h('rect', { x: bar.x, y: cacheY, width: bar.barW, height: Math.max(0, bar.cacheH), rx: Math.min(3, bar.barW / 3), fill: 'color-mix(in srgb, var(--dsw-alias-link) 26%, var(--dsw-alias-bg-layer-3))' }),
                  h('rect', { x: bar.x, y: inputY, width: bar.barW, height: Math.max(0, bar.inputH), rx: Math.min(3, bar.barW / 3), fill: 'color-mix(in srgb, var(--dsw-alias-link) 58%, var(--dsw-alias-bg-layer-3))' }),
                  h('rect', { x: bar.x, y: outputY, width: bar.barW, height: Math.max(0.6, bar.outputH), rx: Math.min(3, bar.barW / 3), fill: 'var(--dsw-alias-link)' }),
                  bar.isToday
                    ? h('rect', { x: bar.x - 1, y: chart.padTop, width: bar.barW + 2, height: chart.plotH, fill: 'none', stroke: 'var(--dsw-alias-link)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.55, rx: 4 })
                    : null,
                );
              }
              const barHeight = Math.max(bar.costCny > 0 ? 1.5 : 0, bar.costH);
              return h(
                'g',
                { key: bar.day.date, className: 'us-chartbar' + (dim ? ' us-dim' : ''), 'data-us': 'bar' },
                hover === bar.index ? h('rect', { x: bar.x - 2, y: chart.padTop, width: bar.barW + 4, height: chart.plotH, fill: 'var(--dsw-alias-interactive-bg-hover)', rx: 4 }) : null,
                h('rect', {
                  x: bar.x,
                  y: baseY - barHeight,
                  width: bar.barW,
                  height: barHeight,
                  rx: Math.min(3, bar.barW / 3),
                  fill: bar.isToday ? 'var(--dsw-alias-link)' : 'color-mix(in srgb, var(--dsw-alias-link) 62%, var(--dsw-alias-bg-layer-3))',
                }),
              );
            }),
            chart.bars.map((bar) => {
              const show = bar.index % chart.labelStep === 0 || bar.index === chart.bars.length - 1 || bar.isToday;
              if (!show) return null;
              return h(
                'text',
                { key: `x${bar.day.date}`, className: 'us-axis' + (bar.isToday ? ' us-today' : ''), x: bar.x + bar.barW / 2, y: chart.height - 7, textAnchor: 'middle' },
                bar.isToday ? (isZhLocale ? '今天' : 'Today') : fmtDateShort(bar.day.date),
              );
            }),
          ),
          hoverDay
            ? h(
                'div',
                {
                  className: 'us-tooltip',
                  style: {
                    left: Math.min(Math.max(0, hoverDay.x + hoverDay.barW / 2 - 78), Math.max(10, (width || 900) - 168)),
                    top: 8,
                  },
                },
                h('div', { className: 'us-tt-hd' }, h('strong', null, hoverDay.isToday ? (isZhLocale ? '今天' : 'Today') : fmtDateShort(hoverDay.day.date)), h('span', null, t('chart.events', { count: numberFmt(hoverDay.day.events) }))),
                h('div', { className: 'us-tt-row' }, h('em', null, h(Dot, { color: 'var(--dsw-alias-link)' }), t('kpi.output')), h('b', null, compactTokens(hoverDay.day.tokens.output))),
                h('div', { className: 'us-tt-row' }, h('em', null, h(Dot, { color: 'color-mix(in srgb, var(--dsw-alias-link) 58%, var(--dsw-alias-bg-layer-3))' }), t('kpi.input')), h('b', null, compactTokens(hoverDay.day.tokens.input))),
                h('div', { className: 'us-tt-row' }, h('em', null, h(Dot, { color: 'color-mix(in srgb, var(--dsw-alias-link) 26%, var(--dsw-alias-bg-layer-3))' }), t('kpi.cache')), h('b', null, compactTokens(hoverDay.day.tokens.cacheRead))),
                h('div', { className: 'us-tt-total' }, h('span', null, t('kpi.cost')), h('span', null, compactCny(hoverDay.day.costCny))),
              )
            : null,
        ),
        h(
          'div',
          { className: 'us-legend' },
          h('span', null, h(Icon, { name: 'pulse', size: 11 }), t('chart.peakHint')),
          h('span', { style: { marginLeft: 'auto' } }, t('chart.todayHint')),
        ),
      );
    }

    /* --------------------------------------------------------------------- */
    /* Sessions                                                              */
    /* --------------------------------------------------------------------- */

    function SessionsCard({ t, data, now, colors }) {
      const [query, setQuery] = useState('');
      const [filter, setFilter] = useState('all');
      const [sort, setSort] = useState({ key: 'last', dir: 'desc' });
      const [expanded, setExpanded] = useState(null);

      const totalTokens = data.summary.totalTokens || 1;
      const rows = useMemo(() => {
        const terms = query.trim().toLowerCase();
        let list = (data.sessions ?? []).filter((session) => {
          if (filter === 'main' && session.isSubagent) return false;
          if (filter === 'sub' && !session.isSubagent) return false;
          if (!terms) return true;
          const haystack = `${session.title} ${session.workspace} ${session.cwd} ${(session.models ?? []).join(' ')}`.toLowerCase();
          return haystack.includes(terms);
        });
        const direction = sort.dir === 'asc' ? 1 : -1;
        list = list.slice().sort((a, b) => {
          if (sort.key === 'last') return (a.lastActiveAt - b.lastActiveAt) * direction;
          if (sort.key === 'tokens') return (a.totalTokens - b.totalTokens) * direction;
          if (sort.key === 'cost') return (a.costCny - b.costCny) * direction;
          if (sort.key === 'turns') return ((a.turns ?? 0) - (b.turns ?? 0)) * direction;
          return 0;
        });
        return list;
      }, [data, query, filter, sort]);

      const toggleSort = (key) => {
        setSort((current) => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
      };

      const sortButton = (key, label, className) =>
        h(
          'button',
          {
            type: 'button',
            className: 'us-sortbtn' + (className ? ` ${className}` : ''),
            'data-active': sort.key === key,
            'data-us-sort': key,
            onClick: () => toggleSort(key),
            'aria-label': t('sessions.sortBy', { column: label }),
          },
          label,
          sort.key === key ? h('span', { 'aria-hidden': true }, sort.dir === 'desc' ? '↓' : '↑') : null,
        );

      return h(
        'section',
        { className: 'us-card' },
        h(
          'div',
          { className: 'us-cardhd' },
          h('span', { className: 'us-cardtitle' }, t('sessions.title')),
          h('span', { className: 'us-cardsub' }, t('sessions.count', { count: rows.length, total: data.sessions?.length ?? 0 })),
          h(
            'div',
            { className: 'us-cardhd-right' },
            h(
              'label',
              { className: 'us-search' },
              h(Icon, { name: 'search', size: 11 }),
              h('input', {
                value: query,
                placeholder: t('sessions.search'),
                'aria-label': t('sessions.search'),
                'data-us': 'session-search',
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(Segmented, {
              label: t('sessions.filter'),
              kind: 'filter',
              value: filter,
              onChange: setFilter,
              options: [
                { value: 'all', label: t('sessions.all') },
                { value: 'main', label: t('sessions.main') },
                { value: 'sub', label: t('sessions.sub') },
              ],
            }),
          ),
        ),
        h(
          'div',
          { className: 'us-tablehd' },
          sortButton('last', t('sessions.colSession')),
          sortButton('tokens', t('sessions.colTokens'), 'us-col-tokens'),
          sortButton('cost', t('sessions.colCost'), 'us-col-cost'),
          sortButton('turns', t('sessions.colTurns'), 'us-col-turns'),
          h('span', null),
        ),
        h(
          'div',
          { className: 'us-rows' },
          rows.length === 0
            ? h('div', { className: 'us-empty' }, t('sessions.empty'))
            : rows.map((session) =>
                h(SessionRow, {
                  key: session.id,
                  t,
                  session,
                  now,
                  totalTokens,
                  colors,
                  expanded: expanded === session.id,
                  onToggle: () => setExpanded((current) => (current === session.id ? null : session.id)),
                }),
              ),
        ),
      );
    }

    function SessionRow({ t, session, now, totalTokens, expanded, onToggle, colors }) {
      const [detail, setDetail] = useState(() => detailCache.get(session.id)?.data ?? null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);

      useEffect(() => {
        if (!expanded || detail) return undefined;
        let cancelled = false;
        setLoading(true);
        setError(null);
        loadDetail(session.id)
          .then((value) => {
            if (!cancelled) {
              setDetail(value);
              setLoading(false);
            }
          })
          .catch((cause) => {
            if (!cancelled) {
              setError(cause?.message ?? String(cause));
              setLoading(false);
            }
          });
        return () => {
          cancelled = true;
        };
      }, [expanded, detail, session.id]);

      const share = totalTokens > 0 ? session.totalTokens / totalTokens : 0;
      const subline = [session.workspace || session.cwd, (session.models ?? []).map((model) => modelLabel(model)).join(' / ')].filter(Boolean).join(' · ');

      return h(
        'div',
        { className: 'us-row', 'data-us': 'session-row', 'data-id': session.id },
        h(
          'div',
          {
            className: 'us-rowmain',
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded,
            onClick: onToggle,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggle();
              }
            },
          },
          h(
            'div',
            { className: 'us-rowname' },
            h('span', { className: 'us-expand' }, h(Icon, { name: 'right', size: 11, strokeWidth: 2 })),
            h(
              'div',
              { className: 'us-rowtext' },
              h(
                'div',
                { className: 'us-rowtitle' },
                h('span', { title: session.title }, session.title),
                session.isSubagent ? h('span', { className: 'us-subtag' }, t('sessions.subTag')) : null,
                session.archived ? h('span', { className: 'us-subtag us-archived' }, t('sessions.archivedTag')) : null,
              ),
              h('div', { className: 'us-rowmeta', title: subline }, subline),
            ),
          ),
          h('span', { className: 'us-cell us-col-updated', title: fmtDateTime(session.lastActiveAt) }, relTime(session.lastActiveAt, now)),
          h('span', { className: 'us-cell us-strong us-col-tokens', title: exactTokens(session.totalTokens) }, compactTokens(session.totalTokens)),
          h('span', { className: 'us-cell us-col-cost' }, compactCny(session.costCny)),
          h('span', { className: 'us-cell us-col-turns' }, numberFmt(session.turns ?? 0)),
        ),
        h('div', { className: 'us-rowshare', 'aria-hidden': true }, h('i', { style: { width: `${Math.max(0.6, share * 100)}%` } })),
        expanded
          ? h(SessionDetail, {
              t,
              session,
              detail,
              loading,
              error,
              colors,
              onRetry: () => {
                detailCache.delete(session.id);
                setDetail(null);
                setError(null);
              },
            })
          : null,
      );
    }

    function SessionDetail({ t, session, detail, loading, error, onRetry, colors }) {
      const allTurns = detail?.turns ?? [];
      const turns = allTurns.slice(-36);
      const maxTurnTokens = Math.max(1, ...turns.map((turn) => turn.tokens.total));
      const models = detail?.session?.costByModel ?? session.costByModel ?? [];
      const modelCost = models.reduce((sum, entry) => sum + entry.costCny, 0) || 1;

      const stat = (label, value) => h('div', { className: 'us-stat' }, h('span', { className: 'k' }, label), h('span', { className: 'v', title: value }, value));

      return h(
        'div',
        { className: 'us-detail', 'data-us': 'session-detail' },
        loading
          ? h(
              'div',
              { className: 'us-detailload' },
              h('span', { className: 'us-skel', style: { width: 14, height: 12, borderRadius: '50%' } }),
              h('span', { className: 'us-skelrow' }),
              t('detail.loading'),
            )
          : error
            ? h(
                'div',
                { className: 'us-detailload' },
                h(Icon, { name: 'warn', size: 12 }),
                h('span', { style: { flex: 1 } }, t('detail.error'), ' — ', error),
                h('button', { type: 'button', className: 'us-btn', onClick: onRetry }, t('detail.retry')),
              )
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'us-statgrid' },
                  stat(t('detail.turns'), numberFmt(detail?.session?.turns ?? session.turns ?? 0)),
                  stat(t('detail.steps'), numberFmt(detail?.session?.steps ?? session.steps ?? 0)),
                  stat(t('detail.duration'), fmtDuration((session.llmMs ?? 0) + (session.toolMs ?? 0))),
                  stat(t('detail.peakShare'), pctFromRatio(session.peakShare ?? 0)),
                  stat(t('detail.costPerTurn'), compactCny(session.costPerTurnCny ?? 0)),
                ),
                h(
                  'div',
                  { className: 'us-detailcols' },
                  h(
                    'div',
                    null,
                    h('div', { className: 'us-minititle' }, h('span', null, t('detail.turnTitle')), h('span', null, t('detail.turnCount', { count: numberFmt(turns.length) }))),
                    turns.length === 0
                      ? h('div', { className: 'us-muted', style: { fontSize: 10.5 } }, t('detail.noTurns'))
                      : h(
                          React.Fragment,
                          null,
                          h(
                            'div',
                            { className: 'us-turnchart' },
                            turns.map((turn) =>
                              h('div', {
                                key: turn.turn,
                                className: 'us-turnbar',
                                style: { height: `${Math.max(2, (turn.tokens.total / maxTurnTokens) * 100)}%` },
                                title: `${t('detail.turnLabel', { turn: turn.turn })} · ${compactTokens(turn.tokens.total)} · ${compactCny(turn.costCny)} · ${fmtTime(turn.start)}–${fmtTime(turn.end)}`,
                              }),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'us-turnlabels' },
                            h('span', { title: t('detail.turnCount', { count: numberFmt(allTurns.length) }) }, t('detail.turnLabel', { turn: turns[0]?.turn ?? 1 })),
                            h('span', { title: t('detail.turnCount', { count: numberFmt(allTurns.length) }) }, t('detail.turnLabel', { turn: turns[turns.length - 1]?.turn ?? 1 })),
                          ),
                          h(
                            'div',
                            { className: 'us-modelturn', style: { marginTop: 7 } },
                            h(Icon, { name: 'pulse', size: 10 }),
                            t('detail.events', { count: numberFmt(detail?.events?.length ?? session.events ?? 0) }),
                            ' · ',
                            t('detail.tokensPerTurn', { value: compactTokens((session.totalTokens ?? 0) / Math.max(1, session.turns ?? 1)) }),
                          ),
                        ),
                  ),
                  h(
                    'div',
                    null,
                    h('div', { className: 'us-minititle' }, h('span', null, t('detail.models'))),
                    h(
                      'div',
                      { className: 'us-modellist' },
                      models.slice(0, 4).map((entry) =>
                        h(
                          'div',
                          { className: 'us-modelrow', key: entry.model },
                          h('span', { title: entry.model }, modelLabel(entry.model)),
                          h('span', { className: 'track' }, h('i', { style: { width: `${Math.max(1, (entry.costCny / modelCost) * 100)}%`, background: modelColor(colors, entry.model) } })),
                          h('span', { style: { textAlign: 'right' } }, compactCny(entry.costCny)),
                        ),
                      ),
                    ),
                    session.models?.length
                      ? h('div', { className: 'us-modelturn', style: { marginTop: 7, flexWrap: 'wrap' } }, t('detail.modelsList', { models: session.models.map((model) => modelLabel(model)).join(' / ') }))
                      : null,
                    h('div', { className: 'us-modelturn', style: { marginTop: 5, flexWrap: 'wrap' } }, t('detail.created', { time: fmtDateTime(session.createdAt) })),
                  ),
                ),
              ),
      );
    }

    function Footer({ t, data }) {
      const warnings = data?.warnings ?? [];
      return h(
        'footer',
        { className: 'us-ft' },
        h('span', null, t('footer.source')),
        h('span', null, '·'),
        h('span', null, t('footer.generated', { time: data ? fmtTime(data.generatedAt) : '—' })),
        h('span', { className: 'us-grow' }),
        h('span', { className: 'us-ft-formula', title: t('footer.formula') }, t('footer.formula')),
        h(
          'details',
          { className: 'us-warnings' },
          h(
            'summary',
            null,
            warnings.length > 0 ? h(Icon, { name: 'warn', size: 10 }) : h(Icon, { name: 'info', size: 10 }),
            warnings.length > 0 ? t('footer.warnings', { count: warnings.length }) : t('footer.healthy'),
          ),
          h(
            'ul',
            { className: 'us-warninglist' },
            warnings.length > 0 ? warnings.map((warning, index) => h('li', { key: index }, warning)) : h('li', null, t('footer.healthyDetail')),
          ),
        ),
      );
    }

    /* --------------------------------------------------------------------- */
    /* dictionary                                                            */
    /* --------------------------------------------------------------------- */

    const dictionary = {
      zh: {
        'pill.title': '查看用量与成本统计',
        'pill.tokens': 'TOKENS',
        'pill.cost': '成本',
        'pill.budget': '预算',
        'pill.error': '统计不可用',
        'pill.aria': '用量统计：{tokens} tokens，成本 {cost}。点击打开详细面板',
        'panel.title': '用量与成本',
        'panel.sub': '真实会话数据 · 本地计算',
        'panel.live': '实时',
        'panel.cached': '缓存',
        'panel.updated': '更新于 {time}',
        'panel.refresh': '刷新数据',
        'panel.close': '关闭面板',
        'panel.retry': '重试',
        'panel.error': '统计加载失败',
        'panel.loading': '正在读取本机会话日志…',
        'panel.refreshing': '刷新中…',
        'range.label': '时间范围',
        'range.3': '近 3 天',
        'range.7': '近 7 天',
        'range.14': '近 14 天',
        'range.30': '近 30 天',
        'range.all': '全部',
        'units.tokens': 'tokens',
        'kpi.tokens': '总 Token',
        'kpi.tokensSub': '今日 {today}',
        'kpi.cache': '缓存读',
        'kpi.input': '输入',
        'kpi.output': '输出',
        'kpi.cacheHint': '缓存命中读取的 token 按更低价格计费',
        'kpi.sessions': '会话数',
        'kpi.sessionsUnit': '个',
        'kpi.sessionsSub': '主会话 {main} · 子代理 {sub}',
        'kpi.activeDays': '活跃 {days} 天',
        'kpi.avgTokens': '均 {value}',
        'kpi.events': '{events} 次请求',
        'kpi.lastActivity': '{time}活跃',
        'kpi.cost': '估算成本',
        'kpi.costHint': '按 token 用量 × 官方价目表估算，非实际账单',
        'kpi.today': '今日 {value}',
        'kpi.month': '本月 {value}',
        'kpi.perSession': '每会话 {value}',
        'kpi.peakShare': '高峰用量 {value}',
        'kpi.priceHint': '当前时段单价（缓存命中 / 未命中，每百万 tokens）',
        'kpi.priceChip': '输入 ¥{hit} / ¥{miss}',
        'kpi.budget': '预算',
        'kpi.budgetMonth': '本月',
        'kpi.budgetAll': '累计',
        'kpi.budgetEdit': '修改预算金额',
        'kpi.budgetUsed': '已用 {used} / {amount}',
        'kpi.budgetRemain': '剩余 {value}',
        'kpi.overBudget': '已超预算',
        'kpi.projected': '预计本月 {value}',
        'kpi.projectedHint': '按最近 7 天日均成本推算',
        'kpi.reset': '恢复默认',
        'price.peak': '高峰时段',
        'price.offPeak': '空闲时段',
        'price.hit': '缓存命中',
        'price.miss': '未命中',
        'price.out': '输出',
        'price.perM': '/M',
        'price.note': '按 DeepSeek 官方价目表估算，含高峰/空闲时段',
        'price.estimated': '部分模型按 Flash 价估算',
        'models.title': '模型占比',
        'models.sub': '{window} · {tokens} token · {cost}',
        'models.subAll': '全部时间 · {tokens} token · {cost}',
        'models.metric': '统计口径',
        'models.byTokens': 'Token',
        'models.byCost': '成本',
        'models.other': '其他 {count} 个模型',
        'models.empty': '所选时间范围内还没有模型用量',
        'models.tokenTotal': 'Token 合计',
        'models.costTotal': '成本合计',
        'models.allTime': '全部时间',
        'models.provider': '提供商',
        'models.tokens': 'Token',
        'models.cost': '成本',
        'models.events': '请求',
        'models.aria': '{count} 个模型，共 {tokens} token、{cost}',
        'chart.title': 'Token 消耗时间线',
        'chart.sub': '{count} 天有数据 · {total}',
        'chart.mode': '图表模式',
        'chart.tokens': 'Token',
        'chart.cost': '成本',
        'chart.costLegend': '每日成本',
        'chart.events': '{count} 次请求',
        'chart.empty': '所选时间范围内没有用量数据',
        'chart.aria': '{days} 天共 {tokens} tokens，估算成本 {cost}',
        'chart.peakHint': '柱状按 token 类型堆叠：缓存读 / 输入 / 输出',
        'chart.todayHint': '虚线框标记今天',
        'sessions.title': '会话明细',
        'sessions.count': '{count} / {total}',
        'sessions.search': '搜索会话…',
        'sessions.filter': '会话类型',
        'sessions.all': '全部',
        'sessions.main': '主会话',
        'sessions.sub': '子会话',
        'sessions.colSession': '会话',
        'sessions.colTokens': 'Token',
        'sessions.colCost': '成本',
        'sessions.colTurns': '轮次',
        'sessions.sortBy': '按{column}排序',
        'sessions.empty': '没有匹配的会话',
        'sessions.subTag': '子',
        'sessions.archivedTag': '归档',
        'detail.loading': '正在加载会话明细…',
        'detail.error': '会话明细加载失败',
        'detail.retry': '重试',
        'detail.turns': '轮次',
        'detail.steps': '步骤',
        'detail.duration': '模型+工具耗时',
        'detail.peakShare': '高峰用量',
        'detail.costPerTurn': '每轮成本',
        'detail.turnTitle': '逐轮 Token',
        'detail.turnCount': '{count} 轮',
        'detail.turnLabel': '第 {turn} 轮',
        'detail.noTurns': '暂无逐轮数据',
        'detail.events': '{count} 次请求',
        'detail.tokensPerTurn': '均 {value}/轮',
        'detail.models': '模型分布',
        'detail.modelsList': '模型：{models}',
        'detail.created': '创建于 {time}',
        'footer.source': '数据源 ~/.dsh 会话日志',
        'footer.generated': '生成于 {time}',
        'footer.formula': '成本 = token × 官方单价（含高峰/空闲）',
        'footer.warnings': '{count} 条提示',
        'footer.healthy': '数据校验正常',
        'footer.healthyDetail': '日志与投影缓存一致，无解析异常。',
      },
      en: {
        'pill.title': 'Open usage and cost statistics',
        'pill.tokens': 'TOKENS',
        'pill.cost': 'COST',
        'pill.budget': 'BUDGET',
        'pill.error': 'usage unavailable',
        'pill.aria': 'Usage: {tokens} tokens, cost {cost}. Click for details',
        'panel.title': 'Usage & Cost',
        'panel.sub': 'Real session data, computed locally',
        'panel.live': 'live',
        'panel.cached': 'cached',
        'panel.updated': 'updated {time}',
        'panel.refresh': 'Refresh data',
        'panel.close': 'Close panel',
        'panel.retry': 'Retry',
        'panel.error': 'Failed to load statistics',
        'panel.loading': 'Reading local session logs…',
        'panel.refreshing': 'Refreshing…',
        'range.label': 'Time range',
        'range.3': 'last 3d',
        'range.7': 'last 7d',
        'range.14': 'last 14d',
        'range.30': 'last 30d',
        'range.all': 'All',
        'units.tokens': 'tokens',
        'kpi.tokens': 'Total tokens',
        'kpi.tokensSub': 'today {today}',
        'kpi.cache': 'cache read',
        'kpi.input': 'input',
        'kpi.output': 'output',
        'kpi.cacheHint': 'Cache-hit tokens are billed at a lower rate',
        'kpi.sessions': 'Sessions',
        'kpi.sessionsUnit': '',
        'kpi.sessionsSub': '{main} main · {sub} subagents',
        'kpi.activeDays': '{days} active days',
        'kpi.avgTokens': 'avg {value}',
        'kpi.events': '{events} requests',
        'kpi.lastActivity': 'active {time}',
        'kpi.cost': 'Est. cost',
        'kpi.costHint': 'Estimated from tokens × list price; not an invoice',
        'kpi.today': 'today {value}',
        'kpi.month': 'this month {value}',
        'kpi.perSession': '{value} / session',
        'kpi.peakShare': 'peak usage {value}',
        'kpi.priceHint': 'Current rates (cache hit / miss per 1M tokens)',
        'kpi.priceChip': 'input ¥{hit} / ¥{miss}',
        'kpi.budget': 'Budget',
        'kpi.budgetMonth': 'month',
        'kpi.budgetAll': 'all time',
        'kpi.budgetEdit': 'Edit budget amount',
        'kpi.budgetUsed': '{used} of {amount}',
        'kpi.budgetRemain': '{value} left',
        'kpi.overBudget': 'over budget',
        'kpi.projected': 'proj. {value}',
        'kpi.projectedHint': 'Projected from the last 7 days',
        'kpi.reset': 'reset',
        'price.peak': 'Peak hours',
        'price.offPeak': 'Off-peak',
        'price.hit': 'cache hit',
        'price.miss': 'miss',
        'price.out': 'output',
        'price.perM': '/M',
        'price.note': 'Estimated from official DeepSeek list prices (peak / off-peak)',
        'price.estimated': 'some models priced as Flash',
        'models.title': 'Model share',
        'models.sub': '{window} · {tokens} tokens · {cost}',
        'models.subAll': 'all time · {tokens} tokens · {cost}',
        'models.metric': 'Metric',
        'models.byTokens': 'Tokens',
        'models.byCost': 'Cost',
        'models.other': 'Other {count} models',
        'models.empty': 'No model usage in the selected range yet',
        'models.tokenTotal': 'TOTAL TOKENS',
        'models.costTotal': 'TOTAL COST',
        'models.allTime': 'all time',
        'models.provider': 'Provider',
        'models.tokens': 'Tokens',
        'models.cost': 'Cost',
        'models.events': 'Requests',
        'models.aria': '{count} models, {tokens} tokens, {cost}',
        'chart.title': 'Token timeline',
        'chart.sub': '{count} days with data · {total}',
        'chart.mode': 'Chart mode',
        'chart.tokens': 'Tokens',
        'chart.cost': 'Cost',
        'chart.costLegend': 'daily cost',
        'chart.events': '{count} requests',
        'chart.empty': 'No usage in the selected range',
        'chart.aria': '{days} days, {tokens} tokens, estimated cost {cost}',
        'chart.peakHint': 'Bars stack cache read / input / output',
        'chart.todayHint': 'Dashed outline marks today',
        'sessions.title': 'Sessions',
        'sessions.count': '{count} / {total}',
        'sessions.search': 'Search sessions…',
        'sessions.filter': 'Session type',
        'sessions.all': 'All',
        'sessions.main': 'Main',
        'sessions.sub': 'Sub',
        'sessions.colSession': 'Session',
        'sessions.colTokens': 'Tokens',
        'sessions.colCost': 'Cost',
        'sessions.colTurns': 'Turns',
        'sessions.sortBy': 'Sort by {column}',
        'sessions.empty': 'No matching sessions',
        'sessions.subTag': 'sub',
        'sessions.archivedTag': 'archived',
        'detail.loading': 'Loading session details…',
        'detail.error': 'Failed to load session details',
        'detail.retry': 'Retry',
        'detail.turns': 'Turns',
        'detail.steps': 'Steps',
        'detail.duration': 'LLM + tool time',
        'detail.peakShare': 'Peak usage',
        'detail.costPerTurn': 'Cost / turn',
        'detail.turnTitle': 'Tokens per turn',
        'detail.turnCount': '{count} turns',
        'detail.turnLabel': 'Turn {turn}',
        'detail.noTurns': 'No per-turn data',
        'detail.events': '{count} requests',
        'detail.tokensPerTurn': 'avg {value}/turn',
        'detail.models': 'Model split',
        'detail.modelsList': 'Models: {models}',
        'detail.created': 'created {time}',
        'footer.source': 'source ~/.dsh session logs',
        'footer.generated': 'generated {time}',
        'footer.formula': 'cost = tokens × list price (peak / off-peak)',
        'footer.warnings': '{count} notices',
        'footer.healthy': 'data checks passed',
        'footer.healthyDetail': 'Logs agree with the projection cache; nothing failed to parse.',
      },
    };

    /* --------------------------------------------------------------------- */
    /* plugin                                                                */
    /* --------------------------------------------------------------------- */

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        api.rpc = ctx.connection.rpc;
        ctx.effect(() => ctx.locale.register(NS, dictionary), 'usage-stats: locale');
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: NS, order: 60, locale: NS }, Pill),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: NS, order: 60, locale: NS }, Dashboard),
        );
      },
    };
  },
});

/* ===== Wall Street overview =====
 *
 * Shows how the markets are moving using the data cached in the Resources/
 * folder (one file per asset class: indexes, stocks, ETFs, metals, cryptos):
 * A period selector drives the change percentages, sparklines and the
 * normalized comparison charts.
 */

const _WS_RANGES = {
  "1m": { bars: 22, days: 45 },
  "1w": { bars: 5, days: 7 },
  "3m": { bars: 66, days: 135 },
  "6m": { bars: 130, days: 260 },
  "1y": { bars: 252, days: 520 },
  ytd: { ytd: true },
  "2y": { bars: 504, days: 1040 },
  "3y": { bars: 756, days: 1560 },
  "5y": { bars: 1260, days: 2600 },
};
const _WS_INDEX_COLORS = {
  "^GSPC": "#33ff33",
  "^SSMI": "#ff4d4d",
  "^IXIC": "#33ccff",
  "^DJI": "#ffcc00",
  "^GDAXI": "#ff9900",
  "^STOXX50E": "#ff66cc",
  "^FTSE": "#9966ff",
  "^FCHI": "#00cc88",
  "^N225": "#66ffcc",
  "^HSI": "#ff8866",
  "^BVSP": "#aaccff",
};
const _WS_METAL_COLORS = {
  "GC=F": "#ff9900",
  "SI=F": "#cc66ff",
  "HG=F": "#66ccff",
  "PL=F": "#ffcc00",
  "PA=F": "#ff4d4d",
};
const _WS_ETF_COLORS = [
  "#33ff33", "#33ccff", "#ffcc00", "#ff9900", "#ff66cc",
  "#9966ff", "#00cc88", "#66ffcc", "#ff8866", "#aaccff",
];
// ETFs that track global/international markets get a GLO/INT tag instead of the
// US flag, since the asset catalog does not carry a region for them.
const _WS_ETF_REGION = {
  VOO: "US", IVV: "US", SPY: "US", VTI: "US", QQQ: "US",
  VT: "GLO", VEA: "INT", VXUS: "INT", VWO: "INT", BND: "US",
};
const _WS_STOCK_COLORS = [
  "#33ff33", "#33ccff", "#ffcc00", "#ff9900", "#ff66cc",
  "#9966ff", "#00cc88", "#66ffcc", "#ff8866", "#aaccff",
];
const _WS_CRYPTO_COLORS = [
  "#f7931a", "#627eea", "#26a17b", "#00ffa3", "#f3ba2f",
];
const _WS_FADED = "rgba(140,140,140,0.35)";
const _WS_CURRENCIES = ["USD", "EUR", "CHF", "GBP", "JPY", "AUD", "CAD", "CNY", "HKD", "NZD", "SEK"];
const _WS_CCY_SYMBOL = {
  USD: "$", EUR: "€", CHF: "CHF", GBP: "£", JPY: "¥",
  AUD: "A$", CAD: "C$", CNY: "¥", HKD: "HK$", NZD: "NZ$", SEK: "kr",
};
const _WS_INDEX_CUR = {
  "^GSPC": "USD", "^IXIC": "USD", "^DJI": "USD",
  "^FTSE": "GBP", "^GDAXI": "EUR", "^FCHI": "EUR",
  "^STOXX50E": "EUR", "^N225": "JPY", "^HSI": "HKD",
  "^BVSP": "BRL", "^SSMI": "CHF",
};
const _WS_FLAG_FILES = { 'US': 'us', 'UK': 'gb', 'DE': 'de', 'FR': 'fr', 'JP': 'jp', 'HK': 'hk', 'EU': 'eu', 'CH': 'ch' };
const _WS_OZ_TO_G = 31.1034768;
const _WS_METAL_WEIGHTS = {
  oz: { mult: 1, label: "PER OZ" },
  g: { mult: 1 / _WS_OZ_TO_G, label: "PER G" },
  "100g": { mult: 100 / _WS_OZ_TO_G, label: "PER 100 G" },
  "0.5kg": { mult: 500 / _WS_OZ_TO_G, label: "PER 0.5 KG" },
  "1kg": { mult: 1000 / _WS_OZ_TO_G, label: "PER KG" },
};
let _wsRange = "1m";
let _wsCurrency = "USD";
let _wsMetalWeight = "oz";

// Stock panel state: search query, selected symbol and the last render context
// so the panel can re-render itself on search/selection without a full page pass.
let _wsStockQuery = "";
let _wsSelectedStock = null;
let _wsStockCtx = null;
let _wsStockSort = "perf";
let _wsStockRegion = "";

// Crypto chart scale toggle (false = linear, true = logarithmic).
let _wsCryptoLogScale = false;

function _wsWeightShort(w) {
  if (w === "oz") return "oz";
  if (w === "g") return "g";
  if (w === "100g") return "100 g";
  if (w === "0.5kg") return "0.5 kg";
  if (w === "1kg") return "1 kg";
  return w;
}

function wsStockRegion(symbol) {
  if (symbol.endsWith('.SW')) return 'CH';
  if (symbol.endsWith('.DE')) return 'DE';
  if (symbol.endsWith('.T'))  return 'JP';
  return 'US';
}

function wsStockComparer(sortKey) {
  const dir = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byName = (a, b) => {
    const na = ((a.meta && a.meta.name) || "").toLowerCase();
    const nb = ((b.meta && b.meta.name) || "").toLowerCase();
    return dir(na, nb);
  };
  const valueOf = (it) => (it.displayValue != null ? it.displayValue : it.last && it.last.close) || 0;
  return (a, b) => {
    if (sortKey === "name") return byName(a, b);
    if (sortKey === "symbol") return dir(a.symbol || "", b.symbol || "");
    if (sortKey === "price") return dir(valueOf(b), valueOf(a));
    if (sortKey === "region") {
      const ra = wsStockRegion(a.symbol);
      const rb = wsStockRegion(b.symbol);
      return ra === rb ? byName(a, b) : dir(ra, rb);
    }
    const pa = a.chg && a.chg.pct != null ? a.chg.pct : -Infinity;
    const pb = b.chg && b.chg.pct != null ? b.chg.pct : -Infinity;
    return pb - pa;
  };
}

function wsPeriodBars(range) {
  if (range === "ytd") return null;
  return (_WS_RANGES[range] || _WS_RANGES["1m"]).bars;
}

function wsPeriodDays(range) {
  if (range === "ytd") return 0;
  return (_WS_RANGES[range] || _WS_RANGES["1m"]).days;
}

function wsYtdStart(today) {
  return today.slice(0, 4) + "-01-01";
}

function wsWindowStart(bars, range, today) {
  if (range === "ytd") {
    const start = wsYtdStart(today);
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].date >= start) return i;
    }
    return 0;
  }
  const n = wsPeriodBars(range);
  return Math.max(0, bars.length - 1 - n);
}

function wsDateAdd(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

// Last bar that actually has a close. Some symbols (e.g. SW/DE stocks) carry a
// trailing intraday bar with a null OHLC, so indexes/values must never read the
// tail blindly.
function wsLastBar(bars) {
  if (!Array.isArray(bars)) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i] && bars[i].close != null) return bars[i];
  }
  return null;
}

function wsChangePct(bars, wsIdx) {
  if (!bars || bars.length < 2) return null;
  const base = bars[wsIdx].close;
  const lastBar = wsLastBar(bars);
  if (!base || !lastBar) return null;
  const last = lastBar.close;
  return { base, last, pct: ((last - base) / base) * 100 };
}

function wsRateMap(data, assets) {
  const usdPer = { USD: 1 };
  (assets || []).forEach((a) => {
    if (!a || a.class !== "fx" || !a.symbol) return;
    if (!a.symbol.endsWith("USD=X")) return;
    const base = a.symbol.slice(0, 3);
    const bars = (data || {})[a.symbol] || [];
    const lb = wsLastBar(bars);
    if (!lb) return;
    usdPer[base] = lb.close;
  });
  return usdPer;
}

function wsCurrencyScale(usdPer, fromCode, toCode) {
  const a = usdPer[fromCode];
  const b = usdPer[toCode];
  if (a == null || b == null) return null;
  return a / b;
}

function wsFmtValue(v, decimals) {
  if (v == null || isNaN(v)) return "—";
  if (decimals != null) {
    const d = Math.max(0, Math.min(2, decimals));
    return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const a = Math.abs(v);
  if (a < 1000) return v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function wsFmtPct(pct) {
  if (pct == null || isNaN(pct)) return "—";
  return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
}

function wsSparkSvg(values, up) {
  if (!values || values.length < 2) return "";
  const color = up ? "#33ff33" : "#ff3333";
  const fill = up ? "rgba(51,255,51,0.12)" : "rgba(255,51,51,0.12)";
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = max - min || 1;
  const n = values.length;
  const xy = (i, v) => ((i / (n - 1)) * 100).toFixed(2) + "," + (34 - ((v - min) / span) * 29 - 1.5).toFixed(2);
  const points = [];
  for (let i = 0; i < n; i++) points.push(xy(i, values[i]));
  return (
    '<svg class="ws-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="0,36 ' + points.join(" ") + ' 100,36" fill="' + fill + '"/>' +
    '<polyline points="' + points.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    "</svg>"
  );
}

function wsNormalizeSeries(barsBySymbol, order, startDate) {
  const perSym = {};
  const allDates = new Set();
  order.forEach((sym) => {
    const bars = (barsBySymbol || {})[sym] || [];
    const pts = [];
    bars.forEach((b) => {
      if (b.date >= startDate && b.close != null) pts.push({ date: b.date, v: b.close });
    });
    if (pts.length < 2 || !pts[0].v) return;
    const base = pts[0].v;
    const norm = pts.map((p) => ({ date: p.date, v: (p.v / base) * 100 }));
    perSym[sym] = norm;
    norm.forEach((p) => allDates.add(p.date));
  });
  const dates = [...allDates].sort();
  const series = {};
  const symbols = order.filter((s) => perSym[s]);
  const last = {};
  symbols.forEach((s) => {
    series[s] = [];
    last[s] = 100;
  });
  dates.forEach((dt) => {
    symbols.forEach((sym) => {
      const arr = perSym[sym];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].date <= dt) last[sym] = arr[i].v;
        else break;
      }
      series[sym].push(last[sym]);
    });
  });
  return { dates, series, symbols };
}

function wsHistoricalStatsFromItems(items, range) {
  const today = todayStr();
  let retSum = 0,
    retCount = 0,
    upCount = 0,
    curSum = 0,
    curCount = 0,
    curUp = 0,
    ddSum = 0,
    ddCount = 0,
    volSum = 0,
    volCount = 0;
  items.forEach((it) => {
    const chg = it.chg;
    if (chg) {
      curSum += chg.pct;
      curCount++;
      if (chg.pct > 0) curUp++;
    }
    const bars = it.bars || [];
    const winStart = wsWindowStart(bars, range, today);
    const closes = [];
    for (let i = winStart; i < bars.length; i++) {
      if (bars[i] && bars[i].close != null) closes.push(bars[i].close);
    }
    if (closes.length >= 2) {
      let peak = closes[0];
      let maxDd = 0;
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > peak) peak = closes[i];
        else if (peak > 0) maxDd = Math.max(maxDd, (peak - closes[i]) / peak);
      }
      ddSum += maxDd;
      ddCount++;
      let m = 0;
      const rets = [];
      for (let i = 1; i < closes.length; i++) {
        if (!closes[i - 1]) continue;
        const r = closes[i] / closes[i - 1] - 1;
        rets.push(r);
        m += r;
      }
      if (rets.length >= 2) {
        m /= rets.length;
        let varr = 0;
        for (let i = 0; i < rets.length; i++) varr += (rets[i] - m) * (rets[i] - m);
        varr /= rets.length;
        volSum += Math.sqrt(varr) * Math.sqrt(252) * 100;
        volCount++;
      }
    }
    if (bars.length < 2) return;
    if (range === "ytd") {
      const mdy = today.slice(5);
      const year = parseInt(today.slice(0, 4), 10);
      for (let y = year - 1; y >= year - 6; y--) {
        const seg = bars.filter((b) => b.date >= y + "-01-01" && b.date <= y + "-" + mdy);
        const segLast = wsLastBar(seg);
        if (seg.length < 2 || !seg[0] || seg[0].close == null || !segLast) continue;
        const r = ((segLast.close - seg[0].close) / seg[0].close) * 100;
        retSum += r;
        retCount++;
        if (r > 0) upCount++;
      }
    } else {
      const n = wsPeriodBars(range);
      for (let i = 0; i + n < bars.length; i += n) {
        const base = bars[i].close;
        const last = bars[i + n].close;
        if (!base || !last) continue;
        const r = ((last - base) / base) * 100;
        retSum += r;
        retCount++;
        if (r > 0) upCount++;
      }
    }
  });
  if (!curCount) return null;
  const hasRet = retCount > 0;
  return {
    marketChange: curSum / curCount,
    breadth: curUp,
    breadthTotal: curCount,
    expected: hasRet ? retSum / retCount : null,
    winRate: hasRet ? upCount / retCount : null,
    maxDrawdown: ddCount ? ddSum / ddCount : null,
    annualVol: volCount ? volSum / volCount : null,
  };
}

Object.assign(Pages, {
  // ==================== WALL STREET ====================

  async wallStreet() {
    Object.values(App._charts).forEach((c) => {
      try { c.destroy(); } catch (e) {}
    });
    App._charts = {};

    const loading = document.getElementById("ws-loading");
    if (loading) loading.classList.add("show");
    try {
      try {
        const settings = await DB.getSettings();
        if (settings) {
          if (settings.wsCurrency && _WS_CURRENCIES.indexOf(settings.wsCurrency) !== -1) _wsCurrency = settings.wsCurrency;
          if (settings.wsMetalWeight && _WS_METAL_WEIGHTS[settings.wsMetalWeight]) _wsMetalWeight = settings.wsMetalWeight;
          if (typeof settings.wsCryptoLog === "boolean") _wsCryptoLogScale = settings.wsCryptoLog;
          if (settings.wsStockSort) _wsStockSort = settings.wsStockSort;
          if (settings.wsStockRegion) _wsStockRegion = settings.wsStockRegion;
        }
      } catch (e) {}

      this._wsRenderPrefs();

      await Randata.sync();
      const file = await Randata.readFile();
      const data = file.data || {};
      const assets = file.assets || [];
      const usdPer = wsRateMap(data, assets);

      const syncEl = document.getElementById("ws-sync-label");
      if (syncEl) {
        syncEl.textContent = file.synced_date ? "MARKET DATA: " + formatDate(file.synced_date) : "MARKET DATA: NO DATA";
        syncEl.style.color = file.synced_date ? "" : "var(--danger)";
      }

      const metaBySym = {};
      assets.forEach((a) => {
        if (a && a.symbol) metaBySym[a.symbol] = a;
      });

      const range = _wsRange;
      const today = todayStr();
      const startDate = range === "ytd" ? wsYtdStart(today) : wsDateAdd(today, -wsPeriodDays(range));

      const groups = { index: [], etf: [], stock: [], metal: [], crypto: [] };
      let hasData = false;
      const weightMult = _WS_METAL_WEIGHTS[_wsMetalWeight].mult;
      assets.forEach((a) => {
        if (!a || !a.symbol) return;
        if (a.class === "fx") return;
        const sym = a.symbol;
        const bars = data[sym] || [];
        if (!bars.length) return;
        hasData = true;
        const cls = a.class || "index";
        const wsIdx = wsWindowStart(bars, range, today);
        const chg = wsChangePct(bars, wsIdx);
        const winVals = bars.slice(wsIdx).map((b) => b.close);
        const item = { symbol: sym, meta: a, bars, chg, winVals, last: wsLastBar(bars) || bars[bars.length - 1] };
        if (cls === "index") {
          const scale = wsCurrencyScale(usdPer, _WS_INDEX_CUR[sym] || "USD", _wsCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
        } else if (cls === "metal") {
          const scale = wsCurrencyScale(usdPer, "USD", _wsCurrency);
          item.displayValue = (scale == null ? 1 : scale) * weightMult * item.last.close;
          item.unitLabel = _WS_METAL_WEIGHTS[_wsMetalWeight].label;
        } else if (cls === "stock") {
          const region = wsStockRegion(sym);
          const fromCur = region === "CH" ? "CHF" : region === "DE" ? "EUR" : region === "JP" ? "JPY" : "USD";
          const scale = wsCurrencyScale(usdPer, fromCur, _wsCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
        } else if (cls === "etf") {
          const scale = wsCurrencyScale(usdPer, "USD", _wsCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
        } else if (cls === "crypto") {
          const scale = wsCurrencyScale(usdPer, "USD", _wsCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
        } else {
          const scale = wsCurrencyScale(usdPer, "USD", _wsCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
        }
        if (groups[cls]) groups[cls].push(item);
      });

      if (hasData) {
        this._wsRenderGroup("#ws-index-grid", "#ws-index-empty", groups.index);
        this._wsRenderGroup("#ws-etf-grid", "#ws-etf-empty", groups.etf);
        this._wsRenderGroup("#ws-stock-grid", "#ws-stock-empty", groups.stock);
        this._wsRenderGroup("#ws-metal-grid", "#ws-metal-empty", groups.metal);
        this._wsRenderGroup("#ws-crypto-grid", "#ws-crypto-empty", groups.crypto);

        this._wsRenderOverview(
          groups.index.map((i) => i.symbol),
          data, metaBySym, startDate, usdPer,
        );
        this._wsRenderEtfChart(
          groups.etf.map((i) => i.symbol),
          data, metaBySym, startDate, usdPer,
        );
        this._wsRenderStockPanel(
          groups.stock,
          data, metaBySym, startDate, usdPer, range,
        );
        this._wsRenderMetals(
          groups.metal.map((i) => i.symbol),
          data, metaBySym, startDate, usdPer,
        );
        this._wsRenderCryptoChart(
          groups.crypto.map((i) => i.symbol),
          data, metaBySym, startDate, usdPer,
        );
        this._wsRenderOutlook(groups.index, range);
      } else {
        const nodata = document.getElementById("ws-nodata");
        if (nodata) nodata.innerHTML = '<div class="card-gta"><div class="card-gta-body"><div class="empty-state" style="display:block">NO MARKET DATA — PRESS RESYNC OR REOPEN A PROFILE TO SYNC.</div></div></div>';
      }

      this._wsBindRangeButtons();

    } finally {
      const loading = document.getElementById("ws-loading");
      if (loading) loading.classList.remove("show");
    }
  },

  _wsBindRangeButtons() {
    document.querySelectorAll(".ws-range-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.range === _wsRange);
      btn.onclick = () => {
        _wsRange = btn.dataset.range;
        Pages.wallStreet();
      };
    });

    const logBtn = document.getElementById("ws-crypto-log-btn");
    if (logBtn) {
      logBtn.textContent = _wsCryptoLogScale ? "LOG" : "LIN";
      logBtn.classList.toggle("active", _wsCryptoLogScale);
      logBtn.onclick = () => {
        _wsCryptoLogScale = !_wsCryptoLogScale;
        this._wsSavePrefs();
        Pages.wallStreet();
      };
    }
  },

  _wsRenderPrefs() {
    const curSel = document.getElementById("ws-currency");
    if (curSel) {
      curSel.value = _wsCurrency;
      curSel.onchange = () => {
        _wsCurrency = curSel.value;
        this._wsSavePrefs();
        Pages.wallStreet();
      };
    }
    const wtSel = document.getElementById("ws-weight");
    if (wtSel) {
      wtSel.value = _wsMetalWeight;
      wtSel.onchange = () => {
        _wsMetalWeight = wtSel.value;
        this._wsSavePrefs();
        Pages.wallStreet();
      };
    }
  },

  async _wsSavePrefs() {
    try {
      const settings = (await DB.getSettings()) || {};
      settings.wsCurrency = _wsCurrency;
      settings.wsMetalWeight = _wsMetalWeight;
      settings.wsCryptoLog = _wsCryptoLogScale;
      settings.wsStockSort = _wsStockSort;
      settings.wsStockRegion = _wsStockRegion;
      await DB.saveSettings(settings);
    } catch (e) {}
  },

  async wallStreetResync() {
    const btn = document.getElementById("ws-resync-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "SYNCING...";
    }
    try {
      const r = await Randata.sync();
      await this.wallStreet();
      App.toast(r.status === "offline" ? "MARKET DATA OFFLINE" : r.status === "fresh" ? "MARKET DATA AVAILABLE" : r.status === "busy" ? "MARKET DATA SYNC IN PROGRESS" : "MARKET DATA SYNCED");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "RESYNC";
      }
    }
  },

  _wsRenderOutlook(items, range) {
    const el = document.getElementById("ws-outlook");
    if (!el) return;
    const stats = wsHistoricalStatsFromItems(items, range);
    if (!stats) {
      el.innerHTML = '<div class="empty-state" style="display:block">NOT ENOUGH HISTORY FOR ' + range.toUpperCase() + ".</div>";
      return;
    }
    const tag = range.toUpperCase();
    const pct = (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%");
    const color = (v) => (v == null ? "#666666" : v >= 0 ? "#33ff33" : "#ff3333");
    const ddPct = (v) => (v == null ? "—" : "-" + Math.abs(v * 100).toFixed(1) + "%");
    const card = (label, value, colorCss, note, extraClass) => '<div class="col-md-2 col-6' + (extraClass ? " " + extraClass : "") + '"><div class="stat-card"><span class="stat-label">' + label + "</span>" + '<span class="stat-value ws-outlook-value" style="color:' + colorCss + '">' + value + "</span>" + (note ? '<span class="ws-outlook-note">' + note + "</span>" : "") + "</div></div>";
    el.innerHTML =
      card("MARKET CHANGE (" + tag + ")", pct(stats.marketChange), color(stats.marketChange), "AVG OF ALL INDEXES") +
      card("BREADTH", stats.breadth + " / " + stats.breadthTotal + " UP", color(stats.breadth - stats.breadthTotal / 2), "INDEXES RISING") +
      card("MAX DRAWDOWN (" + tag + ")", ddPct(stats.maxDrawdown), stats.maxDrawdown == null ? "#666666" : stats.maxDrawdown > 0 ? "#ff3333" : "#33ff33", "WORST PEAK-TO-TROUGH") +
      card("VOLATILITY (" + tag + ")", stats.annualVol == null ? "—" : stats.annualVol.toFixed(1) + "%", "#ffcc00", "ANNUALIZED, AVG OF INDEXES") +
      card("EXPECTED NEXT (" + tag + ")", pct(stats.expected), color(stats.expected), "HISTORICAL AVERAGE") +
      card("WIN RATE", stats.winRate == null ? "—" : (stats.winRate * 100).toFixed(0) + "% UP", stats.winRate == null ? "#666" : stats.winRate >= 0.5 ? "#33ff33" : "#ff3333", "HISTORICAL PERIODS POSITIVE");
  },

  _wsRenderGroup(gridId, emptyId, items) {
    const grid = document.querySelector(gridId);
    const empty = document.querySelector(emptyId);
    if (!grid) return;
    grid.innerHTML = "";
    if (!items.length && empty) {
      empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";

    items.forEach((it) => {
      const cls = it.meta.class || "index";
      let flag = "";
      let code = "";
      if (cls === "index") {
        flag = _WS_FLAG_FILES[it.meta.region] || "";
        code = flag ? "" : it.meta.region || "";
      } else if (cls === "stock") {
        const region = wsStockRegion(it.symbol);
        flag = _WS_FLAG_FILES[region] || "";
        code = flag ? "" : region;
      } else if (cls === "etf") {
        const region = _WS_ETF_REGION[it.symbol] || "US";
        if (region === "US") {
          flag = _WS_FLAG_FILES["US"] || "";
          code = "";
        } else {
          flag = "globe";
          code = region;
        }
      } else if (cls === "metal") {
        code = it.meta.display || it.symbol;
      } else if (cls === "crypto") {
        code = it.meta.display || it.symbol.replace("-USD", "");
      }
      const sub = cls === "metal" || cls === "crypto" ? "" : it.meta.name || "";
      const up = it.chg ? it.chg.pct >= 0 : true;
      const col = document.createElement("div");
      col.className = "col-6 col-md-4 ws-tick-col";
      col.innerHTML =
        '<div class="ws-tick card-gta">' +
        '<div class="ws-tick-head"><span class="ws-tick-name">' +
        escapeHtml(it.meta.name || it.symbol) +
        "</span>" +
        (code || flag
          ? '<span class="ws-tick-code' + (flag ? " ws-tick-flag" : "") + '" title="' + escapeHtml(code || it.meta.region || "") + '">' + (flag ? '<img class="ws-flag' + (flag === "ch" ? " ws-flag-sq" : "") + '" src="flags/' + flag + '.svg?v=3" alt="' + escapeHtml(code || "") + '" loading="lazy"/>' : escapeHtml(code)) + "</span>"
          : "") +
        "</div>" +
        '<div class="ws-tick-value">' +
        (cls === "metal"
          ? '<span class="ws-tick-ccy">' + escapeHtml(_wsCurrency) + "</span>&nbsp;" +
            wsFmtValue(it.displayValue != null ? it.displayValue : it.last.close, 2) +
            '<span class="ws-tick-unit"> per ' + _wsWeightShort(_wsMetalWeight) + "</span>"
          : '<span class="ws-tick-ccy">' + escapeHtml(_WS_CCY_SYMBOL[_wsCurrency] || _wsCurrency) + "</span>&nbsp;" +
            wsFmtValue(it.displayValue != null ? it.displayValue : it.last.close, undefined)) +
        "</div>" +
        '<div class="ws-tick-line"><span class="ws-tick-change ' +
        (up ? "pos" : "neg") +
        '">' +
        (it.chg ? (up ? "&#9650; " : "&#9660; ") + wsFmtPct(it.chg.pct) : "—") +
        "</span>" +
        (sub ? '<span class="ws-tick-sub">' + escapeHtml(sub) + "</span>" : "") +
        "</div>" +
        wsSparkSvg(it.winVals, up) +
        "</div>";
      grid.appendChild(col);
    });
  },

  _wsRenderOverview(order, data, metaBySym, startDate, usdPer) {
    this._wsNormChart("wsOverview", "ws-overview-wrap", "ws-overview-chart", "ws-overview-empty", order, data, metaBySym, startDate, (sym) => _WS_INDEX_COLORS[sym], usdPer);
  },

  _wsRenderEtfChart(order, data, metaBySym, startDate, usdPer) {
    this._wsNormChart("wsEtf", "ws-etf-chart-wrap", "ws-etf-chart", "ws-etf-chart-empty", order, data, metaBySym, startDate, (sym) => {
      const idx = order.indexOf(sym);
      return _WS_ETF_COLORS[idx % _WS_ETF_COLORS.length];
    }, usdPer);
  },

  _wsRenderStockPanel(stocks, data, metaBySym, startDate, usdPer, range) {
    const wrap = document.getElementById("ws-stock-chart-wrap");
    const canvas = document.getElementById("ws-stock-chart");
    const empty = document.getElementById("ws-stock-chart-empty");
    const listEl = document.getElementById("ws-stock-list");
    const emptyList = document.getElementById("ws-stock-empty");
    const searchEl = document.getElementById("ws-stock-search");
    const sortEl = document.getElementById("ws-stock-sort");
    const regionEl = document.getElementById("ws-stock-region");
    if (!listEl || !wrap || !canvas || !empty) return;

    _wsStockCtx = { stocks, data, metaBySym, startDate, usdPer, range };

    if (searchEl) {
      searchEl.value = _wsStockQuery;
      searchEl.oninput = () => {
        _wsStockQuery = searchEl.value.trim().toLowerCase();
        this._wsRenderStockPanel(_wsStockCtx.stocks, _wsStockCtx.data, _wsStockCtx.metaBySym, _wsStockCtx.startDate, _wsStockCtx.usdPer, _wsStockCtx.range);
      };
    }
    if (sortEl) {
      sortEl.value = _wsStockSort;
      sortEl.onchange = () => {
        _wsStockSort = sortEl.value;
        this._wsSavePrefs();
        this._wsRenderStockPanel(_wsStockCtx.stocks, _wsStockCtx.data, _wsStockCtx.metaBySym, _wsStockCtx.startDate, _wsStockCtx.usdPer, _wsStockCtx.range);
      };
    }
    if (regionEl) {
      regionEl.value = _wsStockRegion;
      regionEl.onchange = () => {
        _wsStockRegion = regionEl.value;
        this._wsSavePrefs();
        this._wsRenderStockPanel(_wsStockCtx.stocks, _wsStockCtx.data, _wsStockCtx.metaBySym, _wsStockCtx.startDate, _wsStockCtx.usdPer, _wsStockCtx.range);
      };
    }

    listEl.innerHTML = "";
    emptyList.style.display = stocks.length ? "none" : "block";

    const q = _wsStockQuery;
    const region = _wsStockRegion;
    const visible = [...stocks].sort(wsStockComparer(_wsStockSort)).filter((it) => {
      if (region && wsStockRegion(it.symbol) !== region) return false;
      if (!q) return true;
      const name = ((it.meta && it.meta.name) || "").toLowerCase();
      const sym = (it.symbol || "").toLowerCase();
      return name.indexOf(q) !== -1 || sym.indexOf(q) !== -1;
    });

    if (!visible.length || !visible.some((s) => s.symbol === _wsSelectedStock)) {
      _wsSelectedStock = visible.length ? visible[0].symbol : null;
    }

    visible.forEach((it) => {
      const row = document.createElement("div");
      const selected = it.symbol === _wsSelectedStock;
      row.className = "ws-stock-item" + (selected ? " selected" : "");
      const region = wsStockRegion(it.symbol);
      const flag = _WS_FLAG_FILES[region] || "";
      const up = it.chg ? it.chg.pct >= 0 : true;
      const ccyTxt = escapeHtml(_WS_CCY_SYMBOL[_wsCurrency] || _wsCurrency);
      const chgTxt = it.chg ? (up ? "&#9650;" : "&#9660;") + " " + wsFmtPct(it.chg.pct) : "—";
      row.innerHTML =
        '<div class="ws-stock-item-main">' +
        (flag
          ? '<img class="ws-flag' + (flag === "ch" ? " ws-flag-sq" : "") + '" src="flags/' + flag + '.svg?v=3" alt="' + escapeHtml(region) + '" loading="lazy"/>'
          : '<span class="ws-stock-item-region">' + escapeHtml(region) + "</span>") +
        '<div class="ws-stock-item-names"><span class="ws-stock-item-name">' + escapeHtml(it.meta.name || it.symbol) + "</span>" +
        '<span class="ws-stock-item-symbol">' + escapeHtml(it.symbol) + "</span></div>" +
        "</div>" +
        '<div class="ws-stock-item-right">' +
        '<span class="ws-stock-item-change ' + (up ? "pos" : "neg") + '">' + chgTxt + "</span>" +
        '<span class="ws-stock-item-price"><span class="ws-stock-item-ccy">' + ccyTxt + "</span>&nbsp;" + wsFmtValue(it.displayValue != null ? it.displayValue : it.last.close) + "</span>" +
        "</div>";
      row.onclick = () => {
        _wsSelectedStock = it.symbol;
        this._wsRenderStockPanel(_wsStockCtx.stocks, _wsStockCtx.data, _wsStockCtx.metaBySym, _wsStockCtx.startDate, _wsStockCtx.usdPer, _wsStockCtx.range);
      };
      listEl.appendChild(row);
    });

    const sel = visible.find((s) => s.symbol === _wsSelectedStock);
    if (sel) {
      const listH = listEl.offsetHeight;
      if (wrap) wrap.style.height = (listH > 0 ? listH : 360) + "px";
      this._wsRenderStockSelChart(sel, startDate);
    } else {
      wrap.style.display = "none";
      empty.style.display = "block";
    }
  },

  _wsRenderStockSelChart(sel, startDate) {
    const wrap = document.getElementById("ws-stock-chart-wrap");
    const canvas = document.getElementById("ws-stock-chart");
    const empty = document.getElementById("ws-stock-chart-empty");
    const titleEl = document.getElementById("ws-stock-chart-title");
    if (!wrap || !canvas || !empty) return;

    const key = "wsStockSel";
    if (App._charts[key]) {
      try { App._charts[key].destroy(); } catch (e) {}
      delete App._charts[key];
    }

    const region = wsStockRegion(sel.symbol);
    const fromCur = region === "CH" ? "CHF" : region === "DE" ? "EUR" : region === "JP" ? "JPY" : "USD";
    const scale = wsCurrencyScale(_wsStockCtx.usdPer, fromCur, _wsCurrency);

    const candles = [];
    const vols = [];
    const ts = (d) => new Date(d + "T00:00:00Z").valueOf();
    const mult = scale == null ? 1 : scale;
    (sel.bars || []).forEach((b) => {
      if (b.date < startDate) return;
      if (b.open != null && b.high != null && b.low != null && b.close != null) {
        candles.push({ x: ts(b.date), o: b.open * mult, h: b.high * mult, l: b.low * mult, c: b.close * mult });
      } else if (b.close != null) {
        const v = b.close * mult;
        candles.push({ x: ts(b.date), o: v, h: v, l: v, c: v });
      }
      if (b.volume != null) vols.push({ x: ts(b.date), y: b.volume });
    });

    if (candles.length < 2) {
      wrap.style.display = "none";
      empty.style.display = "block";
      if (titleEl) titleEl.innerHTML = "";
      return;
    }
    wrap.style.display = "";
    empty.style.display = "none";

    const up = sel.chg ? sel.chg.pct >= 0 : true;
    if (titleEl) {
      titleEl.innerHTML =
        '<span class="ws-stock-chart-name">' + escapeHtml(sel.meta.name || sel.symbol) + "</span>" +
        '<span class="ws-stock-chart-symbol">' + escapeHtml(sel.symbol) + "</span>" +
        '<span class="ws-stock-chart-price">' + wsFmtValue(candles[candles.length - 1].c) + "</span>" +
        '<span class="ws-stock-chart-change ' + (up ? "pos" : "neg") + '">' + (sel.chg ? (up ? "&#9650;" : "&#9660;") + " " + wsFmtPct(sel.chg.pct) : "—") + "</span>";
    }

    const ctx = canvas.getContext("2d");
    const bull = "#33ff33";
    const bear = "#ff3333";
    const ccy = _WS_CCY_SYMBOL[_wsCurrency] || _wsCurrency;
    const sFmt = (v) => wsFmtValue(v, undefined);

    App._charts[key] = new Chart(ctx, {
      type: "candlestick",
      data: {
        datasets: [
          {
            label: (sel.meta.name || sel.symbol) + " (OHLC)",
            data: candles,
            // NOTE: chartjs-chart-financial maps close<open to `up` and close>open to
            // `down`, so the colors are assigned swapped to keep green=up / red=down.
            backgroundColors: { up: bear, down: bull, unchanged: "#999999" },
            borderColors: { up: bear, down: bull, unchanged: "#999999" },
          },
          {
            type: "bar",
            label: "VOLUME",
            data: vols,
            yAxisID: "yVol",
            backgroundColor: "rgba(140,140,140,0.30)",
            borderWidth: 0,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: (items) => (items[0] && items[0].parsed.x != null ? formatDate(new Date(items[0].parsed.x).toISOString().slice(0, 10)) : ""),
              label: (c) => {
                if (c.datasetIndex === 1) return null;
                const d = c.parsed;
                return ccy + " " + d.c.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              },
            },
          },
        },
        scales: {
          x: {
            type: "timeseries",
            time: { unit: "day", displayFormats: { day: "dd.MM.yyyy" } },
            ticks: {
              color: "#999999",
              font: { family: "'Share Tech Mono', monospace", size: 10 },
              maxRotation: 0,
              maxTicksLimit: 8,
              callback: (val) => formatDateShort(new Date(val).toISOString().slice(0, 10)),
            },
            grid: { color: "#222222" },
          },
          y: {
            position: "left",
            ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (v) => sFmt(v) },
            grid: { color: "#222222" },
          },
          yVol: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            ticks: {
              color: "#666666",
              font: { family: "'Share Tech Mono', monospace", size: 9 },
              maxTicksLimit: 4,
              callback: (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : v),
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  },

  _wsRenderMetals(order, data, metaBySym, startDate, usdPer) {
    this._wsNormChart("wsMetal", "ws-metal-chart-wrap", "ws-metal-chart", "ws-metal-chart-empty", order, data, metaBySym, startDate, (sym) => _WS_METAL_COLORS[sym], usdPer);
  },

  _wsRenderCryptoChart(order, data, metaBySym, startDate, usdPer) {
    this._wsNormChart("wsCrypto", "ws-crypto-chart-wrap", "ws-crypto-chart", "ws-crypto-chart-empty", order, data, metaBySym, startDate, (sym) => {
      const idx = order.indexOf(sym);
      return _WS_CRYPTO_COLORS[idx % _WS_CRYPTO_COLORS.length];
    }, usdPer, _wsCryptoLogScale);
  },

  _wsNormChart(cacheKey, wrapId, canvasId, emptyId, order, data, metaBySym, startDate, vividColorOf, usdPer, logScale) {
    const wrap = document.getElementById(wrapId);
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    if (!wrap || !canvas || !empty) return;

    if (App._charts[cacheKey]) {
      try { App._charts[cacheKey].destroy(); } catch (e) {}
      delete App._charts[cacheKey];
    }

    const norm = wsNormalizeSeries(data, order, startDate);
    if (norm.symbols.length < 2) {
      wrap.style.display = "none";
      empty.style.display = "block";
      return;
    }
    wrap.style.display = "";
    empty.style.display = "none";

    const colorOf = (sym) => vividColorOf(sym) || _WS_FADED;
    const weightMult = _WS_METAL_WEIGHTS[_wsMetalWeight].mult;
    const scales = {};
    const scaleOf = (sym) => {
      if (scales[sym] != null) return scales[sym];
      const m = metaBySym[sym] || {};
      const cls = m.class;
      let from = "USD";
      if (cls === "metal") from = "USD";
      else if (cls === "index") from = _WS_INDEX_CUR[sym] || "USD";
      else if (cls === "stock") {
        const region = wsStockRegion(sym);
        from = region === "CH" ? "CHF" : region === "DE" ? "EUR" : region === "JP" ? "JPY" : "USD";
      }
      const s = wsCurrencyScale(usdPer, from, _wsCurrency);
      scales[sym] = s == null ? 1 : s;
      return scales[sym];
    };
    const realData = {};
    const lastClose = {};
    norm.symbols.forEach((sym) => (realData[sym] = []));
    norm.dates.forEach((dt) => {
      norm.symbols.forEach((sym) => {
        const bars = data[sym] || [];
        let v = lastClose[sym];
        for (let i = 0; i < bars.length; i++) {
          if (bars[i].date > dt) break;
          if (bars[i].close != null) v = bars[i].close;
        }
        lastClose[sym] = v;
        const cls = (metaBySym[sym] || {}).class;
        let dv = v;
        if (v != null) {
          dv = v * scaleOf(sym);
          if (cls === "metal") dv *= weightMult;
        }
        realData[sym].push(dv);
      });
    });

    App._charts[cacheKey] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: norm.dates,
        datasets: norm.symbols.map((sym) => ({
          label: (metaBySym[sym] && metaBySym[sym].name) || sym,
          data: norm.series[sym],
          borderColor: colorOf(sym),
          backgroundColor: "transparent",
          borderWidth: 1.8,
          pointRadius: 0,
          pointStyle: "circle",
          pointBackgroundColor: colorOf(sym),
          pointBorderColor: colorOf(sym),
          pointBorderWidth: 0,
          tension: 0.2,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 6,
            boxHeight: 6,
            callbacks: {
              title: (items) => (items[0] ? formatDate(items[0].label) : ""),
              label: (ctx) => {
                const sym = norm.symbols[ctx.datasetIndex];
                const cls = (metaBySym[sym] || {}).class;
                const rv = realData[sym][ctx.dataIndex];
                const pctTxt = ctx.parsed.y.toFixed(2) + "%";
                if (rv == null || !isFinite(rv)) return ctx.dataset.label + ": " + pctTxt;
                const ccy = cls === "metal" ? _wsCurrency : _WS_CCY_SYMBOL[_wsCurrency] || _wsCurrency;
                const valTxt = cls === "metal"
                  ? _wsCurrency + " " + wsFmtValue(rv, 2) + " per " + _wsWeightShort(_wsMetalWeight)
                  : ccy + " " + wsFmtValue(rv, undefined);
                return ctx.dataset.label + ": " + valTxt + " (" + pctTxt + ")";
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              color: "#999999",
              font: { family: "'Share Tech Mono', monospace", size: 10 },
              maxTicksLimit: 8,
              callback: (val) => formatDateShort(norm.dates[val]),
            },
            grid: { color: "#222222" },
          },
          y: logScale
            ? {
                type: "logarithmic",
                ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (v) => v.toFixed(1) },
                grid: { color: "#222222" },
              }
            : { ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (v) => v.toFixed(1) }, grid: { color: "#222222" } },
        },
      },
    });

    const legendEl = wrap.querySelector(".ws-norm-legend");
    if (legendEl) {
      legendEl.innerHTML = "";
      norm.symbols.forEach((sym, i) => {
        const row = document.createElement("div");
        row.className = "ws-norm-legend-item";
        row.innerHTML =
          '<span class="ws-norm-legend-swatch" style="background:' + colorOf(sym) + '"></span>' +
          '<span class="ws-norm-legend-label">' + escapeHtml((metaBySym[sym] && metaBySym[sym].name) || sym) + "</span>";
        row.onclick = () => {
          const ch = App._charts[cacheKey];
          if (!ch) return;
          const ds = ch.data.datasets[i];
          ds.hidden = !ds.hidden;
          ch.update();
          row.classList.toggle("off", !!ds.hidden);
        };
        legendEl.appendChild(row);
      });
    }
  },
});

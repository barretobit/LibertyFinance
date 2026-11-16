/* ===== Wall Street overview =====
 *
 * Shows how the markets are moving using the data cached in the Resources/
 * folder (one file per asset class: indexes, stocks, ETFs, metals, cryptos):
 * A period selector drives the change percentages, sparklines and the
 * normalized comparison charts.
 */

const _WALL_STREET_RANGES = {
  "1m": { bars: 22, days: 45 },
  "1w": { bars: 5, days: 7 },
  "3m": { bars: 66, days: 135 },
  "6m": { bars: 130, days: 260 },
  "1y": { bars: 252, days: 520 },
  ytd: { ytd: true },
  "2y": { bars: 504, days: 1040 },
  "3y": { bars: 756, days: 1560 },
  "5y": { bars: 1260, days: 2600 },
  "10y": { bars: 2520, days: 5200 },
};
const _WALL_STREET_INDEX_COLORS = () => ({
  "^GSPC": readAccent(),
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
});
const _WALL_STREET_METAL_COLORS = {
  "GC=F": "#ff9900",
  "SI=F": "#cc66ff",
  "HG=F": "#66ccff",
  "PL=F": "#ffcc00",
  "PA=F": "#ff4d4d",
};
const _WALL_STREET_ETF_COLORS = () => [
  readAccent(), "#33ccff", "#ffcc00", "#ff9900", "#ff66cc",
  "#9966ff", "#00cc88", "#66ffcc", "#ff8866", "#aaccff",
];
// ETFs that track global/international markets get a GLO/INT tag instead of the
// US flag, since the asset catalog does not carry a region for them.
const _WALL_STREET_ETF_REGION = {
  VOO: "US", IVV: "US", SPY: "US", VTI: "US", QQQ: "US",
  VT: "GLO", VEA: "INT", VXUS: "INT", VWO: "INT", BND: "US",
};
const _WALL_STREET_CRYPTO_COLORS = [
  "#f7931a", "#627eea", "#26a17b", "#00ffa3", "#f3ba2f",
];
const _WALL_STREET_FADED_COLOR = "rgba(140,140,140,0.35)";
const _WALL_STREET_CURRENCIES = ["USD", "EUR", "CHF", "GBP", "JPY", "AUD", "CAD", "CNY", "HKD", "NZD", "SEK"];
const _WALL_STREET_CURRENCY_SYMBOL = {
  USD: "$", EUR: "€", CHF: "CHF", GBP: "£", JPY: "¥",
  AUD: "A$", CAD: "C$", CNY: "¥", HKD: "HK$", NZD: "NZ$", SEK: "kr",
  KRW: "₩", INR: "₹",
};
const _WALL_STREET_INDEX_CURRENCY = {
  "^GSPC": "USD", "^IXIC": "USD", "^DJI": "USD",
  "^FTSE": "GBP", "^GDAXI": "EUR", "^FCHI": "EUR",
  "^STOXX50E": "EUR", "^N225": "JPY", "^HSI": "HKD",
  "^BVSP": "BRL", "^SSMI": "CHF",
};
const _WALL_STREET_FLAG_FILES = { 'US': 'us', 'UK': 'gb', 'GB': 'gb', 'DE': 'de', 'FR': 'fr', 'JP': 'jp', 'HK': 'hk', 'EU': 'eu', 'CH': 'ch', 'KR': 'kr', 'IT': 'it', 'IN': 'in' };
const _WALL_STREET_GRAMS_PER_TROY_OUNCE = 31.1034768;
const _WALL_STREET_METAL_WEIGHTS = {
  oz: { multiplier: 1, label: "PER OZ" },
  g: { multiplier: 1 / _WALL_STREET_GRAMS_PER_TROY_OUNCE, label: "PER G" },
  "100g": { multiplier: 100 / _WALL_STREET_GRAMS_PER_TROY_OUNCE, label: "PER 100 G" },
  "0.5kg": { multiplier: 500 / _WALL_STREET_GRAMS_PER_TROY_OUNCE, label: "PER 0.5 KG" },
  "1kg": { multiplier: 1000 / _WALL_STREET_GRAMS_PER_TROY_OUNCE, label: "PER KG" },
};
let _wallStreetRange = "1m";
let _wallStreetCurrency = "USD";
let _wallStreetMetalWeight = "oz";

// Stock panel state: search query, selected symbol and the last render context
// so the panel can re-render itself on search/selection without a full page pass.
let _wallStreetStockQuery = "";
let _wallStreetSelectedStock = null;
let _wallStreetStockContext = null;
let _wallStreetStockSort = "perf";
let _wallStreetStockRegion = "";

// Crypto chart scale toggle (false = linear, true = logarithmic).
let _wallStreetCryptoLogScale = false;

function _wallStreetWeightShortLabel(weight) {
  if (weight === "oz") return "oz";
  if (weight === "g") return "g";
  if (weight === "100g") return "100 g";
  if (weight === "0.5kg") return "0.5 kg";
  if (weight === "1kg") return "1 kg";
  return weight;
}

// Stock listing region, derived from the exchange suffix. Region means the
// listing venue (and hence the traded currency), so US-listed ADRs such as
// ASML and TSM stay US even though the company is foreign. No suffix = US.
const _WALL_STREET_STOCK_SUFFIX_REGION = {
  '.SW': 'CH', '.DE': 'DE', '.T': 'JP', '.KS': 'KR', '.HK': 'HK',
  '.PA': 'FR', '.L': 'GB', '.MI': 'IT', '.NS': 'IN',
};
// Trading currency per listing region (used to convert prices to the display
// currency). KRW and INR have no Randata FX pair yet, so those fall back to
// showing the native price.
const _WALL_STREET_REGION_CURRENCY = {
  US: 'USD', CH: 'CHF', DE: 'EUR', JP: 'JPY', KR: 'KRW',
  HK: 'HKD', FR: 'EUR', GB: 'GBP', IT: 'EUR', IN: 'INR',
};
function wallStreetStockRegion(symbol) {
  const upperSymbol = String(symbol || '').toUpperCase();
  for (const suffix in _WALL_STREET_STOCK_SUFFIX_REGION) {
    if (upperSymbol.endsWith(suffix)) return _WALL_STREET_STOCK_SUFFIX_REGION[suffix];
  }
  return 'US';
}
function wallStreetStockCurrency(symbol) {
  return _WALL_STREET_REGION_CURRENCY[wallStreetStockRegion(symbol)] || 'USD';
}

function wallStreetStockComparer(sortKey) {
  const compareValues = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const byName = (a, b) => {
    const firstName = ((a.meta && a.meta.name) || "").toLowerCase();
    const secondName = ((b.meta && b.meta.name) || "").toLowerCase();
    return compareValues(firstName, secondName);
  };
  const valueOf = (item) => (item.displayValue != null ? item.displayValue : item.last && item.last.close) || 0;
  return (a, b) => {
    if (sortKey === "name") return byName(a, b);
    if (sortKey === "symbol") return compareValues(a.symbol || "", b.symbol || "");
    if (sortKey === "price") return compareValues(valueOf(b), valueOf(a));
    if (sortKey === "region") {
      const firstRegion = wallStreetStockRegion(a.symbol);
      const secondRegion = wallStreetStockRegion(b.symbol);
      return firstRegion === secondRegion ? byName(a, b) : compareValues(firstRegion, secondRegion);
    }
    const firstChange = a.change && a.change.percent != null ? a.change.percent : -Infinity;
    const secondChange = b.change && b.change.percent != null ? b.change.percent : -Infinity;
    return secondChange - firstChange;
  };
}

function wallStreetPeriodBars(range) {
  if (range === "ytd") return null;
  return (_WALL_STREET_RANGES[range] || _WALL_STREET_RANGES["1m"]).bars;
}

function wallStreetPeriodDays(range) {
  if (range === "ytd") return 0;
  return (_WALL_STREET_RANGES[range] || _WALL_STREET_RANGES["1m"]).days;
}

function wallStreetYearToDateStart(today) {
  return today.slice(0, 4) + "-01-01";
}

function wallStreetWindowStart(bars, range, today) {
  if (range === "ytd") {
    const start = wallStreetYearToDateStart(today);
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].date >= start) return i;
    }
    return 0;
  }
  const barCount = wallStreetPeriodBars(range);
  return Math.max(0, bars.length - 1 - barCount);
}

function wallStreetDateAddDays(dateText, days) {
  const date = new Date(dateText + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split("T")[0];
}

// Last bar that actually has a close. Some symbols (e.g. SW/DE stocks) carry a
// trailing intraday bar with a null OHLC, so indexes/values must never read the
// tail blindly.
function wallStreetLastBar(bars) {
  if (!Array.isArray(bars)) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i] && bars[i].close != null) return bars[i];
  }
  return null;
}

function wallStreetChangePercent(bars, startIndex) {
  if (!bars || bars.length < 2) return null;
  const base = bars[startIndex].close;
  const lastBar = wallStreetLastBar(bars);
  if (!base || !lastBar) return null;
  const last = lastBar.close;
  return { base, last, percent: ((last - base) / base) * 100 };
}

function wallStreetRateMap(data, assets) {
  const usdPerUnit = { USD: 1 };
  (assets || []).forEach((asset) => {
    if (!asset || asset.class !== "fx" || !asset.symbol) return;
    if (!asset.symbol.endsWith("USD=X")) return;
    const base = asset.symbol.slice(0, 3);
    const bars = (data || {})[asset.symbol] || [];
    const lastBar = wallStreetLastBar(bars);
    if (!lastBar) return;
    usdPerUnit[base] = lastBar.close;
  });
  return usdPerUnit;
}

function wallStreetCurrencyScale(usdPerUnit, fromCode, toCode) {
  const fromInUsd = usdPerUnit[fromCode];
  const toInUsd = usdPerUnit[toCode];
  if (fromInUsd == null || toInUsd == null) return null;
  return fromInUsd / toInUsd;
}

function wallStreetFormatValue(value, decimals) {
  if (value == null || isNaN(value)) return "—";
  if (decimals != null) {
    const fractionDigits = Math.max(0, Math.min(2, decimals));
    return value.toLocaleString("en-GB", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1000) return value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function wallStreetFormatPercent(percent) {
  if (percent == null || isNaN(percent)) return "—";
  return (percent >= 0 ? "+" : "") + percent.toFixed(2) + "%";
}

function wallStreetSparklineSvg(values, up) {
  if (!values || values.length < 2) return "";
  const color = up ? "#33ff33" : "#ff3333";
  const fill = up ? "rgba(51,255,51,0.12)" : "rgba(255,51,51,0.12)";
  const min = Math.min.apply(null, values);
  const max = Math.max.apply(null, values);
  const span = max - min || 1;
  const count = values.length;
  const pointAt = (i, value) => ((i / (count - 1)) * 100).toFixed(2) + "," + (34 - ((value - min) / span) * 29 - 1.5).toFixed(2);
  const points = [];
  for (let i = 0; i < count; i++) points.push(pointAt(i, values[i]));
  return (
    '<svg class="ws-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon points="0,36 ' + points.join(" ") + ' 100,36" fill="' + fill + '"/>' +
    '<polyline points="' + points.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    "</svg>"
  );
}

function wallStreetNormalizeSeries(barsBySymbol, order, startDate) {
  const normalizedBySymbol = {};
  const allDates = new Set();
  order.forEach((symbol) => {
    const bars = (barsBySymbol || {})[symbol] || [];
    const points = [];
    bars.forEach((bar) => {
      if (bar.date >= startDate && bar.close != null) points.push({ date: bar.date, value: bar.close });
    });
    if (points.length < 2 || !points[0].value) return;
    const base = points[0].value;
    const normalized = points.map((point) => ({ date: point.date, value: (point.value / base) * 100 }));
    normalizedBySymbol[symbol] = normalized;
    normalized.forEach((point) => allDates.add(point.date));
  });
  const dates = [...allDates].sort();
  const series = {};
  const symbols = order.filter((symbol) => normalizedBySymbol[symbol]);
  const last = {};
  symbols.forEach((symbol) => {
    series[symbol] = [];
    last[symbol] = 100;
  });
  dates.forEach((date) => {
    symbols.forEach((symbol) => {
      const symbolPoints = normalizedBySymbol[symbol];
      for (let i = 0; i < symbolPoints.length; i++) {
        if (symbolPoints[i].date <= date) last[symbol] = symbolPoints[i].value;
        else break;
      }
      series[symbol].push(last[symbol]);
    });
  });
  return { dates, series, symbols };
}

function wallStreetHistoricalStatsFromItems(items, range) {
  const today = todayIsoDate();
  let returnSum = 0,
    returnCount = 0,
    risingPeriodCount = 0,
    changeSum = 0,
    changeCount = 0,
    risingCount = 0,
    drawdownSum = 0,
    drawdownCount = 0,
    volatilitySum = 0,
    volatilityCount = 0;
  items.forEach((item) => {
    const change = item.change;
    if (change) {
      changeSum += change.percent;
      changeCount++;
      if (change.percent > 0) risingCount++;
    }
    const bars = item.bars || [];
    const windowStart = wallStreetWindowStart(bars, range, today);
    const closes = [];
    for (let i = windowStart; i < bars.length; i++) {
      if (bars[i] && bars[i].close != null) closes.push(bars[i].close);
    }
    if (closes.length >= 2) {
      let peak = closes[0];
      let maxDrawdown = 0;
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > peak) peak = closes[i];
        else if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - closes[i]) / peak);
      }
      drawdownSum += maxDrawdown;
      drawdownCount++;
      let meanReturn = 0;
      const dailyReturns = [];
      for (let i = 1; i < closes.length; i++) {
        if (!closes[i - 1]) continue;
        const dailyReturn = closes[i] / closes[i - 1] - 1;
        dailyReturns.push(dailyReturn);
        meanReturn += dailyReturn;
      }
      if (dailyReturns.length >= 2) {
        meanReturn /= dailyReturns.length;
        let variance = 0;
        for (let i = 0; i < dailyReturns.length; i++) variance += (dailyReturns[i] - meanReturn) * (dailyReturns[i] - meanReturn);
        variance /= dailyReturns.length;
        volatilitySum += Math.sqrt(variance) * Math.sqrt(252) * 100;
        volatilityCount++;
      }
    }
    if (bars.length < 2) return;
    if (range === "ytd") {
      const monthDay = today.slice(5);
      const year = parseInt(today.slice(0, 4), 10);
      for (let pastYear = year - 1; pastYear >= year - 6; pastYear--) {
        const segment = bars.filter((bar) => bar.date >= pastYear + "-01-01" && bar.date <= pastYear + "-" + monthDay);
        const segmentLastBar = wallStreetLastBar(segment);
        if (segment.length < 2 || !segment[0] || segment[0].close == null || !segmentLastBar) continue;
        const periodReturn = ((segmentLastBar.close - segment[0].close) / segment[0].close) * 100;
        returnSum += periodReturn;
        returnCount++;
        if (periodReturn > 0) risingPeriodCount++;
      }
    } else {
      const barCount = wallStreetPeriodBars(range);
      for (let i = 0; i + barCount < bars.length; i += barCount) {
        const base = bars[i].close;
        const last = bars[i + barCount].close;
        if (!base || !last) continue;
        const periodReturn = ((last - base) / base) * 100;
        returnSum += periodReturn;
        returnCount++;
        if (periodReturn > 0) risingPeriodCount++;
      }
    }
  });
  if (!changeCount) return null;
  const hasReturns = returnCount > 0;
  return {
    marketChange: changeSum / changeCount,
    breadth: risingCount,
    breadthTotal: changeCount,
    expected: hasReturns ? returnSum / returnCount : null,
    winRate: hasReturns ? risingPeriodCount / returnCount : null,
    maxDrawdown: drawdownCount ? drawdownSum / drawdownCount : null,
    annualVolatility: volatilityCount ? volatilitySum / volatilityCount : null,
  };
}

Object.assign(Pages, {
  // ==================== WALL STREET ====================

  async wallStreet() {
    Object.values(App._charts).forEach((chart) => {
      try { chart.destroy(); } catch (error) {}
    });
    App._charts = {};

    const loading = document.getElementById("ws-loading");
    if (loading) loading.classList.add("show");
    try {
      try {
        const settings = await DB.getSettings();
        if (settings) {
          if (settings.wsCurrency && _WALL_STREET_CURRENCIES.indexOf(settings.wsCurrency) !== -1) _wallStreetCurrency = settings.wsCurrency;
          if (settings.wsMetalWeight && _WALL_STREET_METAL_WEIGHTS[settings.wsMetalWeight]) _wallStreetMetalWeight = settings.wsMetalWeight;
          if (typeof settings.wsCryptoLog === "boolean") _wallStreetCryptoLogScale = settings.wsCryptoLog;
          if (settings.wsStockSort) _wallStreetStockSort = settings.wsStockSort;
          if (settings.wsStockRegion) _wallStreetStockRegion = settings.wsStockRegion;
        }
      } catch (error) {}

      this._wallStreetRenderPreferences();

      // The local market files draw the page at once and a background sync
      // redraws it if new bars arrive. Only a first load (nothing synced yet)
      // waits for the network, so stale or half-built data is never shown.
      const shownVersion = Randata.dataVersion();
      let file = await Randata.readFile();
      let syncing = null;
      if (file.synced_date) {
        syncing = Randata.sync();
      } else {
        await Randata.sync();
        file = await Randata.readFile();
      }
      const data = file.data || {};
      const assets = file.assets || [];
      const usdPerUnit = wallStreetRateMap(data, assets);

      const syncLabel = document.getElementById("ws-sync-label");
      if (syncLabel) {
        syncLabel.textContent = file.synced_date ? "MARKET DATA: " + formatDate(file.synced_date) : "MARKET DATA: NO DATA";
        syncLabel.style.color = file.synced_date ? "" : "var(--danger)";
      }

      const metaBySymbol = {};
      assets.forEach((asset) => {
        if (asset && asset.symbol) metaBySymbol[asset.symbol] = asset;
      });

      const range = _wallStreetRange;
      const today = todayIsoDate();
      const startDate = range === "ytd" ? wallStreetYearToDateStart(today) : wallStreetDateAddDays(today, -wallStreetPeriodDays(range));

      const groups = { index: [], etf: [], stock: [], metal: [], crypto: [] };
      let hasData = false;
      const weightMultiplier = _WALL_STREET_METAL_WEIGHTS[_wallStreetMetalWeight].multiplier;
      assets.forEach((asset) => {
        if (!asset || !asset.symbol) return;
        if (asset.class === "fx") return;
        const symbol = asset.symbol;
        const bars = data[symbol] || [];
        if (!bars.length) return;
        hasData = true;
        const assetClass = asset.class || "index";
        const startIndex = wallStreetWindowStart(bars, range, today);
        const change = wallStreetChangePercent(bars, startIndex);
        const windowValues = bars.slice(startIndex).map((bar) => bar.close);
        const item = { symbol, meta: asset, bars, change, windowValues, last: wallStreetLastBar(bars) || bars[bars.length - 1] };
        if (assetClass === "index") {
          const scale = wallStreetCurrencyScale(usdPerUnit, _WALL_STREET_INDEX_CURRENCY[symbol] || "USD", _wallStreetCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
          item.currency = scale == null ? (_WALL_STREET_INDEX_CURRENCY[symbol] || "USD") : _wallStreetCurrency;
        } else if (assetClass === "metal") {
          const scale = wallStreetCurrencyScale(usdPerUnit, "USD", _wallStreetCurrency);
          item.displayValue = (scale == null ? 1 : scale) * weightMultiplier * item.last.close;
          item.unitLabel = _WALL_STREET_METAL_WEIGHTS[_wallStreetMetalWeight].label;
          item.currency = scale == null ? "USD" : _wallStreetCurrency;
        } else if (assetClass === "stock") {
          const fromCurrency = wallStreetStockCurrency(symbol);
          const scale = wallStreetCurrencyScale(usdPerUnit, fromCurrency, _wallStreetCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
          item.currency = scale == null ? fromCurrency : _wallStreetCurrency;
        } else if (assetClass === "etf") {
          const scale = wallStreetCurrencyScale(usdPerUnit, "USD", _wallStreetCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
          item.currency = scale == null ? "USD" : _wallStreetCurrency;
        } else if (assetClass === "crypto") {
          const scale = wallStreetCurrencyScale(usdPerUnit, "USD", _wallStreetCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
          item.currency = scale == null ? "USD" : _wallStreetCurrency;
        } else {
          const scale = wallStreetCurrencyScale(usdPerUnit, "USD", _wallStreetCurrency);
          item.displayValue = scale == null ? item.last.close : item.last.close * scale;
          item.currency = scale == null ? "USD" : _wallStreetCurrency;
        }
        if (groups[assetClass]) groups[assetClass].push(item);
      });

      const nodata = document.getElementById("ws-nodata");
      if (nodata) nodata.innerHTML = "";
      if (hasData) {
        this._wallStreetRenderGroup("#ws-index-grid", "#ws-index-empty", groups.index);
        this._wallStreetRenderGroup("#ws-etf-grid", "#ws-etf-empty", groups.etf);
        this._wallStreetRenderGroup("#ws-stock-grid", "#ws-stock-empty", groups.stock);
        this._wallStreetRenderGroup("#ws-metal-grid", "#ws-metal-empty", groups.metal);
        this._wallStreetRenderGroup("#ws-crypto-grid", "#ws-crypto-empty", groups.crypto);

        this._wallStreetRenderOverview(
          groups.index.map((item) => item.symbol),
          data, metaBySymbol, startDate, usdPerUnit,
        );
        this._wallStreetRenderEtfChart(
          groups.etf.map((item) => item.symbol),
          data, metaBySymbol, startDate, usdPerUnit,
        );
        this._wallStreetRenderStockPanel(
          groups.stock,
          data, metaBySymbol, startDate, usdPerUnit, range,
        );
        this._wallStreetRenderMetals(
          groups.metal.map((item) => item.symbol),
          data, metaBySymbol, startDate, usdPerUnit,
        );
        this._wallStreetRenderCryptoChart(
          groups.crypto.map((item) => item.symbol),
          data, metaBySymbol, startDate, usdPerUnit,
        );
        this._wallStreetRenderOutlook(groups.index, range);
      } else if (nodata) {
        nodata.innerHTML = '<div class="card-gta"><div class="card-gta-body"><div class="empty-state" style="display:block">NO MARKET DATA — PRESS RESYNC OR REOPEN A PROFILE TO SYNC.</div></div></div>';
      }

      this._wallStreetBindRangeButtons();

      if (syncing) {
        syncing.then(() => {
          const page = document.getElementById("page-wall-street");
          if (Randata.dataVersion() !== shownVersion && page && page.classList.contains("active")) Pages.wallStreet();
        });
        // Resolves once the background sync is done, so callers can report its result.
        return syncing;
      }
    } finally {
      const loading = document.getElementById("ws-loading");
      if (loading) loading.classList.remove("show");
    }
  },

  _wallStreetBindRangeButtons() {
    document.querySelectorAll(".ws-range-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.range === _wallStreetRange);
      button.onclick = () => {
        _wallStreetRange = button.dataset.range;
        Pages.wallStreet();
      };
    });

    const logButton = document.getElementById("ws-crypto-log-btn");
    if (logButton) {
      logButton.textContent = _wallStreetCryptoLogScale ? "LOG" : "LIN";
      logButton.classList.toggle("active", _wallStreetCryptoLogScale);
      logButton.onclick = async () => {
        _wallStreetCryptoLogScale = !_wallStreetCryptoLogScale;
        await this._wallStreetSavePreferences();
        Pages.wallStreet();
      };
    }
  },

  _wallStreetRenderPreferences() {
    const currencySelect = document.getElementById("ws-currency");
    if (currencySelect) {
      currencySelect.value = _wallStreetCurrency;
      currencySelect.onchange = async () => {
        _wallStreetCurrency = currencySelect.value;
        await this._wallStreetSavePreferences();
        Pages.wallStreet();
      };
    }
    const weightSelect = document.getElementById("ws-weight");
    if (weightSelect) {
      weightSelect.value = _wallStreetMetalWeight;
      weightSelect.onchange = async () => {
        _wallStreetMetalWeight = weightSelect.value;
        await this._wallStreetSavePreferences();
        Pages.wallStreet();
      };
    }
  },

  async _wallStreetSavePreferences() {
    try {
      const settings = (await DB.getSettings()) || {};
      settings.wsCurrency = _wallStreetCurrency;
      settings.wsMetalWeight = _wallStreetMetalWeight;
      settings.wsCryptoLog = _wallStreetCryptoLogScale;
      settings.wsStockSort = _wallStreetStockSort;
      settings.wsStockRegion = _wallStreetStockRegion;
      await DB.saveSettings(settings);
    } catch (error) {}
  },

  async wallStreetResync() {
    const button = document.getElementById("ws-resync-btn");
    if (button) {
      button.disabled = true;
      button.textContent = "SYNCING...";
    }
    try {
      const result = await Randata.sync({ force: true });
      await this.wallStreet();
      App.toast(result.status === "offline" ? "MARKET DATA OFFLINE" : result.status === "fresh" ? "MARKET DATA AVAILABLE" : "MARKET DATA SYNCED");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "RESYNC";
      }
    }
  },

  _wallStreetRenderOutlook(items, range) {
    const outlookElement = document.getElementById("ws-outlook");
    if (!outlookElement) return;
    const stats = wallStreetHistoricalStatsFromItems(items, range);
    if (!stats) {
      outlookElement.innerHTML = '<div class="empty-state" style="display:block">NOT ENOUGH HISTORY FOR ' + range.toUpperCase() + ".</div>";
      return;
    }
    const tag = range.toUpperCase();
    const formatPercent = (value) => (value == null ? "—" : (value >= 0 ? "+" : "") + value.toFixed(2) + "%");
    const color = (value) => (value == null ? "#666666" : value >= 0 ? "#33ff33" : "#ff3333");
    const formatDrawdown = (value) => (value == null ? "—" : "-" + Math.abs(value * 100).toFixed(1) + "%");
    const card = (label, value, colorCss, note, extraClass) => '<div class="col-md-2 col-6' + (extraClass ? " " + extraClass : "") + '"><div class="stat-card"><span class="stat-label">' + label + "</span>" + '<span class="stat-value ws-outlook-value" style="color:' + colorCss + '">' + value + "</span>" + (note ? '<span class="ws-outlook-note">' + note + "</span>" : "") + "</div></div>";
    outlookElement.innerHTML =
      card("MARKET CHANGE (" + tag + ")", formatPercent(stats.marketChange), color(stats.marketChange), "AVG OF ALL INDEXES") +
      card("BREADTH", stats.breadth + " / " + stats.breadthTotal + " UP", color(stats.breadth - stats.breadthTotal / 2), "INDEXES RISING") +
      card("MAX DRAWDOWN (" + tag + ")", formatDrawdown(stats.maxDrawdown), stats.maxDrawdown == null ? "#666666" : stats.maxDrawdown > 0 ? "#ff3333" : "#33ff33", "WORST PEAK-TO-TROUGH") +
      card("VOLATILITY (" + tag + ")", stats.annualVolatility == null ? "—" : stats.annualVolatility.toFixed(1) + "%", "#ffcc00", "ANNUALIZED, AVG OF INDEXES") +
      card("EXPECTED NEXT (" + tag + ")", formatPercent(stats.expected), color(stats.expected), "HISTORICAL AVERAGE") +
      card("WIN RATE", stats.winRate == null ? "—" : (stats.winRate * 100).toFixed(0) + "% UP", stats.winRate == null ? "#666" : stats.winRate >= 0.5 ? "#33ff33" : "#ff3333", "HISTORICAL PERIODS POSITIVE");
  },

  _wallStreetRenderGroup(gridId, emptyId, items) {
    const grid = document.querySelector(gridId);
    const empty = document.querySelector(emptyId);
    if (!grid) return;
    grid.innerHTML = "";
    if (!items.length && empty) {
      empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";

    items.forEach((item) => {
      const assetClass = item.meta.class || "index";
      let flag = "";
      let code = "";
      if (assetClass === "index") {
        flag = _WALL_STREET_FLAG_FILES[item.meta.region] || "";
        code = flag ? "" : item.meta.region || "";
      } else if (assetClass === "stock") {
        const region = wallStreetStockRegion(item.symbol);
        flag = _WALL_STREET_FLAG_FILES[region] || "";
        code = flag ? "" : region;
      } else if (assetClass === "etf") {
        const region = _WALL_STREET_ETF_REGION[item.symbol] || "US";
        if (region === "US") {
          flag = _WALL_STREET_FLAG_FILES["US"] || "";
          code = "";
        } else {
          flag = "globe";
          code = region;
        }
      } else if (assetClass === "metal") {
        code = item.meta.display || item.symbol;
      } else if (assetClass === "crypto") {
        code = item.meta.display || item.symbol.replace("-USD", "");
      }
      const subtitle = assetClass === "metal" || assetClass === "crypto" ? "" : item.meta.name || "";
      const up = item.change ? item.change.percent >= 0 : true;
      const column = document.createElement("div");
      column.className = "col-6 col-md-4 ws-tick-col";
      column.innerHTML =
        '<div class="ws-tick card-gta">' +
        '<div class="ws-tick-head"><span class="ws-tick-name">' +
        escapeHtml(item.meta.name || item.symbol) +
        "</span>" +
        (code || flag
          ? '<span class="ws-tick-code' + (flag ? " ws-tick-flag" : "") + '" title="' + escapeHtml(code || item.meta.region || "") + '">' + (flag ? '<img class="ws-flag' + (flag === "ch" ? " ws-flag-sq" : "") + '" src="flags/' + flag + '.svg?v=3" alt="' + escapeHtml(code || "") + '" loading="lazy"/>' : escapeHtml(code)) + "</span>"
          : "") +
        "</div>" +
        '<div class="ws-tick-value">' +
        (assetClass === "metal"
          ? '<span class="ws-tick-ccy">' + escapeHtml(_wallStreetCurrency) + "</span>&nbsp;" +
            wallStreetFormatValue(item.displayValue != null ? item.displayValue : item.last.close, 2) +
            '<span class="ws-tick-unit"> per ' + _wallStreetWeightShortLabel(_wallStreetMetalWeight) + "</span>"
          : '<span class="ws-tick-ccy">' + escapeHtml(_WALL_STREET_CURRENCY_SYMBOL[item.currency || _wallStreetCurrency] || item.currency || _wallStreetCurrency) + "</span>&nbsp;" +
            wallStreetFormatValue(item.displayValue != null ? item.displayValue : item.last.close, undefined)) +
        "</div>" +
        '<div class="ws-tick-line"><span class="ws-tick-change ' +
        (up ? "pos" : "neg") +
        '">' +
        (item.change ? (up ? "&#9650; " : "&#9660; ") + wallStreetFormatPercent(item.change.percent) : "—") +
        "</span>" +
        (subtitle ? '<span class="ws-tick-sub">' + escapeHtml(subtitle) + "</span>" : "") +
        "</div>" +
        wallStreetSparklineSvg(item.windowValues, up) +
        "</div>";
      grid.appendChild(column);
    });
  },

  _wallStreetRenderOverview(order, data, metaBySymbol, startDate, usdPerUnit) {
    this._wallStreetNormalizedChart("wsOverview", "ws-overview-wrap", "ws-overview-chart", "ws-overview-empty", order, data, metaBySymbol, startDate, (symbol) => _WALL_STREET_INDEX_COLORS()[symbol], usdPerUnit);
  },

  _wallStreetRenderEtfChart(order, data, metaBySymbol, startDate, usdPerUnit) {
    this._wallStreetNormalizedChart("wsEtf", "ws-etf-chart-wrap", "ws-etf-chart", "ws-etf-chart-empty", order, data, metaBySymbol, startDate, (symbol) => {
      const position = order.indexOf(symbol);
      return _WALL_STREET_ETF_COLORS()[position % _WALL_STREET_ETF_COLORS().length];
    }, usdPerUnit);
  },

  _wallStreetRenderStockPanel(stocks, data, metaBySymbol, startDate, usdPerUnit, range) {
    const wrap = document.getElementById("ws-stock-chart-wrap");
    const canvas = document.getElementById("ws-stock-chart");
    const empty = document.getElementById("ws-stock-chart-empty");
    const listElement = document.getElementById("ws-stock-list");
    const emptyList = document.getElementById("ws-stock-empty");
    const searchInput = document.getElementById("ws-stock-search");
    const sortSelect = document.getElementById("ws-stock-sort");
    const regionSelect = document.getElementById("ws-stock-region");
    if (!listElement || !wrap || !canvas || !empty) return;

    _wallStreetStockContext = { stocks, data, metaBySymbol, startDate, usdPerUnit, range };

    if (searchInput) {
      searchInput.value = _wallStreetStockQuery;
      searchInput.oninput = () => {
        _wallStreetStockQuery = searchInput.value.trim().toLowerCase();
        this._wallStreetRenderStockPanel(_wallStreetStockContext.stocks, _wallStreetStockContext.data, _wallStreetStockContext.metaBySymbol, _wallStreetStockContext.startDate, _wallStreetStockContext.usdPerUnit, _wallStreetStockContext.range);
      };
    }
    if (sortSelect) {
      sortSelect.value = _wallStreetStockSort;
      sortSelect.onchange = () => {
        _wallStreetStockSort = sortSelect.value;
        this._wallStreetSavePreferences();
        this._wallStreetRenderStockPanel(_wallStreetStockContext.stocks, _wallStreetStockContext.data, _wallStreetStockContext.metaBySymbol, _wallStreetStockContext.startDate, _wallStreetStockContext.usdPerUnit, _wallStreetStockContext.range);
      };
    }
    if (regionSelect) {
      regionSelect.value = _wallStreetStockRegion;
      regionSelect.onchange = () => {
        _wallStreetStockRegion = regionSelect.value;
        this._wallStreetSavePreferences();
        this._wallStreetRenderStockPanel(_wallStreetStockContext.stocks, _wallStreetStockContext.data, _wallStreetStockContext.metaBySymbol, _wallStreetStockContext.startDate, _wallStreetStockContext.usdPerUnit, _wallStreetStockContext.range);
      };
    }

    listElement.innerHTML = "";
    emptyList.style.display = stocks.length ? "none" : "block";

    const query = _wallStreetStockQuery;
    const region = _wallStreetStockRegion;
    const visible = [...stocks].sort(wallStreetStockComparer(_wallStreetStockSort)).filter((item) => {
      if (region && wallStreetStockRegion(item.symbol) !== region) return false;
      if (!query) return true;
      const name = ((item.meta && item.meta.name) || "").toLowerCase();
      const symbol = (item.symbol || "").toLowerCase();
      return name.indexOf(query) !== -1 || symbol.indexOf(query) !== -1;
    });

    if (!visible.length || !visible.some((stock) => stock.symbol === _wallStreetSelectedStock)) {
      _wallStreetSelectedStock = visible.length ? visible[0].symbol : null;
    }

    visible.forEach((item) => {
      const row = document.createElement("div");
      const selected = item.symbol === _wallStreetSelectedStock;
      row.className = "ws-stock-item" + (selected ? " selected" : "");
      const region = wallStreetStockRegion(item.symbol);
      const flag = _WALL_STREET_FLAG_FILES[region] || "";
      const up = item.change ? item.change.percent >= 0 : true;
      const currencyText = escapeHtml(_WALL_STREET_CURRENCY_SYMBOL[item.currency || _wallStreetCurrency] || item.currency || _wallStreetCurrency);
      const changeText = item.change ? (up ? "&#9650;" : "&#9660;") + " " + wallStreetFormatPercent(item.change.percent) : "—";
      row.innerHTML =
        '<div class="ws-stock-item-main">' +
        (flag
          ? '<img class="ws-flag' + (flag === "ch" ? " ws-flag-sq" : "") + '" src="flags/' + flag + '.svg?v=3" alt="' + escapeHtml(region) + '" loading="lazy"/>'
          : '<span class="ws-stock-item-region">' + escapeHtml(region) + "</span>") +
        '<div class="ws-stock-item-names"><span class="ws-stock-item-name">' + escapeHtml(item.meta.name || item.symbol) + "</span>" +
        '<span class="ws-stock-item-symbol">' + escapeHtml(item.symbol) + "</span></div>" +
        "</div>" +
        '<div class="ws-stock-item-right">' +
        '<span class="ws-stock-item-change ' + (up ? "pos" : "neg") + '">' + changeText + "</span>" +
        '<span class="ws-stock-item-price"><span class="ws-stock-item-ccy">' + currencyText + "</span>&nbsp;" + wallStreetFormatValue(item.displayValue != null ? item.displayValue : item.last.close) + "</span>" +
        "</div>";
      row.onclick = () => {
        _wallStreetSelectedStock = item.symbol;
        this._wallStreetRenderStockPanel(_wallStreetStockContext.stocks, _wallStreetStockContext.data, _wallStreetStockContext.metaBySymbol, _wallStreetStockContext.startDate, _wallStreetStockContext.usdPerUnit, _wallStreetStockContext.range);
      };
      listElement.appendChild(row);
    });

    const selectedStock = visible.find((stock) => stock.symbol === _wallStreetSelectedStock);
    if (selectedStock) {
      const listHeight = listElement.offsetHeight;
      if (wrap) wrap.style.height = (listHeight > 0 ? listHeight : 360) + "px";
      this._wallStreetRenderSelectedStockChart(selectedStock, startDate);
    } else {
      wrap.style.display = "none";
      empty.style.display = "block";
    }
  },

  _wallStreetRenderSelectedStockChart(stock, startDate) {
    const wrap = document.getElementById("ws-stock-chart-wrap");
    const canvas = document.getElementById("ws-stock-chart");
    const empty = document.getElementById("ws-stock-chart-empty");
    const titleElement = document.getElementById("ws-stock-chart-title");
    if (!wrap || !canvas || !empty) return;

    const key = "wsStockSel";
    if (App._charts[key]) {
      try { App._charts[key].destroy(); } catch (error) {}
      delete App._charts[key];
    }

    const fromCurrency = wallStreetStockCurrency(stock.symbol);
    const scale = wallStreetCurrencyScale(_wallStreetStockContext.usdPerUnit, fromCurrency, _wallStreetCurrency);
    const currencyCode = scale == null ? fromCurrency : _wallStreetCurrency;

    const candles = [];
    const volumes = [];
    const toTimestamp = (date) => new Date(date + "T00:00:00Z").valueOf();
    const multiplier = scale == null ? 1 : scale;
    (stock.bars || []).forEach((bar) => {
      if (bar.date < startDate) return;
      if (bar.open != null && bar.high != null && bar.low != null && bar.close != null) {
        candles.push({ x: toTimestamp(bar.date), o: bar.open * multiplier, h: bar.high * multiplier, l: bar.low * multiplier, c: bar.close * multiplier });
      } else if (bar.close != null) {
        const value = bar.close * multiplier;
        candles.push({ x: toTimestamp(bar.date), o: value, h: value, l: value, c: value });
      }
      if (bar.volume != null) volumes.push({ x: toTimestamp(bar.date), y: bar.volume });
    });

    if (candles.length < 2) {
      wrap.style.display = "none";
      empty.style.display = "block";
      if (titleElement) titleElement.innerHTML = "";
      return;
    }
    wrap.style.display = "";
    empty.style.display = "none";

    const up = stock.change ? stock.change.percent >= 0 : true;
    if (titleElement) {
      titleElement.innerHTML =
        '<span class="ws-stock-chart-name">' + escapeHtml(stock.meta.name || stock.symbol) + "</span>" +
        '<span class="ws-stock-chart-symbol">' + escapeHtml(stock.symbol) + "</span>" +
        '<span class="ws-stock-chart-price">' + wallStreetFormatValue(candles[candles.length - 1].c) + "</span>" +
        '<span class="ws-stock-chart-change ' + (up ? "pos" : "neg") + '">' + (stock.change ? (up ? "&#9650;" : "&#9660;") + " " + wallStreetFormatPercent(stock.change.percent) : "—") + "</span>";
    }

    const canvasContext = canvas.getContext("2d");
    const bull = "#33ff33";
    const bear = "#ff3333";
    const currencySymbol = _WALL_STREET_CURRENCY_SYMBOL[currencyCode] || currencyCode;
    const formatTick = (value) => wallStreetFormatValue(value, undefined);

    App._charts[key] = new Chart(canvasContext, {
      type: "candlestick",
      data: {
        datasets: [
          {
            label: (stock.meta.name || stock.symbol) + " (OHLC)",
            data: candles,
            // NOTE: chartjs-chart-financial maps close<open to `up` and close>open to
            // `down`, so the colors are assigned swapped to keep green=up / red=down.
            backgroundColors: { up: bear, down: bull, unchanged: "#999999" },
            borderColors: { up: bear, down: bull, unchanged: "#999999" },
          },
          {
            type: "bar",
            label: "VOLUME",
            data: volumes,
            yAxisID: "yVolume",
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
              label: (tooltipItem) => {
                if (tooltipItem.datasetIndex === 1) return null;
                const parsed = tooltipItem.parsed;
                return currencySymbol + " " + parsed.c.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
              callback: (tickValue) => formatDateShort(new Date(tickValue).toISOString().slice(0, 10)),
            },
            grid: { color: "#222222" },
          },
          y: {
            position: "left",
            ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (tickValue) => formatTick(tickValue) },
            grid: { color: "#222222" },
          },
          yVolume: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            ticks: {
              color: "#666666",
              font: { family: "'Share Tech Mono', monospace", size: 9 },
              maxTicksLimit: 4,
              callback: (tickValue) => (tickValue >= 1e6 ? (tickValue / 1e6).toFixed(1) + "M" : tickValue >= 1e3 ? (tickValue / 1e3).toFixed(0) + "K" : tickValue),
            },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  },

  _wallStreetRenderMetals(order, data, metaBySymbol, startDate, usdPerUnit) {
    this._wallStreetNormalizedChart("wsMetal", "ws-metal-chart-wrap", "ws-metal-chart", "ws-metal-chart-empty", order, data, metaBySymbol, startDate, (symbol) => _WALL_STREET_METAL_COLORS[symbol], usdPerUnit);
  },

  _wallStreetRenderCryptoChart(order, data, metaBySymbol, startDate, usdPerUnit) {
    this._wallStreetNormalizedChart("wsCrypto", "ws-crypto-chart-wrap", "ws-crypto-chart", "ws-crypto-chart-empty", order, data, metaBySymbol, startDate, (symbol) => {
      const position = order.indexOf(symbol);
      return _WALL_STREET_CRYPTO_COLORS[position % _WALL_STREET_CRYPTO_COLORS.length];
    }, usdPerUnit, _wallStreetCryptoLogScale);
  },

  _wallStreetNormalizedChart(cacheKey, wrapId, canvasId, emptyId, order, data, metaBySymbol, startDate, vividColorOf, usdPerUnit, logScale) {
    const wrap = document.getElementById(wrapId);
    const canvas = document.getElementById(canvasId);
    const empty = document.getElementById(emptyId);
    if (!wrap || !canvas || !empty) return;

    if (App._charts[cacheKey]) {
      try { App._charts[cacheKey].destroy(); } catch (error) {}
      delete App._charts[cacheKey];
    }

    const normalized = wallStreetNormalizeSeries(data, order, startDate);
    if (normalized.symbols.length < 2) {
      wrap.style.display = "none";
      empty.style.display = "block";
      return;
    }
    wrap.style.display = "";
    empty.style.display = "none";

    const colorOf = (symbol) => vividColorOf(symbol) || _WALL_STREET_FADED_COLOR;
    const weightMultiplier = _WALL_STREET_METAL_WEIGHTS[_wallStreetMetalWeight].multiplier;
    const scales = {};
    const scaleOf = (symbol) => {
      if (scales[symbol] != null) return scales[symbol];
      const meta = metaBySymbol[symbol] || {};
      const assetClass = meta.class;
      let from = "USD";
      if (assetClass === "metal") from = "USD";
      else if (assetClass === "index") from = _WALL_STREET_INDEX_CURRENCY[symbol] || "USD";
      else if (assetClass === "stock") {
        from = wallStreetStockCurrency(symbol);
      }
      const scale = wallStreetCurrencyScale(usdPerUnit, from, _wallStreetCurrency);
      scales[symbol] = scale == null ? 1 : scale;
      return scales[symbol];
    };
    const realData = {};
    const lastClose = {};
    normalized.symbols.forEach((symbol) => (realData[symbol] = []));
    normalized.dates.forEach((date) => {
      normalized.symbols.forEach((symbol) => {
        const bars = data[symbol] || [];
        let value = lastClose[symbol];
        for (let i = 0; i < bars.length; i++) {
          if (bars[i].date > date) break;
          if (bars[i].close != null) value = bars[i].close;
        }
        lastClose[symbol] = value;
        const assetClass = (metaBySymbol[symbol] || {}).class;
        let displayValue = value;
        if (value != null) {
          displayValue = value * scaleOf(symbol);
          if (assetClass === "metal") displayValue *= weightMultiplier;
        }
        realData[symbol].push(displayValue);
      });
    });

    App._charts[cacheKey] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: normalized.dates,
        datasets: normalized.symbols.map((symbol) => ({
          label: (metaBySymbol[symbol] && metaBySymbol[symbol].name) || symbol,
          data: normalized.series[symbol],
          borderColor: colorOf(symbol),
          backgroundColor: "transparent",
          borderWidth: 1.8,
          pointRadius: 0,
          pointStyle: "circle",
          pointBackgroundColor: colorOf(symbol),
          pointBorderColor: colorOf(symbol),
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
              label: (tooltipItem) => {
                const symbol = normalized.symbols[tooltipItem.datasetIndex];
                const assetClass = (metaBySymbol[symbol] || {}).class;
                const realValue = realData[symbol][tooltipItem.dataIndex];
                const percentText = tooltipItem.parsed.y.toFixed(2) + "%";
                if (realValue == null || !isFinite(realValue)) return tooltipItem.dataset.label + ": " + percentText;
                const currencySymbol = assetClass === "metal" ? _wallStreetCurrency : _WALL_STREET_CURRENCY_SYMBOL[_wallStreetCurrency] || _wallStreetCurrency;
                const valueText = assetClass === "metal"
                  ? _wallStreetCurrency + " " + wallStreetFormatValue(realValue, 2) + " per " + _wallStreetWeightShortLabel(_wallStreetMetalWeight)
                  : currencySymbol + " " + wallStreetFormatValue(realValue, undefined);
                return tooltipItem.dataset.label + ": " + valueText + " (" + percentText + ")";
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
              callback: (tickIndex) => formatDateShort(normalized.dates[tickIndex]),
            },
            grid: { color: "#222222" },
          },
          y: logScale
            ? {
                type: "logarithmic",
                ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (tickValue) => tickValue.toFixed(1) },
                grid: { color: "#222222" },
              }
            : { ticks: { color: "#999999", font: { family: "'Share Tech Mono', monospace", size: 10 }, callback: (tickValue) => tickValue.toFixed(1) }, grid: { color: "#222222" } },
        },
      },
    });

    const legendElement = wrap.querySelector(".ws-norm-legend");
    if (legendElement) {
      legendElement.innerHTML = "";
      normalized.symbols.forEach((symbol, i) => {
        const row = document.createElement("div");
        row.className = "ws-norm-legend-item";
        row.innerHTML =
          '<span class="ws-norm-legend-swatch" style="background:' + colorOf(symbol) + '"></span>' +
          '<span class="ws-norm-legend-label">' + escapeHtml((metaBySymbol[symbol] && metaBySymbol[symbol].name) || symbol) + "</span>";
        row.onclick = () => {
          const chart = App._charts[cacheKey];
          if (!chart) return;
          const dataset = chart.data.datasets[i];
          dataset.hidden = !dataset.hidden;
          chart.update();
          row.classList.toggle("off", !!dataset.hidden);
        };
        legendElement.appendChild(row);
      });
    }
  },
});

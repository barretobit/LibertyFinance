/* ===== Utility Functions ===== */

const CURRENCIES = [
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' }
];

function formatCurrency(amount, currencyCode = 'CHF') {
  const c = CURRENCIES.find(c => c.code === currencyCode) || CURRENCIES[0];
  if (currencyCode === 'JPY') {
    return c.symbol + Math.round(amount).toLocaleString();
  }
  return c.symbol + ' ' + amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _rateFromEntries(entries, fromCurrency, toCurrency, date) {
  if (!fromCurrency || fromCurrency === toCurrency) return 1;
  const sorted = entries
    .filter(e => e.date && e.rates && e.rates[fromCurrency] != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return 1;
  let best = null;
  for (const e of sorted) {
    if (e.date <= (date || '')) best = e;
    else break;
  }
  return best ? best.rates[fromCurrency] : sorted[0].rates[fromCurrency];
}

// Convert an amount in `fromCurrency` to `toCurrency` on `date` using stored rates
function currencyRateTo(rateEntries, fromCurrency, toCurrency, date) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return 1;
  const a = _rateFromEntries(rateEntries, fromCurrency, toCurrency, date);
  const b = _rateFromEntries(rateEntries, toCurrency, fromCurrency, date);
  return a / b;
}

async function lookupRate(fromCurrency, toCurrency, date) {
  return _rateFromEntries(await DB.getAll('exchangeRates'), fromCurrency, toCurrency, date);
}

async function convertAmount(amount, fromCurrency, toCurrency, date) {
  if (amount == null || amount === 0 || !fromCurrency || fromCurrency === toCurrency) return Number(amount) || 0;
  const rate = await lookupRate(fromCurrency, toCurrency, date);
  return Number(amount) * rate;
}

async function formatConverted(amount, fromCurrency, toCurrency, date) {
  return formatCurrency(await convertAmount(amount, fromCurrency, toCurrency, date), toCurrency);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function nowISO() {
  return new Date().toISOString();
}

function pluralize(n, word) {
  return n + ' ' + (n === 1 ? word : word + 's');
}

function isPositivePL(val) {
  return val >= 0;
}

function plClass(val) {
  return val >= 0 ? 'pos' : 'neg';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatNumber(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

/* ===== Tangible Assets ===== */

function assetYearsElapsed(asset, date) {
  if (!asset || !asset.purchaseDate) return 0;
  const start = new Date(asset.purchaseDate + 'T00:00:00');
  const end = date ? new Date(date + 'T00:00:00') : new Date();
  const ms = end - start;
  if (ms <= 0) return 0;
  return ms / (365.25 * 86400000);
}

// Straight-line depreciation: current = purchase × max(0, 1 − (pct/100) × years)
function assetCurrentValue(asset, date) {
  if (!asset || asset.sold) return 0;
  const purchaseValue = parseFloat(asset.purchaseValue) || 0;
  const pct = parseFloat(asset.depreciationPct) || 0;
  const years = assetYearsElapsed(asset, date);
  return purchaseValue * Math.max(0, 1 - (pct / 100) * years);
}

function assetCostValue(asset) {
  return asset ? (parseFloat(asset.purchaseValue) || 0) : 0;
}

function assetRealizedPL(asset) {
  if (!asset || !asset.sold) return null;
  return (parseFloat(asset.saleValue) || 0) - (parseFloat(asset.purchaseValue) || 0);
}

function assetAccountMetrics(assets, date, rateFor) {
  let value = 0;
  let cost = 0;
  let count = 0;
  let soldCount = 0;
  let realized = 0;
  (assets || []).forEach(a => {
    const r = rateFor ? rateFor(a.currency || 'CHF', date) : 1;
    if (a.sold) {
      soldCount++;
      realized += (assetRealizedPL(a) || 0) * r;
      return;
    }
    count++;
    value += assetCurrentValue(a, date) * r;
    cost += assetCostValue(a) * r;
  });
  return { value, cost, count, soldCount, realized, pl: value - cost };
}

/* ===== Accent color helpers =====
 *
 * The app's theme color is user-selectable and stored in the --accent CSS
 * variable. These helpers read the live value so charts and inline styles
 * follow the chosen accent instead of hardcoded green.
 */

const DEFAULT_ACCENT = '#33ff33';

function readAccent() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '').trim();
  const n = parseInt(h.match(/^[0-9a-fA-F]{6}$/) ? h : '33ff33', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Derived accent variants: darken by `factor` for --accent-dim, or keep the
// color and add an alpha channel for --accent-glow / chart fills.
function shadeAccent(hex, factor, alpha) {
  const { r, g, b } = hexToRgb(hex);
  if (alpha != null) return 'rgba(' + Math.round(r * factor) + ',' + Math.round(g * factor) + ',' + Math.round(b * factor) + ',' + alpha + ')';
  const hx = (c) => Math.round(c * factor).toString(16).padStart(2, '0');
  return '#' + hx(r) + hx(g) + hx(b);
}

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

/* ===== Exchange Rates =====
 *
 * market.json stores every rate against CHF ("1 unit of the currency = rate CHF"),
 * whatever a profile's main currency is, so profiles can safely share the file.
 */

const RATE_BASE_CURRENCY = 'CHF';

// CHF value of one unit of `currency` on `date`: the latest stored rate on or
// before that date, else the earliest stored one. Null when the currency has no rate at all.
function chfPerUnit(rateEntries, currency, date) {
  if (currency === RATE_BASE_CURRENCY) return 1;
  let latestOnOrBefore = null;
  let earliest = null;
  (rateEntries || []).forEach(entry => {
    if (!entry || !entry.date || !entry.rates || entry.rates[currency] == null) return;
    if (!earliest || entry.date < earliest.date) earliest = entry;
    if (entry.date <= (date || '') && (!latestOnOrBefore || entry.date > latestOnOrBefore.date)) latestOnOrBefore = entry;
  });
  const best = latestOnOrBefore || earliest;
  return best ? best.rates[currency] : null;
}

// Factor that converts an amount in `fromCurrency` into `toCurrency` on `date`.
// A currency without any stored rate counts 1:1; currenciesWithoutRate() lets pages warn about it.
function currencyRateTo(rateEntries, fromCurrency, toCurrency, date) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return 1;
  const fromInChf = chfPerUnit(rateEntries, fromCurrency, date);
  const toInChf = chfPerUnit(rateEntries, toCurrency, date);
  if (fromInChf == null || toInChf == null) return 1;
  return fromInChf / toInChf;
}

// The given currencies that have no stored rate at all, sorted
function currenciesWithoutRate(rateEntries, currencies) {
  return [...new Set(currencies)].filter(currency => currency && chfPerUnit(rateEntries, currency, todayStr()) == null).sort();
}

// True for a calendar date in the app's storage format, YYYY-MM-DD
function isIsoDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text || '');
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

// "1 ASSET", "0 ASSETS", "2 accounts": the plural "s" follows the word's case
function pluralize(count, word) {
  if (count === 1) return count + ' ' + word;
  return count + ' ' + word + (word === word.toUpperCase() ? 'S' : 's');
}

function plClass(value) {
  return value >= 0 ? 'pos' : 'neg';
}

// "+CHF 12.00" / "-CHF 12.00": the sign shown on gains too
function signedCurrency(amount, currency) {
  return (amount >= 0 ? '+' : '') + formatCurrency(amount, currency);
}

// "+1.25%" / "-1.25%"
function signedPercent(value, decimals) {
  return (value >= 0 ? '+' : '') + value.toFixed(decimals) + '%';
}

// Safe for element content and for quoted attribute values (quotes escaped too).
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

/* ===== Tangible Assets & Real Estate ===== */

function isRealEstateAsset(asset) {
  return asset.accountType === 'Real Estate' || asset.assetType === 'Real Estate';
}

// Owned share of the asset as a fraction. A missing value means 100%; 0% stays 0%.
function assetOwnershipShare(asset) {
  const percent = parseFloat(asset.ownershipPct);
  return (isNaN(percent) ? 100 : percent) / 100;
}

// Latest dated entry ({ date: 'YYYY-MM-DD', ... }) on or before `date`, or null
function latestEntryOnOrBefore(entries, date) {
  return (entries || [])
    .filter(entry => entry && entry.date && entry.date <= date)
    .reduce((latest, entry) => (!latest || entry.date > latest.date ? entry : latest), null);
}

// Mortgage still owed on `date` (no date: today), full amount; only Real Estate
// carries one. The latest dated balance on or before the date, else the mortgage
// entered at purchase (asset.debt).
function assetMortgage(asset, date) {
  if (!isRealEstateAsset(asset)) return 0;
  const balance = latestEntryOnOrBefore(asset.mortgageBalances, date || todayStr());
  return parseFloat(balance ? balance.amount : asset.debt) || 0;
}

// True once the asset is sold on `date` (no date: today)
function isAssetSoldOn(asset, date) {
  return !!asset.sold && (!asset.saleDate || !date || date >= asset.saleDate);
}

function yearsBetween(startDate, endDate) {
  if (!startDate) return 0;
  const start = new Date(startDate + 'T00:00:00');
  const end = endDate ? new Date(endDate + 'T00:00:00') : new Date();
  const milliseconds = end - start;
  if (milliseconds <= 0) return 0;
  return milliseconds / (365.25 * 86400000);
}

// Full value of the asset on `date`: 100% ownership, mortgage not deducted.
// Straight-line depreciation from a starting point: value × max(0, 1 − (percent/100) × years).
// Real Estate starts from its latest valuation on or before the date when there
// is one; everything else (and Real Estate before its first valuation) starts
// from the purchase value at the purchase date.
function assetFullValue(asset, date) {
  const onDate = date || todayStr();
  const valuation = isRealEstateAsset(asset) ? latestEntryOnOrBefore(asset.valuations, onDate) : null;
  const startValue = valuation ? parseFloat(valuation.value) || 0 : parseFloat(asset.purchaseValue) || 0;
  const startDate = valuation ? valuation.date : asset.purchaseDate;
  const depreciationPercent = parseFloat(asset.depreciationPct) || 0;
  return startValue * Math.max(0, 1 - (depreciationPercent / 100) * yearsBetween(startDate, onDate));
}

// Owned value on `date`: the owned share of the full value, net of the mortgage.
// Zero before the purchase date and from the sale date on.
function assetCurrentValue(asset, date) {
  if (!asset || isAssetSoldOn(asset, date)) return 0;
  if (asset.purchaseDate && date && date < asset.purchaseDate) return 0;
  return (assetFullValue(asset, date) - assetMortgage(asset, date)) * assetOwnershipShare(asset);
}

function assetCostValue(asset) {
  return asset ? (parseFloat(asset.purchaseValue) || 0) : 0;
}

// Owned cost basis on `date`: the owned share of the purchase price net of the
// mortgage still owed then. Repaying the mortgage is capital put in, so the
// cost rises with it and P&L stays the change in the property's value.
function assetOwnedCost(asset, date) {
  return (assetCostValue(asset) - assetMortgage(asset, date)) * assetOwnershipShare(asset);
}

// Realized profit or loss on the owned share, once sold
function assetRealizedPL(asset) {
  if (!asset || !asset.sold) return null;
  return ((parseFloat(asset.saleValue) || 0) - assetCostValue(asset)) * assetOwnershipShare(asset);
}

function assetAccountMetrics(assets, date, rateFor) {
  let value = 0;
  let cost = 0;
  let count = 0;
  let soldCount = 0;
  let realized = 0;
  (assets || []).forEach(asset => {
    const rate = rateFor ? rateFor(asset.currency || 'CHF', date) : 1;
    if (isAssetSoldOn(asset, date)) {
      soldCount++;
      realized += (assetRealizedPL(asset) || 0) * rate;
      return;
    }
    if (asset.purchaseDate && date && date < asset.purchaseDate) return;
    count++;
    value += assetCurrentValue(asset, date) * rate;
    cost += assetOwnedCost(asset, date) * rate;
  });
  return { value, cost, count, soldCount, realized, pl: value - cost };
}

/* ===== Precious Metals ===== */

const METAL_SYMBOLS = { Gold: 'XAU', Silver: 'XAG', Platinum: 'XPT', Palladium: 'XPD' };

// Live spot price per gram for a metal type, expressed in `toCurrency`, or null when no snapshot / rate available
function metalSpotPerGram(metalEntry, metalType, toCurrency, rateEntries, date) {
  const symbol = METAL_SYMBOLS[metalType];
  const p = symbol && metalEntry && metalEntry.prices ? metalEntry.prices[symbol] : null;
  if (!p || p.chfPerGram == null) return null;
  const rate = currencyRateTo(rateEntries || [], 'CHF', toCurrency || 'CHF', date || todayStr());
  return p.chfPerGram * rate;
}

// Current value of a precious-metal account: quantity x live spot (market.json), fallback to last trade price
function metalAccountValue(account, metalEntry, rateEntries, date) {
  const spot = metalSpotPerGram(metalEntry, account.metalType, account.currency || 'CHF', rateEntries, date);
  const price = spot != null ? spot : (account.pricePerGram || 0);
  return (account.quantity || 0) * price;
}

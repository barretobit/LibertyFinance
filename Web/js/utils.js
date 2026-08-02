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

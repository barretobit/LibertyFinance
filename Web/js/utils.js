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

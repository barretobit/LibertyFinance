/* ===== Page Renderers ===== */

// Tint a hex color: amount in [-1, 1], negative darkens, positive lightens
function tintColor(hex, amount) {
  const value = parseInt(hex.slice(1), 16);
  let red = (value >> 16) & 255;
  let green = (value >> 8) & 255;
  let blue = value & 255;
  if (amount >= 0) {
    red = Math.round(red + (255 - red) * amount);
    green = Math.round(green + (255 - green) * amount);
    blue = Math.round(blue + (255 - blue) * amount);
  } else {
    const factor = 1 + amount;
    red = Math.round(red * factor);
    green = Math.round(green * factor);
    blue = Math.round(blue * factor);
  }
  return 'rgb(' + red + ',' + green + ',' + blue + ')';
}

// Badge text of a transaction in history tables
function transactionTypeLabel(transaction) {
  if (transaction.type === 'asset-add') return 'ASSET ADDED';
  if (transaction.type === 'asset-sell') return 'ASSET SOLD';
  if (isOpeningValuation(transaction)) return 'OPENING VALUATION';
  return escapeHtml(String(transaction.type || '').toUpperCase());
}

// Badge style of a transaction: money in, money out, opening or valuation
function transactionBadgeClass(transaction) {
  if (isOpeningValuation(transaction)) return 'opening';
  if (['deposit', 'buy', 'asset-add'].includes(transaction.type)) return 'deposit';
  if (['withdrawal', 'sell', 'asset-sell'].includes(transaction.type)) return 'withdrawal';
  return 'valuation';
}

const Pages = {};

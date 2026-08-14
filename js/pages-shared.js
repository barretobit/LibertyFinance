/* ===== Page Renderers ===== */

// Tint a hex color: amt in [-1, 1] → negative darkens, positive lightens
function _shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
  } else {
    const f = 1 + amt;
    r = Math.round(r * f);
    g = Math.round(g * f);
    b = Math.round(b * f);
  }
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function _effValue(transactions, fallback) {
  const txs = transactions.filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return txs.length > 0 ? (txs[txs.length - 1].balanceAfter || 0) : (fallback || 0);
}

function _effCostBasis(transactions) {
  // Precious metals: average-cost basis across buys/sells
  const metalTxs = transactions.filter(t => t.type === 'buy' || t.type === 'sell');
  if (metalTxs.length > 0) {
    let spent = 0;
    let qty = 0;
    const sorted = [...metalTxs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    sorted.forEach(t => {
      if (t.type === 'buy') {
        spent += Math.abs(t.amount || 0);
        qty += Math.abs(t.quantity || 0);
      } else {
        const sold = Math.abs(t.quantity || 0);
        if (qty > 0) {
          spent = Math.max(0, spent - (spent / qty) * sold);
          qty = Math.max(0, qty - sold);
        }
      }
    });
    return spent;
  }

  let basis = 0;
  let hasFlow = false;
  transactions.forEach(t => {
    if (t.type === 'deposit') { basis += Math.abs(t.amount); hasFlow = true; }
    if (t.type === 'withdrawal') { basis -= Math.abs(t.amount); hasFlow = true; }
  });
  if (!hasFlow) {
    const vals = [...transactions].filter(t => t.type === 'valuation')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (vals.length > 0) basis = vals[0].amount || 0;
  }
  return basis;
}

const Pages = {};
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

const Pages = {

  // ==================== DASHBOARD ====================

  async dashboard() {
    Object.values(App._charts).forEach(c => { try { c.destroy(); } catch(e) {} });
    App._charts = {};

    const accounts = await DB.getAll('accounts');
    const portfolios = await DB.getAll('portfolios');
    const transactions = await DB.getAll('transactions');
    const custodians = await DB.getAll('custodians');
    const assets = await DB.getAll('assets');

    const custodianMap = {};
    custodians.forEach(c => custodianMap[c.id] = c.name);

    const accountAssets = {};
    assets.forEach(a => {
      if (!accountAssets[a.accountId]) accountAssets[a.accountId] = [];
      accountAssets[a.accountId].push(a);
    });

    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const metalEntry = await DB.getMetalPricesForDate(todayStr());
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const accCurrency = {};
    accounts.forEach(a => accCurrency[a.id] = a.currency || 'CHF');

    // Total value — use latest transaction balance per account
    const accTxs = {};
    transactions.filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
      .forEach(t => {
        const prev = accTxs[t.accountId];
        if (!prev || (t.date || '') > (prev.date || '')) accTxs[t.accountId] = t;
      });

    let totalValue = 0;
    const pfValues = {};
    portfolios.forEach(p => pfValues[p.id] = { name: p.name, value: 0 });

    accounts.forEach(a => {
      let latest = accTxs[a.id];
      let v = latest ? (latest.balanceAfter || 0) : (a.currentValue || 0);
      let vDate = latest ? latest.date : todayStr();
      if (a.accountType === 'Tangible Asset') {
        const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
        v = assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc).value;
        vDate = todayStr();
      }
      if (a.accountType === 'Precious Metal') {
        v = metalAccountValue(a, metalEntry, rateEntries, todayStr());
        vDate = todayStr();
      }
      if (a.includeInNetWorth !== false) {
        const vm = v * rateFor(accCurrency[a.id], vDate);
        totalValue += vm;
        if (pfValues[a.portfolioId]) pfValues[a.portfolioId].value += vm;
      }
    });

    document.getElementById('dash-total-value').textContent = formatCurrency(totalValue, mainCurrency);

    // Liquid Net Worth = included accounts minus Pillars portfolio (id=3), filtered by includeInLiquidNetWorth
    let liqTotal = 0;
    accounts.forEach(a => {
      const latest = accTxs[a.id];
      const v = latest ? (latest.balanceAfter || 0) : (a.currentValue || 0);
      if (a.includeInLiquidNetWorth !== false && a.portfolioId != 3) {
        if (a.accountType === 'Tangible Asset') {
          const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
          liqTotal += assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc).value * rateFor(accCurrency[a.id], todayStr());
        } else if (a.accountType === 'Precious Metal') {
          liqTotal += metalAccountValue(a, metalEntry, rateEntries, todayStr()) * rateFor(accCurrency[a.id], todayStr());
        } else {
          liqTotal += v * rateFor(accCurrency[a.id], latest ? latest.date : todayStr());
        }
      }
    });
    document.getElementById('dash-liquid-value').textContent = formatCurrency(liqTotal, mainCurrency);

    // Build perf-tracked month groups for performance card & chart
    const perfAccountIds = new Set(accounts.filter(a => a.trackPerformance !== false).map(a => a.id));
    const perfMonthGroups = {};
    const _perfBal = {};
    perfAccountIds.forEach(id => _perfBal[id] = 0);
    const perfTxs = transactions
      .filter(t => (t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell') && perfAccountIds.has(t.accountId))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    perfTxs.forEach(tx => {
      _perfBal[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
      const mk = (tx.date || '').substring(0, 7);
      if (!mk) return;
      let tot = 0;
      Object.values(_perfBal).forEach(b => tot += b);
      perfMonthGroups[mk] = tot;
    });
    // Investment performance calculator
    function _computePerfSince(idSet, txList, cutoffDate, currentTotal) {
      const bal = {};
      idSet.forEach(id => bal[id] = 0);
      let totalAtCutoff = 0;
      txList.forEach(tx => {
        if (tx.date >= cutoffDate) return;
        bal[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
        let t = 0;
        Object.values(bal).forEach(b => t += b);
        totalAtCutoff = t;
      });
      // Find each account's first-ever transaction
      const firstOfAccount = {};
      txList.forEach(tx => {
        const key = tx.accountId;
        if (!firstOfAccount[key] || tx.date < firstOfAccount[key].date) {
          firstOfAccount[key] = tx;
        }
      });
      let netDeposits = 0;
      txList.forEach(tx => {
        if (tx.date < cutoffDate) return;
        if (tx.type === 'deposit') netDeposits += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'withdrawal') netDeposits -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'buy') netDeposits += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'sell') netDeposits -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        // Opening valuations count as deposit (pre-existing wealth entered tracking)
        if (tx.type === 'valuation' && firstOfAccount[tx.accountId] && firstOfAccount[tx.accountId].id === tx.id) {
          netDeposits += tx.amount * rateFor(accCurrency[tx.accountId], tx.date);
        }
      });
      const abs = currentTotal - totalAtCutoff - netDeposits;
      const base = totalAtCutoff + netDeposits;
      const pct = base !== 0 ? (abs / base) * 100 : 0;
      return { abs, pct };
    }

    // Investment-only scope (Investment Account type)
    const investAccountIds = new Set(accounts.filter(a => a.accountType === 'Investment Account').map(a => a.id));
    const investTxs = perfTxs.filter(t => investAccountIds.has(t.accountId));
    const investBal = {};
    investAccountIds.forEach(id => investBal[id] = 0);
    investTxs.forEach(tx => { investBal[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date); });
    const investCurrentTotal = Object.values(investBal).reduce((s, v) => s + v, 0);
    const _invPerfSince = (cutoffDate) => _computePerfSince(investAccountIds, investTxs, cutoffDate, investCurrentTotal);

    const today = todayStr();
    const curYear = today.substring(0, 4);
    const ytdCutoff = curYear + '-01-01';
    const oneYearAgo = String(Number(curYear) - 1) + today.substring(4);
    const twoYearsAgo = String(Number(curYear) - 2) + today.substring(4);
    const threeYearsAgo = String(Number(curYear) - 3) + today.substring(4);

    // Set initial YTD
    const perfEl = document.getElementById('dash-perf-value');
    const activePerf = document.querySelector('#perf-selectors .perf-btn.active');
    const perfMap = { ytd: _invPerfSince(ytdCutoff), '1y': _invPerfSince(oneYearAgo), '2y': _invPerfSince(twoYearsAgo), '3y': _invPerfSince(threeYearsAgo), max: _invPerfSince(investTxs.length > 0 ? investTxs[0].date : today) };
    const initial = perfMap[activePerf ? activePerf.dataset.perf : 'ytd'];
    perfEl.innerHTML = (initial.abs >= 0 ? '+' : '') + formatCurrency(initial.abs, mainCurrency) + ' <span class="perf-pct">(' + (initial.pct >= 0 ? '+' : '') + initial.pct.toFixed(2) + '%)</span>';
    perfEl.style.color = initial.abs >= 0 ? '#33ff33' : '#ff3333';

    // Perf selector click handler
    document.querySelectorAll('#perf-selectors .perf-btn').forEach(btn => {
      btn.onclick = function() {
        document.querySelectorAll('#perf-selectors .perf-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        const val = perfMap[this.dataset.perf];
        perfEl.innerHTML = (val.abs >= 0 ? '+' : '') + formatCurrency(val.abs, mainCurrency) + ' <span class="perf-pct">(' + (val.pct >= 0 ? '+' : '') + val.pct.toFixed(2) + '%)</span>';
        perfEl.style.color = val.abs >= 0 ? '#33ff33' : '#ff3333';
      };
    });

    // Chart range selector click handler
    document.querySelectorAll('#chart-range-selectors .perf-btn').forEach(btn => {
      btn.onclick = function() {
        document.querySelectorAll('#chart-range-selectors .perf-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        Pages.dashboard();
      };
    });

    // Earning performance last 6 months
    const allIncomes = await DB.getAll('incomes');
    const allExpenses = await DB.getAll('expenses');
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const todayDate = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      months.push(y + '-' + m);
    }

    const earningGrid = document.getElementById('earning-perf-grid');
    const earningEmpty = document.getElementById('earning-perf-empty');
    earningGrid.innerHTML = '';

    const monthlyRoi = _monthlyPctSeries(investAccountIds, investTxs);
    let hasData = false;

    months.forEach(monthKey => {
      const year = monthKey.substring(0, 4);
      const mNum = parseInt(monthKey.substring(5, 7));
      const monthLabel = monthNames[mNum - 1] + ' ' + year;

      const monthIncome = allIncomes
        .filter(inc => inc.month === monthKey)
        .reduce((sum, inc) => sum + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || (monthKey + '-01')), 0);

      const yearExpenses = allExpenses.filter(exp => exp.year === year);
      const monthlyTot = yearExpenses
        .filter(exp => exp.type === 'monthly')
        .reduce((sum, exp) => sum + (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01')), 0);
      const yearlyTot = yearExpenses
        .filter(exp => exp.type === 'yearly')
        .reduce((sum, exp) => sum + (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01')), 0);
      const totalExpenses = monthlyTot + yearlyTot / 12;

      const expected = monthIncome - totalExpenses;

      const monthTxs = transactions.filter(tx =>
        (tx.date || '').startsWith(monthKey) &&
        (tx.type === 'deposit' || tx.type === 'withdrawal' || tx.type === 'buy' || tx.type === 'sell')
      );
      const netDeposits = monthTxs.reduce((sum, tx) => {
        if (tx.type === 'deposit') return sum + Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'withdrawal') return sum - Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'buy') return sum + Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'sell') return sum - Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        return sum;
      }, 0);

      if (monthIncome > 0 || netDeposits !== 0) hasData = true;

      let perfColor, perfText;
      if (expected > 0) {
        const pct = (netDeposits / expected) * 100;
        perfColor = pct >= 0 ? '#33ff33' : '#ff3333';
        perfText = pct.toFixed(0) + '%';
      } else {
        perfColor = '#555';
        perfText = 'N/A';
      }

      const roiVal = monthlyRoi[monthKey];
      const roiText = roiVal ? formatCurrency(roiVal.abs, mainCurrency) + ' (' + (roiVal.abs >= 0 ? '+' : '') + roiVal.pct.toFixed(2) + '%)' : 'N/A';
      const roiColor = roiVal ? (roiVal.abs >= 0 ? '#33ff33' : '#ff3333') : '#555';

      const col = document.createElement('div');
      col.className = 'col-2 mb-3';
      col.innerHTML = '<div class="earning-month">' +
        '<div class="earning-month-label">' + monthLabel + '</div>' +
        '<div class="earning-month-line"><span class="lbl">ACCESS</span><span class="val">' + formatCurrency(expected, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">VALUE</span><span class="val">' + formatCurrency(netDeposits, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">PERFORMANCE</span><span class="val" style="color:' + perfColor + '">' + perfText + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">ROI</span><span class="val" style="color:' + roiColor + '">' + roiText + '</span></div>' +
        '</div>';
      earningGrid.appendChild(col);
    });

    if (!hasData) {
      earningEmpty.style.display = 'block';
    } else {
      earningEmpty.style.display = 'none';
    }

    // Goals section
    const goals = await DB.getAll('goals');
    const { accValue, accNames } = await this._buildGoalContext();
    const goalGrid = document.getElementById('dash-goal-grid');
    const goalEmpty = document.getElementById('dash-goal-empty');
    goalGrid.innerHTML = '';

    if (goals.length === 0) {
      goalEmpty.style.display = 'block';
    } else {
      goalEmpty.style.display = 'none';
      goals.sort((a, b) =>
        ((a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity)) || (a.id - b.id)
      );
      const results = this._computeGoalWaterfall(goals, accValue);
      results.slice(0, 3).forEach(goalRes => {
        const col = document.createElement('div');
        col.className = 'col-md-4 mb-3';
        col.innerHTML = this._goalCardHtml(goalRes, accNames, true, mainCurrency);
        goalGrid.appendChild(col);
      });
    }

    // ==================== FORECAST ====================
    // Projects liquid net worth 12 months ahead using historical monthly ROI
    (function() {
      const canvas = document.getElementById('chart-forecast');
      const empty = document.getElementById('forecast-empty');
      const statsRow = document.getElementById('forecast-stats');
      if (!canvas || !empty) return;

      // Liquid Net Worth scope
      const liquidAccountIds = new Set(accounts
        .filter(a => a.includeInLiquidNetWorth !== false && a.portfolioId != 3)
        .map(a => a.id));
      const flowTypes = ['deposit', 'withdrawal', 'valuation', 'buy', 'sell', 'asset-add', 'asset-sell'];
      const liquidTxs = transactions
        .filter(t => liquidAccountIds.has(t.accountId) && flowTypes.includes(t.type))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      let liquidCurrentTotal = 0;
      accounts.forEach(a => {
        if (a.includeInLiquidNetWorth !== false && a.portfolioId != 3) {
          if (a.accountType === 'Tangible Asset') {
            const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
            liquidCurrentTotal += assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc).value * rateFor(accCurrency[a.id], todayStr());
          } else {
            const latest = accTxs[a.id];
            const v = latest ? (latest.balanceAfter || 0) : (a.currentValue || 0);
            liquidCurrentTotal += v * rateFor(accCurrency[a.id], latest ? latest.date : todayStr());
          }
        }
      });

      const bal = {};
      liquidAccountIds.forEach(id => bal[id] = 0);
      const monthTotals = {};
      liquidTxs.forEach(tx => {
        bal[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
        const mk = (tx.date || '').substring(0, 7);
        if (mk) {
          let t = 0;
          Object.values(bal).forEach(b => t += b);
          monthTotals[mk] = t;
        }
      });

      const curMonth = todayStr().substring(0, 7);
      monthTotals[curMonth] = liquidCurrentTotal;

      // Monthly ROI over liquid accounts (asset add/sell treated as flows)
      function _liquidMonthlyRoi() {
        const b = {};
        liquidAccountIds.forEach(id => b[id] = 0);
        const firstOfAccount = {};
        liquidTxs.forEach(tx => {
          const key = tx.accountId;
          if (!firstOfAccount[key] || tx.date < firstOfAccount[key].date) firstOfAccount[key] = tx;
        });
        const totalB = () => Object.values(b).reduce((s, v) => s + v, 0);
        const results = {};
        let mkActive = null;
        let startBal = 0;
        let monthFlows = 0;
        liquidTxs.forEach(tx => {
          const mk = (tx.date || '').substring(0, 7);
          if (!mk) return;
          if (mk !== mkActive) {
            if (mkActive !== null) {
              const abs = totalB() - startBal - monthFlows;
              const base = startBal + monthFlows;
              results[mkActive] = { abs, pct: base !== 0 ? (abs / base) * 100 : 0 };
            }
            mkActive = mk;
            startBal = totalB();
            monthFlows = 0;
          }
          b[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
          if (tx.type === 'deposit' || tx.type === 'buy' || tx.type === 'asset-add') {
            monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          } else if (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') {
            monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          } else if (tx.type === 'valuation' && firstOfAccount[tx.accountId] && firstOfAccount[tx.accountId].id === tx.id) {
            monthFlows += tx.amount * rateFor(accCurrency[tx.accountId], tx.date);
          }
        });
        if (mkActive !== null) {
          const abs = totalB() - startBal - monthFlows;
          const base = startBal + monthFlows;
          results[mkActive] = { abs, pct: base !== 0 ? (abs / base) * 100 : 0 };
        }
        return results;
      }

      const roi = _liquidMonthlyRoi();
      let roiMonths = Object.keys(roi).filter(m => m < curMonth).sort();
      if (roiMonths.length === 0) roiMonths = Object.keys(roi).sort();
      const rates = roiMonths.map(m => roi[m].pct / 100);

      const hasData = rates.length > 0 && liquidCurrentTotal > 0;
      if (!hasData) {
        empty.style.display = 'block';
        if (statsRow) statsRow.style.display = 'none';
        if (canvas) {
          canvas.style.display = 'none';
          if (canvas.parentElement) canvas.parentElement.style.display = 'none';
        }
        return;
      }
      empty.style.display = 'none';
      if (statsRow) statsRow.style.display = '';
      if (canvas) {
        canvas.style.display = '';
        if (canvas.parentElement) canvas.parentElement.style.display = '';
      }

      const mean = rates.reduce((s, v) => s + v, 0) / rates.length;
      const variance = rates.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rates.length;
      const stdev = Math.sqrt(variance);

      const histKeys = Object.keys(monthTotals).filter(m => m <= curMonth).sort().slice(-12);
      const labels = [];
      const histVals = [];
      const pessVals = [];
      const neutralVals = [];
      const optVals = [];
      histKeys.forEach(mk => {
        labels.push(mk);
        histVals.push(monthTotals[mk]);
        pessVals.push(null);
        neutralVals.push(null);
        optVals.push(null);
      });

      const anchorIdx = histKeys.indexOf(curMonth);
      const anchorVal = monthTotals[curMonth] || liquidCurrentTotal;
      if (anchorIdx >= 0) {
        pessVals[anchorIdx] = anchorVal;
        neutralVals[anchorIdx] = anchorVal;
        optVals[anchorIdx] = anchorVal;
      }

      const now = new Date();
      const baseYear = now.getFullYear();
      const baseMonth = now.getMonth();
      let nRun = anchorVal;
      let pRun = anchorVal;
      let oRun = anchorVal;
      for (let m = 1; m <= 12; m++) {
        const d = new Date(baseYear, baseMonth + m, 1);
        const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        labels.push(mk);
        histVals.push(null);
        nRun *= (1 + mean);
        pRun *= (1 + mean - stdev);
        oRun *= (1 + mean + stdev);
        pessVals.push(Math.max(0, pRun));
        neutralVals.push(nRun);
        optVals.push(oRun);
      }
      const projectedValue = nRun;

      const growthAmt = projectedValue - anchorVal;
      const growthPct = anchorVal > 0 ? (growthAmt / anchorVal) * 100 : 0;

      document.getElementById('forecast-current').textContent = formatCurrency(anchorVal, mainCurrency);
      document.getElementById('forecast-projected').textContent = formatCurrency(projectedValue, mainCurrency);
      const growthEl = document.getElementById('forecast-growth');
      growthEl.innerHTML = (growthAmt >= 0 ? '+' : '') + formatCurrency(growthAmt, mainCurrency) + ' <span class="perf-pct">(' + (growthPct >= 0 ? '+' : '') + growthPct.toFixed(2) + '%)</span>';
      growthEl.className = 'stat-value forecast-stat ' + (growthAmt >= 0 ? 'pos' : 'neg');
      const roiEl = document.getElementById('forecast-roi');
      roiEl.innerHTML = (mean >= 0 ? '+' : '') + (mean * 100).toFixed(2) + '% <span class="perf-pct">+/&minus;' + (stdev * 100).toFixed(2) + '%</span>';
      roiEl.className = 'stat-value forecast-stat ' + (mean >= 0 ? 'pos' : 'neg');

      App._charts.forecast = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'HISTORY',
              data: histVals,
              borderColor: '#33ff33',
              backgroundColor: '#33ff330d',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#33ff33',
              borderWidth: 2
            },
            {
              label: 'PESSIMISTIC',
              data: pessVals,
              borderColor: '#ff3333',
              backgroundColor: '#ff33330d',
              borderDash: [6, 4],
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#ff3333',
              borderWidth: 2,
              fill: false
            },
            {
              label: 'NEUTRAL',
              data: neutralVals,
              borderColor: '#33ccff',
              backgroundColor: '#33ccff0d',
              borderDash: [6, 4],
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#33ccff',
              borderWidth: 2,
              fill: false
            },
            {
              label: 'OPTIMISTIC',
              data: optVals,
              borderColor: '#ffaa00',
              backgroundColor: '#ffaa000d',
              borderDash: [6, 4],
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#ffaa00',
              borderWidth: 2,
              fill: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                color: '#d0d0d0',
                font: { family: "'Share Tech Mono', monospace", size: 10 },
                padding: 8
              }
            },
            tooltip: {
              callbacks: {
                title: items => {
                  const mk = items && items.length ? items[0].label : '';
                  const d = new Date(mk + '-01');
                  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
                }
              }
            }
          },
          scales: {
            x: {
              ticks: {
                color: '#888',
                font: { size: 10, family: "'Share Tech Mono', monospace" },
                callback: v => {
                  const d = new Date(labels[v] + '-01');
                  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
                }
              },
              grid: { color: '#222' }
            },
            y: {
              ticks: {
                color: '#888',
                font: { size: 10, family: "'Share Tech Mono', monospace" },
                callback: v => formatCurrency(v, mainCurrency)
              },
              grid: { color: '#222' }
            }
          }
        }
      });
    })();

    // Portfolio allocation chart (doughnut)
    const allocCanvas = document.getElementById('chart-allocation');
    if (allocCanvas) {
      const labels = [];
      const values = [];
      const colors = [];
      const palette = ['#33ff33', '#33ccff', '#ffaa00', '#ff6633', '#cc33ff', '#33ffcc', '#ff3388'];
      let ci = 0;
      Object.values(pfValues).forEach(p => {
        if (p.value > 0) {
          const pct = totalValue > 0 ? Math.round(p.value / totalValue * 100) : 0;
          labels.push(p.name + ' (' + pct + '%)');
          values.push(p.value);
          colors.push(palette[ci % palette.length]);
          ci++;
        }
      });
      if (values.length === 0) {
        labels.push('NO DATA');
        values.push(1);
        colors.push('#333333');
      }
      App._charts.allocation = new Chart(allocCanvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#161616', borderWidth: 2 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#d0d0d0', font: { family: "'Share Tech Mono', monospace", size: 10 }, padding: 8 }
            }
          }
        }
      });
    }

    // Range line chart — shared renderer for Performance Over Time & Investment Performance
    function _renderRangeChart(canvas, chartKey, idSet, txList, range, color, opts) {
      const isPercent = opts && opts.percent;

      const accBalances = {};
      idSet.forEach(id => accBalances[id] = 0);

      // Group by month — record total after last tx in each month
      const monthGroups = {};
      txList.forEach(tx => {
        accBalances[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
        const monthKey = (tx.date || '').substring(0, 7);
        if (!monthKey) return;
        let total = 0;
        Object.values(accBalances).forEach(b => total += b);
        monthGroups[monthKey] = total; // overwrites with last value of the month
      });

      let points = Object.entries(monthGroups).map(([month, value]) => ({ month, value }));

      // add current snapshot
      const curMonth = todayStr().substring(0, 7);
      const currentTotal = Object.values(accBalances).reduce((s, v) => s + v, 0);
      if (!monthGroups[curMonth] && currentTotal > 0) {
        points.push({ month: curMonth, value: currentTotal });
      }

      // filter by range
      if (points.length > 0) {
        const latest = points.reduce((a, b) => a.month > b.month ? a : b).month;
        let cutoffStr;
        if (range === 'ytd') {
          cutoffStr = todayStr().substring(0, 4) + '-01';
        } else if (range === 'max') {
          cutoffStr = '';
        } else {
          const years = parseInt(range.replace('y', '')) || 1;
          const latestDate = new Date(latest + '-01');
          const cutoff = new Date(latestDate);
          cutoff.setFullYear(cutoff.getFullYear() - years);
          cutoffStr = cutoff.toISOString().substring(0, 7);
        }
        if (cutoffStr) points = points.filter(p => p.month >= cutoffStr);
      }

      points.sort((a, b) => a.month.localeCompare(b.month));

      if (points.length === 0) {
        points.push({ month: curMonth, value: currentTotal || 0 });
      }

      const labels = points.map(p => {
        const d = new Date(p.month + '-01');
        return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
      });

      let values;
      if (isPercent) {
        const monthly = _monthlyPctSeries(idSet, txList);
        values = points.map(p => monthly[p.month] != null ? monthly[p.month].pct : 0);
      } else {
        values = points.map(p => p.value);
      }

      App._charts[chartKey] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: isPercent ? 'MONTHLY P/L %' : 'TOTAL VALUE',
            data: values,
            borderColor: color,
            backgroundColor: color + '0d',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            pointBackgroundColor: color,
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              ticks: { color: '#888', font: { size: 10, family: "'Share Tech Mono', monospace" } },
              grid: { color: '#222' }
            },
            y: {
              ticks: { color: '#888', font: { size: 10, family: "'Share Tech Mono', monospace" }, callback: v => isPercent ? v.toFixed(2) + '%' : formatCurrency(v, mainCurrency) },
              grid: { color: '#222' }
            }
          }
        }
      });
    }

    // Per-month unrealized P/L for a set of accounts (one value per month, non-cumulative)
    function _monthlyPctSeries(idSet, txList) {
      const bal = {};
      idSet.forEach(id => bal[id] = 0);
      const firstOfAccount = {};
      txList.forEach(tx => {
        const key = tx.accountId;
        if (!firstOfAccount[key] || tx.date < firstOfAccount[key].date) firstOfAccount[key] = tx;
      });
      const totalBal = () => Object.values(bal).reduce((s, v) => s + v, 0);
      const results = {};
      let curMonth = null;
      let startBal = 0;
      let monthFlows = 0;
      txList.forEach(tx => {
        const mk = (tx.date || '').substring(0, 7);
        if (!mk) return;
        if (mk !== curMonth) {
          if (curMonth !== null) {
            const abs = totalBal() - startBal - monthFlows;
            const base = startBal + monthFlows;
            results[curMonth] = { abs, pct: base !== 0 ? (abs / base) * 100 : 0 };
          }
          curMonth = mk;
          startBal = totalBal();
          monthFlows = 0;
        }
        bal[tx.accountId] = (tx.balanceAfter || 0) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'deposit') monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'withdrawal') monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'buy') monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'sell') monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'valuation' && firstOfAccount[tx.accountId] && firstOfAccount[tx.accountId].id === tx.id) {
          monthFlows += tx.amount * rateFor(accCurrency[tx.accountId], tx.date);
        }
      });
      if (curMonth !== null) {
        const abs = totalBal() - startBal - monthFlows;
        const base = startBal + monthFlows;
        results[curMonth] = { abs, pct: base !== 0 ? (abs / base) * 100 : 0 };
      }
      return results;
    }

    // Performance chart (line) — one dot per month, end-of-month value
    const perfCanvas = document.getElementById('chart-performance');
    if (perfCanvas) {
      const activeRange = document.querySelector('#chart-range-selectors .perf-btn.active');
      const range = activeRange ? activeRange.dataset.range : '1y';
      _renderRangeChart(perfCanvas, 'performance', perfAccountIds, perfTxs, range, '#33ff33');
    }

    // Investment Performance chart (line) — same range selector, investments only, in %
    const investCanvas = document.getElementById('chart-investment');
    if (investCanvas) {
      const activeRange = document.querySelector('#chart-range-selectors .perf-btn.active');
      const range = activeRange ? activeRange.dataset.range : '1y';
      _renderRangeChart(investCanvas, 'investment', investAccountIds, investTxs, range, '#33ccff', { percent: true });
    }

    // Recent transactions (last 10)
    const sortedTxs = [...transactions].sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));
    const recent = sortedTxs.slice(0, 10);
    const tbody = document.getElementById('dash-tx-body');
    const empty = document.getElementById('dash-tx-empty');
    tbody.innerHTML = '';

    if (recent.length === 0) {
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      const accMap = {};
      accounts.forEach(a => accMap[a.id] = a);
      recent.forEach(tx => {
        const acc = accMap[tx.accountId];
        const typeLabel = tx.type === 'asset-add' ? 'ASSET ADDED' : tx.type === 'asset-sell' ? 'ASSET SOLD' : tx.type.toUpperCase();
        const typeClass = (tx.type === 'deposit' || tx.type === 'buy' || tx.type === 'asset-add') ? 'deposit' : (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') ? 'withdrawal' : 'valuation';
        const displayAmount = tx.type === 'valuation' ? formatCurrency(tx.amount, acc ? acc.currency : 'CHF')
          : formatCurrency(Math.abs(tx.amount), acc ? acc.currency : 'CHF');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(tx.date)}</td>
          <td>${acc ? escapeHtml(acc.name) : '—'}</td>
          <td><span class="tx-badge ${typeClass}">${typeLabel}</span></td>
          <td>${displayAmount}</td>`;
        tbody.appendChild(tr);
      });
    }
  },

  // ==================== PORTFOLIOS ====================

  async portfolios() {
    const portfolios = await DB.getAll('portfolios');
    const accounts = await DB.getAll('accounts');
    const transactions = await DB.getAll('transactions');
    const assets = await DB.getAll('assets');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const metalEntry = await DB.getMetalPricesForDate(todayStr());
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const list = document.getElementById('portfolio-list');
    const empty = document.getElementById('portfolio-empty');
    list.innerHTML = '';

    if (portfolios.length === 0) {
      empty.style.display = 'block';
      this._renderPortfolioChart([], mainCurrency);
      return;
    }
    empty.style.display = 'none';

    const accountAssets = {};
    assets.forEach(a => {
      if (!accountAssets[a.accountId]) accountAssets[a.accountId] = [];
      accountAssets[a.accountId].push(a);
    });

    const accEff = {};
    accounts.forEach(a => {
      const accTxs = transactions.filter(t => t.accountId === a.id);
      let value, cost, date;
      if (a.accountType === 'Tangible Asset') {
        const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
        const m = assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc);
        value = m.value;
        cost = m.cost;
        date = todayStr();
      } else if (a.accountType === 'Precious Metal') {
        value = metalAccountValue(a, metalEntry, rateEntries, todayStr());
        cost = _effCostBasis(accTxs);
        date = todayStr();
      } else {
        const flowTxs = accTxs.filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
          .sort((x, y) => (x.date || '').localeCompare(y.date || ''));
        value = _effValue(accTxs, a.currentValue);
        cost = _effCostBasis(accTxs);
        date = flowTxs.length > 0 ? flowTxs[flowTxs.length - 1].date : null;
      }
      accEff[a.id] = { value, cost, date };
    });

    const palette = ['#33ff33', '#33ccff', '#ffaa00', '#ff6633', '#cc33ff', '#33ffcc', '#ff3388'];

    // Effective values per portfolio and per account, all in main currency
    const pfData = portfolios.map((p, pi) => {
      const pfAccounts = accounts.filter(a => a.portfolioId === p.id);
      const baseColor = palette[pi % palette.length];
      const rows = pfAccounts.map((a, ai) => {
        const val = accEff[a.id] ? accEff[a.id].value * rateFor(a.currency || 'CHF', accEff[a.id].date || todayStr()) : 0;
        const shade = pfAccounts.length === 1 ? 0 : -0.3 + 0.6 * (ai / (pfAccounts.length - 1));
        return {
          id: a.id,
          name: a.name,
          value: val,
          color: _shadeColor(baseColor, shade)
        };
      });
      return {
        id: p.id,
        name: p.name,
        description: p.description || '',
        color: baseColor,
        value: rows.reduce((s, r) => s + r.value, 0),
        accounts: rows
      };
    });

    // Render the portfolio cards
    pfData.forEach(p => {
      const col = document.createElement('div');
      col.className = 'mb-3';
      col.innerHTML = `<div class="pf-card" onclick="App.navigate('portfolio-detail?id=${p.id}')">
        <div class="pf-name">${escapeHtml(p.name)}</div>
        <div class="pf-value">${formatCurrency(p.value, mainCurrency)}</div>
        <div class="pf-desc">${escapeHtml(p.description || '')}</div>
        <div class="pf-meta">${pluralize(p.accounts.length, 'ACCOUNT')}</div>
      </div>`;
      list.appendChild(col);
    });

    this._renderPortfolioChart(pfData, mainCurrency);
  },

  // Nested doughnut: outer ring = portfolios, inner ring = accounts within each portfolio
  _renderPortfolioChart(pfData, mainCurrency) {
    const wrap = document.getElementById('portfolio-chart-wrap');
    const canvas = document.getElementById('chart-portfolio-nested');
    const emptyState = document.getElementById('portfolio-chart-empty');
    const legendBox = document.getElementById('portfolio-chart-legend');
    if (!wrap || !canvas || !emptyState || !legendBox) return;

    if (App._charts.portfolios) { try { App._charts.portfolios.destroy(); } catch (e) {} delete App._charts.portfolios; }

    const chartData = pfData.filter(p => p.value > 0);

    if (chartData.length === 0) {
      wrap.style.display = 'none';
      emptyState.style.display = 'block';
      legendBox.innerHTML = '';
      return;
    }
    wrap.style.display = '';
    emptyState.style.display = 'none';

    const outerRows = chartData.map(p => ({ name: p.name, value: p.value, color: p.color }));
    const innerRows = [];
    chartData.forEach(p => {
      p.accounts.forEach(a => {
        if (a.value > 0) innerRows.push({ name: a.name, value: a.value, color: a.color, portfolio: p.name });
      });
    });
    const total = outerRows.reduce((s, r) => s + r.value, 0) || 1;

    const labels = outerRows.map(r => r.name).concat(innerRows.map(r => r.name));
    const datasets = [
      {
        label: 'PORTFOLIOS',
        data: outerRows.map(r => r.value),
        backgroundColor: outerRows.map(r => r.color),
        borderColor: '#161616',
        borderWidth: 2,
        weight: 2,
        names: outerRows.map(r => r.name)
      },
      {
        label: 'ACCOUNTS',
        data: innerRows.map(r => r.value),
        backgroundColor: innerRows.map(r => r.color),
        borderColor: '#161616',
        borderWidth: 2,
        weight: 1,
        names: innerRows.map(r => r.name),
        portfolios: innerRows.map(r => r.portfolio)
      }
    ];

    App._charts.portfolios = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '32%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const it = items && items[0];
                const ds = it && it.dataset;
                return ds && ds.names ? (ds.names[it.dataIndex] || '') : '';
              },
              label: (ctx) => {
                const ds = ctx.dataset;
                const name = ds.names[ctx.dataIndex] || '';
                const val = ds.data[ctx.dataIndex] || 0;
                const pct = (val / total * 100).toFixed(1);
                const pf = ds.portfolios ? ds.portfolios[ctx.dataIndex] : null;
                return (pf ? pf + ' / ' : '') + name + ': ' + formatCurrency(val, mainCurrency) + ' (' + pct + '%)';
              }
            }
          }
        }
      }
    });

    // Custom legend — portfolios with their accounts grouped beneath
    let legendHtml = '';
    chartData.forEach(p => {
      legendHtml += `<div class="pf-legend-group">
        <div class="pf-legend-row">
          <span class="pf-legend-dot" style="background:${p.color}"></span>
          <span class="pf-legend-name">${escapeHtml(p.name)}</span>
          <span class="pf-legend-val">${formatCurrency(p.value, mainCurrency)}</span>
          <span class="pf-legend-pct">${(p.value / total * 100).toFixed(1)}%</span>
        </div>`;
      p.accounts.forEach(a => {
        if (a.value > 0) {
          legendHtml += `<div class="pf-legend-row sub">
            <span class="pf-legend-dot" style="background:${a.color}"></span>
            <span class="pf-legend-name">${escapeHtml(a.name)}</span>
            <span class="pf-legend-val">${formatCurrency(a.value, mainCurrency)}</span>
            <span class="pf-legend-pct">${(a.value / total * 100).toFixed(1)}%</span>
          </div>`;
        }
      });
      legendHtml += `</div>`;
    });
    legendBox.innerHTML = legendHtml;
  },

  // ==================== PORTFOLIO DETAIL ====================

  async portfolioDetail(id) {
    const portfolio = await DB.getById('portfolios', id);
    const accounts = await DB.getByIndex('accounts', 'portfolioId', id);
    const transactions = await DB.getAll('transactions');
    const assets = await DB.getAll('assets');
    const custodians = await DB.getAll('custodians');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const metalEntry = await DB.getMetalPricesForDate(todayStr());
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const custMap = {};
    custodians.forEach(c => custMap[c.id] = c.name);

    const accountAssets = {};
    assets.forEach(a => {
      if (!accountAssets[a.accountId]) accountAssets[a.accountId] = [];
      accountAssets[a.accountId].push(a);
    });

    document.getElementById('pf-detail-title').textContent = portfolio ? portfolio.name : 'PORTFOLIO';

    let totalValue = 0;
    let totalCost = 0;

    // compute effective value and cost basis per account (no mutation)
    const effMap = {};
    accounts.forEach(a => {
      const accTxs = transactions.filter(t => t.accountId === a.id);
      let costBasis, effVal, lastDate;
      if (a.accountType === 'Tangible Asset') {
        const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
        const m = assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc);
        costBasis = m.cost;
        effVal = m.value;
        lastDate = todayStr();
      } else if (a.accountType === 'Precious Metal') {
        costBasis = _effCostBasis(accTxs);
        effVal = metalAccountValue(a, metalEntry, rateEntries, todayStr());
        lastDate = todayStr();
      } else {
        costBasis = _effCostBasis(accTxs);
        effVal = _effValue(accTxs, a.currentValue);
        const flowTxs = accTxs.filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
          .sort((x, y) => (x.date || '').localeCompare(y.date || ''));
        lastDate = flowTxs.length > 0 ? flowTxs[flowTxs.length - 1].date : null;
      }
      const cur = a.currency || 'CHF';
      const rate = rateFor(cur, lastDate || todayStr());
      effMap[a.id] = { costBasis, effVal, pl: effVal - costBasis };
      totalValue += effVal * rate;
      totalCost += costBasis * rate;
    });

    const totalPL = totalValue - totalCost;

    document.getElementById('pf-stat-value').textContent = formatCurrency(totalValue, mainCurrency);
    document.getElementById('pf-stat-accounts').textContent = accounts.length;
    document.getElementById('pf-stat-cost').textContent = formatCurrency(totalCost, mainCurrency);
    const plEl = document.getElementById('pf-stat-pl');
    plEl.textContent = formatCurrency(totalPL, mainCurrency);
    plEl.style.color = totalPL >= 0 ? '#33ff33' : '#ff3333';

    const list = document.getElementById('account-list');
    const empty = document.getElementById('account-empty');
    list.innerHTML = '';

    if (accounts.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    accounts.forEach(a => {
      const { effVal, pl } = effMap[a.id] || { effVal: 0, pl: 0 };
      let metaExtra = '';
      if (a.accountType === 'Precious Metal' && a.quantity) {
        const spot = metalSpotPerGram(metalEntry, a.metalType, a.currency || 'CHF', rateEntries, todayStr());
        const shownPrice = spot != null ? spot : (a.pricePerGram || 0);
        metaExtra = ' &middot; ' + a.quantity + 'g ' + (a.metalType || '') + ' @ ' + formatCurrency(shownPrice, a.currency) + '/g';
      } else if (a.accountType === 'Tangible Asset') {
        const held = (accountAssets[a.id] || []).filter(x => !x.sold).length;
        metaExtra = ' &middot; ' + pluralize(held, 'ASSET');
      }
      const col = document.createElement('div');
      col.className = 'col-md-6 mb-3';
      col.innerHTML = `<div class="acc-card" onclick="App.navigate('account-detail?id=${a.id}&pfid=${id}')">
        <div class="acc-name">
          <span>${escapeHtml(a.name)}</span>
          <div class="acc-toggles">
            <label class="perf-toggle" onclick="event.stopPropagation()">
              <span>Include in Net Worth</span>
              <input type="checkbox" class="perf-cb"
                ${a.includeInNetWorth !== false ? 'checked' : ''}
                onchange="App.toggleFlag(event, ${a.id}, 'includeInNetWorth', this.checked)">
            </label>
            <label class="perf-toggle" onclick="event.stopPropagation()">
              <span>Include in Liquid Net Worth</span>
              <input type="checkbox" class="perf-cb"
                ${a.includeInLiquidNetWorth !== false ? 'checked' : ''}
                onchange="App.toggleFlag(event, ${a.id}, 'includeInLiquidNetWorth', this.checked)">
            </label>
            <label class="perf-toggle" onclick="event.stopPropagation()">
              <span>Include in Performance</span>
              <input type="checkbox" class="perf-cb"
                ${a.trackPerformance !== false ? 'checked' : ''}
                onchange="App.toggleFlag(event, ${a.id}, 'trackPerformance', this.checked)">
            </label>
          </div>
        </div>
        <div class="acc-meta"><span class="type-badge type-${(a.accountType||'Investment Account').replace(/\s+/g,'-').toLowerCase()}">${a.accountType || 'Investment Account'}</span> &middot; ${custMap[a.custodianId] || '—'} &middot; ${a.currency || 'CHF'}${metaExtra}</div>
        <div class="acc-value">${formatCurrency(effVal, a.currency)}</div>
        <div class="acc-pl ${plClass(pl)}">${pl >= 0 ? '+' : ''}${formatCurrency(pl, a.currency)}</div>
      </div>`;
      list.appendChild(col);
    });
  },

  // ==================== ACCOUNT DETAIL ====================

  async accountDetail(id) {
    const account = await DB.getById('accounts', id);
    if (!account) { App.navigate('dashboard'); return; }
    const transactions = await DB.getByIndex('transactions', 'accountId', id);
    const accountAssets = await DB.getByIndex('assets', 'accountId', id);
    const assetMap = {};
    accountAssets.forEach(a => assetMap[a.id] = a);
    const custodians = await DB.getAll('custodians');
    const custMap = {};
    custodians.forEach(c => custMap[c.id] = c.name);

    document.getElementById('acc-detail-name').textContent = account.name || 'ACCOUNT';
    document.getElementById('acc-detail-back').href = '#portfolio-detail?id=' + (account.portfolioId || '');

    const isPm = account.accountType === 'Precious Metal';
    const isTa = account.accountType === 'Tangible Asset';

    const settings = await DB.getSettings();
    const rateEntries = await DB.getAll('exchangeRates');
    const metalEntry = await DB.getMetalPricesForDate(todayStr());
    const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', account.currency || 'CHF', date);

    let costBasis;
    let currentVal;
    if (isTa) {
      const m = assetAccountMetrics(accountAssets, todayStr(), rateToAcc);
      costBasis = m.cost;
      currentVal = m.value;
    } else if (isPm) {
      costBasis = _effCostBasis(transactions);
      currentVal = metalAccountValue(account, metalEntry, rateEntries, todayStr());
    } else {
      costBasis = _effCostBasis(transactions);
      currentVal = _effValue(transactions, account.currentValue);
    }
    const pl = currentVal - costBasis;

    document.getElementById('acc-stat-value').textContent = formatCurrency(currentVal, account.currency);
    document.getElementById('acc-stat-cost').textContent = formatCurrency(costBasis, account.currency);
    const plEl = document.getElementById('acc-stat-pl');
    plEl.textContent = (pl >= 0 ? '+' : '') + formatCurrency(pl, account.currency);
    plEl.style.color = pl >= 0 ? '#33ff33' : '#ff3333';

    const custName = custMap[account.custodianId] || '—';
    let metaText = custName + ' / ' + (account.currency || 'CHF');
    if (isPm) {
      metaText += ' / ' + (account.metalType || 'METAL');
    }
    document.getElementById('acc-stat-meta').textContent = metaText;

    // Precious metal / tangible asset stat cards & actions
    const qtyCard = document.getElementById('acc-stat-qty-card');
    const priceCard = document.getElementById('acc-stat-price-card');
    const assetsCard = document.getElementById('acc-stat-assets-card');
    const pmActions = document.getElementById('pm-actions');
    const taActions = document.getElementById('ta-actions');
    const taAssetsCard = document.getElementById('ta-assets-card');
    const stdActions = document.getElementById('std-actions');
    if (qtyCard) qtyCard.style.display = isPm ? 'block' : 'none';
    if (priceCard) priceCard.style.display = isPm ? 'block' : 'none';
    if (assetsCard) assetsCard.style.display = isTa ? 'block' : 'none';
    if (pmActions) pmActions.style.display = isPm ? 'flex' : 'none';
    if (taActions) taActions.style.display = isTa ? 'flex' : 'none';
    if (taAssetsCard) taAssetsCard.style.display = isTa ? 'block' : 'none';
    if (stdActions) stdActions.style.display = (isPm || isTa) ? 'none' : 'flex';
    if (isPm) {
      if (document.getElementById('acc-stat-qty')) document.getElementById('acc-stat-qty').textContent = (account.quantity || 0) + 'g';
      if (document.getElementById('acc-stat-price')) {
        const spot = metalSpotPerGram(metalEntry, account.metalType, account.currency || 'CHF', rateEntries, todayStr());
        const shownPrice = spot != null ? spot : (account.pricePerGram || 0);
        document.getElementById('acc-stat-price').textContent = formatCurrency(shownPrice, account.currency) + '/g';
      }
    }
    if (isTa) {
      if (document.getElementById('acc-stat-assets')) {
        const held = accountAssets.filter(a => !a.sold).length;
        document.getElementById('acc-stat-assets').textContent = pluralize(held, 'ASSET');
      }
      this._renderAssetsTable(accountAssets, account.currency);
    }

    // Performance period selectors
    const accTxsSorted = [...transactions]
      .filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const firstTx = accTxsSorted.length > 0 ? accTxsSorted[0] : null;

    function _accPerfSince(cutoffDate) {
      if (isTa) {
        const vNow = assetAccountMetrics(accountAssets, todayStr(), rateToAcc).value;
        const vCutoff = assetAccountMetrics(accountAssets, cutoffDate, rateToAcc).value;
        const abs = vNow - vCutoff;
        const base = vCutoff;
        return { abs, pct: base !== 0 ? (abs / base) * 100 : 0, initial: vCutoff, input: 0 };
      }
      let totalAtCutoff = 0;
      accTxsSorted.forEach(tx => {
        if (tx.date >= cutoffDate) return;
        totalAtCutoff = tx.balanceAfter || 0;
      });
      let netDeposits = 0;
      accTxsSorted.forEach(tx => {
        if (tx.date < cutoffDate) return;
        if (tx.type === 'deposit') netDeposits += Math.abs(tx.amount);
        if (tx.type === 'withdrawal') netDeposits -= Math.abs(tx.amount);
        if (tx.type === 'buy') netDeposits += Math.abs(tx.amount);
        if (tx.type === 'sell') netDeposits -= Math.abs(tx.amount);
        if (tx.type === 'valuation' && firstTx && firstTx.id === tx.id) {
          netDeposits += tx.amount;
        }
      });
      const abs = currentVal - totalAtCutoff - netDeposits;
      const base = totalAtCutoff + netDeposits;
      const pct = base !== 0 ? (abs / base) * 100 : 0;
      return { abs, pct, initial: totalAtCutoff, input: netDeposits };
    }

    const today = todayStr();
    const curYear = today.substring(0, 4);
    const ytdCutoff = curYear + '-01-01';
    const oneYearAgo = String(Number(curYear) - 1) + today.substring(4);
    const twoYearsAgo = String(Number(curYear) - 2) + today.substring(4);
    const threeYearsAgo = String(Number(curYear) - 3) + today.substring(4);
    const earliestTx = accTxsSorted.length > 0 ? accTxsSorted[0].date : today;

    const accPerfYTD = _accPerfSince(ytdCutoff);
    const accPerf1Y = _accPerfSince(oneYearAgo);
    const accPerf2Y = _accPerfSince(twoYearsAgo);
    const accPerf3Y = _accPerfSince(threeYearsAgo);
    const accPerfMax = _accPerfSince(earliestTx);

    const accPerfMap = { ytd: accPerfYTD, '1y': accPerf1Y, '2y': accPerf2Y, '3y': accPerf3Y, max: accPerfMax };
    const activeAccPerf = document.querySelector('#acc-perf-selectors .perf-btn.active');
    const initialAccPerf = activeAccPerf ? activeAccPerf.dataset.perf : 'ytd';
    const initialAcc = accPerfMap[initialAccPerf];

    function _renderAccPerf(val) {
      const initialEl = document.getElementById('acc-perf-initial');
      const actualEl = document.getElementById('acc-perf-actual');
      const inputEl = document.getElementById('acc-perf-input');
      const plEl = document.getElementById('acc-perf-pl');
      const pctEl = document.getElementById('acc-perf-pct');
      if (!initialEl || !actualEl || !inputEl || !plEl || !pctEl) return;
      initialEl.textContent = formatCurrency(val.initial, account.currency);
      actualEl.textContent = formatCurrency(currentVal, account.currency);
      inputEl.textContent = formatCurrency(val.input, account.currency);
      plEl.textContent = (val.abs >= 0 ? '+' : '') + formatCurrency(val.abs, account.currency);
      plEl.style.color = val.abs >= 0 ? '#33ff33' : '#ff3333';
      pctEl.textContent = (val.pct >= 0 ? '+' : '') + val.pct.toFixed(2) + '%';
      pctEl.style.color = val.abs >= 0 ? '#33ff33' : '#ff3333';
    }
    _renderAccPerf(initialAcc);

    // Performance chart — line chart of account value over the selected period
    const accPerfCutoffs = { ytd: ytdCutoff, '1y': oneYearAgo, '2y': twoYearsAgo, '3y': threeYearsAgo, max: earliestTx };
    const accPerfMonthLabel = (monthKey) => {
      const [y, mo] = monthKey.split('-').map(Number);
      return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    };
    function _renderAccPerfChart(range) {
      const wrap = document.getElementById('acc-perf-chart-wrap');
      const canvas = document.getElementById('acc-perf-chart');
      const emptyMsg = document.getElementById('acc-perf-chart-empty');
      if (!wrap || !canvas || !emptyMsg) return;
      const key = 'accPerfChart';
      if (App._charts[key]) { try { App._charts[key].destroy(); } catch (e) {} delete App._charts[key]; }

      const cutoff = accPerfCutoffs[range] || ytdCutoff;
      let points = [];
      if (isTa) {
        let month = cutoff.substring(0, 7);
        const curMonth = today.substring(0, 7);
        let guard = 0;
        while (month <= curMonth && guard < 720) {
          guard++;
          const [y, mo] = month.split('-').map(Number);
          const lastDay = String(new Date(y, mo, 0).getDate()).padStart(2, '0');
          const v = assetAccountMetrics(accountAssets, month + '-' + lastDay, rateToAcc).value;
          points.push({ month, value: v });
          const next = new Date(y, mo, 1);
          next.setMonth(next.getMonth() + 1);
          month = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0');
        }
      } else {
        const byMonth = {};
        accTxsSorted.forEach(tx => {
          if (tx.date < cutoff) return;
          const monthKey = (tx.date || '').substring(0, 7);
          if (!monthKey) return;
          byMonth[monthKey] = tx.balanceAfter != null ? tx.balanceAfter : (byMonth[monthKey] || 0);
        });
        const curMonth = today.substring(0, 7);
        if (currentVal > 0) byMonth[curMonth] = currentVal;
        points = Object.entries(byMonth).map(([month, value]) => ({ month, value }));
      }
      points.sort((a, b) => a.month.localeCompare(b.month));

      if (points.length < 2) {
        wrap.style.display = 'none';
        emptyMsg.style.display = 'block';
        return;
      }
      wrap.style.display = '';
      emptyMsg.style.display = 'none';

      App._charts[key] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: points.map(p => accPerfMonthLabel(p.month)),
          datasets: [{
            label: account.name || 'ACCOUNT',
            data: points.map(p => p.value),
            borderColor: '#33ff33',
            backgroundColor: 'rgba(51,255,51,0.08)',
            fill: true,
            tension: 0.25,
            pointRadius: 2,
            pointBackgroundColor: '#33ff33'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => formatCurrency(ctx.parsed.y, account.currency) } }
          },
          scales: {
            x: { ticks: { color: '#999999', font: { family: "'Share Tech Mono', monospace", size: 10 }, maxTicksLimit: 8 }, grid: { color: '#222222' } },
            y: { ticks: { color: '#999999', font: { family: "'Share Tech Mono', monospace", size: 10 } }, grid: { color: '#222222' } }
          }
        }
      });
    }
    _renderAccPerfChart(initialAccPerf);

    document.querySelectorAll('#acc-perf-selectors .perf-btn').forEach(btn => {
      btn.onclick = function() {
        document.querySelectorAll('#acc-perf-selectors .perf-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        _renderAccPerf(accPerfMap[this.dataset.perf]);
        _renderAccPerfChart(this.dataset.perf);
      };
    });

    // Transaction history
    const tbody = document.getElementById('acc-tx-body');
    const empty = document.getElementById('acc-tx-empty');
    tbody.innerHTML = '';

    const sorted = [...transactions].sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    if (sorted.length === 0) {
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      sorted.forEach(tx => {
        const typeLabel = tx.type === 'asset-add' ? 'ASSET ADDED' : tx.type === 'asset-sell' ? 'ASSET SOLD' : tx.type.toUpperCase();
        const typeClass = (tx.type === 'deposit' || tx.type === 'buy' || tx.type === 'asset-add') ? 'deposit' : (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') ? 'withdrawal' : 'valuation';
        let displayAmount;
        if (tx.type === 'valuation') {
          displayAmount = formatCurrency(tx.amount, account.currency);
        } else if (tx.type === 'buy' || tx.type === 'sell' || tx.type === 'asset-add' || tx.type === 'asset-sell') {
          let amt = Math.abs(tx.amount);
          if (tx.type === 'asset-add' || tx.type === 'asset-sell') {
            const asset = assetMap[tx.assetId];
            if (asset) amt = amt * rateToAcc(asset.currency || 'CHF', tx.date);
          }
          displayAmount = (tx.amount >= 0 ? '+' : '-') + formatCurrency(amt, account.currency);
        } else {
          displayAmount = formatCurrency(Math.abs(tx.amount), account.currency);
        }
        let notesHtml = escapeHtml(tx.notes || '');
        if (tx.quantity != null) {
          let metalLine = (tx.type === 'buy' ? '+' : tx.type === 'sell' ? '&minus;' : '') + tx.quantity + 'g';
          if (tx.pricePerGram) metalLine += ' @ ' + tx.pricePerGram.toFixed(2) + ' ' + account.currency + '/g';
          if (tx.quantityAfter != null) metalLine += ' &middot; QTY ' + tx.quantityAfter + 'g';
          notesHtml += '<br><small style="color:#888">' + metalLine + '</small>';
        } else if (tx.pricePerGram) {
          notesHtml += '<br><small style="color:#888">' + tx.pricePerGram.toFixed(2) + ' ' + account.currency + '/g</small>';
        }
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(tx.date)}</td>
          <td><span class="tx-badge ${typeClass}">${typeLabel}</span></td>
          <td>${displayAmount}</td>
          <td>${formatCurrency(tx.balanceAfter || 0, account.currency)}</td>
          <td>${notesHtml}</td>
          <td><a class="tx-link" onclick="App.deleteTransaction(${tx.id})">DELETE</a></td>`;
        tbody.appendChild(tr);
      });
    }
  },

  _renderAssetsTable(assets, currency) {
    const tbody = document.getElementById('ta-assets-body');
    const empty = document.getElementById('ta-assets-empty');
    const table = document.getElementById('ta-assets-table');
    tbody.innerHTML = '';

    const sorted = [...assets].sort((a, b) => {
      if (a.sold !== b.sold) return a.sold ? 1 : -1;
      return (b.purchaseDate || '').localeCompare(a.purchaseDate || '');
    });

    if (sorted.length === 0) {
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = '';

    sorted.forEach(asset => {
      const assetCur = asset.currency || 'CHF';
      const currentValue = assetCurrentValue(asset, todayStr());
      const realized = assetRealizedPL(asset);
      const statusHtml = asset.sold
        ? '<span class="tx-badge withdrawal">SOLD</span>'
        : '<span class="tx-badge deposit">HELD</span>';
      const valueHtml = asset.sold
        ? '<span class="text-muted">—</span>'
        : formatCurrency(currentValue, assetCur);
      const plHtml = realized == null
        ? '<span class="text-muted">—</span>'
        : '<span class="ta-pl ' + plClass(realized) + '">' + (realized >= 0 ? '+' : '') + formatCurrency(realized, assetCur) + '</span>';
      const editLink = '<a class="tx-link me-2" onclick="App.showModal(\'asset\', ' + asset.accountId + ', ' + asset.id + ')">EDIT</a>';
      const actionsHtml = asset.sold
        ? editLink + '<a class="tx-link" onclick="App.deleteAsset(' + asset.id + ')">DELETE</a>'
        : '<a class="tx-link me-2" onclick="App.showModal(\'sellAsset\', ' + asset.id + ')">SELL</a>' +
          editLink + '<a class="tx-link" onclick="App.deleteAsset(' + asset.id + ')">DELETE</a>';

      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(asset.name)}</td>
        <td>${formatDate(asset.purchaseDate)}</td>
        <td>${formatCurrency(assetCostValue(asset), assetCur)}</td>
        <td>${assetCur}</td>
        <td>${(asset.depreciationPct || 0)}%</td>
        <td>${valueHtml}</td>
        <td>${statusHtml}</td>
        <td>${plHtml}</td>
        <td>${actionsHtml}</td>`;
      tbody.appendChild(tr);
    });
  },

  // ==================== CUSTODIANS ====================

  async custodians() {
    const custodians = await DB.getAll('custodians');
    const list = document.getElementById('custodian-list');
    const empty = document.getElementById('custodian-empty');
    list.innerHTML = '';

    if (custodians.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    custodians.forEach(c => {
      const col = document.createElement('div');
      col.className = 'col-md-4 col-sm-6 mb-3';
      col.innerHTML = `<div class="cus-card">
        <div class="cus-name">${escapeHtml(c.name)}</div>
        <div class="cus-notes">${escapeHtml(c.notes || '')}</div>
        <div class="cus-actions">
          <button class="btn btn-gta btn-sm me-2" onclick="App.showModal('custodian', ${c.id})">EDIT</button>
        </div>
      </div>`;
      list.appendChild(col);
    });
  },

  // ==================== INCOMES ====================

  async incomes() {
    const allIncomes = await DB.getAll('incomes');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const yearEl = document.getElementById('income-year-select');
    if (!yearEl) return;

    // populate year dropdown (preserve selection)
    const prevYear = yearEl.value;
    const years = [...new Set(allIncomes.map(inc => (inc.month || '').substring(0, 4)).filter(Boolean))].sort().reverse();
    const currentYear = new Date().getFullYear().toString();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    yearEl.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearEl.value = prevYear && years.includes(prevYear) ? prevYear : currentYear;
    const selectedYear = yearEl.value;

    const filtered = allIncomes.filter(inc => (inc.month || '').startsWith(selectedYear));
    const total = filtered.reduce((sum, inc) => sum + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || ((inc.month || '') + '-01')), 0);
    const monthsWithIncome = new Set(filtered.map(inc => inc.month).filter(Boolean)).size;

    document.getElementById('income-total').textContent = formatCurrency(total, mainCurrency);
    document.getElementById('income-avg-monthly').textContent =
      formatCurrency(monthsWithIncome > 0 ? total / monthsWithIncome : 0, mainCurrency);

    const tbody = document.getElementById('income-list-body');
    const empty = document.getElementById('income-empty');
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    const sorted = filtered.sort((a, b) => new Date(b.date || b.id) - new Date(a.date || a.id));
    sorted.forEach(inc => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(inc.source)}</td>
        <td>${formatCurrency(inc.amount, inc.currency)}</td>
        <td>${formatDate(inc.date)}</td>
        <td>${escapeHtml(inc.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('income', ${inc.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteIncome(${inc.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  // ==================== EXPENSES ====================

  async expenses() {
    const allExpenses = await DB.getAll('expenses');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const yearEl = document.getElementById('expense-year-select');
    if (!yearEl) return;

    const prevYear = yearEl.value;
    const years = [...new Set(allExpenses.map(exp => exp.year).filter(Boolean))].sort().reverse();
    const currentYear = new Date().getFullYear().toString();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    yearEl.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearEl.value = prevYear && years.includes(prevYear) ? prevYear : currentYear;
    const selectedYear = yearEl.value;

    const filtered = allExpenses.filter(exp => exp.year === selectedYear);
    let totalAnnual = 0;
    let totalMonthly = 0;
    filtered.forEach(exp => {
      const v = (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || ((exp.year || '') + '-01-01'));
      if (exp.type === 'monthly') {
        totalAnnual += v * 12;
        totalMonthly += v;
      } else {
        totalAnnual += v;
      }
    });

    document.getElementById('expense-total').textContent = formatCurrency(totalAnnual, mainCurrency);
    document.getElementById('expense-total-monthly').textContent = formatCurrency(totalMonthly, mainCurrency);

    const tbody = document.getElementById('expense-list-body');
    const empty = document.getElementById('expense-empty');
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    filtered.sort((a, b) => (b.amount || 0) - (a.amount || 0)).forEach(exp => {
      const annualCost = exp.type === 'monthly' ? (exp.amount || 0) * 12 : (exp.amount || 0);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(exp.text)}</td>
        <td><span class="tx-badge ${exp.type === 'monthly' ? 'deposit' : 'valuation'}">${exp.type.toUpperCase()}</span></td>
        <td>${formatCurrency(exp.amount, exp.currency)}</td>
        <td>${formatCurrency(annualCost, exp.currency)}</td>
        <td>${escapeHtml(exp.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('expense', ${exp.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteExpense(${exp.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  async debts() {
    const allDebts = await DB.getAll('debts');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const debtsIn = allDebts.filter(d => d.direction === 'in');
    const debtsOut = allDebts.filter(d => d.direction !== 'in');

    const totalIn = debtsIn.reduce((sum, d) => sum + (d.amount || 0), 0);
    const totalOut = debtsOut.reduce((sum, d) => sum + (d.amount || 0), 0);

    document.getElementById('debt-owe').textContent = formatCurrency(totalOut, mainCurrency);
    document.getElementById('debt-in').textContent = formatCurrency(totalIn, mainCurrency);

    const tbody = document.getElementById('debt-list-body');
    const empty = document.getElementById('debt-empty');
    tbody.innerHTML = '';

    if (allDebts.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    allDebts.forEach(debt => {
      const isIn = debt.direction === 'in';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(debt.description)}</td>
        <td>${escapeHtml(debt.person || '-')}</td>
        <td><span class="tx-badge ${isIn ? 'deposit' : 'withdrawal'}">${isIn ? 'OWED TO ME' : 'I OWE'}</span></td>
        <td>${formatCurrency(debt.amount, mainCurrency)}</td>
        <td>${debt.date ? formatDate(debt.date) : '-'}</td>
        <td>${escapeHtml(debt.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('debt', ${debt.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteDebt(${debt.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  // ==================== GOALS ====================

  // Waterfall: higher-priority goals consume account value first;
  // later goals only see what remains. Consumed per allocation in row order, capped at target.
  _computeGoalWaterfall(goals, accValue) {
    const remaining = {};
    Object.keys(accValue).forEach(id => remaining[id] = accValue[id]);
    return goals.map(goal => {
      let current = 0;
      let totalAvail = 0;
      const claims = (goal.allocations || []).map(a => {
        const avail = (remaining[a.accountId] || 0) * ((a.pct || 0) / 100);
        totalAvail += avail;
        const need = (goal.target || 0) - current;
        const take = Math.max(0, Math.min(avail, need));
        if (take > 0) {
          current += take;
          remaining[a.accountId] = (remaining[a.accountId] || 0) - take;
        }
        return { accountId: a.accountId, pct: a.pct || 0, avail, take };
      });
      return { goal, current, totalAvail, claims };
    });
  },

  _goalCardHtml(goalRes, accNames, compact, mainCurrency) {
    const goal = goalRes.goal;
    const cur = mainCurrency || 'CHF';
    const total = goalRes.totalAvail;
    const target = goal.target || 0;
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    const diff = total - target;
    const reached = total >= target;
    const statusText = diff < 0 ? 'SHORT BY ' + formatCurrency(-diff, cur)
      : diff > 0 ? 'EXCEED BY ' + formatCurrency(diff, cur)
      : 'TARGET REACHED';
    const statusHtml =
      '<div class="goal-status-row">' +
      '<div class="goal-status ' + (diff < 0 ? 'danger' : 'ok') + '">' + statusText + '</div>' +
      '<span class="goal-pct" style="color:' + (reached ? 'var(--accent)' : 'var(--text-primary)') + '">' + pct.toFixed(1) + '%</span>' +
      '</div>';
    const allocHtml = goalRes.claims.map(c => {
      const name = accNames[c.accountId] || ('ACCOUNT #' + c.accountId);
      return '<div class="goal-alloc-line">' +
        '<span class="goal-alloc-name">' + escapeHtml(name) + ' (' + c.pct + '%)</span>' +
        '<span>' + formatCurrency(c.avail, cur) + '</span>' +
        '<span>' + formatCurrency(c.take, cur) + '</span>' +
        '</div>';
    }).join('') || '<div class="goal-alloc-line"><span class="text-muted">NO ACCOUNTS ASSIGNED</span></div>';

    return '<div class="goal-card">' +
      '<div class="goal-card-top">' +
      '<span class="goal-name"><span class="goal-priority">#' + (goal.order != null ? goal.order : '-') + '</span> ' + escapeHtml(goal.name) + '</span>' +
      '<span class="goal-reached" style="' + (reached ? '' : 'display:none') + '">REACHED</span>' +
      '</div>' +
      '<div class="goal-target-line" style="color:' + (reached ? 'var(--accent)' : 'var(--text-primary)') + '">' + formatCurrency(target, cur) + '</div>' +
      statusHtml +
      '<div class="goal-progress"><div class="goal-progress-fill" style="width:' + pct + '%"></div></div>' +
      (compact ? '' :
      '<div class="goal-allocations">' +
      '<div class="goal-alloc-header"><span>ACCOUNT</span><span>AVAILABLE</span><span>TAKE</span></div>' +
      allocHtml + '</div>') +
      '<div class="goal-actions">' +
      '<a class="tx-link me-2" onclick="App.moveGoal(' + goal.id + ', -1)">UP</a>' +
      '<a class="tx-link me-2" onclick="App.moveGoal(' + goal.id + ', 1)">DOWN</a>' +
      '<a class="tx-link me-2" onclick="App.showModal(\'goal\', ' + goal.id + ')">EDIT</a>' +
      '<a class="tx-link" onclick="App.deleteGoal(' + goal.id + ')">DELETE</a>' +
      '</div>' +
      '</div>';
  },

  async _buildGoalContext() {
    const accounts = await DB.getAll('accounts');
    const transactions = await DB.getAll('transactions');
    const assets = await DB.getAll('assets');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const metalEntry = await DB.getMetalPricesForDate(todayStr());
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const accTxs = {};
    transactions.filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
      .forEach(t => {
        const prev = accTxs[t.accountId];
        if (!prev || (t.date || '') > (prev.date || '')) accTxs[t.accountId] = t;
      });
    const accountAssets = {};
    assets.forEach(a => {
      if (!accountAssets[a.accountId]) accountAssets[a.accountId] = [];
      accountAssets[a.accountId].push(a);
    });
    const accValue = {};
    const accNames = {};
    accounts.forEach(a => {
      let raw;
      let latest = null;
      if (a.accountType === 'Tangible Asset') {
        const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
        raw = assetAccountMetrics(accountAssets[a.id], todayStr(), rateToAcc).value;
      } else if (a.accountType === 'Precious Metal') {
        raw = metalAccountValue(a, metalEntry, rateEntries, todayStr());
      } else {
        latest = accTxs[a.id];
        raw = latest ? (latest.balanceAfter || 0) : (a.currentValue || 0);
      }
      accValue[a.id] = raw * rateFor(a.currency || 'CHF', a.accountType === 'Precious Metal' ? todayStr() : (latest ? latest.date : todayStr()));
      accNames[a.id] = a.name;
    });
    return { accValue, accNames };
  },

  async goals() {
    const goals = await DB.getAll('goals');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const { accValue, accNames } = await this._buildGoalContext();

    const list = document.getElementById('goal-list');
    const empty = document.getElementById('goal-empty');
    list.innerHTML = '';

    if (goals.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    goals.sort((a, b) =>
      ((a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity)) || (a.id - b.id)
    );

    const results = this._computeGoalWaterfall(goals, accValue);

    results.forEach(goalRes => {
      const col = document.createElement('div');
      col.className = 'col-md-4 mb-3';
      col.innerHTML = this._goalCardHtml(goalRes, accNames, undefined, mainCurrency);
      list.appendChild(col);
    });
  },

  // ==================== EXCHANGE RATES ====================

  async exchangeRates() {
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';

    const accounts = await DB.getAll('accounts');
    const incomes = await DB.getAll('incomes');
    const expenses = await DB.getAll('expenses');

    const usage = {};
    function addUsage(cur, kind) {
      if (!cur) return;
      if (!usage[cur]) usage[cur] = { accounts: 0, incomes: 0, expenses: 0 };
      usage[cur][kind]++;
    }
    accounts.forEach(a => addUsage(a.currency, 'accounts'));
    incomes.forEach(inc => addUsage(inc.currency, 'incomes'));
    expenses.forEach(exp => addUsage(exp.currency, 'expenses'));

    const currencies = Object.keys(usage).filter(c => c !== mainCurrency).sort();

    document.getElementById('rates-main-label').textContent = 'MAIN CURRENCY: ' + mainCurrency;

    const dateEl = document.getElementById('rates-date');
    const dateLabel = document.getElementById('rates-date-label');
    const tbody = document.getElementById('rates-body');
    const empty = document.getElementById('rates-empty');
    const table = document.getElementById('rates-table');

    const loadRates = async (date) => {
      const saved = await DB.getRatesForDate(date);
      const rates = (saved && saved.rates) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      currencies.forEach(code => {
        const info = usage[code];
        const parts = [];
        if (info.accounts) parts.push(info.accounts + ' ACCOUNT' + (info.accounts === 1 ? '' : 'S'));
        if (info.incomes) parts.push(info.incomes + ' INCOME' + (info.incomes === 1 ? '' : 'S'));
        if (info.expenses) parts.push(info.expenses + ' EXPENSE' + (info.expenses === 1 ? '' : 'S'));
        const c = CURRENCIES.find(x => x.code === code) || { code, name: code };
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><span class="rate-code">${escapeHtml(code)}</span></td>
          <td>${escapeHtml(c.name)}</td>
          <td>${parts.join(' &middot; ')}</td>
          <td>
            <div class="input-group" style="max-width: 280px">
              <span class="input-group-text input-gta-addon">1 ${escapeHtml(code)}</span>
              <input type="number" step="0.0001" min="0" class="form-control form-gta rate-input" data-code="${escapeHtml(code)}" placeholder="${escapeHtml(mainCurrency)}" value="${rates[code] != null ? rates[code] : ''}" />
              <span class="input-group-text input-gta-addon">${escapeHtml(mainCurrency)}</span>
            </div>
          </td>`;
        tbody.appendChild(tr);
      });

      if (currencies.length === 0) {
        table.style.display = 'none';
        empty.style.display = 'block';
      } else {
        table.style.display = '';
        empty.style.display = 'none';
      }
    };

    const allBody = document.getElementById('rates-all-body');
    const allEmpty = document.getElementById('rates-all-empty');
    const allTable = document.getElementById('rates-all-table');

    const loadAllRates = async () => {
      const entries = await DB.getAll('exchangeRates');
      const sorted = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      allBody.innerHTML = '';

      sorted.forEach(entry => {
        const codes = Object.keys(entry.rates || {}).sort();
        const chips = codes.map(code => {
          const rate = entry.rates[code];
          return `<span class="badge badge-rate">${escapeHtml(code)} ${escapeHtml(formatNumber(rate))}</span>`;
        }).join(' ');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(entry.date)}</td>
          <td>${chips || '<span class="text-muted">EMPTY</span>'}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-gta" onclick="Pages.loadRatesFromHistory('${escapeHtml(entry.date)}')">OPEN</button>
          </td>`;
        allBody.appendChild(tr);
      });

      if (sorted.length === 0) {
        allTable.style.display = 'none';
        allEmpty.style.display = 'block';
      } else {
        allTable.style.display = '';
        allEmpty.style.display = 'none';
      }
    };

    if (this._ratesDateHandler) dateEl.removeEventListener('change', this._ratesDateHandler);
    this._ratesDateHandler = () => loadRates(dateEl.value);
    dateEl.addEventListener('change', this._ratesDateHandler);

    dateEl.value = todayStr();
    loadRates(dateEl.value);
    loadAllRates();
  },

  async fetchMetalPrices(silent) {
    const btn = document.getElementById('metals-fetch-btn');
    const status = document.getElementById('metals-fetch-status');

    const symbols = ['XAU', 'XAG', 'XPT', 'XPD'];
    const today = todayStr();
    const saved = await DB.getMetalPricesForDate(today);
    const existing = (saved && saved.prices) || {};
    const missing = symbols.filter(sym => !(existing[sym] && existing[sym].chfPerGram != null));

    if (missing.length === 0) {
      if (status) status.textContent = 'UP TO DATE — PRICES EXIST FOR TODAY';
      return { skipped: true, prices: existing };
    }

    if (!silent && btn) btn.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const prices = Object.assign({}, existing);
      for (const sym of missing) {
        try {
          const res = await fetch('https://api.gold-api.com/price/' + sym + '/CHF');
          if (!res.ok) { prices[sym] = { error: 'HTTP ' + res.status }; continue; }
          const d = await res.json();
          prices[sym] = {
            name: d.name || sym,
            chfPerOz: d.price != null ? d.price : null,
            chfPerGram: d.price != null ? Math.round((d.price / 31.1034768) * 100) / 100 : null
          };
        } catch (e) {
          prices[sym] = { error: e.message };
        }
      }

      await DB.saveMetalPricesForDate(today, prices);

      if (status) {
        const ok = symbols.filter(s => prices[s] && prices[s].chfPerGram != null).length;
        status.textContent = ok + '/4 METALS FETCHED';
      }
      if (!silent) {
        App.toast('METAL PRICES SYNCED');
        await this.metalPrices();
      }
      return prices;
    } finally {
      if (!silent && btn) btn.disabled = false;
    }
  },

  // ==================== PRECIOUS METALS PRICES ====================

  async metalPrices() {
    const dateEl = document.getElementById('metals-date');
    const dateLabel = document.getElementById('metals-date-label');
    const tbody = document.getElementById('metals-body');
    const empty = document.getElementById('metals-empty');
    const table = document.getElementById('metals-table');

    const METALS = [
      { symbol: 'XAU', name: 'Gold' },
      { symbol: 'XAG', name: 'Silver' },
      { symbol: 'XPT', name: 'Platinum' },
      { symbol: 'XPD', name: 'Palladium' }
    ];

    const loadMetals = async (date) => {
      const saved = await DB.getMetalPricesForDate(date);
      const prices = (saved && saved.prices) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      METALS.forEach(m => {
        const p = prices[m.symbol];
        const tr = document.createElement('tr');
        if (p && p.chfPerGram != null) {
          tr.innerHTML = `<td><span class="rate-code">${m.name}</span> <span class="text-muted">(${m.symbol})</span></td>
            <td>${formatCurrency(p.chfPerOz, 'CHF')}</td>
            <td>${formatCurrency(p.chfPerGram, 'CHF')}/g</td>`;
        } else {
          tr.innerHTML = `<td><span class="rate-code">${m.name}</span> <span class="text-muted">(${m.symbol})</span></td>
            <td class="text-muted" colspan="2">NO PRICE</td>`;
        }
        tbody.appendChild(tr);
      });

      const hasAny = METALS.some(m => prices[m.symbol] && prices[m.symbol].chfPerGram != null);
      table.style.display = hasAny ? '' : 'none';
      empty.style.display = hasAny ? 'none' : 'block';
    };

    const allBody = document.getElementById('metals-all-body');
    const allEmpty = document.getElementById('metals-all-empty');
    const allTable = document.getElementById('metals-all-table');

    const loadAllMetals = async () => {
      const entries = await DB.getAll('metalPrices');
      const sorted = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      allBody.innerHTML = '';

      sorted.forEach(entry => {
        const chips = METALS.map(m => {
          const p = (entry.prices || {})[m.symbol];
          if (!p || p.chfPerGram == null) return null;
          return `<span class="badge badge-rate">${escapeHtml(m.name)} ${escapeHtml(formatNumber(p.chfPerGram))} CHF/g</span>`;
        }).filter(Boolean).join(' ');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(entry.date)}</td>
          <td>${chips || '<span class="text-muted">EMPTY</span>'}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-gta" onclick="Pages.loadMetalsFromHistory('${escapeHtml(entry.date)}')">OPEN</button>
          </td>`;
        allBody.appendChild(tr);
      });

      if (sorted.length === 0) {
        allTable.style.display = 'none';
        allEmpty.style.display = 'block';
      } else {
        allTable.style.display = '';
        allEmpty.style.display = 'none';
      }
    };

    if (this._metalsDateHandler) dateEl.removeEventListener('change', this._metalsDateHandler);
    this._metalsDateHandler = () => loadMetals(dateEl.value);
    dateEl.addEventListener('change', this._metalsDateHandler);

    dateEl.value = todayStr();
    loadMetals(dateEl.value);
    loadAllMetals();
  },

  async loadMetalsFromHistory(date) {
    const dateEl = document.getElementById('metals-date');
    dateEl.value = date;
    if (this._metalsDateHandler) this._metalsDateHandler();
    document.getElementById('metals-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async loadRatesFromHistory(date) {
    const dateEl = document.getElementById('rates-date');
    dateEl.value = date;
    if (this._ratesDateHandler) this._ratesDateHandler();
    document.getElementById('rates-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async saveRates() {
    const dateEl = document.getElementById('rates-date');
    const date = dateEl.value || todayStr();
    const rates = {};
    document.querySelectorAll('#rates-body .rate-input').forEach(inp => {
      const code = inp.dataset.code;
      const val = parseFloat(inp.value);
      if (val > 0) rates[code] = val;
    });
    await DB.saveRatesForDate(date, rates);
    App.toast('RATES SAVED');
  },

  async fetchRatesFromFrankfurter() {
    const btn = document.getElementById('rates-fetch-btn');
    const status = document.getElementById('rates-fetch-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';

      const accounts = await DB.getAll('accounts');
      const incomes = await DB.getAll('incomes');
      const expenses = await DB.getAll('expenses');
      const transactions = await DB.getAll('transactions');
      const assets = await DB.getAll('assets');

      const accCur = {};
      accounts.forEach(a => accCur[a.id] = a.currency || 'CHF');

      // Collect distinct (date -> set of foreign currencies) from records
      const dateCurrencies = {};
      const allForeign = new Set();
      const track = (currency) => {
        if (currency && currency !== mainCurrency) allForeign.add(currency);
      };
      const addDateCurrency = (date, currency) => {
        if (!currency || currency === mainCurrency || !date) return;
        if (!dateCurrencies[date]) dateCurrencies[date] = new Set();
        dateCurrencies[date].add(currency);
      };

      incomes.forEach(inc => { track(inc.currency); addDateCurrency(inc.date, inc.currency); });
      expenses.forEach(exp => { track(exp.currency); addDateCurrency(exp.date, exp.currency); });
      transactions.forEach(tx => {
        const cur = accCur[tx.accountId];
        track(cur);
        addDateCurrency(tx.date, cur);
      });
      accounts.forEach(a => track(a.currency));
      assets.forEach(a => {
        const cur = a.currency;
        track(cur);
        addDateCurrency(a.purchaseDate, cur);
        addDateCurrency(a.saleDate, cur);
      });

      // Ensure a "latest" snapshot so current account balances convert
      const today = todayStr();
      if (allForeign.size > 0) {
        if (!dateCurrencies[today]) dateCurrencies[today] = new Set();
        allForeign.forEach(c => dateCurrencies[today].add(c));
      }

      const dates = Object.keys(dateCurrencies).sort();
      if (dates.length === 0) {
        if (status) status.textContent = 'NO FOREIGN CURRENCIES IN USE';
        return;
      }

      const api = 'https://api.frankfurter.dev/v1';
      let filled = 0;
      let skipped = 0;
      let failed = 0;

      for (const date of dates) {
        const codes = [...dateCurrencies[date]];
        const url = api + '/' + date + '?from=' + encodeURIComponent(mainCurrency) + '&to=' + encodeURIComponent(codes.join(','));
        let data;
        try {
          const res = await fetch(url);
          if (!res.ok) { failed++; continue; }
          data = await res.json();
        } catch (e) {
          failed++;
          continue;
        }
        const fx = (data && data.rates) || {};

        const existing = await DB.getRatesForDate(date);
        const merged = Object.assign({}, existing ? existing.rates : {});
        let changed = false;
        codes.forEach(code => {
          const raw = fx[code];
          if (raw == null) return;
          if (merged[code] != null) { skipped++; return; }
          merged[code] = Math.round((1 / raw) * 10000) / 10000;
          filled++;
          changed = true;
        });
        if (changed) await DB.saveRatesForDate(date, merged);
      }

      if (status) status.textContent = 'DONE — ' + filled + ' FILLED, ' + skipped + ' SKIPPED, ' + failed + ' FAILED';
      App.toast('RATES SYNCED FROM FRANKFURTER');
      await this.exchangeRates();
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // Lightweight startup sync: fetch today's FX snapshot for currencies used by accounts only
  async fetchRatesLatest(silent) {
    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';
      const accounts = await DB.getAll('accounts');
      const foreign = [...new Set(accounts.map(a => a.currency || mainCurrency).filter(c => c && c !== mainCurrency))].sort();
      if (foreign.length === 0) return { filled: 0 };

      const today = todayStr();
      const existing = await DB.getRatesForDate(today);
      const current = (existing && existing.rates) || {};
      const missing = foreign.filter(code => current[code] == null);
      if (missing.length === 0) return { filled: 0 };

      const url = 'https://api.frankfurter.dev/v1/latest?from=' + encodeURIComponent(mainCurrency) + '&to=' + encodeURIComponent(missing.join(','));
      let data;
      try {
        const res = await fetch(url);
        if (!res.ok) return { filled: 0 };
        data = await res.json();
      } catch (e) {
        return { filled: 0 };
      }
      const fx = (data && data.rates) || {};

      const merged = Object.assign({}, current);
      let changed = false;
      let filled = 0;
      missing.forEach(code => {
        const raw = fx[code];
        if (raw == null) return;
        if (merged[code] != null) return;
        merged[code] = Math.round((1 / raw) * 10000) / 10000;
        filled++;
        changed = true;
      });
      if (changed) await DB.saveRatesForDate(today, merged);
      if (!silent) {
        App.toast('RATES SYNCED — ' + filled + ' FILLED');
        await this.exchangeRates();
      }
      return { filled };
    } catch (e) {
      return { filled: 0 };
    }
  }

};

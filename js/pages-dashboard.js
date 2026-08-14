Object.assign(Pages, {
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
        if (!prev || (t.date || '') >= (prev.date || '')) accTxs[t.accountId] = t;
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

    // Earning performance last 12 months
    const allIncomes = await DB.getAll('incomes');
    const allExpenses = await DB.getAll('expenses');
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const todayDate = new Date();
    const months = [];
    for (let i = 12; i >= 0; i--) {
      const d = new Date(todayDate.getFullYear(), todayDate.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      months.push(y + '-' + m);
    }

    const earningGrid = document.getElementById('earning-perf-grid');
    const earningEmpty = document.getElementById('earning-perf-empty');
    const earningLeft = document.getElementById('earning-perf-left');
    const earningRight = document.getElementById('earning-perf-right');
    if (!earningGrid) return;
    earningGrid.innerHTML = '';

    const monthlyRoi = _monthlyPctSeries(investAccountIds, investTxs);
    const monthCards = [];
    const MAX_VISIBLE = 4;
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
      col.className = 'col-3 earning-col';
      col.innerHTML = '<div class="earning-month">' +
        '<div class="earning-month-label">' + monthLabel + '</div>' +
        '<div class="earning-month-line"><span class="lbl">INCOME - EXPENSES</span><span class="val">' + formatCurrency(expected, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">INVESTED + SAVED</span><span class="val">' + formatCurrency(netDeposits, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">MANAGEMENT PERFORMANCE</span><span class="val" style="color:' + perfColor + '">' + perfText + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">INVESTMENT PERFORMANCE</span><span class="val" style="color:' + roiColor + '">' + roiText + '</span></div>' +
        '</div>';
      monthCards.push(col);
      earningGrid.appendChild(col);
    });

    let carouselOffset = months.length - MAX_VISIBLE;
    const renderCarousel = () => {
      if (!earningLeft || !earningRight) return;
      monthCards.forEach((card, i) => {
        card.style.display = (i >= carouselOffset && i < carouselOffset + MAX_VISIBLE) ? '' : 'none';
      });
      earningLeft.disabled = carouselOffset <= 0;
      earningRight.disabled = carouselOffset >= months.length - MAX_VISIBLE;
    };
    if (earningLeft && earningRight) {
      earningLeft.addEventListener('click', () => {
        if (carouselOffset > 0) {
          carouselOffset--;
          renderCarousel();
        }
      });
      earningRight.addEventListener('click', () => {
        if (carouselOffset < months.length - MAX_VISIBLE) {
          carouselOffset++;
          renderCarousel();
        }
      });
    }
    renderCarousel();

    if (!hasData) {
      if (earningEmpty) earningEmpty.style.display = 'block';
      if (earningLeft) earningLeft.disabled = true;
      if (earningRight) earningRight.disabled = true;
    } else {
      if (earningEmpty) earningEmpty.style.display = 'none';
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
        col.className = 'col-md-4 goal-col goal-col-flush';
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
      roiMonths = roiMonths.slice(-12);
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

      const initialDate = new Date(baseYear, baseMonth - 12, 1);
      const initialMonthKey = initialDate.getFullYear() + '-' + String(initialDate.getMonth() + 1).padStart(2, '0');
      const initialVal = monthTotals[initialMonthKey];

      const growthAmt = projectedValue - anchorVal;
      const growthPct = anchorVal > 0 ? (growthAmt / anchorVal) * 100 : 0;

      const initialEl = document.getElementById('forecast-initial');
      if (initialEl) initialEl.textContent = initialVal !== undefined ? formatCurrency(initialVal, mainCurrency) : 'N/A';
      const currentEl = document.getElementById('forecast-current');
      if (currentEl) currentEl.textContent = formatCurrency(anchorVal, mainCurrency);
      const projectedEl = document.getElementById('forecast-projected');
      if (projectedEl) projectedEl.textContent = formatCurrency(projectedValue, mainCurrency);
      const growthEl = document.getElementById('forecast-growth');
      if (growthEl) {
        growthEl.innerHTML = (growthAmt >= 0 ? '+' : '') + formatCurrency(growthAmt, mainCurrency) + ' <span class="perf-pct">(' + (growthPct >= 0 ? '+' : '') + growthPct.toFixed(2) + '%)</span>';
        growthEl.className = 'stat-value forecast-stat ' + (growthAmt >= 0 ? 'pos' : 'neg');
      }
      const roiEl = document.getElementById('forecast-roi');
      if (roiEl) {
        roiEl.innerHTML = (mean >= 0 ? '+' : '') + (mean * 100).toFixed(2) + '% <span class="perf-pct">+/&minus;' + (stdev * 100).toFixed(2) + '%</span>';
        roiEl.className = 'stat-value forecast-stat ' + (mean >= 0 ? 'pos' : 'neg');
      }

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

    // ==================== YEARLY PERFORMANCE ====================
    (function() {
      const grid = document.getElementById('decade-anal-grid');
      const empty = document.getElementById('decade-anal-empty');
      const leftBtn = document.getElementById('decade-anal-left');
      const rightBtn = document.getElementById('decade-anal-right');
      if (!grid || !empty) return;

      const curYear = todayStr().substring(0, 4);
      const candidateYears = [];
      for (let i = 4; i >= 0; i--) candidateYears.push(String(Number(curYear) - i));

      const flowTypes = ['deposit', 'withdrawal', 'valuation', 'buy', 'sell', 'asset-add', 'asset-sell'];
      const sortedTxs = transactions
        .filter(t => flowTypes.includes(t.type))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      const investedByYear = {};
      sortedTxs.forEach(t => {
        const y = (t.date || '').substring(0, 4);
        if (!y) return;
        if (t.type === 'deposit') investedByYear[y] = (investedByYear[y] || 0) + Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
        else if (t.type === 'withdrawal') investedByYear[y] = (investedByYear[y] || 0) - Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
        else if (t.type === 'buy') investedByYear[y] = (investedByYear[y] || 0) + Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
        else if (t.type === 'sell') investedByYear[y] = (investedByYear[y] || 0) - Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
      });

      const netWorthAt = (eoyDate) => {
        const lastByAccount = {};
        sortedTxs.forEach(t => {
          if ((t.date || '') > eoyDate) return;
          const prev = lastByAccount[t.accountId];
          if (!prev || (t.date || '') > (prev.date || '')) lastByAccount[t.accountId] = t;
        });

        const accountValueAt = (a) => {
          if (a.accountType === 'Tangible Asset') {
            const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
            return { value: assetAccountMetrics(accountAssets[a.id], eoyDate, rateToAcc).value, date: eoyDate };
          }
          if (a.accountType === 'Precious Metal' && eoyDate === todayStr()) {
            return { value: metalAccountValue(a, metalEntry, rateEntries, eoyDate), date: eoyDate };
          }
          const last = lastByAccount[a.id];
          if (last) return { value: last.balanceAfter || 0, date: last.date };
          if (eoyDate === todayStr()) return { value: a.currentValue || 0, date: eoyDate };
          return { value: 0, date: eoyDate };
        };

        let netWorth = 0;
        let liqNetWorth = 0;
        accounts.forEach(a => {
          if (a.includeInNetWorth === false) return;
          const v = accountValueAt(a);
          const val = v.value * rateFor(accCurrency[a.id], v.date);
          netWorth += val;
          if (a.includeInLiquidNetWorth !== false && a.portfolioId != 3) liqNetWorth += val;
        });
        return { netWorth, liqNetWorth };
      };

      const yearStats = {};
      candidateYears.forEach(year => {
        const eoyDate = year === curYear ? todayStr() : (year + '-12-31');
        const { netWorth, liqNetWorth } = netWorthAt(eoyDate);

        const isCurYear = year === curYear;
        const curMonthKey = todayStr().substring(0, 7);
        const income = allIncomes
          .filter(inc => (inc.month || '').startsWith(year) && (!isCurYear || (inc.month || '') <= curMonthKey))
          .reduce((s, inc) => s + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || ((inc.month || (year + '-01')) + '-01')), 0);

        const monthsElapsed = isCurYear ? Math.max(0, Number(curMonthKey.substring(5, 7)) - 1) : 12;
        let expenses = 0;
        allExpenses.filter(exp => exp.year === year).forEach(exp => {
          const v = (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01'));
          expenses += exp.type === 'monthly' ? v * monthsElapsed : v;
        });

        const investedSaved = investedByYear[year] || 0;
        const surplus = income - expenses;
        const mgmtPct = surplus > 0 ? (investedSaved / surplus) * 100 : null;

        yearStats[year] = { netWorth, liqNetWorth, mgmtPct };
      });

      const years = candidateYears.filter(year => {
        const hasTx = sortedTxs.some(t => (t.date || '').startsWith(year) && ['deposit', 'withdrawal', 'buy', 'sell', 'valuation'].includes(t.type));
        const hasInc = allIncomes.some(inc => (inc.month || '').startsWith(year));
        const hasExp = allExpenses.some(exp => exp.year === year);
        return hasTx || hasInc || hasExp;
      });

      const firstYear = years[0];
      const boy = firstYear ? netWorthAt(firstYear + '-01-01') : null;

      const cards = [];
      grid.innerHTML = '';

      years.forEach((year, idx) => {
        const s = yearStats[year];
        const base = idx > 0 ? yearStats[years[idx - 1]] : boy;
        const nwGrowth = base ? s.netWorth - base.netWorth : null;
        const lqGrowth = base ? s.liqNetWorth - base.liqNetWorth : null;

        const growthHtml = (amt) => {
          if (amt === null || amt === undefined) return '<span class="val" style="color:#555">N/A</span>';
          return '<span class="val" style="color:' + (amt >= 0 ? '#33ff33' : '#ff3333') + '">' + (amt >= 0 ? '+' : '') + formatCurrency(amt, mainCurrency) + '</span>';
        };

        const mgmtColor = s.mgmtPct === null ? '#555' : (s.mgmtPct >= 0 ? '#33ff33' : '#ff3333');
        const mgmtText = s.mgmtPct === null ? 'N/A' : (s.mgmtPct >= 0 ? '+' : '') + s.mgmtPct.toFixed(0) + '%';

        const col = document.createElement('div');
        col.className = 'col-3 earning-col';
        col.innerHTML = '<div class="earning-month">' +
          '<div class="earning-month-label">' + year + '</div>' +
          '<div class="earning-month-line"><span class="lbl">NET WORTH EOY</span><span class="val">' + formatCurrency(s.netWorth, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">NET WORTH GROWTH</span>' + growthHtml(nwGrowth) + '</div>' +
          '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH EOY</span><span class="val">' + formatCurrency(s.liqNetWorth, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH GROWTH</span>' + growthHtml(lqGrowth) + '</div>' +
          '<div class="earning-month-line"><span class="lbl">MANAGEMENT PERFORMANCE</span><span class="val" style="color:' + mgmtColor + '">' + mgmtText + '</span></div>' +
          '</div>';
        cards.push(col);
        grid.appendChild(col);
      });

      if (years.length === 0) {
        empty.style.display = 'block';
        if (leftBtn) leftBtn.disabled = true;
        if (rightBtn) rightBtn.disabled = true;
        return;
      }
      empty.style.display = 'none';

      const MAX_VISIBLE = 4;
      let offset = Math.max(0, years.length - MAX_VISIBLE);
      const renderCarousel = () => {
        cards.forEach((card, i) => {
          card.style.display = (i >= offset && i < offset + MAX_VISIBLE) ? '' : 'none';
        });
        if (leftBtn) leftBtn.disabled = offset <= 0;
        if (rightBtn) rightBtn.disabled = offset >= years.length - MAX_VISIBLE;
      };
      if (leftBtn) leftBtn.addEventListener('click', () => { if (offset > 0) { offset--; renderCarousel(); } });
      if (rightBtn) rightBtn.addEventListener('click', () => { if (offset < years.length - MAX_VISIBLE) { offset++; renderCarousel(); } });
      renderCarousel();
    })();

    // Portfolio allocation chart (doughnut)
    const allocCanvas = document.getElementById('chart-allocation');
    if (allocCanvas) {
      const labels = [];
      const values = [];
      const colors = [];
      const rows = [];
      const palette = ['#33ff33', '#33ccff', '#ffaa00', '#ff6633', '#cc33ff', '#33ffcc', '#ff3388'];
      let ci = 0;
      Object.values(pfValues).forEach(p => {
        if (p.value > 0) {
          const pct = totalValue > 0 ? Math.round(p.value / totalValue * 100) : 0;
          labels.push(p.name + ' (' + pct + '%)');
          values.push(p.value);
          const color = palette[ci % palette.length];
          colors.push(color);
          rows.push({ name: p.name, pct, color });
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
            legend: { display: false }
          }
        }
      });
      const legendEl = document.getElementById('alloc-legend');
      if (legendEl) {
        legendEl.innerHTML = rows.length
          ? rows.map(r =>
              '<div class="alloc-legend-row">' +
                '<span class="alloc-legend-swatch" style="background:' + r.color + '"></span>' +
                '<span class="alloc-legend-pct">' + r.pct + '%</span>' +
                '<span class="alloc-legend-name">' + escapeHtml(r.name) + '</span>' +
              '</div>'
            ).join('')
          : '<div class="alloc-legend-row"><span class="alloc-legend-name">NO DATA</span></div>';
      }
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

      const showAverage = opts && opts.average;
      const datasets = [{
        label: isPercent ? 'MONTHLY P/L %' : 'TOTAL VALUE',
        data: values,
        borderColor: color,
        backgroundColor: color + '0d',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: color,
        borderWidth: 2
      }];
      if (showAverage) {
        const avg = values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
        datasets.push({
          label: 'AVG',
          data: values.map(() => avg),
          borderColor: '#ffaa00',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0
        });
      }

      App._charts[chartKey] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: showAverage, labels: { color: '#aaa', boxWidth: 14, font: { size: 9, family: "'Share Tech Mono', monospace" } } }
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
      _renderRangeChart(investCanvas, 'investment', investAccountIds, investTxs, range, '#33ccff', { percent: true, average: true });
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
        tr.innerHTML = `<td><span class="tx-badge ${typeClass}">${typeLabel}</span></td>
          <td>${acc ? escapeHtml(acc.name) : '—'}</td>
          <td>${displayAmount}</td>
          <td>${formatDate(tx.date)}</td>`;
        tbody.appendChild(tr);
      });
    }
  },
});
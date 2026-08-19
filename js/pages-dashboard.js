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
      let netDeposits = 0;
      txList.forEach(tx => {
        if (tx.date < cutoffDate) return;
        if (tx.type === 'deposit' && !_isOpeningContribution(tx)) netDeposits += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'withdrawal') netDeposits -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'buy') netDeposits += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'sell') netDeposits -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        // Opening valuations count as capital (pre-existing wealth entered tracking)
        if (_isOpeningTx(tx)) {
          netDeposits += tx.amount * rateFor(accCurrency[tx.accountId], tx.date);
        }
      });
      const abs = currentTotal - totalAtCutoff - netDeposits;
      const base = totalAtCutoff + netDeposits;
      const pct = base !== 0 ? (abs / base) * 100 : 0;
      return { abs, pct };
    }

    // Performance scope — accounts flagged "Include in Performance" (trackPerformance)
    const perfCurrentTotal = Object.values(_perfBal).reduce((s, v) => s + v, 0);
    const _invPerfSince = (cutoffDate) => _computePerfSince(perfAccountIds, perfTxs, cutoffDate, perfCurrentTotal);

    const today = todayStr();
    const curYear = today.substring(0, 4);
    const ytdCutoff = curYear + '-01-01';
    const oneYearAgo = String(Number(curYear) - 1) + today.substring(4);
    const twoYearsAgo = String(Number(curYear) - 2) + today.substring(4);
    const threeYearsAgo = String(Number(curYear) - 3) + today.substring(4);

    // Set initial YTD
    const perfEl = document.getElementById('dash-perf-value');
    const activePerf = document.querySelector('#perf-selectors .perf-btn.active');
    const perfMap = { ytd: _invPerfSince(ytdCutoff), '1y': _invPerfSince(oneYearAgo), '2y': _invPerfSince(twoYearsAgo), '3y': _invPerfSince(threeYearsAgo), max: _invPerfSince(perfTxs.length > 0 ? perfTxs[0].date : today) };
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

    const monthlyRoi = _monthlyPctSeries(perfAccountIds, perfTxs);
    const monthCards = [];
    const MAX_VISIBLE = 4;
    let hasData = false;

    // Net worth / liquid net worth at the end of a given month (replicates yearly logic)
    const monthEndDate = (mk) => {
      if (mk === todayStr().substring(0, 7)) return todayStr();
      const y = Number(mk.substring(0, 4));
      const m = Number(mk.substring(5, 7));
      return mk + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
    };
    const flowSorted = transactions
      .filter(t => t.type === 'deposit' || t.type === 'withdrawal' || t.type === 'valuation' || t.type === 'buy' || t.type === 'sell' || t.type === 'asset-add' || t.type === 'asset-sell')
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const netWorthAtMonth = (mk) => {
      const end = monthEndDate(mk);
      const lastByAccount = {};
      flowSorted.forEach(t => {
        if ((t.date || '') > end) return;
        const prev = lastByAccount[t.accountId];
        if (!prev || (t.date || '') > (prev.date || '')) lastByAccount[t.accountId] = t;
      });
      const accountValueAt = (a) => {
        if (a.accountType === 'Tangible Asset') {
          const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', a.currency || 'CHF', date);
          return { value: assetAccountMetrics(accountAssets[a.id], end, rateToAcc).value, date: end };
        }
        if (a.accountType === 'Precious Metal' && end === todayStr()) {
          return { value: metalAccountValue(a, metalEntry, rateEntries, end), date: end };
        }
        const last = lastByAccount[a.id];
        if (last) return { value: last.balanceAfter || 0, date: last.date };
        if (end === todayStr()) return { value: a.currentValue || 0, date: end };
        return { value: 0, date: end };
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
    let prevNw = null;
    let prevLq = null;

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
      const yearlyForMonth = yearExpenses
        .filter(exp => exp.type === 'yearly' && (!exp.paymentMonth || Number(exp.paymentMonth) === mNum))
        .reduce((sum, exp) => sum + (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01')), 0);
      const totalExpenses = monthlyTot + yearlyForMonth;

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
      const grossDeposits = monthTxs
        .filter(tx => tx.type === 'deposit' || tx.type === 'withdrawal')
        .reduce((sum, tx) => {
          if (tx.type === 'deposit') return sum + Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          return sum - Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        }, 0);

      if (monthIncome > 0 || netDeposits !== 0) hasData = true;

      const roiVal = monthlyRoi[monthKey];
      const roiText = roiVal ? formatCurrency(roiVal.abs, mainCurrency) + ' (' + (roiVal.abs >= 0 ? '+' : '') + roiVal.pct.toFixed(2) + '%)' : 'N/A';
      const roiColor = roiVal ? (roiVal.abs >= 0 ? '#33ff33' : '#ff3333') : '#555';

      const savingsRate = monthIncome > 0 ? (expected / monthIncome) * 100 : null;
      const savingsRateText = savingsRate === null ? 'N/A' : (savingsRate >= 0 ? '+' : '') + savingsRate.toFixed(1) + '%';
      const savingsRateColor = savingsRate === null ? '#555' : (savingsRate >= 0 ? '#33ff33' : '#ff3333');
      const capDeployment = expected > 0 ? (netDeposits / expected) * 100 : null;
      const capDeploymentText = capDeployment === null ? 'N/A' : capDeployment.toFixed(1) + '%';

      const nw = netWorthAtMonth(monthKey);
      const nwGrowth = prevNw !== null ? nw.netWorth - prevNw : null;
      const lqGrowth = prevLq !== null ? nw.liqNetWorth - prevLq : null;
      prevNw = nw.netWorth;
      prevLq = nw.liqNetWorth;
      const growthHtml = (amt) => {
        if (amt === null || amt === undefined) return '<span class="val" style="color:#555">N/A</span>';
        return '<span class="val" style="color:' + (amt >= 0 ? '#33ff33' : '#ff3333') + '">' + (amt >= 0 ? '+' : '') + formatCurrency(amt, mainCurrency) + '</span>';
      };

      const col = document.createElement('div');
      col.className = 'col-3 earning-col';
      col.innerHTML = '<div class="earning-month">' +
        '<div class="earning-month-label">' + monthLabel + '</div>' +
        '<div class="earning-month-line"><span class="lbl">INCOME</span><span class="val">' + formatCurrency(monthIncome, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">EXPENSES</span><span class="val">' + formatCurrency(totalExpenses, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">NET INCOME</span><span class="val">' + formatCurrency(expected, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">SAVINGS RATE</span><span class="val" style="color:' + savingsRateColor + '">' + savingsRateText + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">TOTAL SAVED</span><span class="val">' + formatCurrency(grossDeposits, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">CAPITAL DEPLOYMENT<span class="info-icon" title="How much of your net income actually reached your accounts. Formula: NET DEPOSITS (deposits + buys - withdrawals - sells) \u00F7 NET INCOME \u00D7 100. Above 100% means you also drew on existing cash.">i</span></span><span class="val" style="color:#33ff33">' + capDeploymentText + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">INVESTMENT PERFORMANCE</span><span class="val" style="color:' + roiColor + '">' + roiText + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">NET WORTH EoM</span><span class="val">' + formatCurrency(nw.netWorth, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">NET WORTH GROWTH</span>' + growthHtml(nwGrowth) + '</div>' +
        '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH EoM</span><span class="val">' + formatCurrency(nw.liqNetWorth, mainCurrency) + '</span></div>' +
        '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH GROWTH</span>' + growthHtml(lqGrowth) + '</div>' +
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
          if ((tx.type === 'deposit' && !_isOpeningContribution(tx)) || tx.type === 'buy' || tx.type === 'asset-add') {
            monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          } else if (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') {
            monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          } else if (_isOpeningTx(tx)) {
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
                font: { family: "'Share Tech Mono', monospace", size: 12 },
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
                font: { size: 12, family: "'Share Tech Mono', monospace" },
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
                font: { size: 12, family: "'Share Tech Mono', monospace" },
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

      // Net deposits per year (saving performance)
      const depositsByYear = {};
      sortedTxs.forEach(t => {
        const y = (t.date || '').substring(0, 4);
        if (!y) return;
        if (t.type === 'deposit') depositsByYear[y] = (depositsByYear[y] || 0) + Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
        else if (t.type === 'withdrawal') depositsByYear[y] = (depositsByYear[y] || 0) - Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
      });

      // Gross deposits per year into performance-tracked accounts only
      const perfDepositsByYear = {};
      perfTxs.forEach(t => {
        const y = (t.date || '').substring(0, 4);
        if (!y || t.type !== 'deposit') return;
        perfDepositsByYear[y] = (perfDepositsByYear[y] || 0) + Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
      });

      // Value of performance-tracked accounts at a given date
      const perfValueAt = (date) => {
        const lastByAccount = {};
        perfTxs.forEach(t => {
          if ((t.date || '') > date) return;
          const prev = lastByAccount[t.accountId];
          if (!prev || (t.date || '') > (prev.date || '')) lastByAccount[t.accountId] = t;
        });
        let total = 0;
        perfAccountIds.forEach(id => {
          const last = lastByAccount[id];
          if (last) total += (last.balanceAfter || 0) * rateFor(accCurrency[id], last.date);
          else if (date === todayStr()) {
            const acc = accounts.find(a => a.id === id);
            total += (acc ? (acc.currentValue || 0) : 0) * rateFor(accCurrency[id], date);
          }
        });
        return total;
      };

      // Net flows (deposits/withdrawals/buys/sells) within a date window for perf-tracked accounts
      const perfNetFlows = (startDate, endDate) => {
        let net = 0;
        perfTxs.forEach(t => {
          if ((t.date || '') < startDate || (t.date || '') > endDate) return;
          if (t.type === 'deposit' && !_isOpeningContribution(t)) net += Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
          else if (t.type === 'withdrawal') net -= Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
          else if (t.type === 'buy') net += Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
          else if (t.type === 'sell') net -= Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
          else if (_isOpeningTx(t)) net += Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
        });
        return net;
      };

      // Unrealized P/L of perf-tracked accounts for a given year
      const perfPlForYear = (year) => {
        const boy = year + '-01-01';
        const eoy = year === curYear ? todayStr() : year + '-12-31';
        const valueEoy = perfValueAt(eoy);
        const valueBoy = perfValueAt(boy);
        const flows = perfNetFlows(boy, eoy);
        const abs = valueEoy - valueBoy - flows;
        const base = valueBoy + flows;
        return { abs, pct: base !== 0 ? (abs / base) * 100 : 0, roiPct: valueBoy !== 0 ? (abs / valueBoy) * 100 : null };
      };

      // Value of perf-tracked accounts using last snapshot strictly before a given date
      const perfValueBefore = (date) => {
        const lastByAccount = {};
        perfTxs.forEach(t => {
          if ((t.date || '') >= date) return;
          const prev = lastByAccount[t.accountId];
          if (!prev || (t.date || '') > (prev.date || '')) lastByAccount[t.accountId] = t;
        });
        let total = 0;
        perfAccountIds.forEach(id => {
          const last = lastByAccount[id];
          if (last) total += (last.balanceAfter || 0) * rateFor(accCurrency[id], last.date);
        });
        return total;
      };

      // Time-weighted return: geometrically links sub-period returns between cash-flow dates
      const twrForYear = (year) => {
        const boy = year + '-01-01';
        const eoy = year === curYear ? todayStr() : year + '-12-31';
        const flowDates = [...new Set(
          perfTxs
            .filter(t => (t.date || '') >= boy && (t.date || '') <= eoy && (['deposit', 'withdrawal', 'buy', 'sell'].includes(t.type) ? !_isOpeningContribution(t) : _isOpeningTx(t)))
            .map(t => t.date)
        )].sort();

        let product = 1;
        let prevVal = perfValueAt(boy);
        flowDates.forEach(d => {
          const before = perfValueBefore(d);
          if (prevVal !== 0) product *= (before / prevVal);
          prevVal = perfValueAt(d);
        });
        const valEoy = perfValueAt(eoy);
        if (prevVal !== 0) product *= (valEoy / prevVal);
        return (product - 1) * 100;
      };

      // Money-weighted return (IRR): rate r solving NPV of all flows = 0
      const mwrForYear = (year) => {
        const boy = year + '-01-01';
        const eoy = year === curYear ? todayStr() : year + '-12-31';
        const t0 = new Date(boy).getTime();
        const tEoy = new Date(eoy).getTime();
        const flows = [{ t: 0, v: -perfValueAt(boy) }];
        perfTxs.forEach(t => {
          if ((t.date || '') < boy || (t.date || '') > eoy) return;
          const y = (new Date(t.date).getTime() - t0) / (tEoy - t0);
          const amt = Math.abs(t.amount) * rateFor(accCurrency[t.accountId], t.date);
          if ((t.type === 'deposit' && !_isOpeningContribution(t)) || t.type === 'buy' || _isOpeningTx(t)) flows.push({ t: y, v: -amt });
          else if (t.type === 'withdrawal' || t.type === 'sell') flows.push({ t: y, v: amt });
        });
        flows.push({ t: 1, v: perfValueAt(eoy) });

        const npv = (r) => flows.reduce((s, f) => s + f.v / Math.pow(1 + r, f.t), 0);
        let lo = -0.999;
        let hi = 10;
        if (npv(lo) * npv(hi) > 0) return null;
        for (let i = 0; i < 200; i++) {
          const mid = (lo + hi) / 2;
          if (npv(mid) * npv(lo) > 0) lo = mid;
          else hi = mid;
        }
        return ((lo + hi) / 2) * 100;
      };

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

      const curMonthKey = todayStr().substring(0, 7);
      const curMonthNum = Number(curMonthKey.substring(5, 7));
      const monthsElapsedCur = Math.max(0, curMonthNum - 1);

      const incomeUpTo = (year, upToMonth) => allIncomes
        .filter(inc => (inc.month || '').startsWith(year) && (!upToMonth || Number((inc.month || '').substring(5, 7)) <= upToMonth))
        .reduce((sum, inc) => sum + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || ((inc.month || (year + '-01')) + '-01')), 0);

      const expensesUpTo = (year, monthsCount) => {
        let tot = 0;
        allExpenses.filter(exp => exp.year === year).forEach(exp => {
          const v = (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01'));
          if (exp.type === 'monthly') tot += v * monthsCount;
          else if (!exp.paymentMonth || Number(exp.paymentMonth) <= monthsCount) tot += v;
        });
        return tot;
      };

      const yearStats = {};
      candidateYears.forEach(year => {
        const eoyDate = year === curYear ? todayStr() : (year + '-12-31');
        const { netWorth, liqNetWorth } = netWorthAt(eoyDate);

        const isCurYear = year === curYear;
        const income = isCurYear ? incomeUpTo(year, curMonthNum) : incomeUpTo(year, null);
        const expenses = isCurYear ? expensesUpTo(year, monthsElapsedCur) : expensesUpTo(year, 12);

        const investedSaved = investedByYear[year] || 0;
        const surplus = income - expenses;
        const savingPerf = depositsByYear[year] || 0;
        const savingsRate = income > 0 ? (surplus / income) * 100 : null;
        const investPerf = perfPlForYear(year);
        const twr = twrForYear(year);
        const mwr = mwrForYear(year);

        yearStats[year] = { netWorth, liqNetWorth, netDeposits: investedSaved, income, expenses, surplus, savingPerf, savingsRate, investPerf, twr, mwr };
      });

      const years = candidateYears.filter(year => {
        const hasTx = sortedTxs.some(t => (t.date || '').startsWith(year) && ['deposit', 'withdrawal', 'buy', 'sell', 'valuation'].includes(t.type));
        const hasInc = allIncomes.some(inc => (inc.month || '').startsWith(year));
        const hasExp = allExpenses.some(exp => exp.year === year);
        return hasTx || hasInc || hasExp;
      });
      const yearsSet = new Set(years);

      // Year-over-year deltas (previous calendar year as base; only if that year has data).
      // For the current (partial) year, the previous year is prorated to the same period for a fair comparison.
      Object.keys(yearStats).forEach(year => {
        const prevYear = String(Number(year) - 1);
        const prev = yearsSet.has(prevYear) ? yearStats[prevYear] : null;
        const s = yearStats[year];
        const isCurYear = year === curYear;
        const prevIncome = isCurYear && prev ? incomeUpTo(prevYear, curMonthNum) : (prev ? prev.income : null);
        const prevExpenses = isCurYear && prev ? expensesUpTo(prevYear, monthsElapsedCur) : (prev ? prev.expenses : null);
        s.incomeDelta = prevIncome === null ? null : s.income - prevIncome;
        s.expenseDelta = prevExpenses === null ? null : s.expenses - prevExpenses;
        s.savingsRateDelta = (prev && s.savingsRate !== null && prev.savingsRate !== null) ? s.savingsRate - prev.savingsRate : null;
        s.capitalDeployment = s.surplus > 0 ? (s.netDeposits / s.surplus) * 100 : null;
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

        const investPerfText = (s.investPerf.abs >= 0 ? '+' : '') + formatCurrency(s.investPerf.abs, mainCurrency) + ' (' + (s.investPerf.pct >= 0 ? '+' : '') + s.investPerf.pct.toFixed(2) + '%)';
        const investPerfColor = s.investPerf.abs >= 0 ? '#33ff33' : '#ff3333';
        const savingsRateText = s.savingsRate === null ? 'N/A' : (s.savingsRate >= 0 ? '+' : '') + s.savingsRate.toFixed(1) + '%';
        const savingsRateColor = s.savingsRate === null ? '#555' : (s.savingsRate >= 0 ? '#33ff33' : '#ff3333');

        const deltaHtml = (delta, opts) => {
          if (delta === null || delta === undefined) return '<span class="val" style="color:#555">N/A</span>';
          const good = opts && opts.invert ? delta < 0 : delta >= 0;
          const color = good ? '#33ff33' : '#ff3333';
          let txt = (delta >= 0 ? '+' : '-') + formatCurrency(Math.abs(delta), mainCurrency);
          if (opts && opts.pct && opts.base) txt += ' (' + (delta >= 0 ? '+' : '-') + ((Math.abs(delta) / Math.abs(opts.base)) * 100).toFixed(1) + '%)';
          return '<span class="val" style="color:' + color + '">' + txt + '</span>';
        };

        const info = (title) => '<span class="info-icon" title="' + title + '">i</span>';

        const incomeDeltaHtml = deltaHtml(s.incomeDelta, { pct: true, base: s.income - (s.incomeDelta || 0) });
        const expenseDeltaHtml = deltaHtml(s.expenseDelta, { pct: true, base: s.expenses - (s.expenseDelta || 0), invert: true });
        const savingsDeltaColor = s.savingsRateDelta === null || s.savingsRateDelta >= 0 ? '#33ff33' : '#ff3333';
        const savingsDeltaText = s.savingsRateDelta === null ? 'N/A' : (s.savingsRateDelta >= 0 ? '+' : '') + s.savingsRateDelta.toFixed(1) + 'pp';
        const capDeployText = s.capitalDeployment === null ? 'N/A' : s.capitalDeployment.toFixed(1) + '%';
        const twrText = s.twr === null || s.twr === undefined ? 'N/A' : (s.twr >= 0 ? '+' : '') + s.twr.toFixed(2) + '%';
        const twrColor = s.twr >= 0 ? '#33ff33' : '#ff3333';
        const mwrText = s.mwr === null || s.mwr === undefined ? 'N/A' : (s.mwr >= 0 ? '+' : '') + s.mwr.toFixed(2) + '%';
        const mwrColor = s.mwr >= 0 ? '#33ff33' : '#ff3333';

        const col = document.createElement('div');
        col.className = 'col-3 earning-col';
        col.innerHTML = '<div class="earning-month">' +
          '<div class="earning-month-label">' + year + '</div>' +
          '<div class="earning-month-line"><span class="lbl">INCOME</span><span class="val">' + formatCurrency(s.income, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">INCOME YoY' + info('Change in income vs previous year') + '</span>' + incomeDeltaHtml + '</div>' +
          '<div class="earning-month-line"><span class="lbl">EXPENSES</span><span class="val">' + formatCurrency(s.expenses, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">EXPENSES YoY' + info('Change in expenses vs previous year') + '</span>' + expenseDeltaHtml + '</div>' +
          '<div class="earning-month-line"><span class="lbl">NET INCOME</span><span class="val">' + formatCurrency(s.surplus, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">SAVINGS RATE' + info('Share of income not spent. Formula: NET INCOME \u00F7 INCOME \u00D7 100') + '</span><span class="val" style="color:' + savingsRateColor + '">' + savingsRateText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">SAVINGS RATE YoY' + info('Change in savings rate vs previous year, in percentage points') + '</span><span class="val" style="color:' + savingsDeltaColor + '">' + savingsDeltaText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">TOTAL SAVED' + info('Deposits minus withdrawals made into all accounts during the year') + '</span><span class="val">' + formatCurrency(s.savingPerf, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">CAPITAL DEPLOYMENT' + info('How much of your net income actually reached your accounts. Formula: NET DEPOSITS (deposits + buys - withdrawals - sells) \u00F7 NET INCOME \u00D7 100. Above 100% means you also drew on existing cash.') + '</span><span class="val" style="color:#33ff33">' + capDeployText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">INVESTMENTS PERFORMANCE' + info('Gain in investment accounts relative to capital deployed. Formula: (value EoY - value BoY - net flows) \u00F7 (value BoY + net flows) \u00D7 100') + '</span><span class="val" style="color:' + investPerfColor + '">' + investPerfText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">TWR' + info('Time-weighted return: isolates market performance by removing the effect of cash flow timing. Best measure to compare against an index.') + '</span><span class="val" style="color:' + twrColor + '">' + twrText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">MWR' + info('Money-weighted return (IRR): accounts for the size and timing of every deposit/withdrawal, weighted by how long money was invested. Best measure of your personal experience.') + '</span><span class="val" style="color:' + mwrColor + '">' + mwrText + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">NET WORTH EoY</span><span class="val">' + formatCurrency(s.netWorth, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">NET WORTH GROWTH' + info('Change in net worth vs previous year-end') + '</span>' + growthHtml(nwGrowth) + '</div>' +
          '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH EoY</span><span class="val">' + formatCurrency(s.liqNetWorth, mainCurrency) + '</span></div>' +
          '<div class="earning-month-line"><span class="lbl">LIQUID NET WORTH GROWTH' + info('Change in liquid net worth vs previous year-end') + '</span>' + growthHtml(lqGrowth) + '</div>' +
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

      const zeroFillPlugin = isPercent ? {
        id: 'zeroFillSplit',
        beforeDatasetsDraw(chart) {
          const meta = chart.getDatasetMeta(0);
          if (!meta || meta.hidden) return;
          const ctx = chart.ctx;
          const yScale = chart.scales.y;
          const pts = meta.data;
          if (!pts || pts.length < 2) return;

          const zeroY = yScale.getPixelForValue(0);
          ctx.save();

          for (let i = 0; i < pts.length - 1; i++) {
            const x0 = pts[i].x, y0 = pts[i].y;
            const x1 = pts[i + 1].x, y1 = pts[i + 1].y;
            const v0 = values[i], v1 = values[i + 1];
            const pos0 = v0 >= 0, pos1 = v1 >= 0;

            if (pos0 === pos1) {
              ctx.beginPath();
              ctx.moveTo(x0, zeroY);
              ctx.lineTo(x0, y0);
              ctx.lineTo(x1, y1);
              ctx.lineTo(x1, zeroY);
              ctx.closePath();
              ctx.fillStyle = pos0 ? 'rgba(51,255,51,0.18)' : 'rgba(255,51,51,0.18)';
              ctx.fill();
            } else {
              const t = (0 - v0) / (v1 - v0);
              const xCross = x0 + t * (x1 - x0);
              if (pos0) {
                ctx.beginPath(); ctx.moveTo(x0, zeroY); ctx.lineTo(x0, y0); ctx.lineTo(xCross, zeroY); ctx.closePath();
                ctx.fillStyle = 'rgba(51,255,51,0.18)'; ctx.fill();
              }
              if (pos1) {
                ctx.beginPath(); ctx.moveTo(xCross, zeroY); ctx.lineTo(x1, y1); ctx.lineTo(x1, zeroY); ctx.closePath();
                ctx.fillStyle = 'rgba(51,255,51,0.18)'; ctx.fill();
              }
              if (!pos0) {
                ctx.beginPath(); ctx.moveTo(x0, zeroY); ctx.lineTo(x0, y0); ctx.lineTo(xCross, zeroY); ctx.closePath();
                ctx.fillStyle = 'rgba(255,51,51,0.18)'; ctx.fill();
              }
              if (!pos1) {
                ctx.beginPath(); ctx.moveTo(xCross, zeroY); ctx.lineTo(x1, y1); ctx.lineTo(x1, zeroY); ctx.closePath();
                ctx.fillStyle = 'rgba(255,51,51,0.18)'; ctx.fill();
              }
            }
          }

          pts.forEach((pt, i) => {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = values[i] >= 0 ? '#33ff33' : '#ff3333';
            ctx.fill();
            ctx.strokeStyle = '#1a1a2e';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          });

          ctx.restore();
        }
      } : null;

      const showAverage = opts && opts.average;
      const datasets = [{
        label: isPercent ? 'MONTHLY P/L %' : 'TOTAL VALUE',
        data: values,
        borderColor: color,
        backgroundColor: isPercent ? 'transparent' : color + '0d',
        fill: isPercent ? false : true,
        tension: isPercent ? 0.15 : 0.3,
        pointRadius: isPercent ? 0 : 4,
        pointBackgroundColor: isPercent ? undefined : color,
        pointHitRadius: isPercent ? 8 : undefined,
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
          pointHitRadius: 12,
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
        plugins: zeroFillPlugin ? [zeroFillPlugin] : [],
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: showAverage, labels: { color: '#aaa', boxWidth: 14, font: { size: 11, family: "'Share Tech Mono', monospace" } } },
            tooltip: {
              callbacks: {
                title: items => items.length ? labels[items[0].dataIndex] : '',
                label: item => {
                  const fmt = isPercent ? v => v.toFixed(2) + '%' : v => formatCurrency(v, mainCurrency);
                  if (item.datasetIndex === 1 && showAverage) return 'AVG: ' + fmt(item.parsed.y);
                  return item.dataset.label + ': ' + fmt(item.parsed.y);
                }
              }
            }
          },
          scales: {
            x: {
              ticks: { color: '#888', font: { size: 12, family: "'Share Tech Mono', monospace" } },
              grid: { color: '#222' }
            },
            y: {
              ticks: { color: '#888', font: { size: 12, family: "'Share Tech Mono', monospace" }, callback: v => isPercent ? v.toFixed(2) + '%' : formatCurrency(v, mainCurrency) },
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
        if (tx.type === 'deposit' && !_isOpeningContribution(tx)) monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'withdrawal') monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'buy') monthFlows += Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (tx.type === 'sell') monthFlows -= Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
        if (_isOpeningTx(tx)) {
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
      _renderRangeChart(investCanvas, 'investment', perfAccountIds, perfTxs, range, '#33ccff', { percent: true, average: true });
    }

    // ==================== SAVINGS RATE TREND ====================
    (function() {
      const canvas = document.getElementById('chart-savings-rate');
      const empty = document.getElementById('savings-rate-empty');
      const statsCard = document.getElementById('sr-stats-card');
      if (!canvas || !empty) return;

      // Build months going back 5 years (60+ months) for range filtering
      const srMonths = [];
      for (let i = 60; i >= 0; i--) {
        const d = new Date(todayDate.getFullYear(), todayDate.getMonth() - i, 1);
        srMonths.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
      }

      const allMonthData = [];
      srMonths.forEach(monthKey => {
        const year = monthKey.substring(0, 4);
        const mNum = parseInt(monthKey.substring(5, 7));
        const monthIncome = allIncomes
          .filter(inc => inc.month === monthKey)
          .reduce((sum, inc) => sum + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || (monthKey + '-01')), 0);
        const yearExpenses = allExpenses.filter(exp => exp.year === year);
        const monthlyTot = yearExpenses
          .filter(exp => exp.type === 'monthly')
          .reduce((sum, exp) => sum + (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01')), 0);
        const yearlyForMonth = yearExpenses
          .filter(exp => exp.type === 'yearly' && (!exp.paymentMonth || Number(exp.paymentMonth) === mNum))
          .reduce((sum, exp) => sum + (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || (year + '-01-01')), 0);
        const totalExpenses = monthlyTot + yearlyForMonth;
        const net = monthIncome - totalExpenses;
        const rate = monthIncome > 0 ? (net / monthIncome) * 100 : null;

        const monthTxs = transactions.filter(tx =>
          (tx.date || '').startsWith(monthKey) &&
          (tx.type === 'deposit' || tx.type === 'withdrawal' || tx.type === 'buy' || tx.type === 'sell')
        );
        const grossDeposits = monthTxs
          .filter(tx => tx.type === 'deposit' || tx.type === 'withdrawal')
          .reduce((sum, tx) => {
            if (tx.type === 'deposit') return sum + Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
            return sum - Math.abs(tx.amount) * rateFor(accCurrency[tx.accountId], tx.date);
          }, 0);

        if (rate !== null) {
          const d = new Date(monthKey + '-01');
          allMonthData.push({
            key: monthKey,
            label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
            netIncome: net,
            totalSaved: grossDeposits
          });
        }
      });

      function renderSavingsRateTrend() {
        if (App._charts.savingsRate) { try { App._charts.savingsRate.destroy(); } catch (e) {} delete App._charts.savingsRate; }

        // Read active range
        const activeBtn = document.querySelector('#sr-range-selectors .perf-btn.active');
        const range = activeBtn ? activeBtn.dataset.range : '1y';

        // Filter by range
        let filtered = allMonthData;
        if (allMonthData.length > 0) {
          const latest = allMonthData[allMonthData.length - 1].key;
          const latestDate = new Date(latest + '-01');
          let cutoff;
          if (range === 'ytd') {
            cutoff = new Date(latestDate.getFullYear(), 0, 1);
          } else if (range === 'max') {
            cutoff = null;
          } else {
            const years = parseInt(range.replace('y', '')) || 1;
            cutoff = new Date(latestDate);
            cutoff.setMonth(cutoff.getMonth() - (years * 12 - 1));
          }
          if (cutoff) {
            const cutoffKey = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0');
            filtered = allMonthData.filter(m => m.key >= cutoffKey);
          }
        }

        if (filtered.length === 0) {
          empty.style.display = 'block';
          canvas.style.display = 'none';
          if (statsCard) statsCard.style.display = 'none';
          return;
        }
        empty.style.display = 'none';
        canvas.style.display = '';
        if (statsCard) statsCard.style.display = '';

        const monthLabels = filtered.map(m => m.label);
        const netIncomeValues = filtered.map(m => m.netIncome);
        const totalSavedValues = filtered.map(m => m.totalSaved);

        // Stats from filtered data
        const avgNet = netIncomeValues.reduce((s, v) => s + v, 0) / netIncomeValues.length;
        const minNet = Math.min(...netIncomeValues);
        const maxNet = Math.max(...netIncomeValues);
        const avgSaved = totalSavedValues.reduce((s, v) => s + v, 0) / totalSavedValues.length;
        const minSaved = Math.min(...totalSavedValues);
        const maxSaved = Math.max(...totalSavedValues);

        function _srCurHtml(val) {
          const color = val >= 0 ? '#33ff33' : '#ff3333';
          return '<span style="color:' + color + '">' + (val >= 0 ? '+' : '') + formatCurrency(val, mainCurrency) + '</span>';
        }

        const minEl = document.getElementById('sr-min');
        const avgEl = document.getElementById('sr-avg');
        const maxEl = document.getElementById('sr-max');
        const minSavedEl = document.getElementById('sr-min-saved');
        const avgSavedEl = document.getElementById('sr-avg-saved');
        const maxSavedEl = document.getElementById('sr-max-saved');
        if (minEl) minEl.innerHTML = _srCurHtml(minNet);
        if (avgEl) avgEl.innerHTML = _srCurHtml(avgNet);
        if (maxEl) maxEl.innerHTML = _srCurHtml(maxNet);
        if (minSavedEl) minSavedEl.innerHTML = _srCurHtml(minSaved);
        if (avgSavedEl) avgSavedEl.innerHTML = _srCurHtml(avgSaved);
        if (maxSavedEl) maxSavedEl.innerHTML = _srCurHtml(maxSaved);

        App._charts.savingsRate = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels: monthLabels,
            datasets: [
              {
                label: 'NET INCOME',
                data: netIncomeValues,
                borderColor: '#33ff33',
                backgroundColor: 'rgba(51,255,51,0.08)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: netIncomeValues.map(v => v >= 0 ? '#33ff33' : '#ff3333'),
                borderWidth: 2,
                yAxisID: 'y'
              },
              {
                label: 'TOTAL SAVED',
                data: totalSavedValues,
                borderColor: '#33ccff',
                backgroundColor: 'rgba(51,204,255,0.08)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: '#33ccff',
                borderWidth: 2,
                yAxisID: 'y'
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: true, labels: { color: '#aaa', boxWidth: 14, font: { size: 11, family: "'Share Tech Mono', monospace" } } },
              tooltip: {
                callbacks: {
                  label: item => {
                    if (item.datasetIndex === 0) return 'NET INCOME: ' + formatCurrency(item.parsed.y, mainCurrency);
                    return 'TOTAL SAVED: ' + formatCurrency(item.parsed.y, mainCurrency);
                  }
                }
              }
            },
            scales: {
              x: {
                ticks: { color: '#888', font: { size: 12, family: "'Share Tech Mono', monospace" } },
                grid: { color: '#222' }
              },
              y: {
                ticks: { color: '#888', font: { size: 12, family: "'Share Tech Mono', monospace" }, callback: v => formatCurrency(v, mainCurrency) },
                grid: { color: '#222' }
              }
            }
          }
        });
      }

      renderSavingsRateTrend();

      // Range selector click handler
      document.querySelectorAll('#sr-range-selectors .perf-btn').forEach(btn => {
        btn.onclick = function() {
          document.querySelectorAll('#sr-range-selectors .perf-btn').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          renderSavingsRateTrend();
        };
      });
    })();

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
        const typeLabel = tx.type === 'asset-add' ? 'ASSET ADDED' : tx.type === 'asset-sell' ? 'ASSET SOLD' : _isOpeningTx(tx) ? 'OPENING VALUATION' : tx.type.toUpperCase();
        const typeClass = _isOpeningTx(tx) ? 'opening' : (tx.type === 'deposit' || tx.type === 'buy' || tx.type === 'asset-add') ? 'deposit' : (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') ? 'withdrawal' : 'valuation';
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
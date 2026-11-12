/* ===== Account detail =====
 *
 * accountDetail() gathers the account's figures once and hands them to one
 * renderer per section: stat cards, type-specific cards, performance (figures,
 * value chart, comparison with market indexes), history and assets.
 */

// Market indexes the investment accounts are compared with
const COMPARISON_INDEXES = [
  { symbol: '^GSPC', name: 'S&P 500', color: null },
  { symbol: '^SSMI', name: 'SMI', color: '#ff4d4d' },
  { symbol: '^IXIC', name: 'NASDAQ', color: '#33ccff' },
  { symbol: '^DJI', name: 'Dow Jones', color: '#ffcc00' },
  { symbol: '^GDAXI', name: 'DAX', color: '#ff9900' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', color: '#ff66cc' },
];

const ACCOUNT_CHART_TICKS = { color: '#999999', font: { family: CHART_FONT, size: 10 } };

// 'YYYY-MM' months from `firstMonth` through `lastMonth`
function monthsBetween(firstMonth, lastMonth) {
  const months = [];
  let [year, month] = firstMonth.split('-').map(Number);
  while (months.length < 720) {
    const key = year + '-' + String(month).padStart(2, '0');
    if (key > lastMonth) break;
    months.push(key);
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return months;
}

// Last day of a 'YYYY-MM' month
function lastDayOfMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return month + '-' + String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0');
}

Object.assign(Pages, {
  // ==================== ACCOUNT DETAIL ====================

  async accountDetail(id) {
    const account = await DB.getById('accounts', id);
    if (!account) { App.navigate('dashboard'); return; }
    const context = await loadValuationContext();
    const custodians = await DB.getAll('custodians');
    const custodian = custodians.find(entry => entry.id === account.custodianId);

    const today = context.today;
    const balanceTransactions = context.balanceTransactionsOf(new Set([account.id]));
    const sameDayYearsAgo = (years) => String(Number(today.substring(0, 4)) - years) + today.substring(4);
    const page = {
      account,
      context,
      custodianName: (custodian && custodian.name) || '—',
      isPreciousMetal: account.accountType === ACCOUNT_TYPE.preciousMetal,
      isAssetAccount: isAssetAccount(account),
      isRealEstate: account.accountType === ACCOUNT_TYPE.realEstate,
      assets: context.assetsByAccount[account.id] || [],
      transactions: context.transactionsOf(account.id),
      balanceTransactions,
      currentValue: context.accountValue(account),
      costBasis: context.accountCostBasis(account),
      // Start date of each performance period
      periodStarts: {
        ytd: today.substring(0, 4) + '-01-01',
        '1y': sameDayYearsAgo(1),
        '2y': sameDayYearsAgo(2),
        '3y': sameDayYearsAgo(3),
        max: balanceTransactions.length > 0 ? balanceTransactions[0].date : today,
      },
      indexBars: null,
    };

    document.getElementById('acc-detail-name').textContent = account.name || 'ACCOUNT';
    document.getElementById('acc-detail-back').href = '#portfolio-detail?id=' + (account.portfolioId || '');
    this._renderAccountStats(page);
    this._renderAccountTypeSections(page);
    this._bindAccountPerformance(page);
    this._renderAccountHistory(page);
  },

  // Value, P&L, cost and custodian cards. Real Estate shows the full property
  // value, the owned share net of the mortgage, the mortgage, and the change in
  // the owned share's value (repayments are capital, not a gain) instead.
  _renderAccountStats({ account, context, currentValue, costBasis, custodianName, isPreciousMetal, isRealEstate, assets }) {
    const currency = account.currency;
    const profitLoss = currentValue - costBasis;
    const valueElement = document.getElementById('acc-stat-value');
    const profitLossElement = document.getElementById('acc-stat-pl');
    const costElement = document.getElementById('acc-stat-cost');

    // The stat cards are shared by every account page: set their labels on each
    // render so the Real Estate wording never sticks to the next account opened.
    document.getElementById('acc-stat-value-label').textContent = isRealEstate ? 'TOTAL VALUE' : 'CURRENT VALUE';
    document.getElementById('acc-stat-pl-label').textContent = isRealEstate ? 'SHARE VALUE' : 'UNREALIZED P&L';
    document.getElementById('acc-stat-cost-label').textContent = isRealEstate ? 'DEBT (MORTGAGE)' : 'INPUT';
    document.getElementById('acc-stat-meta').closest('.col-md-3').style.display = isRealEstate ? 'none' : '';
    document.getElementById('acc-stat-gain-card').style.display = isRealEstate ? '' : 'none';

    if (isRealEstate) {
      const gainElement = document.getElementById('acc-stat-gain');
      gainElement.textContent = signedCurrency(profitLoss, currency) + (costBasis !== 0 ? ' (' + signedPercent((profitLoss / costBasis) * 100, 2) + ')' : '');
      gainElement.style.color = profitLossColor(profitLoss);
      // Each property is stored in its own currency: convert into the account's
      const rateToAccount = context.assetRateToAccount(account);
      const inAccountCurrency = (asset, amount) => amount * rateToAccount(asset.currency || 'CHF', context.today);
      const heldAssets = assets.filter(asset => !asset.sold);
      valueElement.textContent = formatCurrency(heldAssets.reduce((sum, asset) => sum + inAccountCurrency(asset, assetFullValue(asset, context.today)), 0), currency);
      profitLossElement.textContent = formatCurrency(currentValue, currency);
      profitLossElement.style.color = 'var(--accent)';
      costElement.textContent = formatCurrency(heldAssets.reduce((sum, asset) => sum + inAccountCurrency(asset, assetMortgage(asset, context.today)), 0), currency);
    } else {
      valueElement.textContent = formatCurrency(currentValue, currency);
      profitLossElement.textContent = signedCurrency(profitLoss, currency);
      profitLossElement.style.color = profitLossColor(profitLoss);
      costElement.textContent = formatCurrency(costBasis, currency);
    }

    document.getElementById('acc-stat-meta').textContent =
      custodianName + ' / ' + (account.currency || 'CHF') + (isPreciousMetal ? ' / ' + (account.metalType || 'METAL') : '');
  },

  // Quantity and price cards for precious metals, assets card and table for
  // asset accounts, and the matching action buttons
  _renderAccountTypeSections({ account, context, isPreciousMetal, isAssetAccount: hasAssets, isRealEstate, assets }) {
    const show = (id, isShown, display) => { const element = document.getElementById(id); if (element) element.style.display = isShown ? display : 'none'; };
    show('acc-stat-qty-card', isPreciousMetal, 'block');
    show('acc-stat-price-card', isPreciousMetal, 'block');
    show('acc-stat-assets-card', hasAssets, 'block');
    show('pm-actions', isPreciousMetal, 'flex');
    show('ta-actions', hasAssets, 'flex');
    show('ta-assets-card', hasAssets, 'block');
    show('std-actions', !isPreciousMetal && !hasAssets, 'flex');

    if (isPreciousMetal) {
      const spotPrice = metalSpotPerGram(context.todaysMetalPrices, account.metalType, account.currency || 'CHF', context.rateEntries, context.today);
      document.getElementById('acc-stat-qty').textContent = (account.quantity || 0) + 'g';
      document.getElementById('acc-stat-price').textContent = formatCurrency(spotPrice != null ? spotPrice : (account.pricePerGram || 0), account.currency) + '/g';
    }
    if (hasAssets) {
      document.getElementById('acc-stat-assets').textContent = pluralize(assets.filter(asset => !asset.sold).length, 'ASSET');
      this._renderAssetsTable(assets, account.currency, isRealEstate);
    }
  },

  // Performance figures, value chart and index comparison, driven by the period selector
  _bindAccountPerformance(page) {
    const activeButton = document.querySelector('#acc-perf-selectors .perf-btn.active');
    const render = (period) => {
      this._renderAccountPerformanceFigures(page, period);
      this._renderAccountValueChart(page, period);
      this._renderAccountIndexComparison(page, period);
    };
    render(activeButton ? activeButton.dataset.perf : 'ytd');

    document.querySelectorAll('#acc-perf-selectors .perf-btn').forEach(button => {
      button.onclick = function () {
        document.querySelectorAll('#acc-perf-selectors .perf-btn').forEach(other => other.classList.remove('active'));
        this.classList.add('active');
        render(this.dataset.perf);
      };
    });

    // Investment accounts are compared with market indexes from the Randata cache.
    // The section stays hidden until that comparison can be drawn.
    const section = document.getElementById('acc-index-compare-section');
    if (section) section.style.display = 'none';
    if (!/investment/i.test(page.account.accountType || '')) return;
    (async () => {
      try {
        const indexes = await Randata.readClass('index');
        if (!indexes || !indexes.data) return;
        if (!COMPARISON_INDEXES.some(index => Array.isArray(indexes.data[index.symbol]) && indexes.data[index.symbol].length > 0)) return;
        page.indexBars = indexes.data;
        const currentButton = document.querySelector('#acc-perf-selectors .perf-btn.active');
        this._renderAccountIndexComparison(page, currentButton ? currentButton.dataset.perf : 'ytd');
      } catch (error) { /* no market data available */ }
    })();
  },

  // Result of the period: start value, current value, money put in and the profit or loss.
  // Asset accounts: the change in their assets' value.
  _accountPerformanceSince(page, startDate) {
    const { context, assets, currentValue } = page;
    if (page.isAssetAccount) {
      // Capital put in is the change in owned cost: purchases and mortgage repayments
      // raise it, sales lower it. A sale's realized gain counts as result.
      const rateToAccount = context.assetRateToAccount(page.account);
      const atStart = assetAccountMetrics(assets, startDate, rateToAccount);
      const atEnd = assetAccountMetrics(assets, context.today, rateToAccount);
      const capitalAdded = atEnd.cost - atStart.cost;
      const realizedInPeriod = atEnd.realized - atStart.realized;
      const result = periodResult(atStart.value, atEnd.value + realizedInPeriod, capitalAdded);
      // Percent of the equity held over the period: a sale's capital leaving does not shrink the base
      const base = atStart.value + Math.max(0, capitalAdded);
      return { abs: result.abs, pct: base > 0 ? (result.abs / base) * 100 : 0, startValue: atStart.value, deposited: capitalAdded };
    }
    let startValue = 0;
    let capitalAdded = 0;
    let deposited = 0;
    page.balanceTransactions.forEach(transaction => {
      if (transaction.date < startDate) {
        startValue = transaction.balanceAfter || 0;
        return;
      }
      capitalAdded += capitalFlow(transaction);
      if (transaction.type === 'deposit' && !isOpeningContribution(transaction)) deposited += Math.abs(transaction.amount);
    });
    return { ...periodResult(startValue, currentValue, capitalAdded), startValue, deposited };
  },

  _renderAccountPerformanceFigures(page, period) {
    const elements = ['acc-perf-initial', 'acc-perf-actual', 'acc-perf-input', 'acc-perf-pl', 'acc-perf-pct'].map(id => document.getElementById(id));
    if (elements.some(element => !element)) return;
    const [initialElement, actualElement, inputElement, profitLossElement, percentElement] = elements;
    const currency = page.account.currency;
    const result = this._accountPerformanceSince(page, page.periodStarts[period] || page.periodStarts.ytd);
    initialElement.textContent = formatCurrency(result.startValue, currency);
    actualElement.textContent = formatCurrency(page.currentValue, currency);
    inputElement.textContent = formatCurrency(result.deposited, currency);
    profitLossElement.textContent = signedCurrency(result.abs, currency);
    profitLossElement.style.color = profitLossColor(result.abs);
    percentElement.textContent = signedPercent(result.pct, 2);
    percentElement.style.color = profitLossColor(result.abs);
  },

  // Month-end values of the account from the period start. Recorded accounts also
  // get the running capital put in (`capital`); the current month uses today's value.
  _accountMonthlyPoints(page, startDate) {
    const { context, assets, currentValue } = page;
    const currentMonth = context.today.substring(0, 7);
    if (page.isAssetAccount) {
      const rateToAccount = context.assetRateToAccount(page.account);
      return monthsBetween(startDate.substring(0, 7), currentMonth).map(month => ({ month, value: assetAccountMetrics(assets, lastDayOfMonth(month), rateToAccount).value }));
    }

    const valueByMonth = {};
    const capitalByMonth = {};
    let valueBeforeStart = 0;
    page.balanceTransactions.forEach(transaction => {
      if (transaction.date < startDate) {
        valueBeforeStart = transaction.balanceAfter || valueBeforeStart;
        return;
      }
      const month = (transaction.date || '').substring(0, 7);
      if (!month) return;
      valueByMonth[month] = transaction.balanceAfter != null ? transaction.balanceAfter : (valueByMonth[month] || 0);
      capitalByMonth[month] = (capitalByMonth[month] || 0) + capitalFlow(transaction);
    });
    if (currentValue > 0) valueByMonth[currentMonth] = currentValue;

    let capitalSoFar = 0;
    return Object.keys(valueByMonth).sort().map(month => {
      capitalSoFar += capitalByMonth[month] || 0;
      return { month, value: valueByMonth[month], capital: valueBeforeStart + capitalSoFar, capitalAddedThisMonth: capitalByMonth[month] || 0 };
    });
  },

  // The account's value over the period, with the capital put in as a second line
  _renderAccountValueChart(page, period) {
    const wrap = document.getElementById('acc-perf-chart-wrap');
    const canvas = document.getElementById('acc-perf-chart');
    const emptyMessage = document.getElementById('acc-perf-chart-empty');
    if (!wrap || !canvas || !emptyMessage) return;
    if (App._charts.accPerfChart) { try { App._charts.accPerfChart.destroy(); } catch (error) { /* already destroyed */ } delete App._charts.accPerfChart; }

    const points = this._accountMonthlyPoints(page, page.periodStarts[period] || page.periodStarts.ytd);
    wrap.style.display = points.length < 2 ? 'none' : '';
    emptyMessage.style.display = points.length < 2 ? 'block' : 'none';
    if (points.length < 2) return;

    const currency = page.account.currency;
    App._charts.accPerfChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: points.map(point => shortMonthLabel(point.month)),
        datasets: [{
          label: page.account.name || 'ACCOUNT',
          data: points.map(point => point.value),
          borderColor: readAccent(),
          backgroundColor: shadeAccent(readAccent(), 1, 0.08),
          fill: true,
          tension: 0.25,
          pointRadius: 2,
          pointBackgroundColor: readAccent(),
        }, {
          label: 'Deposits / Withdrawals',
          data: points.map(point => (point.capital != null ? point.capital : null)),
          borderColor: '#ffcc00',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.25,
          pointRadius: 2,
          pointBackgroundColor: '#ffcc00',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (item) => formatCurrency(item.parsed.y, currency) } } },
        scales: {
          x: { ticks: { ...ACCOUNT_CHART_TICKS, maxTicksLimit: 8 }, grid: { color: '#222222' } },
          y: { ticks: ACCOUNT_CHART_TICKS, grid: { color: '#222222' } },
        },
      },
    });
  },

  // Growth of the account against market indexes, all starting at 100. The
  // account line removes the capital put in each month, so it only shows growth.
  _renderAccountIndexComparison(page, period) {
    if (!page.indexBars) return;
    const section = document.getElementById('acc-index-compare-section');
    const wrap = document.getElementById('acc-index-chart-wrap');
    const canvas = document.getElementById('acc-index-chart');
    const emptyMessage = document.getElementById('acc-index-chart-empty');
    if (!section || !wrap || !canvas || !emptyMessage) return;
    if (App._charts.accIndexChart) { try { App._charts.accIndexChart.destroy(); } catch (error) { /* already destroyed */ } delete App._charts.accIndexChart; }

    const startDate = page.periodStarts[period] || page.periodStarts.ytd;
    const points = this._accountMonthlyPoints(page, startDate);
    if (points.length < 2 || !points[0].value) {
      section.style.display = 'none';
      return;
    }
    const accountGrowth = [{ month: points[0].month, value: 100 }];
    for (let index = 1; index < points.length; index++) {
      const previousValue = points[index - 1].value || 0;
      const growth = previousValue !== 0 ? ((points[index].value || 0) - points[index].capitalAddedThisMonth) / previousValue : 1;
      accountGrowth.push({ month: points[index].month, value: accountGrowth[index - 1].value * growth });
    }

    // Each index: its last close of every month, relative to the first month
    const indexGrowth = {};
    COMPARISON_INDEXES.forEach(index => {
      const bars = (page.indexBars[index.symbol] || []).filter(bar => bar.date >= startDate && bar.close != null);
      const closeByMonth = {};
      bars.forEach(bar => { closeByMonth[bar.date.substring(0, 7)] = bar.close; });
      const months = Object.keys(closeByMonth).sort();
      if (bars.length < 2 || months.length < 2 || !closeByMonth[months[0]]) return;
      indexGrowth[index.symbol] = months.map(month => ({ month, value: (closeByMonth[month] / closeByMonth[months[0]]) * 100 }));
    });
    const shownIndexes = COMPARISON_INDEXES.filter(index => indexGrowth[index.symbol]);
    if (shownIndexes.length === 0) {
      section.style.display = 'none';
      return;
    }

    const allMonths = new Set(accountGrowth.map(point => point.month));
    shownIndexes.forEach(index => indexGrowth[index.symbol].forEach(point => allMonths.add(point.month)));
    const months = [...allMonths].sort();
    // Value of a series in a month: its latest point on or before that month
    const valueInMonth = (series, month) => {
      let latest = null;
      for (const point of series) {
        if (point.month > month) break;
        latest = point.value;
      }
      return latest;
    };

    section.style.display = '';
    wrap.style.display = '';
    emptyMessage.style.display = 'none';
    App._charts.accIndexChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: months.map(shortMonthLabel),
        datasets: [
          {
            label: page.account.name || 'ACCOUNT',
            data: months.map(month => valueInMonth(accountGrowth, month)),
            borderColor: readAccent(),
            backgroundColor: shadeAccent(readAccent(), 1, 0.05),
            borderWidth: 2.5,
            pointRadius: 2,
            pointBackgroundColor: readAccent(),
            tension: 0.2,
            fill: false,
          },
          ...shownIndexes.map(index => ({
            label: index.name,
            data: months.map(month => valueInMonth(indexGrowth[index.symbol], month)),
            borderColor: index.color || readAccent(),
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.2,
            fill: false,
          })),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#aaaaaa', boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: (item) => item.dataset.label + ': ' + signedPercent(item.parsed.y - 100, 2) } },
        },
        scales: {
          x: { ticks: { ...ACCOUNT_CHART_TICKS, maxTicksLimit: 8 }, grid: { color: '#222222' } },
          y: { ticks: { ...ACCOUNT_CHART_TICKS, callback: (value) => value.toFixed(0) + '%' }, grid: { color: '#222222' } },
        },
      },
    });
  },

  // Every transaction of the account, newest first
  _renderAccountHistory({ account, context, transactions, assets }) {
    const tbody = document.getElementById('acc-tx-body');
    const emptyMessage = document.getElementById('acc-tx-empty');
    tbody.innerHTML = '';
    emptyMessage.style.display = transactions.length === 0 ? 'block' : 'none';

    const currency = account.currency;
    const assetsById = {};
    assets.forEach(asset => { assetsById[asset.id] = asset; });
    const rateToAccount = context.assetRateToAccount(account);
    const pricePerGramText = (transaction) => Number(transaction.pricePerGram).toFixed(2) + ' ' + escapeHtml(currency) + '/g';

    [...transactions]
      .sort((first, second) => new Date(second.date || second.createdAt) - new Date(first.date || first.createdAt))
      .forEach(transaction => {
        const transactionId = Number(transaction.id);
        const isAssetEvent = transaction.type === 'asset-add' || transaction.type === 'asset-sell';
        const asset = isAssetEvent ? assetsById[transaction.assetId] : null;
        let amountText;
        let assetBreakdown = '';
        if (transaction.type === 'valuation') {
          amountText = formatCurrency(transaction.amount, currency);
        } else if (asset) {
          // An asset purchase or sale moves the owned equity in or out of the account:
          // the owned share of the price, net of the mortgage, in the asset's currency.
          const price = Math.abs(transaction.amount || 0);
          const mortgage = assetMortgage(asset, transaction.date);
          const share = assetOwnershipShare(asset);
          const ownedEquity = (price - mortgage) * share;
          amountText = (transaction.type === 'asset-add' ? '+' : '-') + formatCurrency(ownedEquity * rateToAccount(asset.currency || 'CHF', transaction.date), currency);
          if (mortgage > 0 || share !== 1) {
            assetBreakdown = (transaction.type === 'asset-add' ? 'PRICE ' : 'SALE ') + formatCurrency(price, asset.currency) +
              (mortgage > 0 ? ' &middot; MORTGAGE ' + formatCurrency(mortgage, asset.currency) : '') +
              ' &middot; YOUR ' + escapeHtml(+(share * 100).toFixed(2)) + '% = ' + formatCurrency(ownedEquity, asset.currency);
          }
        } else if (transaction.type === 'buy' || transaction.type === 'sell' || isAssetEvent) {
          amountText = (transaction.amount >= 0 && transaction.type !== 'asset-sell' ? '+' : '-') + formatCurrency(Math.abs(transaction.amount), currency);
        } else {
          amountText = formatCurrency(Math.abs(transaction.amount), currency);
        }

        let notesHtml = escapeHtml(transaction.notes || '');
        if (assetBreakdown) notesHtml += '<br><small style="color:#888">' + assetBreakdown + '</small>';
        if (transaction.quantity != null) {
          let metalLine = (transaction.type === 'buy' ? '+' : transaction.type === 'sell' ? '&minus;' : '') + escapeHtml(transaction.quantity) + 'g';
          if (transaction.pricePerGram) metalLine += ' @ ' + pricePerGramText(transaction);
          if (transaction.quantityAfter != null) metalLine += ' &middot; QTY ' + escapeHtml(transaction.quantityAfter) + 'g';
          notesHtml += '<br><small style="color:#888">' + metalLine + '</small>';
        } else if (transaction.pricePerGram) {
          notesHtml += '<br><small style="color:#888">' + pricePerGramText(transaction) + '</small>';
        }

        const deleteLink = '<a class="tx-link" onclick="App.deleteTransaction(' + transactionId + ')">DELETE</a>';
        const actionsHtml = isAssetEvent ? deleteLink : '<a class="tx-link me-2" onclick="App.showEditTransaction(' + transactionId + ')">EDIT</a>' + deleteLink;
        const row = document.createElement('tr');
        row.innerHTML = `<td>${formatDate(transaction.date)}</td>
          <td><span class="tx-badge ${transactionBadgeClass(transaction)}">${transactionTypeLabel(transaction)}</span></td>
          <td>${amountText}</td>
          <td>${formatCurrency(transaction.balanceAfter || 0, currency)}</td>
          <td>${notesHtml}</td>
          <td>${actionsHtml}</td>`;
        tbody.appendChild(row);
      });
  },

  _renderAssetsTable(assets, currency, isRealEstate) {
    const tbody = document.getElementById('ta-assets-body');
    const emptyMessage = document.getElementById('ta-assets-empty');
    const table = document.getElementById('ta-assets-table');
    tbody.innerHTML = '';
    const mortgageHeader = Array.from(table.querySelectorAll('th')).find(header => /DEBT/.test(header.textContent));
    if (mortgageHeader) mortgageHeader.style.display = isRealEstate ? '' : 'none';

    // Held assets first, newest purchase first
    const sorted = [...assets].sort((first, second) => {
      if (first.sold !== second.sold) return first.sold ? 1 : -1;
      return (second.purchaseDate || '').localeCompare(first.purchaseDate || '');
    });
    if (emptyMessage) emptyMessage.style.display = sorted.length === 0 ? 'block' : 'none';
    if (table) table.style.display = sorted.length === 0 ? 'none' : '';

    sorted.forEach(asset => {
      const assetCurrency = asset.currency || 'CHF';
      const assetId = Number(asset.id);
      const realized = assetRealizedPL(asset);
      const valueHtml = asset.sold
        ? '<span class="text-muted">—</span>'
        : formatCurrency(assetCurrentValue(asset, todayStr()), assetCurrency);
      const profitLossHtml = realized == null
        ? '<span class="text-muted">—</span>'
        : '<span class="ta-pl ' + plClass(realized) + '">' + signedCurrency(realized, assetCurrency) + '</span>';
      const editLink = '<a class="tx-link me-2" onclick="App.showModal(\'asset\', ' + Number(asset.accountId) + ', ' + assetId + ')">EDIT</a>';
      const deleteLink = '<a class="tx-link" onclick="App.deleteAsset(' + assetId + ')">DELETE</a>';
      const sellLink = '<a class="tx-link me-2" onclick="App.showModal(\'sellAsset\', ' + assetId + ')">SELL</a>';
      const propertyLinks = isRealEstate
        ? '<a class="tx-link me-2" onclick="App.showAssetHistory(' + assetId + ', \'valuations\')">VALUE</a>' +
          '<a class="tx-link me-2" onclick="App.showAssetHistory(' + assetId + ', \'mortgageBalances\')">MORTGAGE</a>'
        : '';
      const actionsHtml = asset.sold ? editLink + deleteLink : propertyLinks + sellLink + editLink + deleteLink;

      const row = document.createElement('tr');
      row.innerHTML = `<td>${escapeHtml(asset.name)}</td>
        <td>${formatDate(asset.purchaseDate)}</td>
        <td>${formatCurrency(assetCostValue(asset), assetCurrency)}</td>
        <td>${escapeHtml(assetCurrency)}</td>
        <td>${escapeHtml(asset.depreciationPct || 0)}%</td>
        <td>${valueHtml}</td>
        ${isRealEstate ? '<td>' + (asset.sold ? '<span class="text-muted">—</span>' : formatCurrency(assetMortgage(asset, todayStr()), assetCurrency)) + '</td>' : ''}
        <td>${asset.sold ? '<span class="tx-badge withdrawal">SOLD</span>' : '<span class="tx-badge deposit">HELD</span>'}</td>
        <td>${profitLossHtml}</td>
        <td>${actionsHtml}</td>`;
      tbody.appendChild(row);
    });
  },
});

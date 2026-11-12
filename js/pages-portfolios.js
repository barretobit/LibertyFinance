Object.assign(Pages, {
  // ==================== PORTFOLIOS ====================

  async portfolios() {
    const portfolios = await DB.getAll('portfolios');
    const context = await loadValuationContext();
    const mainCurrency = context.mainCurrency;
    const list = document.getElementById('portfolio-list');
    const emptyMessage = document.getElementById('portfolio-empty');
    list.innerHTML = '';
    emptyMessage.style.display = portfolios.length === 0 ? 'block' : 'none';
    if (portfolios.length === 0) {
      this._renderPortfolioChart([], mainCurrency);
      return;
    }

    // Every account's current value in the main currency, grouped per portfolio.
    // Accounts of a portfolio get shades of the portfolio's color.
    const palette = chartPalette();
    const portfolioRows = portfolios.map((portfolio, portfolioIndex) => {
      const portfolioAccounts = context.accounts.filter(account => account.portfolioId === portfolio.id);
      const baseColor = palette[portfolioIndex % palette.length];
      const accountRows = portfolioAccounts.map((account, accountIndex) => ({
        id: account.id,
        name: account.name,
        value: context.accountValueInMain(account),
        color: tintColor(baseColor, portfolioAccounts.length === 1 ? 0 : -0.3 + 0.6 * (accountIndex / (portfolioAccounts.length - 1))),
      }));
      return {
        id: portfolio.id,
        name: portfolio.name,
        description: portfolio.description || '',
        color: baseColor,
        value: accountRows.reduce((sum, row) => sum + row.value, 0),
        accounts: accountRows,
      };
    });

    portfolioRows.forEach(portfolio => {
      const column = document.createElement('div');
      column.className = 'col-12';
      column.innerHTML = `<div class="pf-card" onclick="App.navigate('portfolio-detail?id=${Number(portfolio.id)}')">
        <div class="pf-name">${escapeHtml(portfolio.name)}</div>
        <div class="pf-value">${formatCurrency(portfolio.value, mainCurrency)}</div>
        <div class="pf-desc">${escapeHtml(portfolio.description)}</div>
        <div class="pf-meta">${pluralize(portfolio.accounts.length, 'ACCOUNT')}</div>
      </div>`;
      list.appendChild(column);
    });

    this._renderPortfolioChart(portfolioRows, mainCurrency);
  },

  // Nested doughnut: outer ring = portfolios, inner ring = accounts within each portfolio
  _renderPortfolioChart(portfolioRows, mainCurrency) {
    const wrap = document.getElementById('portfolio-chart-wrap');
    const canvas = document.getElementById('chart-portfolio-nested');
    const emptyState = document.getElementById('portfolio-chart-empty');
    const legendBox = document.getElementById('portfolio-chart-legend');
    if (!wrap || !canvas || !emptyState || !legendBox) return;

    if (App._charts.portfolios) { try { App._charts.portfolios.destroy(); } catch (error) { /* already destroyed */ } delete App._charts.portfolios; }

    const shownPortfolios = portfolioRows.filter(portfolio => portfolio.value > 0);
    wrap.style.display = shownPortfolios.length ? '' : 'none';
    emptyState.style.display = shownPortfolios.length ? 'none' : 'block';
    if (shownPortfolios.length === 0) {
      legendBox.innerHTML = '';
      return;
    }

    const shownAccounts = [];
    shownPortfolios.forEach(portfolio => {
      portfolio.accounts.forEach(account => {
        if (account.value > 0) shownAccounts.push({ ...account, portfolio: portfolio.name });
      });
    });
    const total = shownPortfolios.reduce((sum, portfolio) => sum + portfolio.value, 0) || 1;
    const percentOfTotal = (value) => ((value / total) * 100).toFixed(1);

    App._charts.portfolios = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: shownPortfolios.map(portfolio => portfolio.name).concat(shownAccounts.map(account => account.name)),
        datasets: [
          {
            label: 'PORTFOLIOS',
            data: shownPortfolios.map(portfolio => portfolio.value),
            backgroundColor: shownPortfolios.map(portfolio => portfolio.color),
            borderColor: '#161616',
            borderWidth: 2,
            weight: 2,
            names: shownPortfolios.map(portfolio => portfolio.name),
          },
          {
            label: 'ACCOUNTS',
            data: shownAccounts.map(account => account.value),
            backgroundColor: shownAccounts.map(account => account.color),
            borderColor: '#161616',
            borderWidth: 2,
            weight: 1,
            names: shownAccounts.map(account => account.name),
            portfolios: shownAccounts.map(account => account.portfolio),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '32%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const item = items && items[0];
                const dataset = item && item.dataset;
                return dataset && dataset.names ? (dataset.names[item.dataIndex] || '') : '';
              },
              label: (item) => {
                const dataset = item.dataset;
                const value = dataset.data[item.dataIndex] || 0;
                const portfolioName = dataset.portfolios ? dataset.portfolios[item.dataIndex] : null;
                return (portfolioName ? portfolioName + ' / ' : '') + (dataset.names[item.dataIndex] || '') + ': ' + formatCurrency(value, mainCurrency) + ' (' + percentOfTotal(value) + '%)';
              },
            },
          },
        },
      },
    });

    // Legend: each portfolio with its accounts grouped beneath
    const legendRowHtml = (row, extraClass) => `<div class="pf-legend-row${extraClass}">
          <span class="pf-legend-dot" style="background:${row.color}"></span>
          <span class="pf-legend-name">${escapeHtml(row.name)}</span>
          <span class="pf-legend-val">${formatCurrency(row.value, mainCurrency)}</span>
          <span class="pf-legend-pct">${percentOfTotal(row.value)}%</span>
        </div>`;
    legendBox.innerHTML = shownPortfolios.map(portfolio =>
      '<div class="pf-legend-group">' +
      legendRowHtml(portfolio, '') +
      portfolio.accounts.filter(account => account.value > 0).map(account => legendRowHtml(account, ' sub')).join('') +
      '</div>').join('');
  },

  // ==================== PORTFOLIO DETAIL ====================

  async portfolioDetail(id) {
    const portfolio = await DB.getById('portfolios', id);
    const accounts = await DB.getByIndex('accounts', 'portfolioId', id);
    const custodians = await DB.getAll('custodians');
    const context = await loadValuationContext();
    const mainCurrency = context.mainCurrency;
    const custodianNames = {};
    custodians.forEach(custodian => { custodianNames[custodian.id] = custodian.name; });

    document.getElementById('pf-detail-title').textContent = portfolio ? portfolio.name : 'PORTFOLIO';

    // Value and cost basis per account in its own currency; totals in the main currency
    const accountFigures = {};
    let totalValue = 0;
    let totalCost = 0;
    accounts.forEach(account => {
      const value = context.accountValue(account);
      const cost = context.accountCostBasis(account);
      accountFigures[account.id] = { value, cost, profitLoss: value - cost };
      const rate = context.rateToMain(account.currency, context.today);
      totalValue += value * rate;
      totalCost += cost * rate;
    });
    const totalProfitLoss = totalValue - totalCost;

    document.getElementById('pf-stat-value').textContent = formatCurrency(totalValue, mainCurrency);
    document.getElementById('pf-stat-accounts').textContent = accounts.length;
    document.getElementById('pf-stat-cost').textContent = formatCurrency(totalCost, mainCurrency);
    const profitLossElement = document.getElementById('pf-stat-pl');
    profitLossElement.textContent = formatCurrency(totalProfitLoss, mainCurrency);
    profitLossElement.style.color = profitLossColor(totalProfitLoss);

    const list = document.getElementById('account-list');
    const emptyMessage = document.getElementById('account-empty');
    list.innerHTML = '';
    emptyMessage.style.display = accounts.length === 0 ? 'block' : 'none';

    accounts.forEach(account => {
      const { value, cost, profitLoss } = accountFigures[account.id];
      const profitLossPercent = cost !== 0 ? (profitLoss / cost) * 100 : null;
      const accountType = account.accountType || ACCOUNT_TYPE.investment;
      const accountId = Number(account.id);
      let metaExtra = '';
      if (account.accountType === ACCOUNT_TYPE.preciousMetal && account.quantity) {
        const spotPrice = metalSpotPerGram(context.todaysMetalPrices, account.metalType, account.currency || 'CHF', context.rateEntries, context.today);
        const shownPrice = spotPrice != null ? spotPrice : (account.pricePerGram || 0);
        metaExtra = ' &middot; ' + escapeHtml(account.quantity) + 'g ' + escapeHtml(account.metalType || '') + ' @ ' + formatCurrency(shownPrice, account.currency) + '/g';
      } else if (isAssetAccount(account)) {
        const heldCount = (context.assetsByAccount[account.id] || []).filter(asset => !asset.sold).length;
        metaExtra = ' &middot; ' + pluralize(heldCount, 'ASSET');
      }
      const flagToggleHtml = (label, field, isOn) => `<label class="perf-toggle" onclick="event.stopPropagation()">
              <span>${label}</span>
              <input type="checkbox" class="perf-cb"
                ${isOn ? 'checked' : ''}
                onchange="App.toggleFlag(event, ${accountId}, '${field}', this.checked)">
            </label>`;
      const column = document.createElement('div');
      column.className = 'col-md-6 mb-3';
      column.innerHTML = `<div class="acc-card" onclick="App.navigate('account-detail?id=${accountId}&pfid=${Number(id)}')">
        <div class="acc-name">
          <span>${escapeHtml(account.name)}</span>
          <div class="acc-toggles">
            ${flagToggleHtml('Include in Net Worth', 'includeInNetWorth', account.includeInNetWorth !== false)}
            ${flagToggleHtml('Include in Liquid Net Worth', 'includeInLiquidNetWorth', account.includeInLiquidNetWorth !== false)}
            ${flagToggleHtml('Include in Performance', 'trackPerformance', account.trackPerformance !== false)}
          </div>
        </div>
        <div class="acc-meta"><span class="type-badge type-${escapeHtml(accountType.replace(/\s+/g, '-').toLowerCase())}">${escapeHtml(accountType)}</span> &middot; ${escapeHtml(custodianNames[account.custodianId] || '—')} &middot; ${escapeHtml(account.currency || 'CHF')}${metaExtra}</div>
        <div class="acc-value">${formatCurrency(value, account.currency)}</div>
        <div class="acc-pl ${plClass(profitLoss)}">${signedCurrency(profitLoss, account.currency)}<span class="acc-pl-pct">${profitLossPercent != null ? signedPercent(profitLossPercent, 2) : '&mdash;'}</span></div>
      </div>`;
      list.appendChild(column);
    });
  },
});

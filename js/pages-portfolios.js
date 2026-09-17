Object.assign(Pages, {
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
      col.className = 'col-12';
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
      const { effVal, pl, costBasis } = effMap[a.id] || { effVal: 0, pl: 0, costBasis: 0 };
      const plPct = costBasis !== 0 ? (pl / costBasis) * 100 : null;
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
        <div class="acc-pl ${plClass(pl)}">${pl >= 0 ? '+' : ''}${formatCurrency(pl, a.currency)}<span class="acc-pl-pct">${plPct != null ? (plPct >= 0 ? '+' : '') + plPct.toFixed(2) + '%' : '&mdash;'}</span></div>
      </div>`;
      list.appendChild(col);
    });
  },
});
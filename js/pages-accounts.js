Object.assign(Pages, {
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
        if (tx.type === 'deposit' && !_isOpeningContribution(tx)) netDeposits += Math.abs(tx.amount);
        if (tx.type === 'withdrawal') netDeposits -= Math.abs(tx.amount);
        if (tx.type === 'buy') netDeposits += Math.abs(tx.amount);
        if (tx.type === 'sell') netDeposits -= Math.abs(tx.amount);
        if (_isOpeningTx(tx)) {
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
        const typeLabel = tx.type === 'asset-add' ? 'ASSET ADDED' : tx.type === 'asset-sell' ? 'ASSET SOLD' : _isOpeningTx(tx) ? 'OPENING VALUATION' : tx.type.toUpperCase();
        const typeClass = _isOpeningTx(tx) ? 'opening' : (tx.type === 'deposit' || tx.type === 'buy' || tx.type === 'asset-add') ? 'deposit' : (tx.type === 'withdrawal' || tx.type === 'sell' || tx.type === 'asset-sell') ? 'withdrawal' : 'valuation';
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
        const isAssetEvent = tx.type === 'asset-add' || tx.type === 'asset-sell';
        const actionsHtml = isAssetEvent
          ? '<a class="tx-link" onclick="App.deleteTransaction(' + tx.id + ')">DELETE</a>'
          : '<a class="tx-link me-2" onclick="App.showEditTransaction(' + tx.id + ')">EDIT</a>' +
            '<a class="tx-link" onclick="App.deleteTransaction(' + tx.id + ')">DELETE</a>';
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(tx.date)}</td>
          <td><span class="tx-badge ${typeClass}">${typeLabel}</span></td>
          <td>${displayAmount}</td>
          <td>${formatCurrency(tx.balanceAfter || 0, account.currency)}</td>
          <td>${notesHtml}</td>
          <td>${actionsHtml}</td>`;
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
});
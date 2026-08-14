Object.assign(Pages, {
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
        if (!prev || (t.date || '') >= (prev.date || '')) accTxs[t.accountId] = t;
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
      col.className = 'col-md-4 goal-col';
      col.innerHTML = this._goalCardHtml(goalRes, accNames, undefined, mainCurrency);
      list.appendChild(col);
    });
  },
});
Object.assign(Pages, {
  // ==================== GOALS ====================

  // Waterfall: higher-priority goals take from the account values first; later
  // goals only see what is left. Each allocation is taken in row order, capped at the target.
  _computeGoalWaterfall(goals, accountValues) {
    const remaining = { ...accountValues };
    return goals.map(goal => {
      let funded = 0;
      let totalAvailable = 0;
      const claims = (goal.allocations || []).map(allocation => {
        const accountValue = remaining[allocation.accountId] || 0;
        const available = accountValue * ((allocation.pct || 0) / 100);
        totalAvailable += available;
        const stillNeeded = (goal.target || 0) - funded;
        const taken = Math.max(0, Math.min(available, stillNeeded));
        if (taken > 0) {
          funded += taken;
          remaining[allocation.accountId] = accountValue - taken;
        }
        return { accountId: allocation.accountId, percent: allocation.pct || 0, accountValue, available, taken };
      });
      return { goal, funded, totalAvailable, claims };
    });
  },

  _goalCardHtml(goalResult, accountNames, compact, mainCurrency) {
    const goal = goalResult.goal;
    const currency = mainCurrency || 'CHF';
    const total = goalResult.totalAvailable;
    const target = goal.target || 0;
    const percent = target > 0 ? Math.min(100, (total / target) * 100) : 0;
    const difference = total - target;
    const reached = total >= target;
    const goalId = Number(goal.id);
    const statusText = difference < 0 ? 'SHORT BY ' + formatCurrency(-difference, currency)
      : difference > 0 ? 'EXCEED BY ' + formatCurrency(difference, currency)
      : 'TARGET REACHED';
    const targetLineHtml =
      '<div class="goal-target-line">' +
      '<div class="goal-tv-row ' + (reached ? 'is-reached' : '') + '"><span>Target:</span><span>' + formatCurrency(target, currency) + '</span></div>' +
      '<div class="goal-tv-row ' + (reached ? 'is-reached' : 'is-short') + '"><span>Actual:</span><span>' + formatCurrency(total, currency) + '</span></div>' +
      '</div>';
    const statusHtml =
      '<div class="goal-status-row">' +
      '<div class="goal-status ' + (difference < 0 ? 'danger' : 'ok') + '">' + statusText + '</div>' +
      '<span class="goal-pct" style="color:' + (reached ? 'var(--accent)' : 'var(--text-primary)') + '">' + percent.toFixed(1) + '%</span>' +
      '</div>';
    const allocationsHtml = goalResult.claims.map(claim => {
      const name = accountNames[claim.accountId] || ('ACCOUNT #' + claim.accountId);
      return '<div class="goal-alloc-line">' +
        '<span class="goal-alloc-name">' + escapeHtml(name) + '</span>' +
        '<span>' + formatCurrency(claim.accountValue, currency) + '</span>' +
        '<span>' + escapeHtml(claim.percent) + '% ' + formatCurrency(claim.taken, currency) + '</span>' +
        '<span>' + formatCurrency(claim.accountValue - claim.taken, currency) + '</span>' +
        '</div>';
    }).join('') || '<div class="goal-alloc-line"><span class="text-muted">NO ACCOUNTS ASSIGNED</span></div>';

    return '<div class="goal-card">' +
      '<div class="goal-card-top">' +
      '<span class="goal-name"><span class="goal-priority">#' + escapeHtml(goal.order != null ? goal.order : '-') + '</span> ' + escapeHtml(goal.name) + '</span>' +
      '<span class="goal-reached" style="' + (reached ? '' : 'display:none') + '">REACHED</span>' +
      '</div>' +
      targetLineHtml +
      statusHtml +
      '<div class="goal-progress"><div class="goal-progress-fill" style="width:' + percent + '%"></div></div>' +
      (compact ? '' :
      '<div class="goal-allocations">' +
      '<div class="goal-alloc-header"><span>ACCOUNT</span><span>AVAILABLE</span><span>TAKE</span><span>LEFT</span></div>' +
      allocationsHtml + '</div>') +
      '<div class="goal-actions">' +
      '<a class="tx-link me-2" onclick="App.moveGoal(' + goalId + ', -1)">UP</a>' +
      '<a class="tx-link me-2" onclick="App.moveGoal(' + goalId + ', 1)">DOWN</a>' +
      '<a class="tx-link me-2" onclick="App.showModal(\'goal\', ' + goalId + ')">EDIT</a>' +
      '<a class="tx-link" onclick="App.deleteGoal(' + goalId + ')">DELETE</a>' +
      '</div>' +
      '</div>';
  },

  // Current value of every account in the main currency, and its name, for the goal cards
  _goalAccountValues(context) {
    const accountValues = {};
    const accountNames = {};
    context.accounts.forEach(account => {
      accountValues[account.id] = context.accountValueInMain(account);
      accountNames[account.id] = account.name;
    });
    return { accountValues, accountNames };
  },

  // Priority order: lowest order number first, goals without one last, then by id
  _sortGoalsByPriority(goals) {
    const orderOf = (goal) => (goal.order != null ? goal.order : Infinity);
    return [...goals].sort((first, second) => (orderOf(first) - orderOf(second)) || (first.id - second.id));
  },

  async goals() {
    const goals = await DB.getAll('goals');
    const context = await loadValuationContext();

    const list = document.getElementById('goal-list');
    const emptyMessage = document.getElementById('goal-empty');
    list.innerHTML = '';
    emptyMessage.style.display = goals.length === 0 ? 'block' : 'none';
    if (goals.length === 0) return;

    const { accountValues, accountNames } = this._goalAccountValues(context);
    this._computeGoalWaterfall(this._sortGoalsByPriority(goals), accountValues).forEach(goalResult => {
      const column = document.createElement('div');
      column.className = 'col-md-6 goal-col';
      column.innerHTML = this._goalCardHtml(goalResult, accountNames, false, context.mainCurrency);
      list.appendChild(column);
    });
  },
});
/* ===== Dashboard =====
 *
 * dashboard() loads the data once, builds a valuation context (js/valuation.js)
 * and hands both to one renderer per card, top to bottom.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHART_FONT = "'Share Tech Mono', monospace";

// 'YYYY-MM' keys of the last `count` months, oldest first, ending with the current month
function lastMonthKeys(count) {
  const now = new Date();
  const months = [];
  for (let monthsBack = count - 1; monthsBack >= 0; monthsBack--) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    months.push(monthDate.getFullYear() + '-' + String(monthDate.getMonth() + 1).padStart(2, '0'));
  }
  return months;
}

// Last day of a 'YYYY-MM' month, or today for the current month
function monthEndDate(month, today) {
  if (month === today.substring(0, 7)) return today;
  const lastDay = new Date(Number(month.substring(0, 4)), Number(month.substring(5, 7)), 0).getDate();
  return month + '-' + String(lastDay).padStart(2, '0');
}

// First day of a 'YYYY-MM' month, in local time (so the label never slips into the previous month)
function monthStartDate(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1);
}

// 'Mar 26' style label of a 'YYYY-MM' month
function shortMonthLabel(month) {
  return monthStartDate(month).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

// Income received in a 'YYYY-MM' month, in the main currency
function monthIncome(incomes, month, rateToMain) {
  return incomes
    .filter(income => income.month === month)
    .reduce((sum, income) => sum + (income.amount || 0) * rateToMain(income.currency || 'CHF', income.date || (month + '-01')), 0);
}

// Expenses of a 'YYYY-MM' month in the main currency: monthly ones in full, yearly
// ones in their payment month, or a twelfth every month when they have none
function monthExpenses(expenses, month, rateToMain) {
  const year = month.substring(0, 4);
  const monthNumber = Number(month.substring(5, 7));
  const inMain = (expense) => (expense.amount || 0) * rateToMain(expense.currency || 'CHF', expense.date || (year + '-01-01'));
  const yearExpenses = expenses.filter(expense => expense.year === year);
  const monthlyTotal = yearExpenses
    .filter(expense => expense.type === 'monthly')
    .reduce((sum, expense) => sum + inMain(expense), 0);
  const yearlyShare = yearExpenses
    .filter(expense => expense.type === 'yearly')
    .reduce((sum, expense) => {
      if (expense.paymentMonth) return Number(expense.paymentMonth) === monthNumber ? sum + inMain(expense) : sum;
      return sum + inMain(expense) / 12;
    }, 0);
  return monthlyTotal + yearlyShare;
}

// Income of a year in the main currency, through `throughMonth` (1-12) when given
function incomeThroughMonth(incomes, year, throughMonth, rateToMain) {
  return incomes
    .filter(income => (income.month || '').startsWith(year) && (!throughMonth || Number((income.month || '').substring(5, 7)) <= throughMonth))
    .reduce((sum, income) => sum + (income.amount || 0) * rateToMain(income.currency || 'CHF', income.date || ((income.month || (year + '-01')) + '-01')), 0);
}

// Expenses of a year in the main currency over its first `monthCount` months
function expensesThroughMonth(expenses, year, monthCount, rateToMain) {
  let total = 0;
  expenses.filter(expense => expense.year === year).forEach(expense => {
    const amount = (expense.amount || 0) * rateToMain(expense.currency || 'CHF', expense.date || (year + '-01-01'));
    if (expense.type === 'monthly') total += amount * monthCount;
    else if (!expense.paymentMonth) total += amount * (monthCount / 12);
    else if (Number(expense.paymentMonth) <= monthCount) total += amount;
  });
  return total;
}

// One "label: value" line of a monthly or yearly card
function cardLineHtml(labelHtml, valueHtml) {
  return '<div class="earning-month-line"><span class="lbl">' + labelHtml + '</span>' + valueHtml + '</div>';
}

function cardValueHtml(text, color) {
  return '<span class="val"' + (color ? ' style="color:' + color + '"' : '') + '>' + text + '</span>';
}

function infoIconHtml(title) {
  return '<span class="info-icon" title="' + title + '">i</span>';
}

// A change in money, green when up and red when down; N/A without a value
function growthHtml(amount, currency) {
  if (amount === null || amount === undefined) return cardValueHtml('N/A', MISSING_VALUE_COLOR);
  return cardValueHtml(signedCurrency(amount, currency), profitLossColor(amount));
}

// Shows `visibleCount` cards at a time with left/right buttons, starting at the newest
function setUpCarousel(cards, leftButton, rightButton, visibleCount) {
  const lastOffset = cards.length - visibleCount;
  let offset = Math.max(0, lastOffset);
  const render = () => {
    cards.forEach((card, index) => {
      card.style.display = index >= offset && index < offset + visibleCount ? '' : 'none';
    });
    if (leftButton) leftButton.disabled = offset <= 0;
    if (rightButton) rightButton.disabled = offset >= lastOffset;
  };
  // onclick, not addEventListener: the dashboard re-renders on every range
  // change, and each render must replace the previous handler, not add one.
  if (leftButton) leftButton.onclick = () => { if (offset > 0) { offset--; render(); } };
  if (rightButton) rightButton.onclick = () => { if (offset < lastOffset) { offset++; render(); } };
  render();
}

const CAPITAL_DEPLOYMENT_INFO = 'How much of your net income actually reached your accounts. Formula: NET DEPOSITS (deposits + buys - withdrawals - sells) ÷ NET INCOME × 100. Above 100% means you also drew on existing cash.';

Object.assign(Pages, {
  // ==================== DASHBOARD ====================

  async dashboard() {
    Object.values(App._charts).forEach(chart => { try { chart.destroy(); } catch (error) { /* already destroyed */ } });
    App._charts = {};

    const context = await loadValuationContext();
    const dashboard = {
      context,
      mainCurrency: context.mainCurrency,
      portfolios: await DB.getAll('portfolios'),
      incomes: await DB.getAll('incomes'),
      expenses: await DB.getAll('expenses'),
      // Accounts flagged "Include in Performance"; asset accounts are never investments
      performanceAccountIds: new Set(context.accounts.filter(account => account.trackPerformance !== false && !isAssetAccount(account)).map(account => account.id)),
    };

    this._renderDashboardTotals(dashboard);
    this._renderDashboardRateWarning(dashboard);
    this._renderDashboardPerformance(dashboard);
    this._bindDashboardChartRange();
    this._renderDashboardMonthlyCards(dashboard);
    await this._renderDashboardGoals(dashboard);
    this._renderDashboardForecast(dashboard);
    this._renderDashboardYearlyCards(dashboard);
    this._renderDashboardAllocation(dashboard);
    this._renderDashboardValueCharts(dashboard);
    this._renderDashboardSavingsTrend(dashboard);
    this._renderDashboardRecentTransactions(dashboard);
  },

  // Net worth and liquid net worth
  _renderDashboardTotals({ context, mainCurrency }) {
    const { netWorth, liquidNetWorth } = context.netWorth();
    document.getElementById('dash-total-value').textContent = formatCurrency(netWorth, mainCurrency);
    document.getElementById('dash-liquid-value').textContent = formatCurrency(liquidNetWorth, mainCurrency);
  },

  // Amounts in a currency without any stored exchange rate are counted 1:1: say so.
  // Converting into the main currency also needs the main currency's own CHF rate.
  _renderDashboardRateWarning({ context, mainCurrency, incomes, expenses }) {
    const warning = document.getElementById('dash-rate-warning');
    if (!warning) return;
    const foreignCurrencies = [
      ...context.accounts.map(account => account.currency),
      ...context.assets.map(asset => asset.currency),
      ...incomes.map(income => income.currency),
      ...expenses.map(expense => expense.currency),
    ].filter(currency => currency && currency !== mainCurrency);
    const currenciesMissingRate = currenciesWithoutRate(context.rateEntries, foreignCurrencies.length ? [...foreignCurrencies, mainCurrency] : []);
    warning.style.display = currenciesMissingRate.length ? '' : 'none';
    warning.textContent = 'NO EXCHANGE RATE FOR ' + currenciesMissingRate.join(', ') + ': THESE AMOUNTS ARE COUNTED 1:1. ADD RATES ON THE EXCHANGE RATES PAGE.';
  },

  // Investment performance card, with its YTD / 1Y / 2Y / 3Y / MAX selector
  _renderDashboardPerformance({ context, mainCurrency, performanceAccountIds }) {
    const currentTotal = context.replayBalances(performanceAccountIds, () => {});
    const performanceTransactions = context.balanceTransactionsOf(performanceAccountIds);
    const today = context.today;
    const sameDayYearsAgo = (years) => String(Number(today.substring(0, 4)) - years) + today.substring(4);
    const resultSince = (cutoffDate) => context.performanceSince(performanceAccountIds, cutoffDate, currentTotal);
    const resultBySelector = {
      ytd: resultSince(today.substring(0, 4) + '-01-01'),
      '1y': resultSince(sameDayYearsAgo(1)),
      '2y': resultSince(sameDayYearsAgo(2)),
      '3y': resultSince(sameDayYearsAgo(3)),
      max: resultSince(performanceTransactions.length > 0 ? performanceTransactions[0].date : today),
    };

    const valueElement = document.getElementById('dash-perf-value');
    const show = (result) => {
      valueElement.innerHTML = signedCurrency(result.abs, mainCurrency) + ' <span class="perf-pct">(' + signedPercent(result.pct, 2) + ')</span>';
      valueElement.style.color = profitLossColor(result.abs);
    };
    const activeButton = document.querySelector('#perf-selectors .perf-btn.active');
    show(resultBySelector[activeButton ? activeButton.dataset.perf : 'ytd']);

    document.querySelectorAll('#perf-selectors .perf-btn').forEach(button => {
      button.onclick = function () {
        document.querySelectorAll('#perf-selectors .perf-btn').forEach(other => other.classList.remove('active'));
        this.classList.add('active');
        show(resultBySelector[this.dataset.perf]);
      };
    });
  },

  // The chart range selector re-renders the whole dashboard
  _bindDashboardChartRange() {
    document.querySelectorAll('#chart-range-selectors .perf-btn').forEach(button => {
      button.onclick = function () {
        document.querySelectorAll('#chart-range-selectors .perf-btn').forEach(other => other.classList.remove('active'));
        this.classList.add('active');
        Pages.dashboard();
      };
    });
  },

  // One card per month over the last 13 months (4 visible at a time)
  _renderDashboardMonthlyCards({ context, mainCurrency, incomes, expenses, performanceAccountIds }) {
    const grid = document.getElementById('earning-perf-grid');
    const emptyMessage = document.getElementById('earning-perf-empty');
    const leftButton = document.getElementById('earning-perf-left');
    const rightButton = document.getElementById('earning-perf-right');
    if (!grid) return;
    grid.innerHTML = '';

    const monthlyResults = context.monthlyReturns(performanceAccountIds);
    const cards = [];
    let hasData = false;
    let previousTotals = null;

    lastMonthKeys(13).forEach(month => {
      const income = monthIncome(incomes, month, context.rateToMain);
      const expenseTotal = monthExpenses(expenses, month, context.rateToMain);
      const netIncome = income - expenseTotal;

      const monthTransactions = context.transactions.filter(transaction =>
        (transaction.date || '').startsWith(month) && ['deposit', 'withdrawal', 'buy', 'sell'].includes(transaction.type));
      const inMain = (transaction, amount) => context.toMain(amount, context.accountCurrency(transaction.accountId), transaction.date);
      const netDeposits = monthTransactions.reduce((sum, transaction) => sum + inMain(transaction, netDeposit(transaction)), 0);
      const totalSaved = monthTransactions.reduce((sum, transaction) => sum + inMain(transaction, savedAmount(transaction)), 0);
      if (income > 0 || netDeposits !== 0) hasData = true;

      const result = monthlyResults[month];
      const resultHtml = result
        ? cardValueHtml(formatCurrency(result.abs, mainCurrency) + ' (' + (result.abs >= 0 ? '+' : '') + result.pct.toFixed(2) + '%)', profitLossColor(result.abs))
        : cardValueHtml('N/A', MISSING_VALUE_COLOR);
      const savingsRate = income > 0 ? (netIncome / income) * 100 : null;
      const savingsRateHtml = savingsRate === null
        ? cardValueHtml('N/A', MISSING_VALUE_COLOR)
        : cardValueHtml(signedPercent(savingsRate, 1), profitLossColor(savingsRate));
      const capitalDeployment = netIncome > 0 ? (netDeposits / netIncome) * 100 : null;

      const totals = context.netWorth(monthEndDate(month, context.today));
      const netWorthGrowth = previousTotals ? totals.netWorth - previousTotals.netWorth : null;
      const liquidGrowth = previousTotals ? totals.liquidNetWorth - previousTotals.liquidNetWorth : null;
      previousTotals = totals;

      const card = document.createElement('div');
      card.className = 'col-3 earning-col';
      card.innerHTML = '<div class="earning-month">' +
        '<div class="earning-month-label">' + MONTH_NAMES[Number(month.substring(5, 7)) - 1] + ' ' + month.substring(0, 4) + '</div>' +
        cardLineHtml('INCOME', cardValueHtml(formatCurrency(income, mainCurrency))) +
        cardLineHtml('EXPENSES', cardValueHtml(formatCurrency(expenseTotal, mainCurrency))) +
        cardLineHtml('NET INCOME', cardValueHtml(formatCurrency(netIncome, mainCurrency))) +
        cardLineHtml('SAVINGS RATE', savingsRateHtml) +
        cardLineHtml('TOTAL SAVED', cardValueHtml(formatCurrency(totalSaved, mainCurrency))) +
        cardLineHtml('CAPITAL DEPLOYMENT' + infoIconHtml(CAPITAL_DEPLOYMENT_INFO), cardValueHtml(capitalDeployment === null ? 'N/A' : capitalDeployment.toFixed(1) + '%', POSITIVE_COLOR)) +
        cardLineHtml('INVESTMENT PERFORMANCE', resultHtml) +
        cardLineHtml('NET WORTH EoM', cardValueHtml(formatCurrency(totals.netWorth, mainCurrency))) +
        cardLineHtml('NET WORTH GROWTH', growthHtml(netWorthGrowth, mainCurrency)) +
        cardLineHtml('LIQUID NET WORTH EoM', cardValueHtml(formatCurrency(totals.liquidNetWorth, mainCurrency))) +
        cardLineHtml('LIQUID NET WORTH GROWTH', growthHtml(liquidGrowth, mainCurrency)) +
        '</div>';
      cards.push(card);
      grid.appendChild(card);
    });

    setUpCarousel(cards, leftButton, rightButton, 4);
    if (emptyMessage) emptyMessage.style.display = hasData ? 'none' : 'block';
    if (!hasData) {
      if (leftButton) leftButton.disabled = true;
      if (rightButton) rightButton.disabled = true;
    }
  },

  // The first three goals, in priority order
  async _renderDashboardGoals({ context, mainCurrency }) {
    const goals = await DB.getAll('goals');
    const grid = document.getElementById('dash-goal-grid');
    const emptyMessage = document.getElementById('dash-goal-empty');
    grid.innerHTML = '';
    emptyMessage.style.display = goals.length === 0 ? 'block' : 'none';
    if (goals.length === 0) return;

    const { accountValues, accountNames } = this._goalAccountValues(context);
    this._computeGoalWaterfall(this._sortGoalsByPriority(goals), accountValues).slice(0, 3).forEach(goalResult => {
      const column = document.createElement('div');
      column.className = 'col-md-4 goal-col goal-col-flush';
      column.innerHTML = this._goalCardHtml(goalResult, accountNames, true, mainCurrency);
      grid.appendChild(column);
    });
  },

  // Liquid net worth 12 months ahead, from the average and spread of the last 12 monthly returns
  _renderDashboardForecast({ context, mainCurrency }) {
    const canvas = document.getElementById('chart-forecast');
    const emptyMessage = document.getElementById('forecast-empty');
    const statsRow = document.getElementById('forecast-stats');
    if (!canvas || !emptyMessage) return;

    const liquidAccountIds = new Set(context.accounts.filter(context.isLiquidAccount).map(account => account.id));
    const currentMonth = context.today.substring(0, 7);
    const monthTotals = context.monthEndTotals(liquidAccountIds);
    const liquidCurrentTotal = context.netWorth().liquidNetWorth;
    monthTotals[currentMonth] = liquidCurrentTotal;

    // Asset purchases and sales count as capital moving in and out
    const returns = context.monthlyReturns(liquidAccountIds, { includeAssetEvents: true });
    let returnMonths = Object.keys(returns).filter(month => month < currentMonth).sort();
    if (returnMonths.length === 0) returnMonths = Object.keys(returns).sort();
    const rates = returnMonths.slice(-12).map(month => returns[month].pct / 100);

    const hasData = rates.length > 0 && liquidCurrentTotal > 0;
    emptyMessage.style.display = hasData ? 'none' : 'block';
    if (statsRow) statsRow.style.display = hasData ? '' : 'none';
    canvas.style.display = hasData ? '' : 'none';
    if (canvas.parentElement) canvas.parentElement.style.display = hasData ? '' : 'none';
    if (!hasData) return;

    const meanMonthlyReturn = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
    const variance = rates.reduce((sum, rate) => sum + (rate - meanMonthlyReturn) * (rate - meanMonthlyReturn), 0) / rates.length;
    const standardDeviation = Math.sqrt(variance);

    const historyMonths = Object.keys(monthTotals).filter(month => month <= currentMonth).sort().slice(-12);
    const labels = [];
    const historyValues = [];
    const pessimisticValues = [];
    const neutralValues = [];
    const optimisticValues = [];
    historyMonths.forEach(month => {
      labels.push(month);
      historyValues.push(monthTotals[month]);
      pessimisticValues.push(null);
      neutralValues.push(null);
      optimisticValues.push(null);
    });

    // The three projections start from the current month's value
    const startIndex = historyMonths.indexOf(currentMonth);
    const startValue = monthTotals[currentMonth] || liquidCurrentTotal;
    if (startIndex >= 0) {
      pessimisticValues[startIndex] = startValue;
      neutralValues[startIndex] = startValue;
      optimisticValues[startIndex] = startValue;
    }

    // Neutral compounds the average monthly return; pessimistic and optimistic
    // sit one standard deviation below and above it. A month can never lose
    // more than everything, hence the floor at zero.
    const now = new Date();
    let pessimisticValue = startValue;
    let neutralValue = startValue;
    let optimisticValue = startValue;
    for (let monthOffset = 1; monthOffset <= 12; monthOffset++) {
      const monthDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
      labels.push(monthDate.getFullYear() + '-' + String(monthDate.getMonth() + 1).padStart(2, '0'));
      historyValues.push(null);
      pessimisticValue *= Math.max(0, 1 + meanMonthlyReturn - standardDeviation);
      neutralValue *= Math.max(0, 1 + meanMonthlyReturn);
      optimisticValue *= 1 + meanMonthlyReturn + standardDeviation;
      pessimisticValues.push(pessimisticValue);
      neutralValues.push(neutralValue);
      optimisticValues.push(optimisticValue);
    }
    const projectedValue = neutralValue;

    const yearAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const initialValue = monthTotals[yearAgo.getFullYear() + '-' + String(yearAgo.getMonth() + 1).padStart(2, '0')];
    const growthAmount = projectedValue - startValue;
    const growthPercent = startValue > 0 ? (growthAmount / startValue) * 100 : 0;

    const setText = (id, text) => { const element = document.getElementById(id); if (element) element.textContent = text; };
    setText('forecast-initial', initialValue !== undefined ? formatCurrency(initialValue, mainCurrency) : 'N/A');
    setText('forecast-current', formatCurrency(startValue, mainCurrency));
    setText('forecast-projected', formatCurrency(projectedValue, mainCurrency));
    const growthElement = document.getElementById('forecast-growth');
    if (growthElement) {
      growthElement.innerHTML = signedCurrency(growthAmount, mainCurrency) + ' <span class="perf-pct">(' + signedPercent(growthPercent, 2) + ')</span>';
      growthElement.className = 'stat-value forecast-stat ' + plClass(growthAmount);
    }
    const returnElement = document.getElementById('forecast-roi');
    if (returnElement) {
      returnElement.innerHTML = signedPercent(meanMonthlyReturn * 100, 2) + ' <span class="perf-pct">+/&minus;' + (standardDeviation * 100).toFixed(2) + '%</span>';
      returnElement.className = 'stat-value forecast-stat ' + plClass(meanMonthlyReturn);
    }

    const projectionDataset = (label, data, color) => ({
      label, data, borderColor: color, backgroundColor: color + '0d', borderDash: [6, 4], tension: 0.3,
      pointRadius: 3, pointBackgroundColor: color, borderWidth: 2, fill: false,
    });
    const monthLabel = (month, year) => (month ? monthStartDate(month).toLocaleDateString('en-GB', { month: 'short', year }) : '');
    App._charts.forecast = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'HISTORY', data: historyValues, borderColor: readAccent(), backgroundColor: shadeAccent(readAccent(), 1, 0.05),
            fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: readAccent(), borderWidth: 2,
          },
          projectionDataset('PESSIMISTIC', pessimisticValues, '#ff3333'),
          projectionDataset('NEUTRAL', neutralValues, '#33ccff'),
          projectionDataset('OPTIMISTIC', optimisticValues, '#ffaa00'),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#d0d0d0', font: { family: CHART_FONT, size: 12 }, padding: 8 } },
          tooltip: { callbacks: { title: items => monthLabel(items && items.length ? items[0].label : '', 'numeric') } },
        },
        scales: {
          x: { ticks: { color: '#888', font: { size: 12, family: CHART_FONT }, callback: index => monthLabel(labels[index], '2-digit') }, grid: { color: '#222' } },
          y: { ticks: { color: '#888', font: { size: 12, family: CHART_FONT }, callback: value => formatCurrency(value, mainCurrency) }, grid: { color: '#222' } },
        },
      },
    });
  },

  // One card per year over the last 5 years that have data (4 visible at a time)
  _renderDashboardYearlyCards({ context, mainCurrency, incomes, expenses, performanceAccountIds }) {
    const grid = document.getElementById('decade-anal-grid');
    const emptyMessage = document.getElementById('decade-anal-empty');
    const leftButton = document.getElementById('decade-anal-left');
    const rightButton = document.getElementById('decade-anal-right');
    if (!grid || !emptyMessage) return;

    const today = context.today;
    const currentYear = today.substring(0, 4);
    const currentMonthNumber = Number(today.substring(5, 7));
    const candidateYears = [4, 3, 2, 1, 0].map(yearsBack => String(Number(currentYear) - yearsBack));
    const yearEnd = (year) => (year === currentYear ? today : year + '-12-31');
    const inMain = (transaction, amount) => context.toMain(amount, context.accountCurrency(transaction.accountId), transaction.date);

    const netDepositsByYear = {};
    const savedByYear = {};
    context.balanceTransactions.forEach(transaction => {
      const year = (transaction.date || '').substring(0, 4);
      if (!year) return;
      if (netDeposit(transaction) !== 0) netDepositsByYear[year] = (netDepositsByYear[year] || 0) + inMain(transaction, netDeposit(transaction));
      if (savedAmount(transaction) !== 0) savedByYear[year] = (savedByYear[year] || 0) + inMain(transaction, savedAmount(transaction));
    });

    // Investment result of the performance accounts over a year, see periodResult()
    const investmentResultForYear = (year) => {
      const start = year + '-01-01';
      const end = yearEnd(year);
      return periodResult(
        context.recordedTotal(performanceAccountIds, start),
        context.recordedTotal(performanceAccountIds, end),
        context.capitalAddedBetween(performanceAccountIds, start, end),
      );
    };

    // Time-weighted return: links the sub-period returns between capital-flow dates
    const timeWeightedReturn = (year) => {
      const start = year + '-01-01';
      const end = yearEnd(year);
      const flowDates = [...new Set(
        context.balanceTransactionsOf(performanceAccountIds)
          .filter(transaction => (transaction.date || '') >= start && (transaction.date || '') <= end && isCapitalFlow(transaction))
          .map(transaction => transaction.date),
      )].sort();
      let growthFactor = 1;
      let periodStartValue = context.recordedTotal(performanceAccountIds, start);
      flowDates.forEach(flowDate => {
        const valueBeforeFlow = context.recordedTotal(performanceAccountIds, flowDate, true);
        if (periodStartValue !== 0) growthFactor *= valueBeforeFlow / periodStartValue;
        periodStartValue = context.recordedTotal(performanceAccountIds, flowDate);
      });
      const endValue = context.recordedTotal(performanceAccountIds, end);
      if (periodStartValue !== 0) growthFactor *= endValue / periodStartValue;
      return (growthFactor - 1) * 100;
    };

    // Money-weighted return (IRR): the yearly rate at which all flows net to zero; null when none exists
    const moneyWeightedReturn = (year) => {
      const start = year + '-01-01';
      const end = yearEnd(year);
      const startTime = new Date(start).getTime();
      const endTime = new Date(end).getTime();
      const flows = [{ yearFraction: 0, amount: -context.recordedTotal(performanceAccountIds, start) }];
      context.balanceTransactionsOf(performanceAccountIds).forEach(transaction => {
        if ((transaction.date || '') < start || (transaction.date || '') > end || !isCapitalFlow(transaction)) return;
        flows.push({ yearFraction: (new Date(transaction.date).getTime() - startTime) / (endTime - startTime), amount: -inMain(transaction, capitalFlow(transaction)) });
      });
      flows.push({ yearFraction: 1, amount: context.recordedTotal(performanceAccountIds, end) });

      const netPresentValue = (rate) => flows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, flow.yearFraction), 0);
      let low = -0.999;
      let high = 10;
      if (netPresentValue(low) * netPresentValue(high) > 0) return null;
      for (let step = 0; step < 200; step++) {
        const middle = (low + high) / 2;
        if (netPresentValue(middle) * netPresentValue(low) > 0) low = middle;
        else high = middle;
      }
      return ((low + high) / 2) * 100;
    };

    const yearStats = {};
    candidateYears.forEach(year => {
      const isCurrentYear = year === currentYear;
      const totals = context.netWorth(yearEnd(year));
      const income = incomeThroughMonth(incomes, year, isCurrentYear ? currentMonthNumber : null, context.rateToMain);
      // The current year counts income and expenses through the current month alike
      const expenseTotal = expensesThroughMonth(expenses, year, isCurrentYear ? currentMonthNumber : 12, context.rateToMain);
      const netIncome = income - expenseTotal;
      yearStats[year] = {
        netWorth: totals.netWorth,
        liquidNetWorth: totals.liquidNetWorth,
        netDeposits: netDepositsByYear[year] || 0,
        totalSaved: savedByYear[year] || 0,
        income,
        expenses: expenseTotal,
        netIncome,
        savingsRate: income > 0 ? (netIncome / income) * 100 : null,
        investmentResult: investmentResultForYear(year),
        timeWeightedReturn: timeWeightedReturn(year),
        moneyWeightedReturn: moneyWeightedReturn(year),
      };
    });

    const years = candidateYears.filter(year =>
      context.balanceTransactions.some(transaction => (transaction.date || '').startsWith(year) && ['deposit', 'withdrawal', 'buy', 'sell', 'valuation'].includes(transaction.type)) ||
      incomes.some(income => (income.month || '').startsWith(year)) ||
      expenses.some(expense => expense.year === year));
    const yearsWithData = new Set(years);

    // Year-over-year changes against the previous year, when it has data. For the
    // current (partial) year the previous year is cut to the same months.
    Object.keys(yearStats).forEach(year => {
      const previousYear = String(Number(year) - 1);
      const previous = yearsWithData.has(previousYear) ? yearStats[previousYear] : null;
      const stats = yearStats[year];
      const isCurrentYear = year === currentYear;
      const previousIncome = !previous ? null : isCurrentYear ? incomeThroughMonth(incomes, previousYear, currentMonthNumber, context.rateToMain) : previous.income;
      const previousExpenses = !previous ? null : isCurrentYear ? expensesThroughMonth(expenses, previousYear, currentMonthNumber, context.rateToMain) : previous.expenses;
      stats.incomeChange = previousIncome === null ? null : stats.income - previousIncome;
      stats.expenseChange = previousExpenses === null ? null : stats.expenses - previousExpenses;
      stats.savingsRateChange = previous && stats.savingsRate !== null && previous.savingsRate !== null ? stats.savingsRate - previous.savingsRate : null;
      stats.capitalDeployment = stats.netIncome > 0 ? (stats.netDeposits / stats.netIncome) * 100 : null;
    });

    // A change against last year, with its percent; `lowerIsBetter` colors a drop green
    const changeHtml = (change, previousValue, lowerIsBetter) => {
      if (change === null || change === undefined) return cardValueHtml('N/A', MISSING_VALUE_COLOR);
      const isGood = lowerIsBetter ? change < 0 : change >= 0;
      const sign = change >= 0 ? '+' : '-';
      let text = sign + formatCurrency(Math.abs(change), mainCurrency);
      if (previousValue) text += ' (' + sign + ((Math.abs(change) / Math.abs(previousValue)) * 100).toFixed(1) + '%)';
      return cardValueHtml(text, isGood ? POSITIVE_COLOR : NEGATIVE_COLOR);
    };
    const returnHtml = (value) => (value === null || value === undefined ? cardValueHtml('N/A', MISSING_VALUE_COLOR) : cardValueHtml(signedPercent(value, 2), profitLossColor(value)));

    const firstYearStart = years[0] ? context.netWorth(years[0] + '-01-01') : null;
    const cards = [];
    grid.innerHTML = '';
    years.forEach((year, index) => {
      const stats = yearStats[year];
      const previousTotals = index > 0 ? yearStats[years[index - 1]] : firstYearStart;
      const result = stats.investmentResult;
      const card = document.createElement('div');
      card.className = 'col-3 earning-col';
      card.innerHTML = '<div class="earning-month">' +
        '<div class="earning-month-label">' + year + '</div>' +
        cardLineHtml('INCOME', cardValueHtml(formatCurrency(stats.income, mainCurrency))) +
        cardLineHtml('INCOME YoY' + infoIconHtml('Change in income vs previous year'), changeHtml(stats.incomeChange, stats.income - (stats.incomeChange || 0), false)) +
        cardLineHtml('EXPENSES', cardValueHtml(formatCurrency(stats.expenses, mainCurrency))) +
        cardLineHtml('EXPENSES YoY' + infoIconHtml('Change in expenses vs previous year'), changeHtml(stats.expenseChange, stats.expenses - (stats.expenseChange || 0), true)) +
        cardLineHtml('NET INCOME', cardValueHtml(formatCurrency(stats.netIncome, mainCurrency))) +
        cardLineHtml('SAVINGS RATE' + infoIconHtml('Share of income not spent. Formula: NET INCOME ÷ INCOME × 100'),
          stats.savingsRate === null ? cardValueHtml('N/A', MISSING_VALUE_COLOR) : cardValueHtml(signedPercent(stats.savingsRate, 1), profitLossColor(stats.savingsRate))) +
        cardLineHtml('SAVINGS RATE YoY' + infoIconHtml('Change in savings rate vs previous year, in percentage points'),
          stats.savingsRateChange === null ? cardValueHtml('N/A', POSITIVE_COLOR) : cardValueHtml((stats.savingsRateChange >= 0 ? '+' : '') + stats.savingsRateChange.toFixed(1) + 'pp', profitLossColor(stats.savingsRateChange))) +
        cardLineHtml('TOTAL SAVED' + infoIconHtml('Deposits minus withdrawals made into all accounts during the year'), cardValueHtml(formatCurrency(stats.totalSaved, mainCurrency))) +
        cardLineHtml('CAPITAL DEPLOYMENT' + infoIconHtml(CAPITAL_DEPLOYMENT_INFO), cardValueHtml(stats.capitalDeployment === null ? 'N/A' : stats.capitalDeployment.toFixed(1) + '%', POSITIVE_COLOR)) +
        cardLineHtml('INVESTMENTS PERFORMANCE' + infoIconHtml('Gain in investment accounts relative to capital deployed. Formula: (value EoY - value BoY - net flows) ÷ (value BoY + net flows) × 100'),
          cardValueHtml(signedCurrency(result.abs, mainCurrency) + ' (' + signedPercent(result.pct, 2) + ')', profitLossColor(result.abs))) +
        cardLineHtml('TWR' + infoIconHtml('Time-weighted return: isolates market performance by removing the effect of cash flow timing. Best measure to compare against an index.'), returnHtml(stats.timeWeightedReturn)) +
        cardLineHtml('MWR' + infoIconHtml('Money-weighted return (IRR): accounts for the size and timing of every deposit/withdrawal, weighted by how long money was invested. Best measure of your personal experience.'), returnHtml(stats.moneyWeightedReturn)) +
        cardLineHtml('NET WORTH EoY', cardValueHtml(formatCurrency(stats.netWorth, mainCurrency))) +
        cardLineHtml('NET WORTH GROWTH' + infoIconHtml('Change in net worth vs previous year-end'), growthHtml(previousTotals ? stats.netWorth - previousTotals.netWorth : null, mainCurrency)) +
        cardLineHtml('LIQUID NET WORTH EoY', cardValueHtml(formatCurrency(stats.liquidNetWorth, mainCurrency))) +
        cardLineHtml('LIQUID NET WORTH GROWTH' + infoIconHtml('Change in liquid net worth vs previous year-end'), growthHtml(previousTotals ? stats.liquidNetWorth - previousTotals.liquidNetWorth : null, mainCurrency)) +
        '</div>';
      cards.push(card);
      grid.appendChild(card);
    });

    emptyMessage.style.display = years.length === 0 ? 'block' : 'none';
    if (years.length === 0) {
      if (leftButton) leftButton.disabled = true;
      if (rightButton) rightButton.disabled = true;
      return;
    }
    setUpCarousel(cards, leftButton, rightButton, 4);
  },

  // Doughnut of net worth per portfolio
  _renderDashboardAllocation({ context, portfolios }) {
    const canvas = document.getElementById('chart-allocation');
    if (!canvas) return;

    const portfolioValues = {};
    portfolios.forEach(portfolio => { portfolioValues[portfolio.id] = { name: portfolio.name, value: 0 }; });
    context.accounts.forEach(account => {
      if (account.includeInNetWorth === false || !portfolioValues[account.portfolioId]) return;
      portfolioValues[account.portfolioId].value += context.accountValueInMain(account);
    });
    const totalValue = context.netWorth().netWorth;

    const palette = chartPalette();
    const rows = Object.values(portfolioValues)
      .filter(portfolio => portfolio.value > 0)
      .map((portfolio, index) => ({
        name: portfolio.name,
        value: portfolio.value,
        percent: totalValue > 0 ? Math.round((portfolio.value / totalValue) * 100) : 0,
        color: palette[index % palette.length],
      }));
    const hasData = rows.length > 0;

    App._charts.allocation = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: hasData ? rows.map(row => row.name + ' (' + row.percent + '%)') : ['NO DATA'],
        datasets: [{
          data: hasData ? rows.map(row => row.value) : [1],
          backgroundColor: hasData ? rows.map(row => row.color) : ['#333333'],
          borderColor: '#161616',
          borderWidth: 2,
        }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
    });

    const legend = document.getElementById('alloc-legend');
    if (legend) {
      legend.innerHTML = hasData
        ? rows.map(row =>
            '<div class="alloc-legend-row">' +
              '<span class="alloc-legend-swatch" style="background:' + row.color + '"></span>' +
              '<span class="alloc-legend-pct">' + row.percent + '%</span>' +
              '<span class="alloc-legend-name">' + escapeHtml(row.name) + '</span>' +
            '</div>').join('')
        : '<div class="alloc-legend-row"><span class="alloc-legend-name">NO DATA</span></div>';
    }
  },

  // "Performance over time" (value) and "Investment performance" (monthly %) charts, sharing the range selector
  _renderDashboardValueCharts({ context, mainCurrency, performanceAccountIds }) {
    const activeRange = document.querySelector('#chart-range-selectors .perf-btn.active');
    const range = activeRange ? activeRange.dataset.range : '1y';
    const performanceCanvas = document.getElementById('chart-performance');
    if (performanceCanvas) this._renderDashboardRangeChart(context, mainCurrency, performanceCanvas, 'performance', performanceAccountIds, range, readAccent(), {});
    const investmentCanvas = document.getElementById('chart-investment');
    if (investmentCanvas) this._renderDashboardRangeChart(context, mainCurrency, investmentCanvas, 'investment', performanceAccountIds, range, '#33ccff', { percent: true, average: true });
  },

  // One point per month: the end-of-month total value, or with `percent` the
  // month's investment result in %. `average` adds a dashed average line.
  _renderDashboardRangeChart(context, mainCurrency, canvas, chartKey, accountIds, range, color, { percent = false, average = false }) {
    const monthTotals = context.monthEndTotals(accountIds);
    const currentTotal = context.replayBalances(accountIds, () => {});
    let points = Object.entries(monthTotals).map(([month, value]) => ({ month, value }));

    const currentMonth = context.today.substring(0, 7);
    if (!monthTotals[currentMonth] && currentTotal > 0) points.push({ month: currentMonth, value: currentTotal });

    if (points.length > 0) {
      const latestMonth = points.reduce((latest, point) => (latest.month > point.month ? latest : point)).month;
      let cutoffMonth = '';
      if (range === 'ytd') {
        cutoffMonth = context.today.substring(0, 4) + '-01';
      } else if (range !== 'max') {
        const years = parseInt(range.replace('y', '')) || 1;
        const cutoff = new Date(latestMonth + '-01');
        cutoff.setFullYear(cutoff.getFullYear() - years);
        cutoffMonth = cutoff.toISOString().substring(0, 7);
      }
      if (cutoffMonth) points = points.filter(point => point.month >= cutoffMonth);
    }
    points.sort((first, second) => first.month.localeCompare(second.month));
    if (points.length === 0) points.push({ month: currentMonth, value: currentTotal || 0 });

    const labels = points.map(point => shortMonthLabel(point.month));
    let values;
    if (percent) {
      const monthlyResults = context.monthlyReturns(accountIds);
      values = points.map(point => (monthlyResults[point.month] != null ? monthlyResults[point.month].pct : 0));
    } else {
      values = points.map(point => point.value);
    }

    const datasets = [{
      label: percent ? 'MONTHLY P/L %' : 'TOTAL VALUE',
      data: values,
      borderColor: color,
      backgroundColor: percent ? 'transparent' : color + '0d',
      fill: !percent,
      tension: percent ? 0.15 : 0.3,
      pointRadius: percent ? 0 : 4,
      pointBackgroundColor: percent ? undefined : color,
      pointHitRadius: percent ? 8 : undefined,
      borderWidth: 2,
    }];
    if (average) {
      const averageValue = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      datasets.push({ label: 'AVG', data: values.map(() => averageValue), borderColor: '#ffaa00', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, pointHitRadius: 12, fill: false, tension: 0 });
    }

    const formatValue = percent ? value => value.toFixed(2) + '%' : value => formatCurrency(value, mainCurrency);
    App._charts[chartKey] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      plugins: percent ? [this._positiveNegativeFillPlugin(values)] : [],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: average, labels: { color: '#aaa', boxWidth: 14, font: { size: 11, family: CHART_FONT } } },
          tooltip: {
            callbacks: {
              title: items => (items.length ? labels[items[0].dataIndex] : ''),
              label: item => (item.datasetIndex === 1 && average ? 'AVG: ' : item.dataset.label + ': ') + formatValue(item.parsed.y),
            },
          },
        },
        scales: {
          x: { ticks: { color: '#888', font: { size: 12, family: CHART_FONT } }, grid: { color: '#222' } },
          y: { ticks: { color: '#888', font: { size: 12, family: CHART_FONT }, callback: formatValue }, grid: { color: '#222' } },
        },
      },
    });
  },

  // Chart.js plugin: fills the area between the line and zero, green above and red below
  _positiveNegativeFillPlugin(values) {
    const positiveFill = 'rgba(51,255,51,0.18)';
    const negativeFill = 'rgba(255,51,51,0.18)';
    const fillPolygon = (context, corners, fillStyle) => {
      context.beginPath();
      context.moveTo(corners[0][0], corners[0][1]);
      corners.slice(1).forEach(([x, y]) => context.lineTo(x, y));
      context.closePath();
      context.fillStyle = fillStyle;
      context.fill();
    };
    return {
      id: 'zeroFillSplit',
      beforeDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        if (!meta || meta.hidden) return;
        const points = meta.data;
        if (!points || points.length < 2) return;
        const context = chart.ctx;
        const zeroY = chart.scales.y.getPixelForValue(0);
        context.save();

        for (let index = 0; index < points.length - 1; index++) {
          const x0 = points[index].x, y0 = points[index].y;
          const x1 = points[index + 1].x, y1 = points[index + 1].y;
          const startPositive = values[index] >= 0;
          const endPositive = values[index + 1] >= 0;
          if (startPositive === endPositive) {
            fillPolygon(context, [[x0, zeroY], [x0, y0], [x1, y1], [x1, zeroY]], startPositive ? positiveFill : negativeFill);
          } else {
            // The segment crosses zero: fill each side up to the crossing point
            const crossingX = x0 + ((0 - values[index]) / (values[index + 1] - values[index])) * (x1 - x0);
            fillPolygon(context, [[x0, zeroY], [x0, y0], [crossingX, zeroY]], startPositive ? positiveFill : negativeFill);
            fillPolygon(context, [[crossingX, zeroY], [x1, y1], [x1, zeroY]], endPositive ? positiveFill : negativeFill);
          }
        }

        points.forEach((point, index) => {
          context.beginPath();
          context.arc(point.x, point.y, 4, 0, Math.PI * 2);
          context.fillStyle = profitLossColor(values[index]);
          context.fill();
          context.strokeStyle = '#1a1a2e';
          context.lineWidth = 1.5;
          context.stroke();
        });

        context.restore();
      },
    };
  },

  // Net income and money saved per month over a selectable range, with months you can leave out
  _renderDashboardSavingsTrend({ context, mainCurrency, incomes, expenses }) {
    const canvas = document.getElementById('chart-savings-rate');
    const emptyMessage = document.getElementById('savings-rate-empty');
    const statsCard = document.getElementById('sr-stats-card');
    if (!canvas || !emptyMessage) return;

    // Months with income over the last 5 years (61 months), oldest first
    const monthData = [];
    lastMonthKeys(61).forEach(month => {
      const income = monthIncome(incomes, month, context.rateToMain);
      if (!(income > 0)) return;
      const totalSaved = context.transactions
        .filter(transaction => (transaction.date || '').startsWith(month) && (transaction.type === 'deposit' || transaction.type === 'withdrawal'))
        .reduce((sum, transaction) => sum + context.toMain(savedAmount(transaction), context.accountCurrency(transaction.accountId), transaction.date), 0);
      monthData.push({ key: month, label: shortMonthLabel(month), netIncome: income - monthExpenses(expenses, month, context.rateToMain), totalSaved });
    });
    // Months left out by the user, kept for the session
    const excludedMonths = (App._srExcludedMonths = App._srExcludedMonths || new Set());

    const render = (animate = true) => {
      if (App._charts.savingsRate) { try { App._charts.savingsRate.destroy(); } catch (error) { /* already destroyed */ } delete App._charts.savingsRate; }

      const activeButton = document.querySelector('#sr-range-selectors .perf-btn.active');
      const range = activeButton ? activeButton.dataset.range : '1y';
      let monthsInRange = monthData;
      if (monthData.length > 0 && range !== 'max') {
        const latestDate = new Date(monthData[monthData.length - 1].key + '-01');
        let cutoff;
        if (range === 'ytd') {
          cutoff = new Date(latestDate.getFullYear(), 0, 1);
        } else {
          cutoff = new Date(latestDate);
          cutoff.setMonth(cutoff.getMonth() - ((parseInt(range.replace('y', '')) || 1) * 12 - 1));
        }
        const cutoffMonth = cutoff.getFullYear() + '-' + String(cutoff.getMonth() + 1).padStart(2, '0');
        monthsInRange = monthData.filter(month => month.key >= cutoffMonth);
      }
      const shownMonths = monthsInRange.filter(month => !excludedMonths.has(month.key));
      const isExcluded = index => Boolean(monthsInRange[index]) && excludedMonths.has(monthsInRange[index].key);

      // The chart stays up while every month is excluded: its x axis is where months are switched back on
      const showChart = monthsInRange.length > 0;
      emptyMessage.style.display = showChart ? 'none' : 'block';
      canvas.style.display = showChart ? '' : 'none';
      if (statsCard) statsCard.style.display = showChart ? '' : 'none';
      if (!showChart) return;

      const shownNetIncomeValues = shownMonths.map(month => month.netIncome);
      const shownTotalSavedValues = shownMonths.map(month => month.totalSaved);
      const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
      const signedHtml = value => '<span style="color:' + profitLossColor(value) + '">' + signedCurrency(value, mainCurrency) + '</span>';
      const setStat = (id, values, summarize) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = values.length ? signedHtml(summarize(values)) : '—';
      };
      setStat('sr-min', shownNetIncomeValues, values => Math.min(...values));
      setStat('sr-avg', shownNetIncomeValues, average);
      setStat('sr-max', shownNetIncomeValues, values => Math.max(...values));
      setStat('sr-min-saved', shownTotalSavedValues, values => Math.min(...values));
      setStat('sr-avg-saved', shownTotalSavedValues, average);
      setStat('sr-max-saved', shownTotalSavedValues, values => Math.max(...values));

      // Every month in range keeps its place on the axis; an excluded month has no point (null)
      const netIncomeValues = monthsInRange.map(month => excludedMonths.has(month.key) ? null : month.netIncome);
      const totalSavedValues = monthsInRange.map(month => excludedMonths.has(month.key) ? null : month.totalSaved);
      const monthIndexAtAxis = (chart, event) => {
        const axis = chart.scales.x;
        if (event.y < axis.top || event.y > axis.bottom || event.x < axis.left || event.x > axis.right) return null;
        const index = Math.round(axis.getValueForPixel(event.x));
        return index >= 0 && index < monthsInRange.length ? index : null;
      };

      App._charts.savingsRate = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: monthsInRange.map(month => month.label),
          datasets: [
            {
              label: 'NET INCOME', data: netIncomeValues, borderColor: readAccent(), backgroundColor: shadeAccent(readAccent(), 1, 0.08),
              fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: netIncomeValues.map(value => value === null ? 'transparent' : profitLossColor(value)), borderWidth: 2, yAxisID: 'y', spanGaps: true,
            },
            {
              label: 'TOTAL SAVED', data: totalSavedValues, borderColor: '#33ccff', backgroundColor: 'rgba(51,204,255,0.08)',
              fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#33ccff', borderWidth: 2, yAxisID: 'y', spanGaps: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: animate ? undefined : false,
          plugins: {
            legend: { display: true, labels: { color: '#aaa', boxWidth: 14, font: { size: 11, family: CHART_FONT } } },
            tooltip: { callbacks: { label: item => (item.datasetIndex === 0 ? 'NET INCOME: ' : 'TOTAL SAVED: ') + formatCurrency(item.parsed.y, mainCurrency) } },
          },
          scales: {
            x: {
              ticks: {
                // Every month label is a switch, so show them all unless they would not fit (2Y+)
                autoSkip: monthsInRange.length > 24,
                color: tick => isExcluded(tick.index) ? '#444' : '#888',
                font: { size: 12, family: CHART_FONT },
              },
              grid: { color: tick => isExcluded(tick.index) ? 'rgba(255,85,85,0.35)' : '#222' },
            },
            y: { ticks: { color: '#888', font: { size: 12, family: CHART_FONT }, callback: value => formatCurrency(value, mainCurrency) }, grid: { color: '#222' } },
          },
        },
        // Clicking a month on the x axis includes or excludes it from the graph and statistics.
        // A plugin hook, because Chart.js only calls onClick/onHover inside the plot area.
        plugins: [{
          id: 'monthAxisToggle',
          afterEvent: (chart, args) => {
            const index = monthIndexAtAxis(chart, args.event);
            if (args.event.type === 'mousemove') chart.canvas.style.cursor = index === null ? '' : 'pointer';
            if (args.event.type !== 'click' || index === null) return;
            const key = monthsInRange[index].key;
            if (excludedMonths.has(key)) excludedMonths.delete(key);
            else excludedMonths.add(key);
            setTimeout(() => render(false)); // not inside the chart's own event handler, which render destroys
          },
        }],
      });
    };

    render();
    document.querySelectorAll('#sr-range-selectors .perf-btn').forEach(button => {
      button.onclick = function () {
        document.querySelectorAll('#sr-range-selectors .perf-btn').forEach(other => other.classList.remove('active'));
        this.classList.add('active');
        render();
      };
    });
  },

  // The 10 most recently entered transactions
  _renderDashboardRecentTransactions({ context }) {
    const tbody = document.getElementById('dash-tx-body');
    const emptyMessage = document.getElementById('dash-tx-empty');
    const recent = [...context.transactions]
      .sort((first, second) => new Date(second.createdAt || second.date) - new Date(first.createdAt || first.date))
      .slice(0, 10);
    tbody.innerHTML = '';
    emptyMessage.style.display = recent.length === 0 ? 'block' : 'none';

    const accountsById = {};
    context.accounts.forEach(account => { accountsById[account.id] = account; });
    recent.forEach(transaction => {
      const account = accountsById[transaction.accountId];
      const currency = account ? account.currency : 'CHF';
      const amount = transaction.type === 'valuation' ? transaction.amount : Math.abs(transaction.amount);
      const row = document.createElement('tr');
      row.innerHTML = `<td><span class="tx-badge ${transactionBadgeClass(transaction)}">${transactionTypeLabel(transaction)}</span></td>
        <td>${account ? escapeHtml(account.name) : '—'}</td>
        <td>${formatCurrency(amount, currency)}</td>
        <td>${formatDate(transaction.date)}</td>`;
      tbody.appendChild(row);
    });
  },
});

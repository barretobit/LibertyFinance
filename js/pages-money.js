// Change against the previous year, with its percent: "+CHF 1,200.00 (+4.00%)"
function yearOverYearText(change, previousTotal, mainCurrency) {
  const percent = previousTotal !== 0 ? (change / previousTotal) * 100 : null;
  return signedCurrency(change, mainCurrency) + (percent != null ? ' (' + signedPercent(percent, 2) + ')' : '');
}

// Fills a year <select> with the given years plus the current one, newest first,
// keeping the selection; returns the selected year
function fillYearSelect(select, years) {
  const previousSelection = select.value;
  const currentYear = new Date().getFullYear().toString();
  const options = [...new Set(years.filter(Boolean))].sort().reverse();
  if (!options.includes(currentYear)) options.unshift(currentYear);
  select.innerHTML = options.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join('');
  select.value = previousSelection && options.includes(previousSelection) ? previousSelection : currentYear;
  return select.value;
}

Object.assign(Pages, {
  // ==================== CUSTODIANS ====================

  async custodians() {
    const custodians = await DB.getAll('custodians');
    const list = document.getElementById('custodian-list');
    const emptyMessage = document.getElementById('custodian-empty');
    list.innerHTML = '';
    emptyMessage.style.display = custodians.length === 0 ? 'block' : 'none';

    custodians.forEach(custodian => {
      const column = document.createElement('div');
      column.className = 'col-md-4 col-sm-6 mb-3';
      column.innerHTML = `<div class="cus-card">
        <div class="cus-name">${escapeHtml(custodian.name)}</div>
        <div class="cus-notes">${escapeHtml(custodian.notes || '')}</div>
        <div class="cus-actions">
          <button class="btn btn-gta btn-sm me-2" onclick="App.showModal('custodian', ${Number(custodian.id)})">EDIT</button>
        </div>
      </div>`;
      list.appendChild(column);
    });
  },

  // ==================== INCOMES ====================

  async incomes() {
    const allIncomes = await DB.getAll('incomes');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const inMain = (income) => (income.amount || 0) * currencyRateTo(rateEntries, income.currency || 'CHF', mainCurrency, income.date || ((income.month || '') + '-01'));
    const yearSelect = document.getElementById('income-year-select');
    if (!yearSelect) return;

    const selectedYear = fillYearSelect(yearSelect, allIncomes.map(income => (income.month || '').substring(0, 4)));
    const yearIncomes = allIncomes.filter(income => (income.month || '').startsWith(selectedYear));
    const total = yearIncomes.reduce((sum, income) => sum + inMain(income), 0);
    const monthsWithIncome = new Set(yearIncomes.map(income => income.month).filter(Boolean)).size;
    document.getElementById('income-total').textContent = formatCurrency(total, mainCurrency);
    document.getElementById('income-avg-monthly').textContent = formatCurrency(monthsWithIncome > 0 ? total / monthsWithIncome : 0, mainCurrency);

    // The current year is not finished: compare only the months elapsed so far in both years
    const today = new Date();
    const currentMonth = String(today.getMonth() + 1).padStart(2, '0');
    const isCurrentYear = selectedYear === today.getFullYear().toString();
    const incomesOfYear = (year) => allIncomes.filter(income => {
      const month = income.month || '';
      return month.startsWith(year) && (!isCurrentYear || month.substring(0, 7) <= year + '-' + currentMonth);
    });
    const previousIncomes = incomesOfYear(String(Number(selectedYear) - 1));
    const changeElement = document.getElementById('income-change');
    if (previousIncomes.length === 0) {
      changeElement.textContent = '-';
    } else {
      const previousTotal = previousIncomes.reduce((sum, income) => sum + inMain(income), 0);
      const comparableTotal = incomesOfYear(selectedYear).reduce((sum, income) => sum + inMain(income), 0);
      changeElement.textContent = yearOverYearText(comparableTotal - previousTotal, previousTotal, mainCurrency);
    }

    const tbody = document.getElementById('income-list-body');
    const emptyMessage = document.getElementById('income-empty');
    tbody.innerHTML = '';
    emptyMessage.style.display = yearIncomes.length === 0 ? 'block' : 'none';

    yearIncomes
      .sort((first, second) => (first.date || '').localeCompare(second.date || '') || first.id - second.id)
      .forEach(income => {
        const incomeId = Number(income.id);
        const row = document.createElement('tr');
        row.innerHTML = `<td>${escapeHtml(income.source)}</td>
          <td>${formatCurrency(income.amount, income.currency)}</td>
          <td>${formatDate(income.date)}</td>
          <td>${escapeHtml(income.notes || '')}</td>
          <td>
            <a class="tx-link me-2" onclick="App.showModal('income', ${incomeId})">EDIT</a>
            <a class="tx-link" onclick="App.deleteIncome(${incomeId})">DELETE</a>
          </td>`;
        tbody.appendChild(row);
      });
  },

  // ==================== EXPENSES ====================

  async expenses() {
    const allExpenses = await DB.getAll('expenses');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const rateOf = (expense) => currencyRateTo(rateEntries, expense.currency || 'CHF', mainCurrency, expense.date || ((expense.year || '') + '-01-01'));
    // Cost of an expense over a year, in its own currency: monthly ones count twelve times
    const annualCost = (expense) => (expense.amount || 0) * (expense.type === 'monthly' ? 12 : 1);
    const yearSelect = document.getElementById('expense-year-select');
    if (!yearSelect) return;

    const selectedYear = fillYearSelect(yearSelect, allExpenses.map(expense => expense.year));
    const yearExpenses = allExpenses.filter(expense => expense.year === selectedYear);
    let totalAnnual = 0;
    let totalMonthly = 0;
    yearExpenses.forEach(expense => {
      const amount = (expense.amount || 0) * rateOf(expense);
      if (expense.type === 'monthly') {
        totalAnnual += amount * 12;
        totalMonthly += amount;
      } else {
        totalAnnual += amount;
        // A yearly expense without a payment month is spread across the 12 months
        if (!expense.paymentMonth) totalMonthly += amount / 12;
      }
    });
    document.getElementById('expense-total').textContent = formatCurrency(totalAnnual, mainCurrency);
    document.getElementById('expense-total-monthly').textContent = formatCurrency(totalMonthly, mainCurrency);

    const previousExpenses = allExpenses.filter(expense => expense.year === String(Number(selectedYear) - 1));
    const changeElement = document.getElementById('expense-change');
    if (previousExpenses.length === 0) {
      changeElement.textContent = '-';
    } else {
      const previousTotal = previousExpenses.reduce((sum, expense) => {
        const amount = (expense.amount || 0) * rateOf(expense);
        return sum + (expense.type === 'monthly' ? amount * 12 : amount);
      }, 0);
      changeElement.textContent = yearOverYearText(totalAnnual - previousTotal, previousTotal, mainCurrency);
    }

    const tbody = document.getElementById('expense-list-body');
    const emptyMessage = document.getElementById('expense-empty');
    const chartWrap = document.getElementById('expense-chart-wrap');
    const chartEmpty = document.getElementById('expense-chart-empty');
    tbody.innerHTML = '';
    if (App._charts.expenseWeight) { try { App._charts.expenseWeight.destroy(); } catch (error) { /* already destroyed */ } delete App._charts.expenseWeight; }

    const hasExpenses = yearExpenses.length > 0;
    emptyMessage.style.display = hasExpenses ? 'none' : 'block';
    if (chartWrap) chartWrap.style.display = hasExpenses ? '' : 'none';
    if (chartEmpty) chartEmpty.style.display = hasExpenses ? 'none' : 'block';
    if (!hasExpenses) return;

    // Horizontal bars of each expense's annual cost, biggest first
    const chartItems = yearExpenses
      .map(expense => ({ label: expense.text, annual: annualCost(expense) * rateOf(expense) }))
      .sort((first, second) => second.annual - first.annual);
    const chartCanvas = document.getElementById('chart-expense-weight');
    if (chartCanvas) {
      if (chartWrap) chartWrap.style.height = Math.max(220, chartItems.length * 34) + 'px';
      const palette = chartPalette();
      App._charts.expenseWeight = new Chart(chartCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: chartItems.map(item => item.label),
          datasets: [{
            label: 'ANNUAL COST',
            data: chartItems.map(item => item.annual),
            backgroundColor: chartItems.map((item, index) => palette[index % palette.length]),
            borderColor: '#161616',
            borderWidth: 1,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: item => formatCurrency(item.parsed.x, mainCurrency) } },
          },
          scales: {
            x: { ticks: { color: '#888', font: { size: 13, family: CHART_FONT }, callback: value => formatCurrency(value, mainCurrency) }, grid: { color: '#222' } },
            y: { ticks: { color: '#888', font: { size: 13, family: CHART_FONT } }, grid: { display: false } },
          },
        },
      });
    }

    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    yearExpenses
      .sort((first, second) => (second.amount || 0) - (first.amount || 0))
      .forEach(expense => {
        const expenseId = Number(expense.id);
        const paymentLabel = expense.type === 'yearly' && expense.paymentMonth ? monthNames[Number(expense.paymentMonth) - 1] : '-';
        const row = document.createElement('tr');
        row.innerHTML = `<td>${escapeHtml(expense.text)}</td>
          <td><span class="tx-badge ${expense.type === 'monthly' ? 'deposit' : 'valuation'}">${escapeHtml(String(expense.type || '').toUpperCase())}</span></td>
          <td>${escapeHtml(paymentLabel || '-')}</td>
          <td>${formatCurrency(expense.amount, expense.currency)}</td>
          <td>${formatCurrency(annualCost(expense), expense.currency)}</td>
          <td>${escapeHtml(expense.notes || '')}</td>
          <td>
            <a class="tx-link me-2" onclick="App.showModal('expense', ${expenseId})">EDIT</a>
            <a class="tx-link" onclick="App.deleteExpense(${expenseId})">DELETE</a>
          </td>`;
        tbody.appendChild(row);
      });
  },

  // ==================== DEBTS ====================

  async debts() {
    const allDebts = await DB.getAll('debts');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const totalOf = (debts) => debts.reduce((sum, debt) => sum + (debt.amount || 0), 0);
    document.getElementById('debt-owe').textContent = formatCurrency(totalOf(allDebts.filter(debt => debt.direction !== 'in')), mainCurrency);
    document.getElementById('debt-in').textContent = formatCurrency(totalOf(allDebts.filter(debt => debt.direction === 'in')), mainCurrency);

    const tbody = document.getElementById('debt-list-body');
    const emptyMessage = document.getElementById('debt-empty');
    tbody.innerHTML = '';
    emptyMessage.style.display = allDebts.length === 0 ? 'block' : 'none';

    allDebts.forEach(debt => {
      const isOwedToMe = debt.direction === 'in';
      const debtId = Number(debt.id);
      const row = document.createElement('tr');
      row.innerHTML = `<td>${escapeHtml(debt.description)}</td>
        <td>${escapeHtml(debt.person || '-')}</td>
        <td><span class="tx-badge ${isOwedToMe ? 'deposit' : 'withdrawal'}">${isOwedToMe ? 'OWED TO ME' : 'I OWE'}</span></td>
        <td>${formatCurrency(debt.amount, mainCurrency)}</td>
        <td>${debt.date ? formatDate(debt.date) : '-'}</td>
        <td>${escapeHtml(debt.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('debt', ${debtId})">EDIT</a>
          <a class="tx-link" onclick="App.deleteDebt(${debtId})">DELETE</a>
        </td>`;
      tbody.appendChild(row);
    });
  },
});

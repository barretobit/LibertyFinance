Object.assign(Pages, {
  // ==================== CUSTODIANS ====================

  async custodians() {
    const custodians = await DB.getAll('custodians');
    const list = document.getElementById('custodian-list');
    const empty = document.getElementById('custodian-empty');
    list.innerHTML = '';

    if (custodians.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    custodians.forEach(c => {
      const col = document.createElement('div');
      col.className = 'col-md-4 col-sm-6 mb-3';
      col.innerHTML = `<div class="cus-card">
        <div class="cus-name">${escapeHtml(c.name)}</div>
        <div class="cus-notes">${escapeHtml(c.notes || '')}</div>
        <div class="cus-actions">
          <button class="btn btn-gta btn-sm me-2" onclick="App.showModal('custodian', ${c.id})">EDIT</button>
        </div>
      </div>`;
      list.appendChild(col);
    });
  },

  // ==================== INCOMES ====================

  async incomes() {
    const allIncomes = await DB.getAll('incomes');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const yearEl = document.getElementById('income-year-select');
    if (!yearEl) return;

    // populate year dropdown (preserve selection)
    const prevYear = yearEl.value;
    const years = [...new Set(allIncomes.map(inc => (inc.month || '').substring(0, 4)).filter(Boolean))].sort().reverse();
    const currentYear = new Date().getFullYear().toString();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    yearEl.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearEl.value = prevYear && years.includes(prevYear) ? prevYear : currentYear;
    const selectedYear = yearEl.value;

    const filtered = allIncomes.filter(inc => (inc.month || '').startsWith(selectedYear));
    const total = filtered.reduce((sum, inc) => sum + (inc.amount || 0) * rateFor(inc.currency || 'CHF', inc.date || ((inc.month || '') + '-01')), 0);
    const monthsWithIncome = new Set(filtered.map(inc => inc.month).filter(Boolean)).size;

    document.getElementById('income-total').textContent = formatCurrency(total, mainCurrency);
    document.getElementById('income-avg-monthly').textContent =
      formatCurrency(monthsWithIncome > 0 ? total / monthsWithIncome : 0, mainCurrency);

    const tbody = document.getElementById('income-list-body');
    const empty = document.getElementById('income-empty');
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    const sorted = filtered.sort((a, b) => new Date(b.date || b.id) - new Date(a.date || a.id));
    sorted.forEach(inc => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(inc.source)}</td>
        <td>${formatCurrency(inc.amount, inc.currency)}</td>
        <td>${formatDate(inc.date)}</td>
        <td>${escapeHtml(inc.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('income', ${inc.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteIncome(${inc.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  // ==================== EXPENSES ====================

  async expenses() {
    const allExpenses = await DB.getAll('expenses');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const rateEntries = await DB.getAll('exchangeRates');
    const rateFor = (currency, date) => _rateFromEntries(rateEntries, currency, mainCurrency, date);
    const yearEl = document.getElementById('expense-year-select');
    if (!yearEl) return;

    const prevYear = yearEl.value;
    const years = [...new Set(allExpenses.map(exp => exp.year).filter(Boolean))].sort().reverse();
    const currentYear = new Date().getFullYear().toString();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    yearEl.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    yearEl.value = prevYear && years.includes(prevYear) ? prevYear : currentYear;
    const selectedYear = yearEl.value;

    const filtered = allExpenses.filter(exp => exp.year === selectedYear);
    let totalAnnual = 0;
    let totalMonthly = 0;
    filtered.forEach(exp => {
      const v = (exp.amount || 0) * rateFor(exp.currency || 'CHF', exp.date || ((exp.year || '') + '-01-01'));
      if (exp.type === 'monthly') {
        totalAnnual += v * 12;
        totalMonthly += v;
      } else {
        totalAnnual += v;
      }
    });

    document.getElementById('expense-total').textContent = formatCurrency(totalAnnual, mainCurrency);
    document.getElementById('expense-total-monthly').textContent = formatCurrency(totalMonthly, mainCurrency);

    const tbody = document.getElementById('expense-list-body');
    const empty = document.getElementById('expense-empty');
    tbody.innerHTML = '';

    const chartWrap = document.getElementById('expense-chart-wrap');
    const chartEmpty = document.getElementById('expense-chart-empty');
    const chartKey = 'expenseWeight';
    if (App._charts[chartKey]) { try { App._charts[chartKey].destroy(); } catch (e) {} delete App._charts[chartKey]; }

    if (filtered.length === 0) {
      empty.style.display = 'block';
      if (chartWrap) chartWrap.style.display = 'none';
      if (chartEmpty) chartEmpty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    if (chartWrap) chartWrap.style.display = '';
    if (chartEmpty) chartEmpty.style.display = 'none';

    const chartItems = filtered
      .map(exp => {
        const base = (exp.amount || 0) * (exp.type === 'monthly' ? 12 : 1);
        return {
          label: exp.text,
          annual: base * rateFor(exp.currency || 'CHF', exp.date || ((exp.year || '') + '-01-01'))
        };
      })
      .sort((a, b) => b.annual - a.annual);

    const chartCanvas = document.getElementById('chart-expense-weight');
    if (chartCanvas && chartItems.length > 0) {
      if (chartWrap) chartWrap.style.height = Math.max(220, chartItems.length * 34) + 'px';
      const palette = ['#33ff33', '#33ccff', '#ffaa00', '#ff6633', '#cc33ff', '#33ffcc', '#ff3388'];
      App._charts[chartKey] = new Chart(chartCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: chartItems.map(i => i.label),
          datasets: [{
            label: 'ANNUAL COST',
            data: chartItems.map(i => i.annual),
            backgroundColor: chartItems.map((_, idx) => palette[idx % palette.length]),
            borderColor: '#161616',
            borderWidth: 1
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: ctx => formatCurrency(ctx.parsed.x, mainCurrency) } }
          },
          scales: {
            x: {
              ticks: { color: '#888', font: { size: 13, family: "'Share Tech Mono', monospace" }, callback: v => formatCurrency(v, mainCurrency) },
              grid: { color: '#222' }
            },
            y: {
              ticks: { color: '#888', font: { size: 13, family: "'Share Tech Mono', monospace" } },
              grid: { display: false }
            }
          }
        }
      });
    }

    filtered.sort((a, b) => (b.amount || 0) - (a.amount || 0)).forEach(exp => {
      const annualCost = exp.type === 'monthly' ? (exp.amount || 0) * 12 : (exp.amount || 0);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(exp.text)}</td>
        <td><span class="tx-badge ${exp.type === 'monthly' ? 'deposit' : 'valuation'}">${exp.type.toUpperCase()}</span></td>
        <td>${formatCurrency(exp.amount, exp.currency)}</td>
        <td>${formatCurrency(annualCost, exp.currency)}</td>
        <td>${escapeHtml(exp.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('expense', ${exp.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteExpense(${exp.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },

  async debts() {
    const allDebts = await DB.getAll('debts');
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const debtsIn = allDebts.filter(d => d.direction === 'in');
    const debtsOut = allDebts.filter(d => d.direction !== 'in');

    const totalIn = debtsIn.reduce((sum, d) => sum + (d.amount || 0), 0);
    const totalOut = debtsOut.reduce((sum, d) => sum + (d.amount || 0), 0);

    document.getElementById('debt-owe').textContent = formatCurrency(totalOut, mainCurrency);
    document.getElementById('debt-in').textContent = formatCurrency(totalIn, mainCurrency);

    const tbody = document.getElementById('debt-list-body');
    const empty = document.getElementById('debt-empty');
    tbody.innerHTML = '';

    if (allDebts.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    allDebts.forEach(debt => {
      const isIn = debt.direction === 'in';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(debt.description)}</td>
        <td>${escapeHtml(debt.person || '-')}</td>
        <td><span class="tx-badge ${isIn ? 'deposit' : 'withdrawal'}">${isIn ? 'OWED TO ME' : 'I OWE'}</span></td>
        <td>${formatCurrency(debt.amount, mainCurrency)}</td>
        <td>${debt.date ? formatDate(debt.date) : '-'}</td>
        <td>${escapeHtml(debt.notes || '')}</td>
        <td>
          <a class="tx-link me-2" onclick="App.showModal('debt', ${debt.id})">EDIT</a>
          <a class="tx-link" onclick="App.deleteDebt(${debt.id})">DELETE</a>
        </td>`;
      tbody.appendChild(tr);
    });
  },
});
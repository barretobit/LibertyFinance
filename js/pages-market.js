Object.assign(Pages, {
  // ==================== EXCHANGE RATES ====================

  async exchangeRates() {
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';

    const accounts = await DB.getAll('accounts');
    const incomes = await DB.getAll('incomes');
    const expenses = await DB.getAll('expenses');

    const usage = {};
    function addUsage(cur, kind) {
      if (!cur) return;
      if (!usage[cur]) usage[cur] = { accounts: 0, incomes: 0, expenses: 0 };
      usage[cur][kind]++;
    }
    accounts.forEach(a => addUsage(a.currency, 'accounts'));
    incomes.forEach(inc => addUsage(inc.currency, 'incomes'));
    expenses.forEach(exp => addUsage(exp.currency, 'expenses'));

    const currencies = Object.keys(usage).filter(c => c !== mainCurrency).sort();

    document.getElementById('rates-main-label').textContent = 'MAIN CURRENCY: ' + mainCurrency;

    const dateEl = document.getElementById('rates-date');
    const dateLabel = document.getElementById('rates-date-label');
    const tbody = document.getElementById('rates-body');
    const empty = document.getElementById('rates-empty');
    const table = document.getElementById('rates-table');

    const loadRates = async (date) => {
      const saved = await DB.getRatesForDate(date);
      const rates = (saved && saved.rates) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      currencies.forEach(code => {
        const info = usage[code];
        const parts = [];
        if (info.accounts) parts.push(info.accounts + ' ACCOUNT' + (info.accounts === 1 ? '' : 'S'));
        if (info.incomes) parts.push(info.incomes + ' INCOME' + (info.incomes === 1 ? '' : 'S'));
        if (info.expenses) parts.push(info.expenses + ' EXPENSE' + (info.expenses === 1 ? '' : 'S'));
        const c = CURRENCIES.find(x => x.code === code) || { code, name: code };
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><span class="rate-code">${escapeHtml(code)}</span></td>
          <td>${escapeHtml(c.name)}</td>
          <td>${parts.join(' &middot; ')}</td>
          <td>
            <div class="input-group" style="max-width: 280px">
              <span class="input-group-text input-gta-addon">1 ${escapeHtml(code)}</span>
              <input type="number" step="0.0001" min="0" class="form-control form-gta rate-input" data-code="${escapeHtml(code)}" placeholder="${escapeHtml(mainCurrency)}" value="${rates[code] != null ? rates[code] : ''}" />
              <span class="input-group-text input-gta-addon">${escapeHtml(mainCurrency)}</span>
            </div>
          </td>`;
        tbody.appendChild(tr);
      });

      if (currencies.length === 0) {
        table.style.display = 'none';
        empty.style.display = 'block';
      } else {
        table.style.display = '';
        empty.style.display = 'none';
      }
    };

    const allBody = document.getElementById('rates-all-body');
    const allEmpty = document.getElementById('rates-all-empty');
    const allTable = document.getElementById('rates-all-table');

    const loadAllRates = async () => {
      const entries = await DB.getAll('exchangeRates');
      const sorted = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      allBody.innerHTML = '';

      sorted.forEach(entry => {
        const codes = Object.keys(entry.rates || {}).sort();
        const chips = codes.map(code => {
          const rate = entry.rates[code];
          return `<span class="badge badge-rate">${escapeHtml(code)} ${escapeHtml(formatNumber(rate))}</span>`;
        }).join(' ');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(entry.date)}</td>
          <td>${chips || '<span class="text-muted">EMPTY</span>'}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-gta" onclick="Pages.loadRatesFromHistory('${escapeHtml(entry.date)}')">OPEN</button>
          </td>`;
        allBody.appendChild(tr);
      });

      if (sorted.length === 0) {
        allTable.style.display = 'none';
        allEmpty.style.display = 'block';
      } else {
        allTable.style.display = '';
        allEmpty.style.display = 'none';
      }
    };

    if (this._ratesDateHandler) dateEl.removeEventListener('change', this._ratesDateHandler);
    this._ratesDateHandler = () => loadRates(dateEl.value);
    dateEl.addEventListener('change', this._ratesDateHandler);

    dateEl.value = todayStr();
    loadRates(dateEl.value);
    loadAllRates();
  },

  async fetchMetalPrices(silent) {
    const btn = document.getElementById('metals-fetch-btn');
    const status = document.getElementById('metals-fetch-status');

    const symbols = ['XAU', 'XAG', 'XPT', 'XPD'];
    const today = todayStr();
    const saved = await DB.getMetalPricesForDate(today);
    const existing = (saved && saved.prices) || {};
    const missing = symbols.filter(sym => !(existing[sym] && existing[sym].chfPerGram != null));

    if (missing.length === 0) {
      if (status) status.textContent = 'UP TO DATE — PRICES EXIST FOR TODAY';
      return { skipped: true, prices: existing };
    }

    if (!silent && btn) btn.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const prices = Object.assign({}, existing);
      for (const sym of missing) {
        try {
          const res = await fetch('https://api.gold-api.com/price/' + sym + '/CHF');
          if (!res.ok) { prices[sym] = { error: 'HTTP ' + res.status }; continue; }
          const d = await res.json();
          prices[sym] = {
            name: d.name || sym,
            chfPerOz: d.price != null ? d.price : null,
            chfPerGram: d.price != null ? Math.round((d.price / 31.1034768) * 100) / 100 : null
          };
        } catch (e) {
          prices[sym] = { error: e.message };
        }
      }

      await DB.saveMetalPricesForDate(today, prices);

      if (status) {
        const ok = symbols.filter(s => prices[s] && prices[s].chfPerGram != null).length;
        status.textContent = ok + '/4 METALS FETCHED';
      }
      if (!silent) {
        App.toast('METAL PRICES SYNCED');
        await this.metalPrices();
      }
      return prices;
    } finally {
      if (!silent && btn) btn.disabled = false;
    }
  },

  // ==================== PRECIOUS METALS PRICES ====================

  async metalPrices() {
    const dateEl = document.getElementById('metals-date');
    const dateLabel = document.getElementById('metals-date-label');
    const tbody = document.getElementById('metals-body');
    const empty = document.getElementById('metals-empty');
    const table = document.getElementById('metals-table');

    const METALS = [
      { symbol: 'XAU', name: 'Gold' },
      { symbol: 'XAG', name: 'Silver' },
      { symbol: 'XPT', name: 'Platinum' },
      { symbol: 'XPD', name: 'Palladium' }
    ];

    const loadMetals = async (date) => {
      const saved = await DB.getMetalPricesForDate(date);
      const prices = (saved && saved.prices) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      METALS.forEach(m => {
        const p = prices[m.symbol];
        const tr = document.createElement('tr');
        if (p && p.chfPerGram != null) {
          tr.innerHTML = `<td><span class="rate-code">${m.name}</span> <span class="text-muted">(${m.symbol})</span></td>
            <td>${formatCurrency(p.chfPerOz, 'CHF')}</td>
            <td>${formatCurrency(p.chfPerGram, 'CHF')}/g</td>`;
        } else {
          tr.innerHTML = `<td><span class="rate-code">${m.name}</span> <span class="text-muted">(${m.symbol})</span></td>
            <td class="text-muted" colspan="2">NO PRICE</td>`;
        }
        tbody.appendChild(tr);
      });

      const hasAny = METALS.some(m => prices[m.symbol] && prices[m.symbol].chfPerGram != null);
      table.style.display = hasAny ? '' : 'none';
      empty.style.display = hasAny ? 'none' : 'block';
    };

    const allBody = document.getElementById('metals-all-body');
    const allEmpty = document.getElementById('metals-all-empty');
    const allTable = document.getElementById('metals-all-table');

    const loadAllMetals = async () => {
      const entries = await DB.getAll('metalPrices');
      const sorted = entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      allBody.innerHTML = '';

      sorted.forEach(entry => {
        const chips = METALS.map(m => {
          const p = (entry.prices || {})[m.symbol];
          if (!p || p.chfPerGram == null) return null;
          return `<span class="badge badge-rate">${escapeHtml(m.name)} ${escapeHtml(formatNumber(p.chfPerGram))} CHF/g</span>`;
        }).filter(Boolean).join(' ');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${formatDate(entry.date)}</td>
          <td>${chips || '<span class="text-muted">EMPTY</span>'}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-gta" onclick="Pages.loadMetalsFromHistory('${escapeHtml(entry.date)}')">OPEN</button>
          </td>`;
        allBody.appendChild(tr);
      });

      if (sorted.length === 0) {
        allTable.style.display = 'none';
        allEmpty.style.display = 'block';
      } else {
        allTable.style.display = '';
        allEmpty.style.display = 'none';
      }
    };

    if (this._metalsDateHandler) dateEl.removeEventListener('change', this._metalsDateHandler);
    this._metalsDateHandler = () => loadMetals(dateEl.value);
    dateEl.addEventListener('change', this._metalsDateHandler);

    dateEl.value = todayStr();
    loadMetals(dateEl.value);
    loadAllMetals();
  },

  async loadMetalsFromHistory(date) {
    const dateEl = document.getElementById('metals-date');
    dateEl.value = date;
    if (this._metalsDateHandler) this._metalsDateHandler();
    document.getElementById('metals-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async loadRatesFromHistory(date) {
    const dateEl = document.getElementById('rates-date');
    dateEl.value = date;
    if (this._ratesDateHandler) this._ratesDateHandler();
    document.getElementById('rates-date').scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async saveRates() {
    const dateEl = document.getElementById('rates-date');
    const date = dateEl.value || todayStr();
    const rates = {};
    document.querySelectorAll('#rates-body .rate-input').forEach(inp => {
      const code = inp.dataset.code;
      const val = parseFloat(inp.value);
      if (val > 0) rates[code] = val;
    });
    await DB.saveRatesForDate(date, rates);
    App.toast('RATES SAVED');
  },

  async fetchRatesFromFrankfurter() {
    const btn = document.getElementById('rates-fetch-btn');
    const status = document.getElementById('rates-fetch-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';

      const accounts = await DB.getAll('accounts');
      const incomes = await DB.getAll('incomes');
      const expenses = await DB.getAll('expenses');
      const transactions = await DB.getAll('transactions');
      const assets = await DB.getAll('assets');

      const accCur = {};
      accounts.forEach(a => accCur[a.id] = a.currency || 'CHF');

      // Collect distinct (date -> set of foreign currencies) from records
      const dateCurrencies = {};
      const allForeign = new Set();
      const track = (currency) => {
        if (currency && currency !== mainCurrency) allForeign.add(currency);
      };
      const addDateCurrency = (date, currency) => {
        if (!currency || currency === mainCurrency || !date) return;
        if (!dateCurrencies[date]) dateCurrencies[date] = new Set();
        dateCurrencies[date].add(currency);
      };

      incomes.forEach(inc => { track(inc.currency); addDateCurrency(inc.date, inc.currency); });
      expenses.forEach(exp => { track(exp.currency); addDateCurrency(exp.date, exp.currency); });
      transactions.forEach(tx => {
        const cur = accCur[tx.accountId];
        track(cur);
        addDateCurrency(tx.date, cur);
      });
      accounts.forEach(a => track(a.currency));
      assets.forEach(a => {
        const cur = a.currency;
        track(cur);
        addDateCurrency(a.purchaseDate, cur);
        addDateCurrency(a.saleDate, cur);
      });

      // Ensure a "latest" snapshot so current account balances convert
      const today = todayStr();
      if (allForeign.size > 0) {
        if (!dateCurrencies[today]) dateCurrencies[today] = new Set();
        allForeign.forEach(c => dateCurrencies[today].add(c));
      }

      const dates = Object.keys(dateCurrencies).sort();
      if (dates.length === 0) {
        if (status) status.textContent = 'NO FOREIGN CURRENCIES IN USE';
        return;
      }

      const api = 'https://api.frankfurter.dev/v1';
      let filled = 0;
      let skipped = 0;
      let failed = 0;

      for (const date of dates) {
        const codes = [...dateCurrencies[date]];
        const url = api + '/' + date + '?from=' + encodeURIComponent(mainCurrency) + '&to=' + encodeURIComponent(codes.join(','));
        let data;
        try {
          const res = await fetch(url);
          if (!res.ok) { failed++; continue; }
          data = await res.json();
        } catch (e) {
          failed++;
          continue;
        }
        const fx = (data && data.rates) || {};

        const existing = await DB.getRatesForDate(date);
        const merged = Object.assign({}, existing ? existing.rates : {});
        let changed = false;
        codes.forEach(code => {
          const raw = fx[code];
          if (raw == null) return;
          if (merged[code] != null) { skipped++; return; }
          merged[code] = Math.round((1 / raw) * 10000) / 10000;
          filled++;
          changed = true;
        });
        if (changed) await DB.saveRatesForDate(date, merged);
      }

      if (status) status.textContent = 'DONE — ' + filled + ' FILLED, ' + skipped + ' SKIPPED, ' + failed + ' FAILED';
      App.toast('RATES SYNCED FROM FRANKFURTER');
      await this.exchangeRates();
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // Lightweight startup sync: fetch today's FX snapshot for currencies used by accounts only
  async fetchRatesLatest(silent) {
    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';
      const accounts = await DB.getAll('accounts');
      const foreign = [...new Set(accounts.map(a => a.currency || mainCurrency).filter(c => c && c !== mainCurrency))].sort();
      if (foreign.length === 0) return { filled: 0 };

      const today = todayStr();
      const existing = await DB.getRatesForDate(today);
      const current = (existing && existing.rates) || {};
      const missing = foreign.filter(code => current[code] == null);
      if (missing.length === 0) return { filled: 0 };

      const url = 'https://api.frankfurter.dev/v1/latest?from=' + encodeURIComponent(mainCurrency) + '&to=' + encodeURIComponent(missing.join(','));
      let data;
      try {
        const res = await fetch(url);
        if (!res.ok) return { filled: 0 };
        data = await res.json();
      } catch (e) {
        return { filled: 0 };
      }
      const fx = (data && data.rates) || {};

      const merged = Object.assign({}, current);
      let changed = false;
      let filled = 0;
      missing.forEach(code => {
        const raw = fx[code];
        if (raw == null) return;
        if (merged[code] != null) return;
        merged[code] = Math.round((1 / raw) * 10000) / 10000;
        filled++;
        changed = true;
      });
      if (changed) await DB.saveRatesForDate(today, merged);
      if (!silent) {
        App.toast('RATES SYNCED — ' + filled + ' FILLED');
        await this.exchangeRates();
      }
      return { filled };
    } catch (e) {
      return { filled: 0 };
    }
  }
});
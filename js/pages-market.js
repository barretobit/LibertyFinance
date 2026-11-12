// The precious metals the app prices: { symbol: 'XAU', name: 'Gold' }, ...
const METALS = Object.entries(METAL_SYMBOLS).map(([name, symbol]) => ({ symbol, name }));
const GRAMS_PER_TROY_OUNCE = 31.1034768;

Object.assign(Pages, {
  // ==================== EXCHANGE RATES ====================

  async exchangeRates() {
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';

    const accounts = await DB.getAll('accounts');
    const incomes = await DB.getAll('incomes');
    const expenses = await DB.getAll('expenses');
    const assets = await DB.getAll('assets');

    const usage = {};
    function addUsage(currency, kind) {
      if (!currency) return;
      if (!usage[currency]) usage[currency] = { accounts: 0, incomes: 0, expenses: 0, assets: 0 };
      usage[currency][kind]++;
    }
    accounts.forEach(account => addUsage(account.currency, 'accounts'));
    incomes.forEach(income => addUsage(income.currency, 'incomes'));
    expenses.forEach(expense => addUsage(expense.currency, 'expenses'));
    assets.forEach(asset => addUsage(asset.currency, 'assets'));
    if (!usage[mainCurrency]) usage[mainCurrency] = { accounts: 0, incomes: 0, expenses: 0, assets: 0 };

    // Every rate is "1 unit = x CHF", so CHF is the only currency that never needs one
    const currencies = Object.keys(usage).filter(currency => currency !== RATE_BASE_CURRENCY).sort();

    document.getElementById('rates-main-label').textContent = 'MAIN CURRENCY: ' + mainCurrency;

    const dateInput = document.getElementById('rates-date');
    const dateLabel = document.getElementById('rates-date-label');
    const tbody = document.getElementById('rates-body');
    const empty = document.getElementById('rates-empty');
    const table = document.getElementById('rates-table');

    const usageLabel = (count, word) => count ? count + ' ' + word + (count === 1 ? '' : 'S') : null;

    const loadRates = async (date) => {
      const saved = await DB.getRatesForDate(date);
      const rates = (saved && saved.rates) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      currencies.forEach(code => {
        const usageCounts = usage[code];
        const usageParts = [
          code === mainCurrency ? 'MAIN CURRENCY' : null,
          usageLabel(usageCounts.accounts, 'ACCOUNT'),
          usageLabel(usageCounts.incomes, 'INCOME'),
          usageLabel(usageCounts.expenses, 'EXPENSE'),
          usageLabel(usageCounts.assets, 'ASSET'),
        ].filter(Boolean);
        const currencyInfo = CURRENCIES.find(known => known.code === code) || { code, name: code };
        const row = document.createElement('tr');
        row.innerHTML = `<td><span class="rate-code">${escapeHtml(code)}</span></td>
          <td>${escapeHtml(currencyInfo.name)}</td>
          <td>${usageParts.join(' &middot; ')}</td>
          <td>
            <div class="input-group" style="max-width: 280px">
              <span class="input-group-text input-gta-addon">1 ${escapeHtml(code)}</span>
              <input type="number" step="any" min="0" class="form-control form-gta rate-input" data-code="${escapeHtml(code)}" placeholder="${RATE_BASE_CURRENCY}" value="${rates[code] != null ? escapeHtml(rates[code]) : ''}" />
              <span class="input-group-text input-gta-addon">${RATE_BASE_CURRENCY}</span>
            </div>
          </td>`;
        tbody.appendChild(row);
      });

      if (currencies.length === 0) {
        table.style.display = 'none';
        empty.style.display = 'block';
      } else {
        table.style.display = '';
        empty.style.display = 'none';
      }
    };

    if (this._ratesDateHandler) dateInput.removeEventListener('change', this._ratesDateHandler);
    this._ratesDateHandler = () => loadRates(dateInput.value);
    dateInput.addEventListener('change', this._ratesDateHandler);

    dateInput.value = todayStr();
    loadRates(dateInput.value);
    this._renderPriceHistory('rates', await DB.getAll('exchangeRates'), entry =>
      Object.keys(entry.rates || {}).sort().map(code => escapeHtml(code) + ' ' + escapeHtml(formatNumber(entry.rates[code]))), 'loadRatesFromHistory');
  },

  // "All saved rates/prices" table: one row per date, newest first, with chips and an OPEN button
  _renderPriceHistory(prefix, entries, chipTexts, openHandlerName) {
    const tbody = document.getElementById(prefix + '-all-body');
    const table = document.getElementById(prefix + '-all-table');
    const emptyMessage = document.getElementById(prefix + '-all-empty');
    tbody.innerHTML = '';
    table.style.display = entries.length ? '' : 'none';
    emptyMessage.style.display = entries.length ? 'none' : 'block';

    [...entries]
      .sort((first, second) => (second.date || '').localeCompare(first.date || ''))
      .forEach(entry => {
        const chips = chipTexts(entry).map(text => '<span class="badge badge-rate">' + text + '</span>').join(' ');
        // The date goes into an onclick handler, so only a real YYYY-MM-DD date gets a button
        const openButton = isIsoDate(entry.date) ? `<button class="btn btn-sm btn-gta" onclick="Pages.${openHandlerName}('${entry.date}')">OPEN</button>` : '';
        const row = document.createElement('tr');
        row.innerHTML = `<td>${formatDate(entry.date)}</td>
          <td>${chips || '<span class="text-muted">EMPTY</span>'}</td>
          <td class="text-end">${openButton}</td>`;
        tbody.appendChild(row);
      });
  },

  // Today's CHF spot prices from gold-api.com, for the metals still missing today.
  // `silent`: the startup sync, which neither disables the button nor refreshes the page.
  async fetchMetalPrices(silent) {
    const button = document.getElementById('metals-fetch-btn');
    const status = document.getElementById('metals-fetch-status');

    const today = todayStr();
    const saved = await DB.getMetalPricesForDate(today);
    const existing = (saved && saved.prices) || {};
    const missingSymbols = METALS.map(metal => metal.symbol).filter(symbol => !(existing[symbol] && existing[symbol].chfPerGram != null));

    if (missingSymbols.length === 0) {
      if (status) status.textContent = 'UP TO DATE — PRICES EXIST FOR TODAY';
      return { skipped: true, prices: existing };
    }

    if (!silent && button) button.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const prices = Object.assign({}, existing);
      for (const symbol of missingSymbols) {
        try {
          const httpResponse = await fetch('https://api.gold-api.com/price/' + symbol + '/CHF');
          if (!httpResponse.ok) { prices[symbol] = { error: 'HTTP ' + httpResponse.status }; continue; }
          const quote = await httpResponse.json();
          prices[symbol] = {
            name: quote.name || symbol,
            chfPerOz: quote.price != null ? quote.price : null,
            chfPerGram: quote.price != null ? Math.round((quote.price / GRAMS_PER_TROY_OUNCE) * 100) / 100 : null,
          };
        } catch (error) {
          prices[symbol] = { error: error.message };
        }
      }

      await DB.saveMetalPricesForDate(today, prices);

      if (status) {
        const fetchedCount = METALS.filter(metal => prices[metal.symbol] && prices[metal.symbol].chfPerGram != null).length;
        status.textContent = fetchedCount + '/' + METALS.length + ' METALS FETCHED';
      }
      if (!silent) {
        App.toast('METAL PRICES SYNCED');
        await this.metalPrices();
      }
      return prices;
    } finally {
      if (!silent && button) button.disabled = false;
    }
  },

  // ==================== PRECIOUS METALS PRICES ====================

  async metalPrices() {
    const dateInput = document.getElementById('metals-date');
    const dateLabel = document.getElementById('metals-date-label');
    const tbody = document.getElementById('metals-body');
    const emptyMessage = document.getElementById('metals-empty');
    const table = document.getElementById('metals-table');

    const loadMetals = async (date) => {
      const saved = await DB.getMetalPricesForDate(date);
      const prices = (saved && saved.prices) || {};
      dateLabel.textContent = formatDate(date);
      tbody.innerHTML = '';

      METALS.forEach(metal => {
        const price = prices[metal.symbol];
        const row = document.createElement('tr');
        const nameCell = `<td><span class="rate-code">${metal.name}</span> <span class="text-muted">(${metal.symbol})</span></td>`;
        row.innerHTML = price && price.chfPerGram != null
          ? nameCell + `<td>${formatCurrency(price.chfPerOz, 'CHF')}</td><td>${formatCurrency(price.chfPerGram, 'CHF')}/g</td>`
          : nameCell + '<td class="text-muted" colspan="2">NO PRICE</td>';
        tbody.appendChild(row);
      });

      const hasAnyPrice = METALS.some(metal => prices[metal.symbol] && prices[metal.symbol].chfPerGram != null);
      table.style.display = hasAnyPrice ? '' : 'none';
      emptyMessage.style.display = hasAnyPrice ? 'none' : 'block';
    };

    if (this._metalsDateHandler) dateInput.removeEventListener('change', this._metalsDateHandler);
    this._metalsDateHandler = () => loadMetals(dateInput.value);
    dateInput.addEventListener('change', this._metalsDateHandler);

    dateInput.value = todayStr();
    loadMetals(dateInput.value);
    this._renderPriceHistory('metals', await DB.getAll('metalPrices'), entry =>
      METALS
        .filter(metal => (entry.prices || {})[metal.symbol] && entry.prices[metal.symbol].chfPerGram != null)
        .map(metal => escapeHtml(metal.name) + ' ' + escapeHtml(formatNumber(entry.prices[metal.symbol].chfPerGram)) + ' CHF/g'), 'loadMetalsFromHistory');
  },

  async loadMetalsFromHistory(date) {
    const dateInput = document.getElementById('metals-date');
    dateInput.value = date;
    if (this._metalsDateHandler) this._metalsDateHandler();
    dateInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async loadRatesFromHistory(date) {
    const dateInput = document.getElementById('rates-date');
    dateInput.value = date;
    if (this._ratesDateHandler) this._ratesDateHandler();
    dateInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  async saveRates() {
    const date = document.getElementById('rates-date').value || todayStr();
    // Merge into the stored rates: market.json is shared by every profile, so
    // currencies this page does not show must be kept. A cleared field removes its rate.
    const saved = await DB.getRatesForDate(date);
    const rates = Object.assign({}, saved && saved.rates);
    document.querySelectorAll('#rates-body .rate-input').forEach(input => {
      const rate = parseFloat(input.value);
      if (rate > 0) rates[input.dataset.code] = rate;
      else delete rates[input.dataset.code];
    });
    await DB.saveRatesForDate(date, rates);
    App.toast('RATES SAVED');
  },

  // Frankfurter answers "1 CHF = raw units of the currency"; market.json stores
  // the inverse, "1 unit = rate CHF", with six significant digits (JPY needs them).
  _chfRateFromFrankfurter(raw) {
    return Number((1 / raw).toPrecision(6));
  },

  async fetchRatesFromFrankfurter() {
    const button = document.getElementById('rates-fetch-btn');
    const status = document.getElementById('rates-fetch-status');
    if (button) button.disabled = true;
    if (status) status.textContent = 'FETCHING...';

    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';

      const accounts = await DB.getAll('accounts');
      const incomes = await DB.getAll('incomes');
      const expenses = await DB.getAll('expenses');
      const transactions = await DB.getAll('transactions');
      const assets = await DB.getAll('assets');

      const accountCurrency = {};
      accounts.forEach(account => accountCurrency[account.id] = account.currency || 'CHF');

      // Which currencies need a CHF rate on which date. Converting a currency into
      // the main currency needs the CHF rate of both (CHF itself is always 1).
      const currenciesByDate = {};
      const allNeededCurrencies = new Set();
      const needConversion = (date, currency) => {
        if (!currency || currency === mainCurrency) return;
        [currency, mainCurrency].forEach(code => {
          if (code === RATE_BASE_CURRENCY) return;
          allNeededCurrencies.add(code);
          if (!date) return;
          if (!currenciesByDate[date]) currenciesByDate[date] = new Set();
          currenciesByDate[date].add(code);
        });
      };

      incomes.forEach(income => needConversion(income.date, income.currency));
      expenses.forEach(expense => needConversion(expense.date, expense.currency));
      transactions.forEach(transaction => needConversion(transaction.date, accountCurrency[transaction.accountId]));
      accounts.forEach(account => needConversion(null, account.currency));
      assets.forEach(asset => {
        needConversion(asset.purchaseDate, asset.currency);
        needConversion(asset.saleDate, asset.currency);
      });

      // Ensure a "latest" snapshot so current account balances convert
      const today = todayStr();
      if (allNeededCurrencies.size > 0) {
        if (!currenciesByDate[today]) currenciesByDate[today] = new Set();
        allNeededCurrencies.forEach(code => currenciesByDate[today].add(code));
      }

      const dates = Object.keys(currenciesByDate).sort();
      if (dates.length === 0) {
        if (status) status.textContent = 'NO FOREIGN CURRENCIES IN USE';
        return;
      }

      const api = 'https://api.frankfurter.dev/v1';
      let filled = 0;
      let skipped = 0;
      let failed = 0;

      for (const date of dates) {
        const codes = [...currenciesByDate[date]];
        const url = api + '/' + date + '?from=' + RATE_BASE_CURRENCY + '&to=' + encodeURIComponent(codes.join(','));
        let response;
        try {
          const httpResponse = await fetch(url);
          if (!httpResponse.ok) { failed++; continue; }
          response = await httpResponse.json();
        } catch (error) {
          failed++;
          continue;
        }
        const fetchedRates = (response && response.rates) || {};

        const existing = await DB.getRatesForDate(date);
        const merged = Object.assign({}, existing ? existing.rates : {});
        let changed = false;
        codes.forEach(code => {
          const raw = fetchedRates[code];
          if (raw == null) return;
          if (merged[code] != null) { skipped++; return; }
          merged[code] = this._chfRateFromFrankfurter(raw);
          filled++;
          changed = true;
        });
        if (changed) await DB.saveRatesForDate(date, merged);
      }

      if (status) status.textContent = 'DONE — ' + filled + ' FILLED, ' + skipped + ' SKIPPED, ' + failed + ' FAILED';
      App.toast('RATES SYNCED FROM FRANKFURTER');
      await this.exchangeRates();
    } finally {
      if (button) button.disabled = false;
    }
  },

  // Lightweight startup sync: fetch today's CHF rates for the currencies the accounts need
  async fetchRatesLatest(silent) {
    try {
      const settings = await DB.getSettings();
      const mainCurrency = settings.mainCurrency || 'CHF';
      const accounts = await DB.getAll('accounts');
      const neededCurrencies = new Set();
      accounts.forEach(account => {
        const currency = account.currency || mainCurrency;
        if (currency === mainCurrency) return;
        [currency, mainCurrency].forEach(code => { if (code !== RATE_BASE_CURRENCY) neededCurrencies.add(code); });
      });
      if (neededCurrencies.size === 0) return { filled: 0 };

      const today = todayStr();
      const existing = await DB.getRatesForDate(today);
      const current = (existing && existing.rates) || {};
      const missing = [...neededCurrencies].sort().filter(code => current[code] == null);
      if (missing.length === 0) return { filled: 0 };

      const url = 'https://api.frankfurter.dev/v1/latest?from=' + RATE_BASE_CURRENCY + '&to=' + encodeURIComponent(missing.join(','));
      let response;
      try {
        const httpResponse = await fetch(url);
        if (!httpResponse.ok) return { filled: 0 };
        response = await httpResponse.json();
      } catch (error) {
        return { filled: 0 };
      }
      const fetchedRates = (response && response.rates) || {};

      const merged = Object.assign({}, current);
      let changed = false;
      let filled = 0;
      missing.forEach(code => {
        const raw = fetchedRates[code];
        if (raw == null) return;
        if (merged[code] != null) return;
        merged[code] = this._chfRateFromFrankfurter(raw);
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
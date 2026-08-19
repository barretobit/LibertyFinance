/* ===== Application Core: Router & CRUD ===== */

const App = {
  currentPfId: null,
  currentAccId: null,
  _modals: {},
  _charts: {},

  async init() {
    const file = new URLSearchParams(window.location.search).get('file');
    if (!file) {
      const last = localStorage.getItem('liberty-finance-last-file');
      window.location.replace(last ? 'app.html?file=' + encodeURIComponent(last) : 'index.html');
      return;
    }

    const navProfile = document.getElementById('nav-profile');
    if (navProfile) navProfile.textContent = file.replace(/\.json$/i, '');

    try {
      await DB.open();
    } catch (e) {
      // Storage not connected (e.g. folder permission revoked) — back to the picker.
      window.location.replace('index.html');
      return;
    }

    try { await this._recomputeAllBalances(); } catch (e) { /* non-fatal */ }

    this._applyRadius();

    (async () => {
      await Pages.fetchMetalPrices(true).catch(() => {});
      await Pages.fetchRatesLatest(true).catch(() => {});
    })();

    this._modals = {
      custodian: new bootstrap.Modal(document.getElementById('modal-custodian')),
      portfolio: new bootstrap.Modal(document.getElementById('modal-portfolio')),
      account: new bootstrap.Modal(document.getElementById('modal-account')),
      transaction: new bootstrap.Modal(document.getElementById('modal-transaction')),
      valuation: new bootstrap.Modal(document.getElementById('modal-valuation')),
      metal: new bootstrap.Modal(document.getElementById('modal-metal')),
      asset: new bootstrap.Modal(document.getElementById('modal-asset')),
      sellAsset: new bootstrap.Modal(document.getElementById('modal-sell-asset')),
      income: new bootstrap.Modal(document.getElementById('modal-income')),
      expense: new bootstrap.Modal(document.getElementById('modal-expense')),
      debt: new bootstrap.Modal(document.getElementById('modal-debt')),
      goal: new bootstrap.Modal(document.getElementById('modal-goal')),
      settings: new bootstrap.Modal(document.getElementById('modal-settings')),
      importModal: new bootstrap.Modal(document.getElementById('modal-import')),
      confirm: new bootstrap.Modal(document.getElementById('modal-confirm'))
    };

    window.addEventListener('hashchange', () => this.route());
    this.route();
  },

  route() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    const [page, qs] = hash.includes('?') ? hash.split('?') : [hash, ''];
    const params = new URLSearchParams(qs);

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    const target = document.getElementById('page-' + page);
    if (target) {
      target.classList.add('active');

      Object.values(this._charts).forEach(c => { try { c.destroy(); } catch(e) {} });
      this._charts = {};

      switch (page) {
        case 'dashboard':
          Pages.dashboard();
          break;
        case 'portfolios':
          Pages.portfolios();
          break;
        case 'portfolio-detail':
          this.currentPfId = parseInt(params.get('id'));
          Pages.portfolioDetail(this.currentPfId);
          break;
        case 'account-detail':
          this.currentAccId = parseInt(params.get('id'));
          this.currentPfId = parseInt(params.get('pfid'));
          Pages.accountDetail(this.currentAccId);
          break;
        case 'custodians':
          Pages.custodians();
          break;
        case 'incomes':
          Pages.incomes();
          break;
        case 'expenses':
          Pages.expenses();
          break;
        case 'debts':
          Pages.debts();
          break;
        case 'goals':
          Pages.goals();
          break;
        case 'exchange-rates':
          Pages.exchangeRates();
          break;
        case 'metal-prices':
          Pages.metalPrices();
          break;
      }
    }
  },

  navigate(hash) {
    window.location.hash = hash;
  },

  // ==================== MODAL HELPERS ====================

  showModal(type, ...args) {
    switch (type) {
      case 'custodian':
        this._showCustodianModal(args[0]);
        break;
      case 'portfolio':
        this._showPortfolioModal(args[0]);
        break;
      case 'account':
        this._showAccountModal(args[0], args[1]);
        break;
      case 'deposit':
      case 'withdrawal':
        this._showTxModal(type, args[0]);
        break;
      case 'valuation':
        this._showValuationModal(args[0]);
        break;
      case 'opening':
        this._showValuationModal(args[0], true);
        break;
      case 'metal':
        this._showMetalModal(args[0], args[1]);
        break;
      case 'asset':
        this._showAssetModal(args[0], args[1]);
        break;
      case 'sellAsset':
        this._showSellAssetModal(args[0]);
        break;
      case 'income':
        this._showIncomeModal(args[0]);
        break;
      case 'expense':
        this._showExpenseModal(args[0]);
        break;
      case 'debt':
        this._showDebtModal(args[0]);
        break;
      case 'goal':
        this._showGoalModal(args[0]);
        break;
    }
  },

  async showSettingsModal() {
    const settings = await DB.getSettings();
    const current = settings.mainCurrency || 'CHF';
    const select = document.getElementById('settings-currency');
    select.innerHTML = CURRENCIES.map(c =>
      `<option value="${c.code}" ${c.code === current ? 'selected' : ''}>${c.code} - ${c.name}</option>`
    ).join('');
    const slider = document.getElementById('settings-radius');
    const label = document.getElementById('settings-radius-label');
    const radius = settings.borderRadius != null ? settings.borderRadius : 10;
    slider.value = radius;
    label.textContent = radius + 'px';
    const preview = () => {
      const v = slider.value;
      label.textContent = v + 'px';
      document.documentElement.style.setProperty('--radius', v + 'px');
    };
    slider.oninput = preview;
    this._modals.settings.show();
  },

  async _applyRadius() {
    const settings = await DB.getSettings();
    const radius = settings.borderRadius != null ? settings.borderRadius : 10;
    document.documentElement.style.setProperty('--radius', radius + 'px');
  },

  async saveSettings() {
    const currency = document.getElementById('settings-currency').value;
    if (!currency) { this.toast('SELECT A MAIN CURRENCY'); return; }
    const borderRadius = parseInt(document.getElementById('settings-radius').value) || 0;
    const existing = await DB.getSettings();
    await DB.saveSettings({ ...existing, mainCurrency: currency, borderRadius });
    this._modals.settings.hide();
    this.toast('SETTINGS SAVED');
  },

  _showCustodianModal(editId) {
    const title = document.getElementById('modal-custodian-title');
    const idField = document.getElementById('custodian-id');
    const nameField = document.getElementById('custodian-name');
    const notesField = document.getElementById('custodian-notes');
    if (editId) {
      title.textContent = 'EDIT CUSTODIAN';
      DB.getById('custodians', editId).then(c => {
        if (!c) return;
        idField.value = c.id;
        nameField.value = c.name || '';
        notesField.value = c.notes || '';
        this._modals.custodian.show();
      });
    } else {
      title.textContent = 'NEW CUSTODIAN';
      idField.value = '';
      nameField.value = '';
      notesField.value = '';
      this._modals.custodian.show();
    }
  },

  _showPortfolioModal(editId) {
    const title = document.getElementById('modal-portfolio-title');
    const idField = document.getElementById('portfolio-id');
    const nameField = document.getElementById('portfolio-name');
    const descField = document.getElementById('portfolio-desc');
    if (editId) {
      title.textContent = 'EDIT PORTFOLIO';
      DB.getById('portfolios', editId).then(p => {
        if (!p) return;
        idField.value = p.id;
        nameField.value = p.name || '';
        descField.value = p.description || '';
        this._modals.portfolio.show();
      });
    } else {
      title.textContent = 'NEW PORTFOLIO';
      idField.value = '';
      nameField.value = '';
      descField.value = '';
      this._modals.portfolio.show();
    }
  },

  async _showAccountModal(pfId, editId) {
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const title = document.getElementById('modal-account-title');
    const idField = document.getElementById('account-id');
    const pfIdField = document.getElementById('account-pfid');
    const nameField = document.getElementById('account-name');
    const custodianField = document.getElementById('account-custodian');
    const currencyField = document.getElementById('account-currency');
    const notesField = document.getElementById('account-notes');
    const trackPerfField = document.getElementById('account-track-perf');
    const includeNwField = document.getElementById('account-include-nw');
    const includeLiqField = document.getElementById('account-include-liq');
    const typeField = document.getElementById('account-type');
    const metalField = document.getElementById('account-metal');
    const qtyField = document.getElementById('account-qty');
    const pmFields = document.getElementById('pm-fields');
    const startingFields = document.getElementById('starting-value-fields');
    const startingValueField = document.getElementById('account-starting-value');
    const startingContribField = document.getElementById('account-starting-contrib');
    const startingDateField = document.getElementById('account-starting-date');
    const startingSymbol = document.getElementById('account-starting-symbol');
    const contribSymbol = document.getElementById('account-contrib-symbol');

    function toggleAccountTypeFields() {
      const t = typeField.value;
      pmFields.style.display = t === 'Precious Metal' ? 'block' : 'none';
      if (startingFields) startingFields.style.display = (editId || t === 'Tangible Asset') ? 'none' : 'block';
    }
    typeField.onchange = toggleAccountTypeFields;

    function updateStartingSymbol() {
      if (startingSymbol) startingSymbol.textContent = currencyField.value || mainCurrency;
      if (contribSymbol) contribSymbol.textContent = currencyField.value || mainCurrency;
    }
    currencyField.onchange = updateStartingSymbol;

    // populate custodians
    DB.getAll('custodians').then(custodians => {
      custodianField.innerHTML = '<option value="">— SELECT —</option>'
        + custodians.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    });

    // populate currencies
    currencyField.innerHTML = CURRENCIES.map(c =>
      `<option value="${c.code}">${c.code} - ${c.symbol}</option>`
    ).join('');

    if (editId) {
      title.textContent = 'EDIT ACCOUNT';
      DB.getById('accounts', editId).then(a => {
        if (!a) return;
        idField.value = a.id;
        pfIdField.value = a.portfolioId;
        nameField.value = a.name || '';
        custodianField.value = a.custodianId || '';
        currencyField.value = a.currency || 'CHF';
        notesField.value = a.notes || '';
        trackPerfField.checked = a.trackPerformance !== false;
        includeNwField.checked = a.includeInNetWorth !== false;
        includeLiqField.checked = a.includeInLiquidNetWorth !== false;
        typeField.value = a.accountType || 'Cash Account';
        metalField.value = a.metalType || 'Gold';
        qtyField.value = a.quantity || 0;
        toggleAccountTypeFields();
        startingValueField.value = '';
        startingContribField.value = '';
        this._modals.account.show();
      });
    } else {
      title.textContent = 'NEW ACCOUNT';
      idField.value = '';
      pfIdField.value = pfId || '';
      nameField.value = '';
      custodianField.value = '';
      currencyField.value = mainCurrency;
      notesField.value = '';
      trackPerfField.checked = true;
      includeNwField.checked = true;
      includeLiqField.checked = true;
      typeField.value = 'Cash Account';
      metalField.value = 'Gold';
      qtyField.value = 0;
      toggleAccountTypeFields();
      startingValueField.value = '';
      startingContribField.value = '';
      startingDateField.value = todayStr();
      updateStartingSymbol();
      this._modals.account.show();
    }
  },

  _showTxModal(type, accountId) {
    const title = document.getElementById('modal-tx-title');
    const typeField = document.getElementById('tx-type');
    const accIdField = document.getElementById('tx-account-id');
    const amountField = document.getElementById('tx-amount');
    const notesField = document.getElementById('tx-notes');
    const dateField = document.getElementById('tx-date');
    const label = document.getElementById('tx-amount-label');
    const symbol = document.getElementById('tx-currency-symbol');

    typeField.value = type;
    accIdField.value = accountId;
    amountField.value = '';
    notesField.value = '';
    dateField.value = todayStr();

    title.textContent = type === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL';

    // get account currency
    DB.getById('accounts', accountId).then(a => {
      symbol.textContent = a ? a.currency || 'CHF' : 'CHF';
    });

    this._modals.transaction.show();
  },

  _showValuationModal(accountId, isOpening) {
    const accIdField = document.getElementById('val-account-id');
    const amountField = document.getElementById('val-amount');
    const priceGramField = document.getElementById('val-price-gram');
    const priceGramGroup = document.getElementById('val-price-gram-group');
    const pgSymbol = document.getElementById('val-pg-currency');
    const notesField = document.getElementById('val-notes');
    const dateField = document.getElementById('val-date');
    const symbol = document.getElementById('val-currency-symbol');
    const titleEl = document.getElementById('modal-val-title');

    accIdField.value = accountId;
    amountField.value = '';
    priceGramField.value = '';
    notesField.value = '';
    dateField.value = todayStr();
    if (titleEl) titleEl.textContent = isOpening ? 'OPENING VALUE' : 'UPDATE VALUE';
    this._valOpening = !!isOpening;

    DB.getById('accounts', accountId).then(async a => {
      const cur = a ? a.currency || 'CHF' : 'CHF';
      symbol.textContent = cur;
      pgSymbol.textContent = cur;
      if (isOpening) {
        // Opening valuations are recorded for standard accounts; leave the
        // amount empty and pre-fill the marker note.
        priceGramGroup.style.display = 'none';
        notesField.value = 'OPENING VALUATION';
      } else if (a && a.accountType === 'Precious Metal') {
        // Show price/gram and pre-fill from today's spot price
        priceGramGroup.style.display = 'block';
        const qty = a.quantity || 0;
        if (a.pricePerGram) priceGramField.value = a.pricePerGram;
        const saved = await DB.getMetalPricesForDate(todayStr());
        const rateEntries = await DB.getAll('exchangeRates');
        const spot = metalSpotPerGram(saved, a.metalType, cur, rateEntries, todayStr());
        if (spot != null) priceGramField.value = spot;
        if (qty > 0 && parseFloat(priceGramField.value) > 0) {
          amountField.value = (qty * parseFloat(priceGramField.value)).toFixed(2);
        } else if (a.currentValue) {
          amountField.value = a.currentValue;
        }
      } else {
        priceGramGroup.style.display = 'none';
        if (a && a.currentValue) amountField.value = a.currentValue;
      }
    });

    // Auto-compute total = quantity * price/gram
    const pgHandler = () => {
      const pg = parseFloat(priceGramField.value);
      DB.getById('accounts', accountId).then(a => {
        const qty = a && a.quantity ? a.quantity : 0;
        if (pg > 0 && qty > 0) {
          amountField.value = (pg * qty).toFixed(2);
        }
      });
    };
    priceGramField.oninput = pgHandler;

    this._pickedValDate = '';

    const picker = dateField;
    const handler = () => {
      this._pickedValDate = picker.value;
    };
    picker.removeEventListener('change', handler);
    picker.addEventListener('change', handler);

    this._modals.valuation.show();
  },

  _showMetalModal(direction, accountId) {
    const title = document.getElementById('modal-metal-title');
    const accIdField = document.getElementById('metal-account-id');
    const dirField = document.getElementById('metal-direction');
    const qtyField = document.getElementById('metal-qty');
    const priceField = document.getElementById('metal-price');
    const dateField = document.getElementById('metal-date');
    const notesField = document.getElementById('metal-notes');
    const totalEl = document.getElementById('metal-total');
    const currentQtyEl = document.getElementById('metal-current-qty');
    const curSymEl = document.getElementById('metal-currency-symbol');
    const priceSymEl = document.getElementById('metal-price-symbol');

    accIdField.value = accountId;
    dirField.value = direction === 'sell' ? 'sell' : 'buy';
    qtyField.value = '';
    priceField.value = '';
    notesField.value = '';
    dateField.value = todayStr();
    totalEl.textContent = '—';
    title.textContent = direction === 'sell' ? 'SELL METAL' : 'BUY METAL';

    this._metalCurrency = 'CHF';

    DB.getById('accounts', accountId).then(async a => {
      if (!a) return;
      this._metalCurrency = a.currency || 'CHF';
      curSymEl.textContent = this._metalCurrency;
      priceSymEl.textContent = this._metalCurrency + '/g';
      currentQtyEl.textContent = (a.quantity || 0) + 'g ' + (a.metalType || '');
      if (a.pricePerGram) priceField.value = a.pricePerGram;
      if (direction === 'sell') qtyField.value = a.quantity || 0;
      if (!priceField.value && a.metalType) {
        const saved = await DB.getMetalPricesForDate(todayStr());
        const rateEntries = await DB.getAll('exchangeRates');
        const spot = metalSpotPerGram(saved, a.metalType, this._metalCurrency, rateEntries, todayStr());
        if (spot != null) priceField.value = spot;
      }
      this._updateMetalTotal();
    });

    const update = () => this._updateMetalTotal();
    qtyField.oninput = update;
    priceField.oninput = update;

    this._modals.metal.show();
  },

  _updateMetalTotal() {
    const qty = parseFloat(document.getElementById('metal-qty').value);
    const price = parseFloat(document.getElementById('metal-price').value);
    const totalEl = document.getElementById('metal-total');
    if (qty > 0 && price > 0) {
      totalEl.textContent = formatCurrency(qty * price, this._metalCurrency);
    } else {
      totalEl.textContent = '—';
    }
  },

  async saveMetal() {
    const accountId = parseInt(document.getElementById('metal-account-id').value);
    const direction = document.getElementById('metal-direction').value;
    const qty = parseFloat(document.getElementById('metal-qty').value);
    const price = parseFloat(document.getElementById('metal-price').value);
    const date = document.getElementById('metal-date').value || todayStr();
    const notes = document.getElementById('metal-notes').value.trim();

    if (!qty || qty <= 0) { this.toast('ENTER A VALID QUANTITY'); return; }
    if (!price || price <= 0) { this.toast('ENTER A VALID PRICE'); return; }

    const account = await DB.getById('accounts', accountId);
    if (!account) { this.toast('ACCOUNT NOT FOUND'); return; }

    const currentQty = account.quantity || 0;
    if (direction === 'sell' && qty > currentQty) { this.toast('NOT ENOUGH METAL TO SELL'); return; }

    const newQty = direction === 'buy' ? currentQty + qty : currentQty - qty;
    const total = qty * price;
    const newValue = newQty * price;

    await DB.add('transactions', {
      accountId,
      type: direction,
      quantity: qty,
      pricePerGram: price,
      amount: direction === 'buy' ? total : -total,
      date,
      notes,
      balanceAfter: newValue,
      quantityAfter: newQty,
      createdAt: nowISO()
    });

    account.quantity = newQty;
    account.pricePerGram = price;
    account.currentValue = newValue;
    await DB.put('accounts', account);

    this._modals.metal.hide();
    this.toast(direction === 'buy' ? 'METAL PURCHASED' : 'METAL SOLD');
    this.route();
  },

  async _showAssetModal(accountId, assetId) {
    const account = await DB.getById('accounts', accountId);
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    const title = document.getElementById('modal-asset-title');
    if (title) title.textContent = assetId ? 'EDIT ASSET' : 'ADD ASSET';
    document.getElementById('asset-id').value = assetId || '';
    document.getElementById('asset-account-id').value = accountId;
    const curField = document.getElementById('asset-currency');
    curField.innerHTML = CURRENCIES.map(c =>
      `<option value="${c.code}">${c.code} - ${c.symbol}</option>`
    ).join('');
    if (assetId) {
      const asset = await DB.getById('assets', assetId);
      if (asset) {
        document.getElementById('asset-name').value = asset.name || '';
        document.getElementById('asset-value').value = asset.purchaseValue != null ? asset.purchaseValue : '';
        document.getElementById('asset-depreciation').value = asset.depreciationPct != null ? asset.depreciationPct : '';
        document.getElementById('asset-date').value = asset.purchaseDate || todayStr();
        curField.value = asset.currency || (account && account.currency) || mainCurrency;
      }
    } else {
      document.getElementById('asset-name').value = '';
      document.getElementById('asset-value').value = '';
      document.getElementById('asset-depreciation').value = '';
      document.getElementById('asset-date').value = todayStr();
      curField.value = (account && account.currency) || mainCurrency;
    }
    this._modals.asset.show();
  },

  async saveAsset() {
    const assetId = parseInt(document.getElementById('asset-id').value) || 0;
    const accountId = parseInt(document.getElementById('asset-account-id').value);
    const name = document.getElementById('asset-name').value.trim();
    const purchaseValue = parseFloat(document.getElementById('asset-value').value);
    const depreciationPct = parseFloat(document.getElementById('asset-depreciation').value) || 0;
    const purchaseDate = document.getElementById('asset-date').value || todayStr();
    const currency = document.getElementById('asset-currency').value || 'CHF';

    if (!name) { this.toast('NAME IS REQUIRED'); return; }
    if (!purchaseValue || purchaseValue <= 0) { this.toast('ENTER A VALID VALUE'); return; }
    if (isNaN(depreciationPct) || depreciationPct < -100 || depreciationPct > 100) { this.toast('DEPRECIATION MUST BE BETWEEN -100 AND 100'); return; }

    if (assetId) {
      const asset = await DB.getById('assets', assetId);
      if (!asset) { this.toast('ASSET NOT FOUND'); return; }
      asset.name = name;
      asset.purchaseValue = purchaseValue;
      asset.depreciationPct = depreciationPct;
      asset.purchaseDate = purchaseDate;
      asset.currency = currency;
      await DB.put('assets', asset);

      const account = await DB.getById('accounts', accountId);
      if (account) {
        const accountAssets = await DB.getByIndex('assets', 'accountId', accountId);
        const rateEntries = await DB.getAll('exchangeRates');
        const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', account.currency || 'CHF', date);
        const metrics = assetAccountMetrics(accountAssets, purchaseDate, rateToAcc);
        const addTx = (await DB.getByIndex('transactions', 'assetId', assetId)).find(t => t.type === 'asset-add');
        if (addTx) {
          addTx.amount = purchaseValue;
          addTx.date = purchaseDate;
          addTx.notes = 'ASSET ADDED: ' + name;
          addTx.balanceAfter = metrics.value;
          await DB.put('transactions', addTx);
        }
        account.currentValue = assetAccountMetrics(accountAssets, todayStr(), rateToAcc).value;
        await DB.put('accounts', account);
      }
      if (asset.sold) {
        const sellTx = (await DB.getByIndex('transactions', 'assetId', assetId)).find(t => t.type === 'asset-sell');
        if (sellTx && sellTx.notes !== 'ASSET SOLD: ' + name) {
          sellTx.notes = 'ASSET SOLD: ' + name;
          await DB.put('transactions', sellTx);
        }
      }

      this._modals.asset.hide();
      this.toast('ASSET UPDATED');
      this.route();
      return;
    }

    const asset = { accountId, name, purchaseValue, depreciationPct, purchaseDate, currency, sold: false, saleValue: null, saleDate: null };
    const newId = await DB.add('assets', asset);

    const account = await DB.getById('accounts', accountId);
    if (account) {
      const accountAssets = await DB.getByIndex('assets', 'accountId', accountId);
      const rateEntries = await DB.getAll('exchangeRates');
      const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', account.currency || 'CHF', date);
      const metrics = assetAccountMetrics(accountAssets, purchaseDate, rateToAcc);
      await DB.add('transactions', {
        accountId,
        assetId: newId,
        type: 'asset-add',
        amount: purchaseValue,
        date: purchaseDate,
        notes: 'ASSET ADDED: ' + name,
        balanceAfter: metrics.value,
        createdAt: nowISO()
      });
      account.currentValue = metrics.value;
      await DB.put('accounts', account);
    }

    this._modals.asset.hide();
    this.toast('ASSET ADDED');
    this.route();
  },

  async _showSellAssetModal(assetId) {
    const asset = await DB.getById('assets', assetId);
    if (!asset) return;
    document.getElementById('sell-asset-id').value = assetId;
    document.getElementById('sell-asset-name').textContent = asset.name || '—';
    document.getElementById('sell-asset-value').value = asset.sold ? (asset.saleValue || '') : '';
    document.getElementById('sell-asset-date').value = asset.saleDate || todayStr();
    document.getElementById('sell-asset-currency').textContent = asset.currency || 'CHF';
    this._modals.sellAsset.show();
  },

  async saveSellAsset() {
    const assetId = parseInt(document.getElementById('sell-asset-id').value);
    const saleValue = parseFloat(document.getElementById('sell-asset-value').value);
    const saleDate = document.getElementById('sell-asset-date').value || todayStr();

    if (!saleValue || saleValue < 0) { this.toast('ENTER A VALID SALE VALUE'); return; }

    const asset = await DB.getById('assets', assetId);
    if (!asset) { this.toast('ASSET NOT FOUND'); return; }
    if (asset.sold) { this.toast('ASSET ALREADY SOLD'); return; }

    asset.sold = true;
    asset.saleValue = saleValue;
    asset.saleDate = saleDate;
    await DB.put('assets', asset);

    const account = await DB.getById('accounts', asset.accountId);
    if (account) {
      const accountAssets = await DB.getByIndex('assets', 'accountId', asset.accountId);
      const rateEntries = await DB.getAll('exchangeRates');
      const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', account.currency || 'CHF', date);
      const metrics = assetAccountMetrics(accountAssets, saleDate, rateToAcc);
      await DB.add('transactions', {
        accountId: asset.accountId,
        assetId,
        type: 'asset-sell',
        amount: saleValue,
        date: saleDate,
        notes: 'ASSET SOLD: ' + (asset.name || ''),
        balanceAfter: metrics.value,
        createdAt: nowISO()
      });
      account.currentValue = metrics.value;
      await DB.put('accounts', account);
    }

    this._modals.sellAsset.hide();
    this.toast('ASSET SOLD');
    this.route();
  },

  async deleteAsset(id) {
    const confirmed = await this.confirm('DELETE ASSET?', 'Remove this asset and its transactions?');
    if (!confirmed) return;

    const asset = await DB.getById('assets', id);
    if (!asset) return;

    const txs = await DB.getByIndex('transactions', 'assetId', id);
    for (const tx of txs) {
      await DB.del('transactions', tx.id);
    }
    await DB.del('assets', id);

    const account = await DB.getById('accounts', asset.accountId);
    if (account && account.accountType === 'Tangible Asset') {
      const accountAssets = await DB.getByIndex('assets', 'accountId', asset.accountId);
      const rateEntries = await DB.getAll('exchangeRates');
      const rateToAcc = (cur, date) => currencyRateTo(rateEntries, cur || 'CHF', account.currency || 'CHF', date);
      account.currentValue = assetAccountMetrics(accountAssets, todayStr(), rateToAcc).value;
      await DB.put('accounts', account);
    }

    this.toast('ASSET DELETED');
    this.route();
  },

  async _showIncomeModal(editId) {
    const title = document.getElementById('modal-income-title');
    const idField = document.getElementById('income-id');
    const monthField = document.getElementById('income-month-field');
    const sourceField = document.getElementById('income-source');
    const amountField = document.getElementById('income-amount');
    const currencyField = document.getElementById('income-currency');
    const dateField = document.getElementById('income-date');
    const notesField = document.getElementById('income-notes');

    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    currencyField.innerHTML = CURRENCIES.map(c =>
      `<option value="${c.code}">${c.code} - ${c.symbol}</option>`
    ).join('');

    if (editId) {
      title.textContent = 'EDIT INCOME';
      DB.getById('incomes', editId).then(inc => {
        if (!inc) return;
        idField.value = inc.id;
        monthField.value = inc.month || '';
        sourceField.value = inc.source || '';
        amountField.value = inc.amount || '';
        currencyField.value = inc.currency || mainCurrency;
        dateField.value = inc.date || '';
        notesField.value = inc.notes || '';
        this._modals.income.show();
      });
    } else {
      title.textContent = 'NEW INCOME';
      idField.value = '';
      monthField.value = todayStr().substring(0, 7);
      sourceField.value = '';
      amountField.value = '';
      currencyField.value = mainCurrency;
      dateField.value = todayStr();
      notesField.value = '';
      this._modals.income.show();
    }
  },

  async _showExpenseModal(editId) {
    const title = document.getElementById('modal-expense-title');
    const idField = document.getElementById('expense-id');
    const textField = document.getElementById('expense-text');
    const amountField = document.getElementById('expense-amount');
    const currencyField = document.getElementById('expense-currency');
    const typeField = document.getElementById('expense-type');
    const yearField = document.getElementById('expense-year');
    const notesField = document.getElementById('expense-notes');
    const monthGroup = document.getElementById('expense-month-group');
    const monthField = document.getElementById('expense-month');

    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || 'CHF';
    currencyField.innerHTML = CURRENCIES.map(c =>
      `<option value="${c.code}">${c.code} - ${c.symbol}</option>`
    ).join('');

    const curYear = new Date().getFullYear();
    yearField.innerHTML = '';
    for (let y = curYear; y >= curYear - 10; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearField.appendChild(opt);
    }

    const toggleMonth = () => {
      monthGroup.style.display = typeField.value === 'yearly' ? '' : 'none';
    };
    typeField.onchange = toggleMonth;

    if (editId) {
      title.textContent = 'EDIT EXPENSE';
      DB.getById('expenses', editId).then(exp => {
        if (!exp) return;
        idField.value = exp.id;
        textField.value = exp.text || '';
        amountField.value = exp.amount || '';
        currencyField.value = exp.currency || mainCurrency;
        typeField.value = exp.type || 'monthly';
        yearField.value = exp.year || String(curYear);
        monthField.value = exp.paymentMonth || '';
        notesField.value = exp.notes || '';
        toggleMonth();
        this._modals.expense.show();
      });
    } else {
      title.textContent = 'NEW EXPENSE';
      idField.value = '';
      textField.value = '';
      amountField.value = '';
      currencyField.value = mainCurrency;
      typeField.value = 'monthly';
      yearField.value = String(curYear);
      monthField.value = '';
      notesField.value = '';
      toggleMonth();
      this._modals.expense.show();
    }
  },

  _showDebtModal(editId) {
    const title = document.getElementById('modal-debt-title');
    const idField = document.getElementById('debt-id');
    const descriptionField = document.getElementById('debt-description');
    const personField = document.getElementById('debt-person');
    const directionField = document.getElementById('debt-direction');
    const amountField = document.getElementById('debt-amount');
    const dateField = document.getElementById('debt-date');
    const notesField = document.getElementById('debt-notes');

    if (editId) {
      title.textContent = 'EDIT DEBT';
      DB.getById('debts', editId).then(debt => {
        if (!debt) return;
        idField.value = debt.id;
        descriptionField.value = debt.description || '';
        personField.value = debt.person || '';
        directionField.value = debt.direction || 'out';
        amountField.value = debt.amount || '';
        dateField.value = debt.date || todayStr();
        notesField.value = debt.notes || '';
        this._modals.debt.show();
      });
    } else {
      title.textContent = 'ADD DEBT';
      idField.value = '';
      descriptionField.value = '';
      personField.value = '';
      directionField.value = 'out';
      amountField.value = '';
      dateField.value = todayStr();
      notesField.value = '';
      this._modals.debt.show();
    }
  },

  _showGoalModal(editId) {
    const title = document.getElementById('modal-goal-title');
    const idField = document.getElementById('goal-id');
    const nameField = document.getElementById('goal-name');
    const targetField = document.getElementById('goal-target');
    const orderField = document.getElementById('goal-order');
    const allocContainer = document.getElementById('goal-allocations');

    const populate = (goal) => {
      title.textContent = goal ? 'EDIT GOAL' : 'NEW GOAL';
      idField.value = goal ? goal.id : '';
      nameField.value = goal ? (goal.name || '') : '';
      targetField.value = goal ? (goal.target || '') : '';
      orderField.value = goal ? (goal.order != null ? goal.order : '') : '';
      allocContainer.innerHTML = '';
      const allocations = goal && goal.allocations ? goal.allocations : [];
      if (allocations.length === 0) {
        this.addGoalAllocationRow();
      } else {
        allocations.forEach(a => this.addGoalAllocationRow(a.accountId, a.pct));
      }
      this._modals.goal.show();
    };

    if (editId) {
      DB.getById('goals', editId).then(goal => { if (goal) populate(goal); });
    } else {
      DB.getAll('goals').then(goals => {
        const maxOrder = goals.reduce((max, g) => Math.max(max, g.order != null ? g.order : 0), 0);
        populate(null);
        orderField.value = maxOrder + 1;
      });
    }
  },

  async addGoalAllocationRow(accountId, pct) {
    const accounts = await DB.getAll('accounts');
    const container = document.getElementById('goal-allocations');
    const row = document.createElement('div');
    row.className = 'd-flex gap-2 mb-2 align-items-center';
    const opts = accounts.map(a =>
      `<option value="${a.id}" ${Number(a.id) === Number(accountId) ? 'selected' : ''}>${escapeHtml(a.name)}</option>`
    ).join('');
    row.innerHTML =
      '<select class="form-select form-gta goal-alloc-account" style="flex:1">' + opts + '</select>' +
      '<input type="number" min="0" max="100" step="1" class="form-control form-gta goal-alloc-pct" style="width:90px" placeholder="%" value="' + (pct != null ? pct : 100) + '" />' +
      '<span class="tx-link" style="cursor:pointer" title="USE EARLIER" onclick="App.moveGoalAllocationRow(this, -1)">UP</span>' +
      '<span class="tx-link" style="cursor:pointer" title="USE LATER" onclick="App.moveGoalAllocationRow(this, 1)">DOWN</span>' +
      '<span class="tx-link" style="cursor:pointer" onclick="this.parentElement.remove()">REMOVE</span>';
    container.appendChild(row);
  },

  moveGoalAllocationRow(btn, dir) {
    const row = btn.parentElement;
    const container = row.parentElement;
    const rows = [...container.children];
    const idx = rows.indexOf(row);
    const target = idx + dir;
    if (target < 0 || target >= rows.length) return;
    if (dir < 0) container.insertBefore(row, rows[target]);
    else container.insertBefore(rows[target], row);
  },

  // ==================== SAVE METHODS ====================

  async saveCustodian() {
    const id = document.getElementById('custodian-id').value;
    const name = document.getElementById('custodian-name').value.trim();
    if (!name) { this.toast('NAME IS REQUIRED'); return; }
    const data = {
      name,
      notes: document.getElementById('custodian-notes').value.trim()
    };
    if (id) { data.id = parseInt(id); await DB.put('custodians', data); }
    else { await DB.add('custodians', data); }
    this._modals.custodian.hide();
    this.toast('CUSTODIAN SAVED');
    this.route();
  },

  async savePortfolio() {
    const id = document.getElementById('portfolio-id').value;
    const name = document.getElementById('portfolio-name').value.trim();
    if (!name) { this.toast('NAME IS REQUIRED'); return; }
    const data = {
      name,
      description: document.getElementById('portfolio-desc').value.trim(),
      createdAt: nowISO()
    };
    if (id) { data.id = parseInt(id); await DB.put('portfolios', data); }
    else { await DB.add('portfolios', data); }
    this._modals.portfolio.hide();
    this.toast('PORTFOLIO SAVED');
    this.route();
  },

  async saveAccount() {
    const id = document.getElementById('account-id').value;
    const pfId = document.getElementById('account-pfid').value;
    const name = document.getElementById('account-name').value.trim();
    if (!name) { this.toast('NAME IS REQUIRED'); return; }
    if (!pfId) { this.toast('PORTFOLIO ID MISSING'); return; }
    const data = {
      portfolioId: parseInt(pfId),
      name,
      custodianId: parseInt(document.getElementById('account-custodian').value) || null,
      currency: document.getElementById('account-currency').value || 'CHF',
      notes: document.getElementById('account-notes').value.trim(),
      trackPerformance: document.getElementById('account-track-perf').checked,
      includeInNetWorth: document.getElementById('account-include-nw').checked,
      includeInLiquidNetWorth: document.getElementById('account-include-liq').checked,
      accountType: document.getElementById('account-type').value || 'Cash Account',
      metalType: document.getElementById('account-metal').value || '',
      quantity: parseFloat(document.getElementById('account-qty').value) || 0,
      currentValue: 0
    };

    const isNew = !id;
    const accountType = document.getElementById('account-type').value;
    const startingValue = isNew && accountType !== 'Tangible Asset' ? (parseFloat(document.getElementById('account-starting-value').value) || 0) : 0;
    const startingContrib = isNew && accountType !== 'Tangible Asset' ? (parseFloat(document.getElementById('account-starting-contrib').value) || 0) : 0;
    const startingDate = isNew ? (document.getElementById('account-starting-date').value || todayStr()) : todayStr();

    let existingValue = 0;
    if (id) {
      data.id = parseInt(id);
      const old = await DB.getById('accounts', parseInt(id));
      existingValue = old ? old.currentValue || 0 : 0;
      data.currentValue = existingValue;
      data.pricePerGram = old ? (old.pricePerGram || 0) : 0;
      await DB.put('accounts', data);
    } else {
      data.currentValue = 0;
      data.pricePerGram = 0;
      const accountId = await DB.add('accounts', data);
      if (startingValue > 0) {
        // Opening balance split: contributed portion is a deposit, the rest is opening performance.
        const isSplit = startingContrib > 0 && startingContrib < startingValue;
        const createdAt = nowISO();
        if (isSplit) {
          await DB.add('transactions', {
            accountId,
            type: 'deposit',
            amount: startingContrib,
            date: startingDate,
            notes: 'OPENING CONTRIBUTION',
            balanceAfter: startingContrib,
            createdAt
          });
        }
        const txData = {
          accountId,
          type: 'valuation',
          amount: startingValue,
          date: startingDate,
          notes: 'OPENING VALUATION',
          opening: true,
          balanceAfter: startingValue,
          createdAt: isSplit ? nowISO() : createdAt
        };
        if (data.accountType === 'Precious Metal' && (data.quantity || 0) > 0) {
          const derived = startingValue / data.quantity;
          data.pricePerGram = derived;
          txData.pricePerGram = derived;
        }
        await DB.add('transactions', txData);
        data.currentValue = startingValue;
        await DB.put('accounts', data);
        await this._recomputeAccountBalances(accountId);
      }
    }
    this._modals.account.hide();
    this.toast('ACCOUNT SAVED');
    this.route();
  },

  async saveTransaction() {
    const accountId = parseInt(document.getElementById('tx-account-id').value);
    const type = document.getElementById('tx-type').value;
    const amount = parseFloat(document.getElementById('tx-amount').value);
    const notes = document.getElementById('tx-notes').value.trim();
    const date = document.getElementById('tx-date').value || todayStr();

    if (!amount || amount <= 0) { this.toast('ENTER A VALID AMOUNT'); return; }

    const account = await DB.getById('accounts', accountId);
    if (!account) { this.toast('ACCOUNT NOT FOUND'); return; }

    const signedAmount = type === 'withdrawal' ? -amount : amount;
    const balanceAfter = (account.currentValue || 0) + signedAmount;

    await DB.add('transactions', {
      accountId,
      type,
      amount: signedAmount,
      date,
      notes,
      balanceAfter,
      createdAt: nowISO()
    });

    account.currentValue = balanceAfter;
    await DB.put('accounts', account);
    await this._recomputeAccountBalances(accountId);

    this._modals.transaction.hide();
    this.toast((type === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL') + ' RECORDED');
    this.route();
  },

  async saveValuation() {
    const accountId = parseInt(document.getElementById('val-account-id').value);
    const amount = parseFloat(document.getElementById('val-amount').value);
    const notes = document.getElementById('val-notes').value.trim();
    const date = this._pickedValDate || document.getElementById('val-date').value || todayStr();
    const isOpening = !!this._valOpening;

    if (isNaN(amount) || amount < 0) { this.toast('ENTER A VALID VALUE'); return; }

    const account = await DB.getById('accounts', accountId);
    if (!account) { this.toast('ACCOUNT NOT FOUND'); return; }

    const priceGram = parseFloat(document.getElementById('val-price-gram').value);
    const txData = {
      accountId,
      type: 'valuation',
      amount,
      date,
      notes: isOpening ? 'OPENING VALUATION' : notes,
      balanceAfter: amount,
      createdAt: nowISO()
    };
    if (isOpening) txData.opening = true;

    if (account.accountType === 'Precious Metal') {
      const qty = account.quantity || 0;
      if (qty > 0) {
        const derived = priceGram > 0 ? priceGram : amount / qty;
        if (derived > 0) {
          account.pricePerGram = derived;
          txData.pricePerGram = derived;
        }
      }
    } else if (priceGram > 0) {
      txData.pricePerGram = priceGram;
    }
    await DB.add('transactions', txData);
    this._valOpening = false;

    account.currentValue = amount;
    await DB.put('accounts', account);
    await this._recomputeAccountBalances(accountId);

    this._modals.valuation.hide();
    this.toast(isOpening ? 'OPENING VALUE RECORDED' : 'VALUE UPDATED');
    this.route();
  },

  async saveIncome() {
    const id = document.getElementById('income-id').value;
    const date = document.getElementById('income-date').value;
    const month = date ? date.substring(0, 7) : document.getElementById('income-month-field').value;
    const source = document.getElementById('income-source').value.trim();
    const amount = parseFloat(document.getElementById('income-amount').value);
    const notes = document.getElementById('income-notes').value.trim();

    if (!source) { this.toast('SOURCE IS REQUIRED'); return; }
    if (!amount || amount <= 0) { this.toast('ENTER A VALID AMOUNT'); return; }

    const data = { month, source, amount, date, notes, currency: document.getElementById('income-currency').value || 'CHF' };
    if (id) { data.id = parseInt(id); await DB.put('incomes', data); }
    else { await DB.add('incomes', data); }

    this._modals.income.hide();
    this.toast('INCOME SAVED');
    this.route();
  },

  async saveExpense() {
    const id = document.getElementById('expense-id').value;
    const text = document.getElementById('expense-text').value.trim();
    const amount = parseFloat(document.getElementById('expense-amount').value);
    const type = document.getElementById('expense-type').value;
    const year = document.getElementById('expense-year').value;
    const notes = document.getElementById('expense-notes').value.trim();
    const paymentMonth = type === 'yearly' ? (document.getElementById('expense-month').value || null) : null;

    if (!text) { this.toast('TEXT IS REQUIRED'); return; }
    if (!amount || amount <= 0) { this.toast('ENTER A VALID AMOUNT'); return; }

    const data = { text, amount, type, year, notes, currency: document.getElementById('expense-currency').value || 'CHF', paymentMonth };
    if (id) { data.id = parseInt(id); await DB.put('expenses', data); }
    else { await DB.add('expenses', data); }

    this._modals.expense.hide();
    this.toast('EXPENSE SAVED');
    this.route();
  },

  async deleteExpense(id) {
    const confirmed = await this.confirm('DELETE EXPENSE?', 'Remove this expense entry?');
    if (!confirmed) return;
    await DB.del('expenses', id);
    this.toast('EXPENSE DELETED');
    this.route();
  },

  async deleteIncome(id) {
    const confirmed = await this.confirm('DELETE INCOME?', 'Remove this income entry?');
    if (!confirmed) return;
    await DB.del('incomes', id);
    this.toast('INCOME DELETED');
    this.route();
  },

  async saveDebt() {
    const id = document.getElementById('debt-id').value;
    const description = document.getElementById('debt-description').value.trim();
    const person = document.getElementById('debt-person').value.trim();
    const direction = document.getElementById('debt-direction').value;
    const amount = parseFloat(document.getElementById('debt-amount').value);
    const date = document.getElementById('debt-date').value || todayStr();
    const notes = document.getElementById('debt-notes').value.trim();

    if (!description) { this.toast('DESCRIPTION IS REQUIRED'); return; }
    if (!amount || amount <= 0) { this.toast('ENTER A VALID AMOUNT'); return; }

    const data = { description, person, direction, amount, date, notes };
    if (id) { data.id = parseInt(id); await DB.put('debts', data); }
    else { await DB.add('debts', data); }

    this._modals.debt.hide();
    this.toast('DEBT SAVED');
    this.route();
  },

  async deleteDebt(id) {
    const confirmed = await this.confirm('DELETE DEBT?', 'Remove this debt entry?');
    if (!confirmed) return;
    await DB.del('debts', id);
    this.toast('DEBT DELETED');
    this.route();
  },

  async saveGoal() {
    const id = document.getElementById('goal-id').value;
    const name = document.getElementById('goal-name').value.trim();
    const target = parseFloat(document.getElementById('goal-target').value);
    const order = parseInt(document.getElementById('goal-order').value);

    if (!name) { this.toast('NAME IS REQUIRED'); return; }
    if (!target || target <= 0) { this.toast('ENTER A VALID TARGET'); return; }

    const allocations = [];
    document.querySelectorAll('#goal-allocations .goal-alloc-account').forEach(sel => {
      const row = sel.closest('div');
      const pct = parseFloat(row.querySelector('.goal-alloc-pct').value);
      allocations.push({ accountId: parseInt(sel.value), pct: isNaN(pct) ? 100 : pct });
    });

    const data = { name, target, allocations, order: isNaN(order) ? 1 : order };
    if (id) { data.id = parseInt(id); await DB.put('goals', data); }
    else { await DB.add('goals', data); }

    this._modals.goal.hide();
    this.toast('GOAL SAVED');
    this.route();
  },

  async deleteGoal(id) {
    const confirmed = await this.confirm('DELETE GOAL?', 'Remove this goal?');
    if (!confirmed) return;
    await DB.del('goals', id);
    this.toast('GOAL DELETED');
    this.route();
  },

  async moveGoal(id, dir) {
    const goals = await DB.getAll('goals');
    const ordered = goals.sort((a, b) =>
      ((a.order != null ? a.order : Infinity) - (b.order != null ? b.order : Infinity)) || (a.id - b.id)
    );
    const idx = ordered.findIndex(g => Number(g.id) === Number(id));
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= ordered.length) return;

    const a = ordered[idx];
    const b = ordered[targetIdx];
    const tmpA = a.order != null ? a.order : (idx + 1);
    const tmpB = b.order != null ? b.order : (targetIdx + 1);
    a.order = tmpB;
    b.order = tmpA;
    await DB.put('goals', a);
    await DB.put('goals', b);
    this.toast('GOAL REORDERED');
    this.route();
  },

  // ==================== DELETE ====================

  async deleteAccount(id) {
    const confirmed = await this.confirm('DELETE ACCOUNT?', 'This will also delete all transactions for this account. Are you sure?');
    if (!confirmed) return;

    const txs = await DB.getByIndex('transactions', 'accountId', id);
    for (const tx of txs) {
      await DB.del('transactions', tx.id);
    }
    const assets = await DB.getByIndex('assets', 'accountId', id);
    for (const asset of assets) {
      await DB.del('assets', asset.id);
    }
    await DB.del('accounts', id);
    this.toast('ACCOUNT DELETED');
    this.navigate('portfolio-detail?id=' + this.currentPfId);
  },

  async deleteTransaction(id) {
    const confirmed = await this.confirm('DELETE TRANSACTION?', 'This will remove this transaction from the history.');
    if (!confirmed) return;

    const tx = await DB.getById('transactions', id);
    if (!tx) return;
    const account = await DB.getById('accounts', tx.accountId);
    if (account) {
      if (tx.type === 'asset-add' || tx.type === 'asset-sell') {
        // Tangible asset events do not change the computed account value
      } else if (tx.type === 'buy' || tx.type === 'sell') {
        const qty = account.quantity || 0;
        account.quantity = tx.type === 'buy' ? Math.max(0, qty - (tx.quantity || 0)) : qty + (tx.quantity || 0);
        account.currentValue = (account.quantity || 0) * (account.pricePerGram || tx.pricePerGram || 0);
      } else {
        // revert the account value
        account.currentValue = (account.currentValue || 0) - tx.amount;
      }
      if (tx.type !== 'asset-add' && tx.type !== 'asset-sell') {
        await DB.put('accounts', account);
      }
    }
    await DB.del('transactions', id);
    await this._recomputeAccountBalances(tx.accountId);
    this.toast('TRANSACTION DELETED');
    this.route();
  },

  confirm(title, msg) {
    return new Promise(resolve => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-msg').textContent = msg;
      const btn = document.getElementById('confirm-yes');
      const modalEl = document.getElementById('modal-confirm');
      let resolved = false;
      const handler = () => {
        if (resolved) return;
        resolved = true;
        btn.removeEventListener('click', handler);
        this._modals.confirm.hide();
        resolve(true);
      };
      btn.addEventListener('click', handler);
      const cancelHandler = () => {
        if (resolved) return;
        resolved = true;
        document.getElementById('confirm-yes').removeEventListener('click', handler);
        resolve(false);
      };
      modalEl.addEventListener('hidden.bs.modal', cancelHandler, { once: true });
      this._modals.confirm.show();
    });
  },

  // ==================== EXPORT / IMPORT ====================

  async saveFile() {
    try {
      const kind = await DB.saveFile();
      if (kind === 'classic') {
        this.toast('FILE DOWNLOADED');
      } else {
        this.toast('FILE SAVED TO FOLDER');
      }
    } catch (e) {
      this.toast('SAVE FAILED: ' + e.message);
    }
  },

  async exportData() {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = (DB.currentFile || 'liberty-finance').replace(/\.json$/i, '');
    a.download = base + '-backup-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.toast('DATA EXPORTED');
  },

  importData() {
    document.getElementById('import-json').value = '';
    this._modals.importModal.show();
  },

  async doImport() {
    const json = document.getElementById('import-json').value.trim();
    if (!json) { this.toast('PASTE YOUR JSON DATA FIRST'); return; }
    try {
      const data = JSON.parse(json);
      if (!data.custodians || !data.portfolios || !data.accounts || !data.transactions) {
        this.toast('INVALID BACKUP FORMAT'); return;
      }
      await DB.importAll(data);
      this._modals.importModal.hide();
      this.toast('DATA IMPORTED SUCCESSFULLY');
      this.route();
    } catch (e) {
      this.toast('INVALID JSON: ' + e.message);
    }
  },

  // ==================== PERFORMANCE TOGGLE ====================

  async toggleFlag(ev, accountId, field, checked) {
    ev.stopPropagation();
    const account = await DB.getById('accounts', accountId);
    if (account) {
      account[field] = checked;
      await DB.put('accounts', account);
    }
  },

  // ==================== BALANCE REPLAY ====================

  // Recomputes the running balance for a cash-like account by replaying its
  // transactions in chronological order. Fixes out-of-order backfills, where the
  // stored balanceAfter was snapshotted against the account's current value and
  // is therefore wrong for historical dates (e.g. an old deposit inheriting the
  // latest balance).
  async _recomputeAccountBalances(accountId) {
    const account = await DB.getById('accounts', accountId);
    if (!account) return;
    const type = account.accountType;
    if (type === 'Tangible Asset' || type === 'Precious Metal') return; // computed from assets/quantity
    const flowTypes = ['deposit', 'withdrawal', 'valuation', 'buy', 'sell'];
    const txs = (await DB.getByIndex('transactions', 'accountId', accountId))
      .filter(t => flowTypes.includes(t.type))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (txs.length === 0) return;

    let balance = 0;
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      const abs = Math.abs(tx.amount || 0);
      if (i === 0) {
        // Seed with the opening level. A first deposit/buy has nothing before it,
        // so the balance equals the amount itself (avoids inheriting a wrong
        // snapshot from an out-of-order entry). A first valuation carries its own value.
        if (tx.type === 'deposit' || tx.type === 'buy') balance = abs;
        else balance = tx.balanceAfter != null ? tx.balanceAfter : (tx.amount != null ? tx.amount : 0);
      } else if (tx.type === 'deposit' || tx.type === 'buy') {
        balance += abs;
      } else if (tx.type === 'withdrawal' || tx.type === 'sell') {
        balance -= abs;
      } else if (tx.type === 'valuation') {
        balance = tx.amount != null ? tx.amount : balance;
      }
      if (tx.balanceAfter !== balance) {
        tx.balanceAfter = balance;
        await DB.put('transactions', tx);
      }
    }

    if ((account.currentValue || 0) !== balance) {
      account.currentValue = balance;
      await DB.put('accounts', account);
    }
  },

  async _recomputeAllBalances() {
    const accounts = await DB.getAll('accounts');
    for (const a of accounts) {
      await this._recomputeAccountBalances(a.id);
    }
  },

  async recalcAccount() {
    const id = this.currentAccId;
    if (!id) { this.toast('NO ACCOUNT SELECTED'); return; }
    await this._recomputeAccountBalances(id);
    this.toast('BALANCES RECOMPUTED');
    this.route();
  },

  // ==================== TOAST ====================

  toast(msg) {
    const el = document.getElementById('toast-body');
    if (el) {
      el.textContent = msg;
      const t = bootstrap.Toast.getOrCreateInstance(document.getElementById('toast-msg'));
      t.show();
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());

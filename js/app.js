/* ===== Application Core: Router & CRUD ===== */

const App = {
  currentPfId: null,
  currentAccId: null,
  _modals: {},
  _charts: {},
  _saveInProgress: false,

  async init() {
    const file = new URLSearchParams(window.location.search).get("file");
    if (!file) {
      const lastFile = localStorage.getItem(Storage.LAST_FILE_KEY);
      window.location.replace(lastFile ? "app.html?file=" + encodeURIComponent(lastFile) : "index.html");
      return;
    }

    const profileNameElement = document.getElementById("nav-profile");
    if (profileNameElement) profileNameElement.textContent = file.replace(/\.json$/i, "");

    try {
      await DB.open();
    } catch (error) {
      // Storage not connected (e.g. folder permission revoked) — back to the picker.
      // A damaged file is reported there; the picker page handles reconnecting itself.
      if (error && error.name === "DamagedFileError") Storage.setOpenError(error.message);
      window.location.replace("index.html");
      return;
    }

    try {
      await this._recomputeAllBalances();
    } catch (error) {
      /* non-fatal */
    }

    this._applyRadius();
    this._applyAccent();

    (async () => {
      await Pages.fetchMetalPrices(true).catch(() => {});
      await Pages.fetchRatesLatest(true).catch(() => {});
    })();

    (async () => {
      const toastElement = document.getElementById("toast-msg");
      const toastBodyElement = document.getElementById("toast-body");
      const status = (message) => {
        if (!toastElement || !toastBodyElement) return;
        toastBodyElement.textContent = message;
        if (!toastElement.classList.contains("show")) bootstrap.Toast.getOrCreateInstance(toastElement).show();
      };
      status("SYNCING MARKET DATA...");
      const result = await Randata.sync();
      if (result.status === "offline") {
        status("MARKET DATA OFFLINE");
      } else if (result.status === "fresh") {
        status("MARKET DATA AVAILABLE");
      } else if (result.status === "synced") {
        status("MARKET DATA SYNCED (" + result.symbols + " SYMBOLS, " + result.rows + " ROWS)");
      }
    })();

    this._modals = {
      custodian: new bootstrap.Modal(document.getElementById("modal-custodian")),
      portfolio: new bootstrap.Modal(document.getElementById("modal-portfolio")),
      account: new bootstrap.Modal(document.getElementById("modal-account")),
      transaction: new bootstrap.Modal(document.getElementById("modal-transaction")),
      txEdit: new bootstrap.Modal(document.getElementById("modal-tx-edit")),
      valuation: new bootstrap.Modal(document.getElementById("modal-valuation")),
      metal: new bootstrap.Modal(document.getElementById("modal-metal")),
      asset: new bootstrap.Modal(document.getElementById("modal-asset")),
      sellAsset: new bootstrap.Modal(document.getElementById("modal-sell-asset")),
      assetValuation: new bootstrap.Modal(document.getElementById("modal-asset-valuation")),
      income: new bootstrap.Modal(document.getElementById("modal-income")),
      expense: new bootstrap.Modal(document.getElementById("modal-expense")),
      debt: new bootstrap.Modal(document.getElementById("modal-debt")),
      goal: new bootstrap.Modal(document.getElementById("modal-goal")),
      settings: new bootstrap.Modal(document.getElementById("modal-settings")),
      importModal: new bootstrap.Modal(document.getElementById("modal-import")),
      confirm: new bootstrap.Modal(document.getElementById("modal-confirm")),
    };

    window.addEventListener("hashchange", () => this.route());
    this.route();
  },

  route() {
    const hash = window.location.hash.slice(1) || "dashboard";
    const [page, queryString] = hash.includes("?") ? hash.split("?") : [hash, ""];
    const params = new URLSearchParams(queryString);

    document.querySelectorAll(".page").forEach((pageElement) => pageElement.classList.remove("active"));

    const target = document.getElementById("page-" + page);
    if (target) {
      target.classList.add("active");

      Object.values(this._charts).forEach((chart) => {
        try {
          chart.destroy();
        } catch (error) {
          /* already destroyed */
        }
      });
      this._charts = {};

      switch (page) {
        case "dashboard":
          Pages.dashboard();
          break;
        case "portfolios":
          Pages.portfolios();
          break;
        case "portfolio-detail":
          this.currentPfId = parseInt(params.get("id"));
          Pages.portfolioDetail(this.currentPfId);
          break;
        case "account-detail":
          this.currentAccId = parseInt(params.get("id"));
          this.currentPfId = parseInt(params.get("pfid"));
          Pages.accountDetail(this.currentAccId);
          break;
        case "custodians":
          Pages.custodians();
          break;
        case "incomes":
          Pages.incomes();
          break;
        case "expenses":
          Pages.expenses();
          break;
        case "debts":
          Pages.debts();
          break;
        case "goals":
          Pages.goals();
          break;
        case "exchange-rates":
          Pages.exchangeRates();
          break;
        case "metal-prices":
          Pages.metalPrices();
          break;
        case "wall-street":
          Pages.wallStreet();
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
      case "custodian":
        this._showCustodianModal(args[0]);
        break;
      case "portfolio":
        this._showPortfolioModal(args[0]);
        break;
      case "account":
        this._showAccountModal(args[0], args[1]);
        break;
      case "deposit":
      case "withdrawal":
        this._showTxModal(type, args[0]);
        break;
      case "valuation":
        this._showValuationModal(args[0]);
        break;
      case "opening":
        this._showValuationModal(args[0], true);
        break;
      case "metal":
        this._showMetalModal(args[0], args[1]);
        break;
      case "asset":
        this._showAssetModal(args[0], args[1]);
        break;
      case "sellAsset":
        this._showSellAssetModal(args[0]);
        break;
      case "income":
        this._showIncomeModal(args[0]);
        break;
      case "expense":
        this._showExpenseModal(args[0]);
        break;
      case "debt":
        this._showDebtModal(args[0]);
        break;
      case "goal":
        this._showGoalModal(args[0]);
        break;
    }
  },

  async showSettingsModal() {
    const settings = await DB.getSettings();
    const current = settings.mainCurrency || "CHF";
    const select = document.getElementById("settings-currency");
    select.innerHTML = CURRENCIES.map((c) => `<option value="${c.code}" ${c.code === current ? "selected" : ""}>${c.code} - ${c.name}</option>`).join("");
    const colorEl = document.getElementById("settings-accent");
    colorEl.value = /^#[0-9a-fA-F]{6}$/.test(settings.accentColor || "") ? settings.accentColor : DEFAULT_ACCENT;
    colorEl.oninput = () => this.applyAccent(colorEl.value);
    const slider = document.getElementById("settings-radius");
    const label = document.getElementById("settings-radius-label");
    const radius = settings.borderRadius != null ? settings.borderRadius : 10;
    slider.value = radius;
    label.textContent = radius + "px";
    const preview = () => {
      const v = slider.value;
      label.textContent = v + "px";
      document.documentElement.style.setProperty("--radius", v + "px");
    };
    slider.oninput = preview;
    this._modals.settings.show();
  },

  applyAccent(hex) {
    const c = /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : DEFAULT_ACCENT;
    const root = document.documentElement;
    root.style.setProperty("--accent", c);
    root.style.setProperty("--border-accent", c);
    root.style.setProperty("--accent-dim", shadeAccent(c, 0.5));
    root.style.setProperty("--accent-glow", shadeAccent(c, 1, 0.15));
  },

  async _applyAccent() {
    const settings = await DB.getSettings();
    this.applyAccent(settings.accentColor || DEFAULT_ACCENT);
  },

  async _applyRadius() {
    const settings = await DB.getSettings();
    const radius = settings.borderRadius != null ? settings.borderRadius : 10;
    document.documentElement.style.setProperty("--radius", radius + "px");
  },

  async saveSettings() {
    const currency = document.getElementById("settings-currency").value;
    if (!currency) {
      this.toast("SELECT A MAIN CURRENCY");
      return;
    }
    const borderRadius = parseInt(document.getElementById("settings-radius").value) || 0;
    const accentColor = document.getElementById("settings-accent").value || DEFAULT_ACCENT;
    const existing = await DB.getSettings();
    await DB.saveSettings({ ...existing, mainCurrency: currency, borderRadius, accentColor });
    this._modals.settings.hide();
    this.toast("SETTINGS SAVED");
  },

  _showCustodianModal(editId) {
    const title = document.getElementById("modal-custodian-title");
    const idField = document.getElementById("custodian-id");
    const nameField = document.getElementById("custodian-name");
    const notesField = document.getElementById("custodian-notes");
    if (editId) {
      title.textContent = "EDIT CUSTODIAN";
      DB.getById("custodians", editId).then((c) => {
        if (!c) return;
        idField.value = c.id;
        nameField.value = c.name || "";
        notesField.value = c.notes || "";
        this._modals.custodian.show();
      });
    } else {
      title.textContent = "NEW CUSTODIAN";
      idField.value = "";
      nameField.value = "";
      notesField.value = "";
      this._modals.custodian.show();
    }
  },

  _showPortfolioModal(editId) {
    const title = document.getElementById("modal-portfolio-title");
    const idField = document.getElementById("portfolio-id");
    const nameField = document.getElementById("portfolio-name");
    const descriptionField = document.getElementById("portfolio-desc");
    const deleteButton = document.getElementById("portfolio-delete-btn");
    if (deleteButton) deleteButton.style.display = editId ? "" : "none";
    if (editId) {
      title.textContent = "EDIT PORTFOLIO";
      DB.getById("portfolios", editId).then((portfolio) => {
        if (!portfolio) return;
        idField.value = portfolio.id;
        nameField.value = portfolio.name || "";
        descriptionField.value = portfolio.description || "";
        this._modals.portfolio.show();
      });
    } else {
      title.textContent = "NEW PORTFOLIO";
      idField.value = "";
      nameField.value = "";
      descriptionField.value = "";
      this._modals.portfolio.show();
    }
  },

  async _showAccountModal(portfolioId, editId) {
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || "CHF";
    const title = document.getElementById("modal-account-title");
    const idField = document.getElementById("account-id");
    const portfolioIdField = document.getElementById("account-pfid");
    const nameField = document.getElementById("account-name");
    const custodianField = document.getElementById("account-custodian");
    const currencyField = document.getElementById("account-currency");
    const notesField = document.getElementById("account-notes");
    const trackPerformanceField = document.getElementById("account-track-perf");
    const includeInNetWorthField = document.getElementById("account-include-nw");
    const includeInLiquidField = document.getElementById("account-include-liq");
    const typeField = document.getElementById("account-type");
    const metalField = document.getElementById("account-metal");
    const quantityField = document.getElementById("account-qty");
    const preciousMetalFields = document.getElementById("pm-fields");
    const startingFields = document.getElementById("starting-value-fields");
    const startingValueField = document.getElementById("account-starting-value");
    const startingContributionField = document.getElementById("account-starting-contrib");
    const startingDateField = document.getElementById("account-starting-date");
    const startingSymbol = document.getElementById("account-starting-symbol");
    const contributionSymbol = document.getElementById("account-contrib-symbol");
    const deleteButton = document.getElementById("account-delete-btn");
    if (deleteButton) deleteButton.style.display = editId ? "" : "none";

    function toggleAccountTypeFields() {
      const accountType = typeField.value;
      preciousMetalFields.style.display = accountType === ACCOUNT_TYPE.preciousMetal ? "block" : "none";
      // A starting value only makes sense for new accounts that are not valued from assets
      const hasStartingValue = !editId && accountType !== ACCOUNT_TYPE.tangibleAsset && accountType !== ACCOUNT_TYPE.realEstate;
      if (startingFields) startingFields.style.display = hasStartingValue ? "block" : "none";
    }
    typeField.onchange = toggleAccountTypeFields;

    function updateStartingSymbol() {
      if (startingSymbol) startingSymbol.textContent = currencyField.value || mainCurrency;
      if (contributionSymbol) contributionSymbol.textContent = currencyField.value || mainCurrency;
    }
    currencyField.onchange = updateStartingSymbol;

    DB.getAll("custodians").then((custodians) => {
      custodianField.innerHTML = '<option value="">— SELECT —</option>' + custodians.map((custodian) => `<option value="${Number(custodian.id)}">${escapeHtml(custodian.name)}</option>`).join("");
    });
    currencyField.innerHTML = CURRENCIES.map((currency) => `<option value="${currency.code}">${currency.code} - ${currency.symbol}</option>`).join("");

    if (editId) {
      title.textContent = "EDIT ACCOUNT";
      DB.getById("accounts", editId).then((account) => {
        if (!account) return;
        idField.value = account.id;
        portfolioIdField.value = account.portfolioId;
        nameField.value = account.name || "";
        custodianField.value = account.custodianId || "";
        currencyField.value = account.currency || "CHF";
        notesField.value = account.notes || "";
        trackPerformanceField.checked = account.trackPerformance !== false;
        includeInNetWorthField.checked = account.includeInNetWorth !== false;
        includeInLiquidField.checked = account.includeInLiquidNetWorth !== false;
        typeField.value = account.accountType || ACCOUNT_TYPE.cash;
        metalField.value = account.metalType || "Gold";
        quantityField.value = account.quantity || 0;
        toggleAccountTypeFields();
        startingValueField.value = "";
        startingContributionField.value = "";
        this._modals.account.show();
      });
    } else {
      title.textContent = "NEW ACCOUNT";
      idField.value = "";
      portfolioIdField.value = portfolioId || "";
      nameField.value = "";
      custodianField.value = "";
      currencyField.value = mainCurrency;
      notesField.value = "";
      trackPerformanceField.checked = true;
      includeInNetWorthField.checked = true;
      includeInLiquidField.checked = true;
      typeField.value = ACCOUNT_TYPE.cash;
      metalField.value = "Gold";
      quantityField.value = 0;
      toggleAccountTypeFields();
      startingValueField.value = "";
      startingContributionField.value = "";
      startingDateField.value = todayStr();
      updateStartingSymbol();
      this._modals.account.show();
    }
  },

  _showTxModal(type, accountId) {
    const title = document.getElementById("modal-tx-title");
    const typeField = document.getElementById("tx-type");
    const accountIdField = document.getElementById("tx-account-id");
    const amountField = document.getElementById("tx-amount");
    const notesField = document.getElementById("tx-notes");
    const dateField = document.getElementById("tx-date");
    const currencySymbol = document.getElementById("tx-currency-symbol");

    typeField.value = type;
    accountIdField.value = accountId;
    amountField.value = "";
    notesField.value = "";
    dateField.value = todayStr();
    title.textContent = type === "deposit" ? "DEPOSIT" : "WITHDRAWAL";

    DB.getById("accounts", accountId).then((account) => {
      currencySymbol.textContent = account ? account.currency || "CHF" : "CHF";
    });

    this._modals.transaction.show();
  },

  _showValuationModal(accountId, isOpening) {
    const accountIdField = document.getElementById("val-account-id");
    const amountField = document.getElementById("val-amount");
    const pricePerGramField = document.getElementById("val-price-gram");
    const pricePerGramGroup = document.getElementById("val-price-gram-group");
    const pricePerGramSymbol = document.getElementById("val-pg-currency");
    const notesField = document.getElementById("val-notes");
    const dateField = document.getElementById("val-date");
    const currencySymbol = document.getElementById("val-currency-symbol");
    const titleElement = document.getElementById("modal-val-title");

    accountIdField.value = accountId;
    amountField.value = "";
    pricePerGramField.value = "";
    notesField.value = "";
    dateField.value = todayStr();
    if (titleElement) titleElement.textContent = isOpening ? "OPENING VALUE" : "UPDATE VALUE";
    this._valOpening = !!isOpening;

    DB.getById("accounts", accountId).then(async (account) => {
      const currency = account ? account.currency || "CHF" : "CHF";
      currencySymbol.textContent = currency;
      pricePerGramSymbol.textContent = currency;
      if (isOpening) {
        // Opening valuations are recorded for standard accounts; leave the
        // amount empty and pre-fill the marker note.
        pricePerGramGroup.style.display = "none";
        notesField.value = "OPENING VALUATION";
      } else if (account && account.accountType === "Precious Metal") {
        // Show price/gram and pre-fill from today's spot price
        pricePerGramGroup.style.display = "block";
        const quantity = account.quantity || 0;
        if (account.pricePerGram) pricePerGramField.value = account.pricePerGram;
        const todaysMetalPrices = await DB.getMetalPricesForDate(todayStr());
        const rateEntries = await DB.getAll("exchangeRates");
        const spotPrice = metalSpotPerGram(todaysMetalPrices, account.metalType, currency, rateEntries, todayStr());
        if (spotPrice != null) pricePerGramField.value = spotPrice;
        if (quantity > 0 && parseFloat(pricePerGramField.value) > 0) {
          amountField.value = (quantity * parseFloat(pricePerGramField.value)).toFixed(2);
        } else if (account.currentValue) {
          amountField.value = account.currentValue;
        }
      } else {
        pricePerGramGroup.style.display = "none";
        if (account && account.currentValue) amountField.value = account.currentValue;
      }
    });

    // Auto-compute total = quantity * price/gram
    pricePerGramField.oninput = () => {
      const pricePerGram = parseFloat(pricePerGramField.value);
      DB.getById("accounts", accountId).then((account) => {
        const quantity = account && account.quantity ? account.quantity : 0;
        if (pricePerGram > 0 && quantity > 0) {
          amountField.value = (pricePerGram * quantity).toFixed(2);
        }
      });
    };

    this._modals.valuation.show();
  },

  _showMetalModal(direction, accountId) {
    const title = document.getElementById("modal-metal-title");
    const accountIdField = document.getElementById("metal-account-id");
    const directionField = document.getElementById("metal-direction");
    const quantityField = document.getElementById("metal-qty");
    const priceField = document.getElementById("metal-price");
    const dateField = document.getElementById("metal-date");
    const notesField = document.getElementById("metal-notes");
    const totalElement = document.getElementById("metal-total");
    const currentQuantityElement = document.getElementById("metal-current-qty");
    const currencySymbol = document.getElementById("metal-currency-symbol");
    const priceSymbol = document.getElementById("metal-price-symbol");

    accountIdField.value = accountId;
    directionField.value = direction === "sell" ? "sell" : "buy";
    quantityField.value = "";
    priceField.value = "";
    notesField.value = "";
    dateField.value = todayStr();
    totalElement.textContent = "—";
    title.textContent = direction === "sell" ? "SELL METAL" : "BUY METAL";

    this._metalCurrency = "CHF";

    DB.getById("accounts", accountId).then(async (account) => {
      if (!account) return;
      this._metalCurrency = account.currency || "CHF";
      currencySymbol.textContent = this._metalCurrency;
      priceSymbol.textContent = this._metalCurrency + "/g";
      currentQuantityElement.textContent = (account.quantity || 0) + "g " + (account.metalType || "");
      if (account.pricePerGram) priceField.value = account.pricePerGram;
      if (direction === "sell") quantityField.value = account.quantity || 0;
      if (!priceField.value && account.metalType) {
        const todaysMetalPrices = await DB.getMetalPricesForDate(todayStr());
        const rateEntries = await DB.getAll("exchangeRates");
        const spotPrice = metalSpotPerGram(todaysMetalPrices, account.metalType, this._metalCurrency, rateEntries, todayStr());
        if (spotPrice != null) priceField.value = spotPrice;
      }
      this._updateMetalTotal();
    });

    const updateTotal = () => this._updateMetalTotal();
    quantityField.oninput = updateTotal;
    priceField.oninput = updateTotal;

    this._modals.metal.show();
  },

  _updateMetalTotal() {
    const quantity = parseFloat(document.getElementById("metal-qty").value);
    const pricePerGram = parseFloat(document.getElementById("metal-price").value);
    const totalElement = document.getElementById("metal-total");
    totalElement.textContent = quantity > 0 && pricePerGram > 0 ? formatCurrency(quantity * pricePerGram, this._metalCurrency) : "—";
  },

  async saveMetal() {
    const accountId = parseInt(document.getElementById("metal-account-id").value);
    const direction = document.getElementById("metal-direction").value;
    const quantity = parseFloat(document.getElementById("metal-qty").value);
    const pricePerGram = parseFloat(document.getElementById("metal-price").value);
    const date = document.getElementById("metal-date").value || todayStr();
    const notes = document.getElementById("metal-notes").value.trim();

    if (!quantity || quantity <= 0) {
      this.toast("ENTER A VALID QUANTITY");
      return;
    }
    if (!pricePerGram || pricePerGram <= 0) {
      this.toast("ENTER A VALID PRICE");
      return;
    }

    const account = await DB.getById("accounts", accountId);
    if (!account) {
      this.toast("ACCOUNT NOT FOUND");
      return;
    }

    if (direction === "sell" && quantity > (account.quantity || 0)) {
      this.toast("NOT ENOUGH METAL TO SELL");
      return;
    }

    const total = quantity * pricePerGram;
    // quantityAfter and balanceAfter are filled in by the replay below, which
    // also places a backdated trade correctly among the later ones.
    await DB.add("transactions", {
      accountId,
      type: direction,
      quantity,
      pricePerGram,
      amount: direction === "buy" ? total : -total,
      date,
      notes,
      createdAt: nowISO(),
    });
    await this._recomputeAccountBalances(accountId);

    this._modals.metal.hide();
    this.toast(direction === "buy" ? "METAL PURCHASED" : "METAL SOLD");
    this.route();
  },

  async _showAssetModal(accountId, assetId) {
    const account = await DB.getById("accounts", accountId);
    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || "CHF";
    const title = document.getElementById("modal-asset-title");
    if (title) title.textContent = assetId ? "EDIT ASSET" : "ADD ASSET";
    document.getElementById("asset-id").value = assetId || "";
    document.getElementById("asset-account-id").value = accountId;
    // Only Real Estate carries a mortgage
    document.getElementById("asset-debt").closest(".mb-3").style.display = account && account.accountType === "Real Estate" ? "" : "none";
    const currencyField = document.getElementById("asset-currency");
    currencyField.innerHTML = CURRENCIES.map((currency) => `<option value="${currency.code}">${currency.code} - ${currency.symbol}</option>`).join("");
    if (assetId) {
      const asset = await DB.getById("assets", assetId);
      if (asset) {
        document.getElementById("asset-name").value = asset.name || "";
        document.getElementById("asset-value").value = asset.purchaseValue != null ? asset.purchaseValue : "";
        document.getElementById("asset-depreciation").value = asset.depreciationPct != null ? asset.depreciationPct : "";
        document.getElementById("asset-ownership").value = asset.ownershipPct != null ? asset.ownershipPct : 100;
        document.getElementById("asset-debt").value = asset.debt != null ? asset.debt : "";
        document.getElementById("asset-date").value = asset.purchaseDate || todayStr();
        currencyField.value = asset.currency || (account && account.currency) || mainCurrency;
      }
    } else {
      document.getElementById("asset-name").value = "";
      document.getElementById("asset-value").value = "";
      document.getElementById("asset-depreciation").value = "";
      document.getElementById("asset-ownership").value = 100;
      document.getElementById("asset-debt").value = "";
      document.getElementById("asset-date").value = todayStr();
      currencyField.value = (account && account.currency) || mainCurrency;
    }
    this._modals.asset.show();
  },

  async saveAsset() {
    const assetId = parseInt(document.getElementById("asset-id").value) || 0;
    const accountId = parseInt(document.getElementById("asset-account-id").value);
    const name = document.getElementById("asset-name").value.trim();
    const purchaseValue = parseFloat(document.getElementById("asset-value").value);
    const debt = parseFloat(document.getElementById("asset-debt").value) || 0;
    const depreciationPercent = parseFloat(document.getElementById("asset-depreciation").value) || 0;
    const ownershipInput = parseFloat(document.getElementById("asset-ownership").value);
    const ownershipPercent = isNaN(ownershipInput) ? 100 : ownershipInput;
    const purchaseDate = document.getElementById("asset-date").value || todayStr();
    const currency = document.getElementById("asset-currency").value || "CHF";

    if (!name) {
      this.toast("NAME IS REQUIRED");
      return;
    }
    if (!purchaseValue || purchaseValue <= 0) {
      this.toast("ENTER A VALID VALUE");
      return;
    }
    if (isNaN(depreciationPercent) || depreciationPercent < -100 || depreciationPercent > 100) {
      this.toast("DEPRECIATION MUST BE BETWEEN -100 AND 100");
      return;
    }

    // Both the edit and the add paths need the account: its type is stamped on
    // the asset and its value is refreshed after the save.
    const account = await DB.getById("accounts", accountId);
    const rateEntries = await DB.getAll("exchangeRates");
    const rateToAccountCurrency = (assetCurrency, date) => currencyRateTo(rateEntries, assetCurrency || "CHF", (account && account.currency) || "CHF", date);

    if (assetId) {
      const asset = await DB.getById("assets", assetId);
      if (!asset) {
        this.toast("ASSET NOT FOUND");
        return;
      }
      asset.name = name;
      asset.purchaseValue = purchaseValue;
      asset.depreciationPct = depreciationPercent;
      asset.ownershipPct = ownershipPercent;
      asset.purchaseDate = purchaseDate;
      asset.currency = currency;
      asset.debt = debt;
      if (account && account.accountType) asset.accountType = account.accountType;
      await DB.put("assets", asset);

      const assetTransactions = await DB.getByIndex("transactions", "assetId", assetId);
      if (account) {
        const accountAssets = await DB.getByIndex("assets", "accountId", accountId);
        const metrics = assetAccountMetrics(accountAssets, purchaseDate, rateToAccountCurrency);
        const addTransaction = assetTransactions.find((transaction) => transaction.type === "asset-add");
        if (addTransaction) {
          addTransaction.amount = purchaseValue;
          addTransaction.date = purchaseDate;
          addTransaction.notes = "ASSET ADDED: " + name;
          addTransaction.balanceAfter = metrics.value;
          await DB.put("transactions", addTransaction);
        }
        await this._refreshAssetAccountValue(accountId);
      }
      if (asset.sold) {
        const sellTransaction = assetTransactions.find((transaction) => transaction.type === "asset-sell");
        if (sellTransaction && sellTransaction.notes !== "ASSET SOLD: " + name) {
          sellTransaction.notes = "ASSET SOLD: " + name;
          await DB.put("transactions", sellTransaction);
        }
      }

      this._modals.asset.hide();
      this.toast("ASSET UPDATED");
      this.route();
      return;
    }

    const asset = {
      accountId,
      name,
      purchaseValue,
      debt,
      depreciationPct: depreciationPercent,
      ownershipPct: ownershipPercent,
      purchaseDate,
      currency,
      accountType: account && account.accountType ? account.accountType : null,
      sold: false,
      saleValue: null,
      saleDate: null,
    };
    const newAssetId = await DB.add("assets", asset);

    if (account) {
      const accountAssets = await DB.getByIndex("assets", "accountId", accountId);
      await DB.add("transactions", {
        accountId,
        assetId: newAssetId,
        type: "asset-add",
        amount: purchaseValue,
        date: purchaseDate,
        notes: "ASSET ADDED: " + name,
        balanceAfter: assetAccountMetrics(accountAssets, purchaseDate, rateToAccountCurrency).value,
        createdAt: nowISO(),
      });
      await this._refreshAssetAccountValue(accountId);
    }

    this._modals.asset.hide();
    this.toast("ASSET ADDED");
    this.route();
  },

  async _showSellAssetModal(assetId) {
    const asset = await DB.getById("assets", assetId);
    if (!asset) return;
    document.getElementById("sell-asset-id").value = assetId;
    document.getElementById("sell-asset-name").textContent = asset.name || "—";
    document.getElementById("sell-asset-value").value = asset.sold ? asset.saleValue || "" : "";
    document.getElementById("sell-asset-date").value = asset.saleDate || todayStr();
    document.getElementById("sell-asset-currency").textContent = asset.currency || "CHF";
    this._modals.sellAsset.show();
  },

  async saveSellAsset() {
    const assetId = parseInt(document.getElementById("sell-asset-id").value);
    const saleValue = parseFloat(document.getElementById("sell-asset-value").value);
    const saleDate = document.getElementById("sell-asset-date").value || todayStr();

    if (!saleValue || saleValue < 0) {
      this.toast("ENTER A VALID SALE VALUE");
      return;
    }

    const asset = await DB.getById("assets", assetId);
    if (!asset) {
      this.toast("ASSET NOT FOUND");
      return;
    }
    if (asset.sold) {
      this.toast("ASSET ALREADY SOLD");
      return;
    }

    asset.sold = true;
    asset.saleValue = saleValue;
    asset.saleDate = saleDate;
    await DB.put("assets", asset);

    const account = await DB.getById("accounts", asset.accountId);
    if (account) {
      const accountAssets = await DB.getByIndex("assets", "accountId", asset.accountId);
      const rateEntries = await DB.getAll("exchangeRates");
      const rateToAccountCurrency = (assetCurrency, date) => currencyRateTo(rateEntries, assetCurrency || "CHF", account.currency || "CHF", date);
      await DB.add("transactions", {
        accountId: asset.accountId,
        assetId,
        type: "asset-sell",
        amount: saleValue,
        date: saleDate,
        notes: "ASSET SOLD: " + (asset.name || ""),
        balanceAfter: assetAccountMetrics(accountAssets, saleDate, rateToAccountCurrency).value,
        createdAt: nowISO(),
      });
      await this._refreshAssetAccountValue(asset.accountId);
    }

    this._modals.sellAsset.hide();
    this.toast("ASSET SOLD");
    this.route();
  },

  async deleteAsset(id) {
    const confirmed = await this.confirm("DELETE ASSET?", "Remove this asset and its transactions?");
    if (!confirmed) return;

    const asset = await DB.getById("assets", id);
    if (!asset) return;

    const assetTransactions = await DB.getByIndex("transactions", "assetId", id);
    for (const transaction of assetTransactions) {
      await DB.del("transactions", transaction.id);
    }
    await DB.del("assets", id);
    await this._refreshAssetAccountValue(asset.accountId);

    this.toast("ASSET DELETED");
    this.route();
  },

  // Tangible Asset and Real Estate accounts store today's value of their assets
  async _refreshAssetAccountValue(accountId) {
    const account = await DB.getById("accounts", accountId);
    if (!account) return;
    const accountAssets = await DB.getByIndex("assets", "accountId", accountId);
    const rateEntries = await DB.getAll("exchangeRates");
    const rateToAccountCurrency = (assetCurrency, date) => currencyRateTo(rateEntries, assetCurrency || "CHF", account.currency || "CHF", date);
    account.currentValue = assetAccountMetrics(accountAssets, todayStr(), rateToAccountCurrency).value;
    await DB.put("accounts", account);
  },

  // ==================== REAL ESTATE VALUATIONS ====================
  // A valuation is the property's full market value (100% ownership, before
  // the mortgage) on a date; see assetFullValue() in utils.js for how it is used.

  async showAssetValuations(assetId) {
    const asset = await DB.getById("assets", assetId);
    if (!asset) return;
    document.getElementById("asset-valuation-asset-id").value = asset.id;
    document.getElementById("asset-valuation-name").textContent = asset.name || "—";
    document.getElementById("asset-valuation-currency").textContent = asset.currency || "CHF";
    document.getElementById("asset-valuation-value").value = "";
    document.getElementById("asset-valuation-date").value = todayStr();
    this._renderAssetValuationList(asset);
    this._modals.assetValuation.show();
  },

  _renderAssetValuationList(asset) {
    const list = document.getElementById("asset-valuation-list");
    const valuations = (asset.valuations || []).filter((valuation) => isIsoDate(valuation.date)).sort((first, second) => second.date.localeCompare(first.date));
    list.innerHTML = valuations.length
      ? valuations
          .map(
            (valuation) =>
              "<tr><td>" +
              formatDate(valuation.date) +
              "</td><td>" +
              formatCurrency(parseFloat(valuation.value) || 0, asset.currency) +
              '</td><td class="text-end"><a class="tx-link" onclick="App.deleteAssetValuation(this, ' +
              Number(asset.id) +
              ", '" +
              valuation.date +
              "')\">DELETE</a></td></tr>"
          )
          .join("")
      : '<tr><td colspan="3" class="text-muted">NO VALUATIONS YET: THE PURCHASE VALUE IS USED.</td></tr>';
  },

  async saveAssetValuation() {
    const assetId = parseInt(document.getElementById("asset-valuation-asset-id").value);
    const date = document.getElementById("asset-valuation-date").value;
    const value = parseFloat(document.getElementById("asset-valuation-value").value);

    if (!isIsoDate(date)) {
      this.toast("ENTER A VALID DATE");
      return;
    }
    if (isNaN(value) || value < 0) {
      this.toast("ENTER A VALID VALUE");
      return;
    }
    const asset = await DB.getById("assets", assetId);
    if (!asset) {
      this.toast("ASSET NOT FOUND");
      return;
    }
    if (asset.purchaseDate && date < asset.purchaseDate) {
      this.toast("THE VALUATION DATE IS BEFORE THE PURCHASE DATE");
      return;
    }

    // One valuation per date: a new one on the same date replaces the old one
    asset.valuations = (asset.valuations || []).filter((valuation) => valuation.date !== date).concat({ date, value });
    await DB.put("assets", asset);
    await this._refreshAssetAccountValue(asset.accountId);

    this._modals.assetValuation.hide();
    this.toast("PROPERTY VALUE UPDATED");
    this.route();
  },

  // Deleting takes two clicks on the same link, so a stray click cannot remove a
  // valuation (a confirm dialog cannot open on top of this one).
  async deleteAssetValuation(link, assetId, date) {
    if (link.dataset.armed !== "true") {
      link.dataset.armed = "true";
      link.textContent = "CLICK AGAIN TO DELETE";
      return;
    }
    const asset = await DB.getById("assets", assetId);
    if (!asset) return;
    asset.valuations = (asset.valuations || []).filter((valuation) => valuation.date !== date);
    await DB.put("assets", asset);
    await this._refreshAssetAccountValue(asset.accountId);
    this._renderAssetValuationList(asset);
    this.route();
  },

  async _showIncomeModal(editId) {
    const title = document.getElementById("modal-income-title");
    const idField = document.getElementById("income-id");
    const monthField = document.getElementById("income-month-field");
    const sourceField = document.getElementById("income-source");
    const amountField = document.getElementById("income-amount");
    const currencyField = document.getElementById("income-currency");
    const dateField = document.getElementById("income-date");
    const notesField = document.getElementById("income-notes");

    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || "CHF";
    currencyField.innerHTML = CURRENCIES.map((currency) => `<option value="${currency.code}">${currency.code} - ${currency.symbol}</option>`).join("");

    if (editId) {
      title.textContent = "EDIT INCOME";
      DB.getById("incomes", editId).then((income) => {
        if (!income) return;
        idField.value = income.id;
        monthField.value = income.month || "";
        sourceField.value = income.source || "";
        amountField.value = income.amount || "";
        currencyField.value = income.currency || mainCurrency;
        dateField.value = income.date || "";
        notesField.value = income.notes || "";
        this._modals.income.show();
      });
    } else {
      title.textContent = "NEW INCOME";
      idField.value = "";
      monthField.value = todayStr().substring(0, 7);
      sourceField.value = "";
      amountField.value = "";
      currencyField.value = mainCurrency;
      dateField.value = todayStr();
      notesField.value = "";
      this._modals.income.show();
    }
  },

  async _showExpenseModal(editId) {
    const title = document.getElementById("modal-expense-title");
    const idField = document.getElementById("expense-id");
    const textField = document.getElementById("expense-text");
    const amountField = document.getElementById("expense-amount");
    const currencyField = document.getElementById("expense-currency");
    const typeField = document.getElementById("expense-type");
    const yearField = document.getElementById("expense-year");
    const notesField = document.getElementById("expense-notes");
    const monthGroup = document.getElementById("expense-month-group");
    const monthField = document.getElementById("expense-month");

    const settings = await DB.getSettings();
    const mainCurrency = settings.mainCurrency || "CHF";
    currencyField.innerHTML = CURRENCIES.map((currency) => `<option value="${currency.code}">${currency.code} - ${currency.symbol}</option>`).join("");

    // This year and the 10 before it
    const currentYear = new Date().getFullYear();
    yearField.innerHTML = "";
    for (let year = currentYear; year >= currentYear - 10; year--) {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      yearField.appendChild(option);
    }

    const toggleMonth = () => {
      monthGroup.style.display = typeField.value === "yearly" ? "" : "none";
    };
    typeField.onchange = toggleMonth;

    if (editId) {
      title.textContent = "EDIT EXPENSE";
      DB.getById("expenses", editId).then((expense) => {
        if (!expense) return;
        idField.value = expense.id;
        textField.value = expense.text || "";
        amountField.value = expense.amount || "";
        currencyField.value = expense.currency || mainCurrency;
        typeField.value = expense.type || "monthly";
        yearField.value = expense.year || String(currentYear);
        monthField.value = expense.paymentMonth || "";
        notesField.value = expense.notes || "";
        toggleMonth();
        this._modals.expense.show();
      });
    } else {
      title.textContent = "NEW EXPENSE";
      idField.value = "";
      textField.value = "";
      amountField.value = "";
      currencyField.value = mainCurrency;
      typeField.value = "monthly";
      yearField.value = String(currentYear);
      monthField.value = "";
      notesField.value = "";
      toggleMonth();
      this._modals.expense.show();
    }
  },

  _showDebtModal(editId) {
    const title = document.getElementById("modal-debt-title");
    const idField = document.getElementById("debt-id");
    const descriptionField = document.getElementById("debt-description");
    const personField = document.getElementById("debt-person");
    const directionField = document.getElementById("debt-direction");
    const amountField = document.getElementById("debt-amount");
    const dateField = document.getElementById("debt-date");
    const notesField = document.getElementById("debt-notes");

    if (editId) {
      title.textContent = "EDIT DEBT";
      DB.getById("debts", editId).then((debt) => {
        if (!debt) return;
        idField.value = debt.id;
        descriptionField.value = debt.description || "";
        personField.value = debt.person || "";
        directionField.value = debt.direction || "out";
        amountField.value = debt.amount || "";
        dateField.value = debt.date || todayStr();
        notesField.value = debt.notes || "";
        this._modals.debt.show();
      });
    } else {
      title.textContent = "ADD DEBT";
      idField.value = "";
      descriptionField.value = "";
      personField.value = "";
      directionField.value = "out";
      amountField.value = "";
      dateField.value = todayStr();
      notesField.value = "";
      this._modals.debt.show();
    }
  },

  _showGoalModal(editId) {
    const title = document.getElementById("modal-goal-title");
    const idField = document.getElementById("goal-id");
    const nameField = document.getElementById("goal-name");
    const targetField = document.getElementById("goal-target");
    const orderField = document.getElementById("goal-order");
    const allocationsContainer = document.getElementById("goal-allocations");

    const populate = (goal) => {
      title.textContent = goal ? "EDIT GOAL" : "NEW GOAL";
      idField.value = goal ? goal.id : "";
      nameField.value = goal ? goal.name || "" : "";
      targetField.value = goal ? goal.target || "" : "";
      orderField.value = goal ? (goal.order != null ? goal.order : "") : "";
      allocationsContainer.innerHTML = "";
      const allocations = goal && goal.allocations ? goal.allocations : [];
      if (allocations.length === 0) {
        this.addGoalAllocationRow();
      } else {
        allocations.forEach((allocation) => this.addGoalAllocationRow(allocation.accountId, allocation.pct));
      }
      this._modals.goal.show();
    };

    if (editId) {
      DB.getById("goals", editId).then((goal) => {
        if (goal) populate(goal);
      });
    } else {
      DB.getAll("goals").then((goals) => {
        const highestOrder = goals.reduce((highest, goal) => Math.max(highest, goal.order != null ? goal.order : 0), 0);
        populate(null);
        orderField.value = highestOrder + 1;
      });
    }
  },

  async addGoalAllocationRow(accountId, percent) {
    const accounts = await DB.getAll("accounts");
    const container = document.getElementById("goal-allocations");
    const row = document.createElement("div");
    row.className = "d-flex gap-2 mb-2 align-items-center";
    const accountOptions = accounts.map((account) => `<option value="${Number(account.id)}" ${Number(account.id) === Number(accountId) ? "selected" : ""}>${escapeHtml(account.name)}</option>`).join("");
    row.innerHTML =
      '<select class="form-select form-gta goal-alloc-account" style="flex:1">' +
      accountOptions +
      "</select>" +
      '<input type="number" min="0" max="100" step="1" class="form-control form-gta goal-alloc-pct" style="width:90px" placeholder="%" value="' +
      escapeHtml(percent != null ? percent : 100) +
      '" />' +
      '<span class="tx-link" style="cursor:pointer" title="USE EARLIER" onclick="App.moveGoalAllocationRow(this, -1)">UP</span>' +
      '<span class="tx-link" style="cursor:pointer" title="USE LATER" onclick="App.moveGoalAllocationRow(this, 1)">DOWN</span>' +
      '<span class="tx-link" style="cursor:pointer" onclick="this.parentElement.remove()">REMOVE</span>';
    container.appendChild(row);
  },

  // Moves an allocation row up (-1) or down (+1): rows higher up are used first
  moveGoalAllocationRow(link, direction) {
    const row = link.parentElement;
    const container = row.parentElement;
    const rows = [...container.children];
    const targetIndex = rows.indexOf(row) + direction;
    if (targetIndex < 0 || targetIndex >= rows.length) return;
    if (direction < 0) container.insertBefore(row, rows[targetIndex]);
    else container.insertBefore(rows[targetIndex], row);
  },

  // ==================== SAVE METHODS ====================

  async saveCustodian() {
    const id = document.getElementById("custodian-id").value;
    const name = document.getElementById("custodian-name").value.trim();
    if (!name) {
      this.toast("NAME IS REQUIRED");
      return;
    }
    const data = {
      name,
      notes: document.getElementById("custodian-notes").value.trim(),
    };
    if (id) {
      data.id = parseInt(id);
      await DB.put("custodians", data);
    } else {
      await DB.add("custodians", data);
    }
    this._modals.custodian.hide();
    this.toast("CUSTODIAN SAVED");
    this.route();
  },

  async savePortfolio() {
    const id = document.getElementById("portfolio-id").value;
    const name = document.getElementById("portfolio-name").value.trim();
    if (!name) {
      this.toast("NAME IS REQUIRED");
      return;
    }
    const data = {
      name,
      description: document.getElementById("portfolio-desc").value.trim(),
      createdAt: nowISO(),
    };
    if (id) {
      data.id = parseInt(id);
      await DB.put("portfolios", data);
    } else {
      await DB.add("portfolios", data);
    }
    this._modals.portfolio.hide();
    this.toast("PORTFOLIO SAVED");
    this.route();
  },

  async saveAccount() {
    const id = document.getElementById("account-id").value;
    const portfolioId = document.getElementById("account-pfid").value;
    const name = document.getElementById("account-name").value.trim();
    if (!name) {
      this.toast("NAME IS REQUIRED");
      return;
    }
    if (!portfolioId) {
      this.toast("PORTFOLIO ID MISSING");
      return;
    }
    const data = {
      portfolioId: parseInt(portfolioId),
      name,
      custodianId: parseInt(document.getElementById("account-custodian").value) || null,
      currency: document.getElementById("account-currency").value || "CHF",
      notes: document.getElementById("account-notes").value.trim(),
      trackPerformance: document.getElementById("account-track-perf").checked,
      includeInNetWorth: document.getElementById("account-include-nw").checked,
      includeInLiquidNetWorth: document.getElementById("account-include-liq").checked,
      accountType: document.getElementById("account-type").value || "Cash Account",
      metalType: document.getElementById("account-metal").value || "",
      quantity: parseFloat(document.getElementById("account-qty").value) || 0,
      currentValue: 0,
    };

    const isNew = !id;
    const accountType = document.getElementById("account-type").value;
    const hasStartingValue = isNew && accountType !== "Tangible Asset" && accountType !== "Real Estate";
    const startingValue = hasStartingValue ? parseFloat(document.getElementById("account-starting-value").value) || 0 : 0;
    const startingContribution = hasStartingValue ? parseFloat(document.getElementById("account-starting-contrib").value) || 0 : 0;
    const startingDate = isNew ? document.getElementById("account-starting-date").value || todayStr() : todayStr();

    if (id) {
      data.id = parseInt(id);
      const previousAccount = await DB.getById("accounts", data.id);
      data.currentValue = previousAccount ? previousAccount.currentValue || 0 : 0;
      data.pricePerGram = previousAccount ? previousAccount.pricePerGram || 0 : 0;
      // The quantity field is the current holding: a change shifts the quantity
      // held before the first recorded trade by the same amount.
      if (previousAccount && previousAccount.openingQuantity != null) {
        data.openingQuantity = Math.max(0, previousAccount.openingQuantity + (data.quantity - (previousAccount.quantity || 0)));
      }
      await DB.put("accounts", data);
      await this._recomputeAccountBalances(data.id);
    } else {
      data.currentValue = 0;
      data.pricePerGram = 0;
      if (data.accountType === "Precious Metal") data.openingQuantity = data.quantity;
      const accountId = await DB.add("accounts", data);
      if (startingValue > 0) {
        // Opening balance split: contributed portion is a deposit, the rest is opening performance.
        const isSplit = startingContribution > 0 && startingContribution < startingValue;
        const createdAt = nowISO();
        if (isSplit) {
          await DB.add("transactions", {
            accountId,
            type: "deposit",
            amount: startingContribution,
            date: startingDate,
            notes: "OPENING CONTRIBUTION",
            balanceAfter: startingContribution,
            createdAt,
          });
        }
        const openingValuation = {
          accountId,
          type: "valuation",
          amount: startingValue,
          date: startingDate,
          notes: "OPENING VALUATION",
          opening: true,
          balanceAfter: startingValue,
          createdAt: isSplit ? nowISO() : createdAt,
        };
        if (data.accountType === "Precious Metal" && (data.quantity || 0) > 0) {
          const derivedPricePerGram = startingValue / data.quantity;
          data.pricePerGram = derivedPricePerGram;
          openingValuation.pricePerGram = derivedPricePerGram;
        }
        await DB.add("transactions", openingValuation);
        data.currentValue = startingValue;
        await DB.put("accounts", data);
        await this._recomputeAccountBalances(accountId);
      }
    }
    this._modals.account.hide();
    this.toast("ACCOUNT SAVED");
    this.route();
  },

  async saveTransaction() {
    const accountId = parseInt(document.getElementById("tx-account-id").value);
    const type = document.getElementById("tx-type").value;
    const amount = parseFloat(document.getElementById("tx-amount").value);
    const notes = document.getElementById("tx-notes").value.trim();
    const date = document.getElementById("tx-date").value || todayStr();

    if (!amount || amount <= 0) {
      this.toast("ENTER A VALID AMOUNT");
      return;
    }

    const account = await DB.getById("accounts", accountId);
    if (!account) {
      this.toast("ACCOUNT NOT FOUND");
      return;
    }

    const signedAmount = type === "withdrawal" ? -amount : amount;
    const balanceAfter = (account.currentValue || 0) + signedAmount;

    await DB.add("transactions", {
      accountId,
      type,
      amount: signedAmount,
      date,
      notes,
      balanceAfter,
      createdAt: nowISO(),
    });

    account.currentValue = balanceAfter;
    await DB.put("accounts", account);
    await this._recomputeAccountBalances(accountId);

    this._modals.transaction.hide();
    this.toast((type === "deposit" ? "DEPOSIT" : "WITHDRAWAL") + " RECORDED");
    this.route();
  },

  async saveValuation() {
    const accountId = parseInt(document.getElementById("val-account-id").value);
    const amount = parseFloat(document.getElementById("val-amount").value);
    const notes = document.getElementById("val-notes").value.trim();
    const date = document.getElementById("val-date").value || todayStr();
    const isOpening = !!this._valOpening;

    if (isNaN(amount) || amount < 0) {
      this.toast("ENTER A VALID VALUE");
      return;
    }

    const account = await DB.getById("accounts", accountId);
    if (!account) {
      this.toast("ACCOUNT NOT FOUND");
      return;
    }

    const pricePerGram = parseFloat(document.getElementById("val-price-gram").value);
    const transactionData = {
      accountId,
      type: "valuation",
      amount,
      date,
      notes: isOpening ? "OPENING VALUATION" : notes,
      balanceAfter: amount,
      createdAt: nowISO(),
    };
    if (isOpening) transactionData.opening = true;

    if (account.accountType === "Precious Metal") {
      const quantity = account.quantity || 0;
      if (quantity > 0) {
        const derivedPricePerGram = pricePerGram > 0 ? pricePerGram : amount / quantity;
        if (derivedPricePerGram > 0) {
          account.pricePerGram = derivedPricePerGram;
          transactionData.pricePerGram = derivedPricePerGram;
        }
      }
    } else if (pricePerGram > 0) {
      transactionData.pricePerGram = pricePerGram;
    }
    await DB.add("transactions", transactionData);
    this._valOpening = false;

    account.currentValue = amount;
    await DB.put("accounts", account);
    await this._recomputeAccountBalances(accountId);

    this._modals.valuation.hide();
    this.toast(isOpening ? "OPENING VALUE RECORDED" : "VALUE UPDATED");
    this.route();
  },

  async saveIncome() {
    const id = document.getElementById("income-id").value;
    const date = document.getElementById("income-date").value;
    const month = date ? date.substring(0, 7) : document.getElementById("income-month-field").value;
    const source = document.getElementById("income-source").value.trim();
    const amount = parseFloat(document.getElementById("income-amount").value);
    const notes = document.getElementById("income-notes").value.trim();

    if (!source) {
      this.toast("SOURCE IS REQUIRED");
      return;
    }
    if (!amount || amount <= 0) {
      this.toast("ENTER A VALID AMOUNT");
      return;
    }

    const data = { month, source, amount, date, notes, currency: document.getElementById("income-currency").value || "CHF" };
    if (id) {
      data.id = parseInt(id);
      await DB.put("incomes", data);
    } else {
      await DB.add("incomes", data);
    }

    this._modals.income.hide();
    this.toast("INCOME SAVED");
    this.route();
  },

  async saveExpense() {
    const id = document.getElementById("expense-id").value;
    const text = document.getElementById("expense-text").value.trim();
    const amount = parseFloat(document.getElementById("expense-amount").value);
    const type = document.getElementById("expense-type").value;
    const year = document.getElementById("expense-year").value;
    const notes = document.getElementById("expense-notes").value.trim();
    const paymentMonth = type === "yearly" ? document.getElementById("expense-month").value || null : null;

    if (!text) {
      this.toast("TEXT IS REQUIRED");
      return;
    }
    if (!amount || amount <= 0) {
      this.toast("ENTER A VALID AMOUNT");
      return;
    }

    const data = { text, amount, type, year, notes, currency: document.getElementById("expense-currency").value || "CHF", paymentMonth };
    if (id) {
      data.id = parseInt(id);
      await DB.put("expenses", data);
    } else {
      await DB.add("expenses", data);
    }

    this._modals.expense.hide();
    this.toast("EXPENSE SAVED");
    this.route();
  },

  async deleteExpense(id) {
    const confirmed = await this.confirm("DELETE EXPENSE?", "Remove this expense entry?");
    if (!confirmed) return;
    await DB.del("expenses", id);
    this.toast("EXPENSE DELETED");
    this.route();
  },

  async deleteIncome(id) {
    const confirmed = await this.confirm("DELETE INCOME?", "Remove this income entry?");
    if (!confirmed) return;
    await DB.del("incomes", id);
    this.toast("INCOME DELETED");
    this.route();
  },

  async saveDebt() {
    const id = document.getElementById("debt-id").value;
    const description = document.getElementById("debt-description").value.trim();
    const person = document.getElementById("debt-person").value.trim();
    const direction = document.getElementById("debt-direction").value;
    const amount = parseFloat(document.getElementById("debt-amount").value);
    const date = document.getElementById("debt-date").value || todayStr();
    const notes = document.getElementById("debt-notes").value.trim();

    if (!description) {
      this.toast("DESCRIPTION IS REQUIRED");
      return;
    }
    if (!amount || amount <= 0) {
      this.toast("ENTER A VALID AMOUNT");
      return;
    }

    const data = { description, person, direction, amount, date, notes };
    if (id) {
      data.id = parseInt(id);
      await DB.put("debts", data);
    } else {
      await DB.add("debts", data);
    }

    this._modals.debt.hide();
    this.toast("DEBT SAVED");
    this.route();
  },

  async deleteDebt(id) {
    const confirmed = await this.confirm("DELETE DEBT?", "Remove this debt entry?");
    if (!confirmed) return;
    await DB.del("debts", id);
    this.toast("DEBT DELETED");
    this.route();
  },

  async saveGoal() {
    const id = document.getElementById("goal-id").value;
    const name = document.getElementById("goal-name").value.trim();
    const target = parseFloat(document.getElementById("goal-target").value);
    const order = parseInt(document.getElementById("goal-order").value);

    if (!name) {
      this.toast("NAME IS REQUIRED");
      return;
    }
    if (!target || target <= 0) {
      this.toast("ENTER A VALID TARGET");
      return;
    }

    const allocations = [];
    document.querySelectorAll("#goal-allocations .goal-alloc-account").forEach((sel) => {
      const row = sel.closest("div");
      const pct = parseFloat(row.querySelector(".goal-alloc-pct").value);
      allocations.push({ accountId: parseInt(sel.value), pct: isNaN(pct) ? 100 : pct });
    });

    const data = { name, target, allocations, order: isNaN(order) ? 1 : order };
    if (id) {
      data.id = parseInt(id);
      await DB.put("goals", data);
    } else {
      await DB.add("goals", data);
    }

    this._modals.goal.hide();
    this.toast("GOAL SAVED");
    this.route();
  },

  async deleteGoal(id) {
    const confirmed = await this.confirm("DELETE GOAL?", "Remove this goal?");
    if (!confirmed) return;
    await DB.del("goals", id);
    this.toast("GOAL DELETED");
    this.route();
  },

  // Swaps the goal's priority with its neighbour above (-1) or below (+1)
  async moveGoal(id, direction) {
    const ordered = Pages._sortGoalsByPriority(await DB.getAll("goals"));
    const index = ordered.findIndex((goal) => Number(goal.id) === Number(id));
    if (index < 0) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= ordered.length) return;

    const goal = ordered[index];
    const neighbour = ordered[targetIndex];
    const goalOrder = goal.order != null ? goal.order : index + 1;
    const neighbourOrder = neighbour.order != null ? neighbour.order : targetIndex + 1;
    goal.order = neighbourOrder;
    neighbour.order = goalOrder;
    await DB.put("goals", goal);
    await DB.put("goals", neighbour);
    this.toast("GOAL REORDERED");
    this.route();
  },

  // ==================== DELETE ====================

  // Removes an account with all its transactions and assets
  async _deleteAccountWithHistory(accountId) {
    for (const transaction of await DB.getByIndex("transactions", "accountId", accountId)) {
      await DB.del("transactions", transaction.id);
    }
    for (const asset of await DB.getByIndex("assets", "accountId", accountId)) {
      await DB.del("assets", asset.id);
    }
    await DB.del("accounts", accountId);
  },

  async deleteAccount(id) {
    id = parseInt(id);
    if (!id) return;
    const confirmed = await this.confirm("DELETE ACCOUNT?", "This will also delete all transactions for this account. Are you sure?");
    if (!confirmed) return;
    this._modals.account.hide();
    await this._deleteAccountWithHistory(id);
    this.toast("ACCOUNT DELETED");
    this.navigate(this.currentPfId ? "portfolio-detail?id=" + this.currentPfId : "portfolios");
  },

  async deletePortfolio(id) {
    id = parseInt(id);
    if (!id) return;
    const accounts = (await DB.getAll("accounts")).filter((account) => Number(account.portfolioId) === Number(id));
    const message = accounts.length > 0 ? "This will also delete " + pluralize(accounts.length, "ACCOUNT") + " with all their transactions. Are you sure?" : "Remove this portfolio?";
    const confirmed = await this.confirm("DELETE PORTFOLIO?", message);
    if (!confirmed) return;
    this._modals.portfolio.hide();
    for (const account of accounts) {
      await this._deleteAccountWithHistory(account.id);
    }
    await DB.del("portfolios", id);
    this.toast("PORTFOLIO DELETED");
    this.navigate("portfolios");
  },

  // ==================== EDIT TRANSACTION ====================

  async showEditTransaction(id) {
    const transaction = await DB.getById("transactions", id);
    if (!transaction) return;
    if (transaction.type === "asset-add" || transaction.type === "asset-sell") {
      this.toast("EDIT THE ASSET INSTEAD");
      return;
    }

    const isMetalTrade = transaction.type === "buy" || transaction.type === "sell";
    document.getElementById("txedit-id").value = transaction.id;
    document.getElementById("txedit-type").textContent = isOpeningValuation(transaction) ? "OPENING VALUATION" : transaction.type.toUpperCase();
    document.getElementById("txedit-amount-group").style.display = isMetalTrade ? "none" : "";
    document.getElementById("txedit-metal-group").style.display = isMetalTrade ? "" : "none";

    const account = await DB.getById("accounts", transaction.accountId);
    const currency = account ? account.currency || "CHF" : "CHF";
    document.getElementById("txedit-currency-symbol").textContent = currency;
    document.getElementById("txedit-price-symbol").textContent = currency + "/g";

    if (isMetalTrade) {
      document.getElementById("txedit-qty").value = transaction.quantity || 0;
      document.getElementById("txedit-price").value = transaction.pricePerGram || "";
    } else {
      document.getElementById("txedit-amount").value = Math.abs(transaction.amount || 0);
    }
    document.getElementById("txedit-notes").value = transaction.notes || "";
    document.getElementById("txedit-date").value = transaction.date || todayStr();

    this._modals.txEdit.show();
  },

  async saveTransactionEdit() {
    const id = parseInt(document.getElementById("txedit-id").value);
    const transaction = await DB.getById("transactions", id);
    if (!transaction) return;
    const account = await DB.getById("accounts", transaction.accountId);
    if (!account) {
      this.toast("ACCOUNT NOT FOUND");
      return;
    }

    const date = document.getElementById("txedit-date").value || todayStr();
    const notes = document.getElementById("txedit-notes").value.trim();
    const isMetalTrade = transaction.type === "buy" || transaction.type === "sell";

    if (isMetalTrade) {
      const quantity = parseFloat(document.getElementById("txedit-qty").value);
      const pricePerGram = parseFloat(document.getElementById("txedit-price").value);
      if (!quantity || quantity <= 0) {
        this.toast("ENTER A VALID QUANTITY");
        return;
      }
      if (!pricePerGram || pricePerGram <= 0) {
        this.toast("ENTER A VALID PRICE");
        return;
      }
      transaction.quantity = quantity;
      transaction.pricePerGram = pricePerGram;
      transaction.amount = transaction.type === "buy" ? quantity * pricePerGram : -(quantity * pricePerGram);
    } else {
      const amount = parseFloat(document.getElementById("txedit-amount").value);
      if (isNaN(amount) || amount <= 0) {
        this.toast("ENTER A VALID AMOUNT");
        return;
      }
      transaction.amount = transaction.type === "withdrawal" ? -amount : amount;
      if (account.accountType === "Precious Metal" && transaction.type === "valuation" && (account.quantity || 0) > 0) {
        transaction.pricePerGram = amount / account.quantity;
      }
    }
    transaction.date = date;
    // keep the OPENING VALUATION marker intact so performance math stays correct
    if (!isOpeningValuation(transaction)) transaction.notes = notes;

    await DB.put("transactions", transaction);

    // full recalc across all portfolios/accounts so every derived value stays
    // consistent (precious metals replay their quantities there too)
    await this._recomputeAllBalances();

    this._modals.txEdit.hide();
    this.toast("TRANSACTION UPDATED");
    this.route();
  },

  async deleteTransaction(id) {
    const confirmed = await this.confirm("DELETE TRANSACTION?", "This will remove this transaction from the history.");
    if (!confirmed) return;

    const transaction = await DB.getById("transactions", id);
    if (!transaction) return;
    const account = await DB.getById("accounts", transaction.accountId);
    // Tangible asset events do not change the computed account value, and
    // precious metals are fully replayed below.
    const isAssetEvent = transaction.type === "asset-add" || transaction.type === "asset-sell";
    if (account && !isAssetEvent && account.accountType !== "Precious Metal") {
      // Revert the account value; the replay below recomputes it when other transactions remain
      account.currentValue = (account.currentValue || 0) - transaction.amount;
      await DB.put("accounts", account);
    }
    await DB.del("transactions", id);
    await this._recomputeAccountBalances(transaction.accountId);
    this.toast("TRANSACTION DELETED");
    this.route();
  },

  // Resolves true on YES, false when the dialog is closed any other way
  confirm(title, message) {
    return new Promise((resolve) => {
      document.getElementById("confirm-title").textContent = title;
      document.getElementById("confirm-msg").textContent = message;
      const yesButton = document.getElementById("confirm-yes");
      const modalElement = document.getElementById("modal-confirm");
      let answered = false;
      const onYes = () => {
        if (answered) return;
        answered = true;
        yesButton.removeEventListener("click", onYes);
        this._modals.confirm.hide();
        resolve(true);
      };
      const onClosed = () => {
        if (answered) return;
        answered = true;
        yesButton.removeEventListener("click", onYes);
        resolve(false);
      };
      yesButton.addEventListener("click", onYes);
      modalElement.addEventListener("hidden.bs.modal", onClosed, { once: true });
      this._modals.confirm.show();
    });
  },

  // ==================== EXPORT / IMPORT ====================

  async saveFile() {
    try {
      const kind = await DB.saveFile();
      this.toast(kind === "classic" ? "FILE DOWNLOADED" : "FILE SAVED TO FOLDER");
    } catch (error) {
      this.toast("SAVE FAILED: " + error.message);
    }
  },

  async exportData() {
    const data = await DB.exportAll();
    const baseName = (DB.currentFile || "liberty-finance").replace(/\.json$/i, "");
    Storage.download(baseName + "-backup-" + todayStr() + ".json", JSON.stringify(data, null, 2));
    this.toast("DATA EXPORTED");
  },

  importData() {
    document.getElementById("import-json").value = "";
    this._modals.importModal.show();
  },

  async doImport() {
    const json = document.getElementById("import-json").value.trim();
    if (!json) {
      this.toast("PASTE YOUR JSON DATA FIRST");
      return;
    }
    try {
      const data = JSON.parse(json);
      if (!data.custodians || !data.portfolios || !data.accounts || !data.transactions) {
        this.toast("INVALID BACKUP FORMAT");
        return;
      }
      await DB.importAll(data);
      this._modals.importModal.hide();
      this.toast("DATA IMPORTED SUCCESSFULLY");
      this.route();
    } catch (error) {
      this.toast("INVALID JSON: " + error.message);
    }
  },

  // ==================== PERFORMANCE TOGGLE ====================

  async toggleFlag(event, accountId, field, checked) {
    event.stopPropagation();
    const account = await DB.getById("accounts", accountId);
    if (account) {
      account[field] = checked;
      await DB.put("accounts", account);
    }
  },

  // ==================== BALANCE REPLAY ====================

  // Recomputes the running balance for a cash-like account by replaying its
  // transactions in chronological order. Fixes out-of-order backfills, where the
  // stored balanceAfter was snapshotted against the account's current value and
  // is therefore wrong for historical dates (e.g. an old deposit inheriting the
  // latest balance).
  async _recomputeAccountBalances(accountId) {
    const account = await DB.getById("accounts", accountId);
    if (!account) return;
    const type = account.accountType;
    if (type === ACCOUNT_TYPE.preciousMetal) return this._recomputeMetalAccount(account);
    if (isAssetAccount(account)) return; // valued from its assets
    const flowTypes = ["deposit", "withdrawal", "valuation", "buy", "sell"];
    const transactions = (await DB.getByIndex("transactions", "accountId", accountId)).filter((transaction) => flowTypes.includes(transaction.type)).sort((first, second) => (first.date || "").localeCompare(second.date || ""));
    if (transactions.length === 0) return;

    let balance = 0;
    for (let index = 0; index < transactions.length; index++) {
      const transaction = transactions[index];
      const absoluteAmount = Math.abs(transaction.amount || 0);
      if (index === 0) {
        // Seed with the opening level. A first deposit/buy has nothing before it,
        // so the balance equals the amount itself (avoids inheriting a wrong
        // snapshot from an out-of-order entry). A first valuation carries its own value.
        if (transaction.type === "deposit" || transaction.type === "buy") balance = absoluteAmount;
        else balance = transaction.balanceAfter != null ? transaction.balanceAfter : transaction.amount != null ? transaction.amount : 0;
      } else if (transaction.type === "deposit" || transaction.type === "buy") {
        balance += absoluteAmount;
      } else if (transaction.type === "withdrawal" || transaction.type === "sell") {
        balance -= absoluteAmount;
      } else if (transaction.type === "valuation") {
        balance = transaction.amount != null ? transaction.amount : balance;
      }
      if (transaction.balanceAfter !== balance) {
        transaction.balanceAfter = balance;
        await DB.put("transactions", transaction);
      }
    }

    if ((account.currentValue || 0) !== balance) {
      account.currentValue = balance;
      await DB.put("accounts", account);
    }
  },

  // Precious metals: replays buys, sells and valuations in date order, so each
  // transaction's quantity and balance and the account's holding stay right
  // after a backdated trade, an edit or a delete. The replay starts from
  // `openingQuantity`: the metal held before the first recorded trade (e.g. the
  // quantity typed in when the account was created).
  async _recomputeMetalAccount(account) {
    const metalTransactions = (await DB.getByIndex("transactions", "accountId", account.id))
      .filter((transaction) => transaction.type === "buy" || transaction.type === "sell" || transaction.type === "valuation")
      .sort((first, second) => (first.date || "").localeCompare(second.date || ""));

    const accountBefore = JSON.stringify(account);
    if (account.openingQuantity == null) {
      // Accounts from before this field existed: derive it once from the
      // current holding, which every earlier trade already moved.
      const netTraded = metalTransactions.reduce((sum, transaction) => {
        if (transaction.type === "buy") return sum + (transaction.quantity || 0);
        if (transaction.type === "sell") return sum - (transaction.quantity || 0);
        return sum;
      }, 0);
      account.openingQuantity = Math.max(0, (account.quantity || 0) - netTraded);
    }

    let quantity = account.openingQuantity;
    let latestPricePerGram = null;
    for (const transaction of metalTransactions) {
      if (transaction.type === "buy") quantity += transaction.quantity || 0;
      if (transaction.type === "sell") quantity = Math.max(0, quantity - (transaction.quantity || 0));
      if (transaction.pricePerGram > 0) latestPricePerGram = transaction.pricePerGram;

      const transactionBefore = JSON.stringify(transaction);
      if (transaction.type === "valuation") {
        transaction.balanceAfter = transaction.amount;
      } else {
        transaction.quantityAfter = quantity;
        transaction.balanceAfter = quantity * (transaction.pricePerGram || 0);
      }
      if (JSON.stringify(transaction) !== transactionBefore) await DB.put("transactions", transaction);
    }

    account.quantity = quantity;
    if (latestPricePerGram != null) account.pricePerGram = latestPricePerGram;
    account.currentValue = quantity * (account.pricePerGram || 0);
    if (JSON.stringify(account) !== accountBefore) await DB.put("accounts", account);
  },

  async _recomputeAllBalances() {
    const accounts = await DB.getAll("accounts");
    await DB.batch(async () => {
      for (const account of accounts) {
        await this._recomputeAccountBalances(account.id);
      }
    });
  },

  async recalcAccount() {
    const id = this.currentAccId;
    if (!id) {
      this.toast("NO ACCOUNT SELECTED");
      return;
    }
    await this._recomputeAccountBalances(id);
    this.toast("BALANCES RECOMPUTED");
    this.route();
  },

  // ==================== TOAST ====================

  toast(message) {
    const bodyElement = document.getElementById("toast-body");
    if (bodyElement) {
      bodyElement.textContent = message;
      bootstrap.Toast.getOrCreateInstance(document.getElementById("toast-msg")).show();
    }
  },
};

// One file write per user action: every handler below runs inside DB.batch(),
// so deleting an account with hundreds of transactions writes the profile once.
const SAVE_HANDLERS = [
  "saveCustodian",
  "savePortfolio",
  "saveAccount",
  "saveTransaction",
  "saveTransactionEdit",
  "saveValuation",
  "saveMetal",
  "saveAsset",
  "saveSellAsset",
  "saveAssetValuation",
  "saveIncome",
  "saveExpense",
  "saveDebt",
  "saveGoal",
  "saveSettings",
  "doImport",
];
const OTHER_CHANGING_HANDLERS = [
  "deleteAccount",
  "deletePortfolio",
  "deleteAsset",
  "deleteAssetValuation",
  "deleteTransaction",
  "deleteIncome",
  "deleteExpense",
  "deleteDebt",
  "deleteGoal",
  "moveGoal",
  "recalcAccount",
];

// A double-click on SAVE must not store the same record twice: while one save
// handler is running, further clicks on any of them are ignored.
SAVE_HANDLERS.forEach((handlerName) => {
  const handler = App[handlerName];
  App[handlerName] = async function (...handlerArguments) {
    if (App._saveInProgress) return;
    App._saveInProgress = true;
    try {
      return await DB.batch(() => handler.apply(App, handlerArguments));
    } finally {
      App._saveInProgress = false;
    }
  };
});
OTHER_CHANGING_HANDLERS.forEach((handlerName) => {
  const handler = App[handlerName];
  App[handlerName] = (...handlerArguments) => DB.batch(() => handler.apply(App, handlerArguments));
});

document.addEventListener("DOMContentLoaded", () => App.init());

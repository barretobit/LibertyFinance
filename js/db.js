/* ===== File-based Data Layer =====
 *
 * Storage-agnostic: talks to the active Storage adapter (folder or file mode).
 * The public DB.* API is stable so the rest of the app never thinks about
 * where the files live.
 */

const DB = (() => {
  const DATA_FILE = new URLSearchParams(window.location.search).get('file');
  const DEFAULT_SETTINGS = { mainCurrency: 'CHF', borderRadius: 10, accentColor: '#33ff33' };
  const EMPTY = () => ({ custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], settings: { ...DEFAULT_SETTINGS } });
  function normalizeSettings(settings) {
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }
  let data = EMPTY();
  let market = { exchangeRates: [], metalPrices: [] };
  let adapter = null;
  let loaded = false;
  let loadPromise = null;
  let writeQueue = Promise.resolve();
  let backedUp = false;

  async function getAdapter() {
    if (!adapter) adapter = await Storage.get();
    return adapter;
  }

  // An existing data file that cannot be parsed stops the load: carrying on
  // with empty data would let the next save overwrite the damaged file.
  function damagedFileError(fileName) {
    const error = new Error('COULD NOT OPEN ' + fileName + ': THE FILE IS DAMAGED (NOT VALID JSON). IT WAS LEFT UNTOUCHED.');
    error.name = 'DamagedFileError';
    return error;
  }

  function parseDataFile(fileName, content) {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw damagedFileError(fileName);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw damagedFileError(fileName);
    return parsed;
  }

  async function loadMarket() {
    const storageAdapter = await getAdapter();
    const content = await storageAdapter.read('market.json');
    market = content ? parseDataFile('market.json', content) : { exchangeRates: [], metalPrices: [] };
    market.exchangeRates = market.exchangeRates || [];
    market.metalPrices = market.metalPrices || [];
  }

  // Every file write goes through one queue, so an older snapshot can never
  // land after a newer one. The content is captured when the write is queued.
  // A failed write must not block the writes queued behind it.
  function queueWrite(fileName, content) {
    const write = writeQueue.catch(() => {}).then(async () => {
      const storageAdapter = await getAdapter();
      await storageAdapter.write(fileName, content);
    });
    writeQueue = write;
    return write;
  }

  function saveMarket() {
    return queueWrite('market.json', JSON.stringify(market));
  }

  async function doLoad() {
    const storageAdapter = await getAdapter();

    const browserCopy = DATA_FILE ? await storageAdapter.read(DATA_FILE) : null;
    // File mode: a file the user just picked with OPEN PROFILE FILE wins over the
    // copy this browser kept from an earlier visit.
    const pendingFile = Storage.consumePendingOpen();
    const pickedContent = storageAdapter.kind === 'classic' && pendingFile && pendingFile.name === DATA_FILE ? pendingFile.content : null;
    const content = pickedContent != null ? pickedContent : browserCopy;
    data = content ? parseDataFile(DATA_FILE, content) : {};
    if (pickedContent != null && pickedContent !== browserCopy) {
      // The browser copy may hold edits never saved with SAVE FILE: hand it to
      // the user as a download before it is replaced.
      if (browserCopy != null) {
        Storage.download(DATA_FILE.replace(/\.json$/i, '') + '-browser-copy-' + Storage.timestamp() + '.json', browserCopy);
      }
      // Store the picked file so the profile survives a reload before the first edit.
      try { await storageAdapter.write(DATA_FILE, pickedContent); } catch (error) { /* non-fatal */ }
    }
    data = Object.assign(EMPTY(), data);
    data.custodians = data.custodians || [];
    data.portfolios = data.portfolios || [];
    data.accounts = data.accounts || [];
    data.transactions = data.transactions || [];
    data.assets = data.assets || [];
    data.incomes = data.incomes || [];
    data.expenses = data.expenses || [];
    data.debts = data.debts || [];
    data.goals = data.goals || [];
    data.settings = normalizeSettings(data.settings);

    // Annotate assets with their account type so valuation logic (e.g. Real
    // Estate handling) can rely on it even for assets created before the field
    // existed.
    const accountById = {};
    (data.accounts || []).forEach(account => { accountById[account.id] = account; });
    (data.assets || []).forEach(asset => {
      if (!asset.accountType && !asset.assetType && asset.accountId != null) {
        const account = accountById[asset.accountId];
        if (account && account.accountType) asset.accountType = account.accountType;
      }
    });

    await loadMarket();

    // One-time migration: move legacy rates stored in the profile file into the shared market file
    if (Array.isArray(data.exchangeRates) && data.exchangeRates.length) {
      const ratesByDate = {};
      [...market.exchangeRates, ...data.exchangeRates].forEach(rateEntry => {
        if (rateEntry && rateEntry.date) ratesByDate[rateEntry.date] = rateEntry.rates;
      });
      market.exchangeRates = Object.keys(ratesByDate).sort().map(date => ({ date, rates: ratesByDate[date] }));
      await saveMarket();
    }
    delete data.exchangeRates;

    // Light auto-backup once per session.
    if (DATA_FILE && !backedUp) {
      backedUp = true;
      try { await storageAdapter.backup(DATA_FILE, JSON.stringify(data, null, 2)); } catch (error) { /* non-fatal */ }
    }

    loaded = true;
  }

  // Guarded load: concurrent callers share a single in-flight load, so `market` is never reassigned mid-use.
  // On failure the guard resets so a later call can retry.
  function load() {
    if (!loadPromise) {
      loadPromise = doLoad().catch(err => {
        loadPromise = null;
        throw err;
      });
    }
    return loadPromise;
  }

  // Inside batch() saves only mark the profile as changed; the batch writes it once at the end
  let batchDepth = 0;
  let batchHasChanges = false;

  function persist() {
    if (!DATA_FILE) return Promise.resolve();
    if (batchDepth > 0) {
      batchHasChanges = true;
      return Promise.resolve();
    }
    return queueWrite(DATA_FILE, JSON.stringify(data));
  }

  // Runs `work` and writes the profile file once afterwards, however many records
  // it changed (e.g. deleting an account with hundreds of transactions).
  // Batches can nest; the outermost one writes. Changes are written even when
  // `work` fails halfway, as they would have been without a batch.
  async function batch(work) {
    batchDepth++;
    try {
      return await work();
    } finally {
      batchDepth--;
      if (batchDepth === 0 && batchHasChanges) {
        batchHasChanges = false;
        await persist();
      }
    }
  }

  async function open() {
    await load();
  }

  function getStore(store) {
    if (!data[store]) data[store] = [];
    return data[store];
  }

  async function getAll(store) {
    if (!loaded) await load();
    if (store === 'exchangeRates' || store === 'metalPrices') return [...(market[store] || [])];
    return [...(getStore(store))];
  }

  async function getById(store, id) {
    if (!loaded) await load();
    return getStore(store).find(item => Number(item.id) === Number(id)) || null;
  }

  async function getByIndex(store, index, value) {
    if (!loaded) await load();
    return getStore(store).filter(item => item[index] === value);
  }

  async function add(store, item) {
    if (!loaded) await load();
    const arr = getStore(store);
    const maxId = arr.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0);
    item.id = maxId + 1;
    arr.push(item);
    await persist();
    return item.id;
  }

  async function put(store, item) {
    if (!loaded) await load();
    const arr = getStore(store);
    const idx = arr.findIndex(i => Number(i.id) === Number(item.id));
    if (idx >= 0) arr[idx] = item;
    await persist();
    return item.id;
  }

  async function del(store, id) {
    if (!loaded) await load();
    data[store] = getStore(store).filter(i => Number(i.id) !== Number(id));
    await persist();
  }

  async function getSettings() {
    if (!loaded) await load();
    return normalizeSettings(data.settings);
  }

  async function saveSettings(settings) {
    if (!loaded) await load();
    data.settings = normalizeSettings(settings);
    await persist();
  }

  async function getRatesForDate(date) {
    if (!loaded) await load();
    return market.exchangeRates.find(r => r.date === date) || null;
  }

  async function saveRatesForDate(date, rates) {
    if (!loaded) await load();
    const idx = market.exchangeRates.findIndex(r => r.date === date);
    if (idx >= 0) market.exchangeRates[idx] = { date, rates };
    else market.exchangeRates.push({ date, rates });
    await saveMarket();
  }

  async function getMetalPricesForDate(date) {
    if (!loaded) await load();
    return market.metalPrices.find(r => r.date === date) || null;
  }

  async function saveMetalPricesForDate(date, prices) {
    if (!loaded) await load();
    const idx = market.metalPrices.findIndex(r => r.date === date);
    if (idx >= 0) market.metalPrices[idx] = { date, prices };
    else market.metalPrices.push({ date, prices });
    await saveMarket();
  }

  async function exportAll() {
    if (!loaded) await load();
    return { ...data, exportedAt: new Date().toISOString() };
  }

  async function importAll(importData) {
    data = {
      custodians: importData.custodians || [],
      portfolios: importData.portfolios || [],
      accounts: importData.accounts || [],
      transactions: importData.transactions || [],
      assets: importData.assets || [],
      incomes: importData.incomes || [],
      expenses: importData.expenses || [],
      debts: importData.debts || [],
      goals: importData.goals || [],
      settings: importData.settings || {}
    };
    await persist();
  }

  // Force a write of the current data. In file mode this also downloads a copy
  // so the user keeps a real file on disk.
  async function saveFile() {
    await persist();
    const storageAdapter = await getAdapter();
    if (storageAdapter.kind === 'classic') {
      Storage.download(DATA_FILE, JSON.stringify(data, null, 2));
      return 'classic';
    }
    return 'dir';
  }

  return { open, batch, getAll, getById, getByIndex, add, put, del, exportAll, importAll, getSettings, saveSettings, getRatesForDate, saveRatesForDate, getMetalPricesForDate, saveMetalPricesForDate, saveFile, get currentFile() { return DATA_FILE || ''; } };
})();

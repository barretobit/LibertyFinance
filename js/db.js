/* ===== File-based Data Layer =====
 *
 * Storage-agnostic: talks to the active Storage adapter (folder or file mode).
 * The public DB.* API is stable so the rest of the app never thinks about
 * where the files live.
 */

const DB = (() => {
  const DATA_FILE = new URLSearchParams(window.location.search).get('file');
  const EMPTY = () => ({ custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], settings: { borderRadius: 10 } });
  let data = EMPTY();
  let market = { exchangeRates: [], metalPrices: [] };
  let adapter = null;
  let loaded = false;
  let loadPromise = null;
  let marketWrite = Promise.resolve();
  let backedUp = false;

  async function getAdapter() {
    if (!adapter) adapter = await Storage.get();
    return adapter;
  }

  async function loadMarket() {
    const a = await getAdapter();
    let content = null;
    try { content = await a.read('market.json'); } catch (e) { content = null; }
    if (content) {
      try { market = JSON.parse(content); } catch (e) { market = null; }
    }
    if (!market) market = { exchangeRates: [], metalPrices: [] };
    market.exchangeRates = market.exchangeRates || [];
    market.metalPrices = market.metalPrices || [];
  }

  // Serialize market writes so a later mutation is always written after earlier ones.
  // Payload is captured at call time, so the final write reflects all prior mutations.
  function saveMarket() {
    const payload = JSON.stringify(market);
    marketWrite = marketWrite.then(async () => {
      const a = await getAdapter();
      await a.write('market.json', payload);
    });
    return marketWrite;
  }

  async function doLoad() {
    const a = await getAdapter();

    let content = null;
    if (DATA_FILE) {
      content = await a.read(DATA_FILE);
    }
    if (content == null) {
      // File mode, first visit of this profile: the file was opened via the picker.
      const pending = Storage.consumePendingOpen();
      if (pending && pending.name === DATA_FILE) {
        content = pending.content;
        // Seed the mirror so the profile survives a reload before the first edit.
        try { await a.write(DATA_FILE, content); } catch (e) { /* non-fatal */ }
      }
    }
    if (content) {
      try { data = JSON.parse(content); } catch (e) { data = null; }
    }
    data = Object.assign(EMPTY(), data || {});
    data.custodians = data.custodians || [];
    data.portfolios = data.portfolios || [];
    data.accounts = data.accounts || [];
    data.transactions = data.transactions || [];
    data.assets = data.assets || [];
    data.incomes = data.incomes || [];
    data.expenses = data.expenses || [];
    data.debts = data.debts || [];
    data.goals = data.goals || [];
    data.settings = data.settings || {};

    await loadMarket();

    // One-time migration: move legacy rates stored in the profile file into the shared market file
    if (Array.isArray(data.exchangeRates) && data.exchangeRates.length) {
      const byDate = {};
      [...market.exchangeRates, ...data.exchangeRates].forEach(r => {
        if (r && r.date) byDate[r.date] = r.rates;
      });
      market.exchangeRates = Object.keys(byDate).sort().map(date => ({ date, rates: byDate[date] }));
      await saveMarket();
    }
    delete data.exchangeRates;

    // Light auto-backup once per session.
    if (DATA_FILE && !backedUp) {
      backedUp = true;
      try { await a.backup(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { /* non-fatal */ }
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

  async function persist() {
    const a = await getAdapter();
    if (DATA_FILE) await a.write(DATA_FILE, JSON.stringify(data));
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
    return data.settings || {};
  }

  async function saveSettings(settings) {
    if (!loaded) await load();
    data.settings = settings || {};
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

  async function clearAll() {
    data = EMPTY();
    await persist();
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
    const a = await getAdapter();
    if (a.kind === 'classic') {
      Storage.download(DATA_FILE, JSON.stringify(data, null, 2));
      return 'classic';
    }
    return 'dir';
  }

  async function getMode() {
    const a = await getAdapter();
    return a.kind;
  }

  return { open, getAll, getById, getByIndex, add, put, del, clearAll, exportAll, importAll, getSettings, saveSettings, getRatesForDate, saveRatesForDate, getMetalPricesForDate, saveMetalPricesForDate, saveFile, getMode, get currentFile() { return DATA_FILE || ''; } };
})();

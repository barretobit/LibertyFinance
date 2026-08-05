/* ===== File-based Data Layer ===== */

const DB = (() => {
  const DATA_FILE = new URLSearchParams(window.location.search).get('file');
  let data = { custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], settings: {} };
  let market = { exchangeRates: [], metalPrices: [] };
  let loaded = false;
  let loadPromise = null;
  let marketWrite = Promise.resolve();

  function api(path) {
    return DATA_FILE ? path + '?file=' + encodeURIComponent(DATA_FILE) : path;
  }

  async function loadMarket() {
    const res = await fetch('/api/market');
    if (!res.ok) throw new Error('Failed to load market data');
    market = await res.json();
    market.exchangeRates = market.exchangeRates || [];
    market.metalPrices = market.metalPrices || [];
  }

  // Serialize market writes so a later mutation is always written after earlier ones.
  // Payload is captured at call time, so the final write reflects all prior mutations.
  function saveMarket() {
    const payload = JSON.stringify(market);
    marketWrite = marketWrite.then(async () => {
      const res = await fetch('/api/market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!res.ok) throw new Error('Failed to save market data');
    });
    return marketWrite;
  }

  async function doLoad() {
    const res = await fetch(api('/api/data'));
    if (!res.ok) throw new Error('Failed to load data');
    data = await res.json();
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
    const res = await fetch(api('/api/data'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Failed to save data');
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
    data = { custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], settings: {} };
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

  return { open, getAll, getById, getByIndex, add, put, del, clearAll, exportAll, importAll, getSettings, saveSettings, getRatesForDate, saveRatesForDate, getMetalPricesForDate, saveMetalPricesForDate, get currentFile() { return DATA_FILE || ''; } };
})();

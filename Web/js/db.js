/* ===== File-based Data Layer ===== */

const DB = (() => {
  const DATA_FILE = new URLSearchParams(window.location.search).get('file');
  let data = { custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], exchangeRates: [], settings: {} };
  let loaded = false;

  function api(path) {
    return DATA_FILE ? path + '?file=' + encodeURIComponent(DATA_FILE) : path;
  }

  async function load() {
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
    data.exchangeRates = data.exchangeRates || [];
    data.settings = data.settings || {};
    loaded = true;
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
    return data.exchangeRates.find(r => r.date === date) || null;
  }

  async function saveRatesForDate(date, rates) {
    if (!loaded) await load();
    const idx = data.exchangeRates.findIndex(r => r.date === date);
    if (idx >= 0) data.exchangeRates[idx] = { date, rates };
    else data.exchangeRates.push({ date, rates });
    await persist();
  }

  async function clearAll() {
    data = { custodians: [], portfolios: [], accounts: [], transactions: [], assets: [], incomes: [], expenses: [], debts: [], goals: [], exchangeRates: [], settings: {} };
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
      exchangeRates: importData.exchangeRates || [],
      settings: importData.settings || {}
    };
    await persist();
  }

  return { open, getAll, getById, getByIndex, add, put, del, clearAll, exportAll, importAll, getSettings, saveSettings, getRatesForDate, saveRatesForDate, get currentFile() { return DATA_FILE || ''; } };
})();

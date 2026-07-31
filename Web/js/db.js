/* ===== File-based Data Layer ===== */

const DB = (() => {
  let data = { custodians: [], portfolios: [], accounts: [], transactions: [], incomes: [], expenses: [], debts: [], goals: [] };
  let loaded = false;

  async function load() {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('Failed to load data');
    data = await res.json();
    data.custodians = data.custodians || [];
    data.portfolios = data.portfolios || [];
    data.accounts = data.accounts || [];
    data.transactions = data.transactions || [];
    data.incomes = data.incomes || [];
    data.expenses = data.expenses || [];
    data.debts = data.debts || [];
    data.goals = data.goals || [];
    loaded = true;
  }

  async function persist() {
    const res = await fetch('/api/data', {
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

  async function clearAll() {
    data = { custodians: [], portfolios: [], accounts: [], transactions: [], incomes: [], expenses: [], debts: [], goals: [] };
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
      incomes: importData.incomes || [],
      expenses: importData.expenses || [],
      debts: importData.debts || [],
      goals: importData.goals || []
    };
    await persist();
  }

  return { open, getAll, getById, getByIndex, add, put, del, clearAll, exportAll, importAll };
})();

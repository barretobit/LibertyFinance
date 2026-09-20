/* ===== Randata Market Data Layer =====
 *
 * Fetches 5-year historical financial data (indexes / stocks / ETFs / metals /
 * cryptos) plus latest FX closes from the Randata Finance API in-memory cache.
 *
 * Each asset class is persisted as its own file inside the Resources/ folder:
 *   indexes.json · stocks.json · etfs.json · metals.json · cryptos.json · fx.json
 *
 * Every file holds just that class: its asset catalog (metadata) + historical
 * bars, tagged with the day it was synced. On same-day page refreshes the files
 * are read directly — no network call. A failed class keeps its cached file, so
 * a partial outage never wipes the existing market data.
 */

const Randata = (() => {
  const RESOURCES_DIR = 'Resources';
  const API_BASE = 'https://randombit.tail541a06.ts.net';

  // Per asset class: file name inside Resources/ + the /finance/<path> endpoint
  // + the key of that class inside the /finance/assets catalog payload.
  const CLASSES = {
    index:  { file: 'indexes.json',  assetsKey: 'indexes',         api: 'finance/cache/indexes' },
    stock:  { file: 'stocks.json',   assetsKey: 'stocks',          api: 'finance/cache/stocks' },
    etf:    { file: 'etfs.json',     assetsKey: 'etfs',            api: 'finance/cache/etfs' },
    metal:  { file: 'metals.json',   assetsKey: 'precious_metals', api: 'finance/cache/metals' },
    crypto: { file: 'cryptos.json',  assetsKey: 'crypto',          api: 'finance/cache/cryptos' },
    fx:     { file: 'fx.json',       assetsKey: 'fx_pairs',        api: 'finance/fx/rates' },
  };

  let adapter = null;
  let cache = {};
  let syncing = false;
  let lastResult = null;
  let syncInFlight = null;
  let legacyRemoved = false;

  async function getAdapter() {
    if (!adapter) adapter = await Storage.get();
    return adapter;
  }

  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function emptyClass() {
    return { synced_date: null, assets: [], data: {} };
  }

  async function readClassFromDisk(cls) {
    const cfg = CLASSES[cls];
    if (!cfg) return emptyClass();
    const a = await getAdapter();
    let content = null;
    try { content = await a.readIn(RESOURCES_DIR, cfg.file); } catch (e) { content = null; }
    if (!content) return emptyClass();
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.data) {
        return {
          synced_date: parsed.synced_date || null,
          assets: parsed.assets || [],
          data: parsed.data || {}
        };
      }
    } catch (e) { /* corrupted file */ }
    return emptyClass();
  }

  async function apiJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function fetchAssets() {
    const json = await apiJson(API_BASE + '/finance/assets');
    const grouped = {};
    Object.keys(CLASSES).forEach((cls) => {
      const list = json[CLASSES[cls].assetsKey] || [];
      grouped[cls] = list.map((item) => Object.assign({ class: cls }, item));
    });
    return grouped;
  }

  async function fetchClassData(cls, cfg, groupedAssets) {
    const assets = groupedAssets[cls] || [];
    let data = {};
    const json = await apiJson(API_BASE + '/' + cfg.api);
    if (cls === 'fx') {
      (json || []).forEach((pair) => {
        if (pair && pair.symbol && pair.latest && pair.latest.close != null) {
          data[pair.symbol] = [pair.latest];
        }
      });
    } else {
      (json && json.data || []).forEach((entry) => {
        if (entry && entry.symbol && Array.isArray(entry.history)) {
          data[entry.symbol] = entry.history;
        }
      });
    }
    return { assets: assets, data: data };
  }

  function countRows(data) {
    return Object.keys(data || {}).reduce((n, k) => n + (data[k] || []).length, 0);
  }

  function summary(status, synced_date) {
    let symbols = 0;
    let rows = 0;
    const classes = {};
    Object.keys(CLASSES).forEach((cls) => {
      const f = cache[cls] || emptyClass();
      classes[cls] = { synced_date: f.synced_date };
      symbols += Object.keys(f.data || {}).length;
      rows += countRows(f.data);
    });
    return { status: status, synced_date: synced_date, symbols: symbols, rows: rows, classes: classes };
  }

  async function doSync() {
    try {
      const today = todayStr();
      const a = await getAdapter();
      const classKeys = Object.keys(CLASSES);

      // Freshness is judged per file: a class is only re-fetched when its own
      // Resource file was last synced another day (or is missing entirely).
      const states = {};
      for (const cls of classKeys) states[cls] = await readClassFromDisk(cls);
      const stale = classKeys.filter((cls) => states[cls].synced_date !== today);

      if (!stale.length) {
        cache = states;
        lastResult = summary('fresh', today);
        return lastResult;
      }

      // The catalog is shared by all classes; fetch it once for the whole batch.
      let assetsPromise = null;
      const getAssets = () => assetsPromise || (assetsPromise = fetchAssets());

      await Promise.all(stale.map(async (cls) => {
        try {
          const cfg = CLASSES[cls];
          const clsData = await fetchClassData(cls, cfg, await getAssets());
          const payload = { synced_date: today, assets: clsData.assets, data: clsData.data };
          await a.writeIn(RESOURCES_DIR, cfg.file, JSON.stringify(payload));
          states[cls] = payload;
        } catch (e) { /* keep the cached file; a failed class is not fatal */ }
      }));

      cache = states;

      // The old combined randata.json is orphaned by the Resources/ layout.
      if (!legacyRemoved) {
        legacyRemoved = true;
        try { await a.remove('randata.json'); } catch (e) { /* non-fatal */ }
      }

      const allCurrent = classKeys.every((cls) => cache[cls].synced_date === today);
      const anyCurrent = classKeys.some((cls) => cache[cls].synced_date === today);
      const status = allCurrent ? 'synced' : (anyCurrent ? 'synced' : 'offline');
      lastResult = summary(status, today);
      return lastResult;
    } catch (e) {
      lastResult = { status: 'offline', error: e.message || String(e) };
      return lastResult;
    } finally {
      syncing = false;
    }
  }

  async function sync() {
    if (syncInFlight) return syncInFlight;
    syncing = true;
    syncInFlight = doSync().finally(() => { syncInFlight = null; });
    return syncInFlight;
  }

  async function readClass(cls) {
    if (!CLASSES[cls]) return emptyClass();
    if (!cache[cls]) {
      const f = await readClassFromDisk(cls);
      cache[cls] = f;
    }
    return cache[cls];
  }

  // Merged view of every class, for pages that genuinely need all of them.
  async function readFile() {
    const out = { synced_date: null, assets: [], data: {} };
    for (const cls of Object.keys(CLASSES)) {
      const f = await readClass(cls);
      if (!f || !f.data) continue;
      if (f.synced_date && (!out.synced_date || f.synced_date > out.synced_date)) {
        out.synced_date = f.synced_date;
      }
      (f.assets || []).forEach((a) => { if (a && a.symbol) out.assets.push(a); });
      Object.assign(out.data, f.data || {});
    }
    return out;
  }

  return {
    sync,
    readFile,
    readClass,
    isSyncing: () => syncing,
    getLastResult: () => lastResult
  };
})();
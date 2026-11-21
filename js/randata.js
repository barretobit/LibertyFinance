/* ===== Randata Market Data Layer =====
 *
 * Fetches 10-year historical financial data (indexes / stocks / ETFs / metals /
 * cryptos / FX pairs) from the Randata Finance API.
 *
 * History comes from two endpoints; every symbol ends up as one date-ascending
 * array of bars { date, open, high, low, close, volume }:
 *   - Full load:   GET /finance/history/year/{year} for each calendar year,
 *     a few in parallel. Randata prepares these year documents in memory after
 *     every cache load, so they never wait on its database. Years are joined
 *     oldest first, which keeps each symbol's bars in date order.
 *   - Incremental: GET /finance/history/range?from=..&to=.. tail window (rows
 *     sorted by symbol then date), served from the server's in-memory cache.
 * Bars are grouped per symbol and split into the per-class files by matching
 * each symbol against the /finance/assets catalog. New catalog symbols force
 * a full reload so freshly onboarded assets arrive with their complete
 * backfilled history, not just the incremental window.
 *
 * The class files are read and parsed once per page; later syncs work on the
 * in-memory copy and ask the server for news at most every few minutes.
 *
 * Each asset class is persisted as its own file inside the Resources/ folder:
 *   indexes.json · stocks.json · etfs.json · metals.json · cryptos.json · fx.json
 * A small randata-meta.json holds the sync bookkeeping (schema version, the
 * last ingested server cache build instant, and the per-class sync day), so
 * class files are only rewritten when their bars actually changed — a weekend
 * with no new equity bars costs no re-serialization of the ~40 MB dataset.
 *
 * Before trusting the cache we compare our last sync against the Randata cache
 * build timestamp (/finance/cache/status): when Randata rebuilt after our last
 * processed build, the catalog is refreshed (and a full reload is forced if it
 * gained symbols) and the tail bars are re-pulled. A failed class keeps its
 * cached file, so a partial outage never wipes the existing market data.
 */

const Randata = (() => {
  const RESOURCES_FOLDER = 'Resources';
  const API_BASE = 'https://randata.onrender.com';
  const CACHE_STATUS_API = 'finance/cache/status';
  const HISTORY_RANGE_API = 'finance/history/range';
  const HISTORY_YEAR_API = 'finance/history/year';
  const META_FILE = 'randata-meta.json';

  // The full set (~460k bars) is pulled one calendar year per request: a single
  // history/all dump is cut off by the host proxy (~502). Years without data
  // come back empty, so this only has to reach back past the server's window.
  const MAX_HISTORY_YEARS = 15;
  const PARALLEL_YEAR_REQUESTS = 4;
  const REQUEST_TIMEOUT_MS = 90000;
  // A sync with everything already current skips the server check this long.
  const STATUS_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  // Bump when the Resources/ file layout changes: files written under a
  // different schema are ignored, forcing one full reload.
  // 3: schema 2 full loads stored each symbol's years newest first.
  // 4: fx.json holds full history from the cache endpoints, not one latest bar per pair.
  const SCHEMA = 4;
  // Re-fetch this many days behind the last synced day so bars that were still
  // intraday/partial at the previous sync get replaced, not duplicated.
  const INCREMENTAL_OVERLAP_DAYS = 3;

  // Per asset class: file name inside Resources/ + the key of that class inside
  // the /finance/assets catalog payload. Every class is fed by the
  // /finance/history/* endpoints, which Randata serves from its in-memory cache.
  // (/finance/fx/rates reads Randata's database and fails when that is down.)
  const CLASSES = {
    index:  { file: 'indexes.json',  assetsKey: 'indexes' },
    stock:  { file: 'stocks.json',   assetsKey: 'stocks' },
    etf:    { file: 'etfs.json',     assetsKey: 'etfs' },
    metal:  { file: 'metals.json',   assetsKey: 'precious_metals' },
    crypto: { file: 'cryptos.json',  assetsKey: 'crypto' },
    fx:     { file: 'fx.json',       assetsKey: 'fx_pairs' },
  };
  const HISTORY_CLASSES = ['index', 'stock', 'etf', 'metal', 'crypto', 'fx'];

  let adapter = null;
  let cache = {};
  let metaCache = null;
  let lastResult = null;
  let syncInFlight = null;
  let legacyRemoved = false;
  let lastStatusCheck = 0;
  // Goes up whenever a sync changes the market data, so pages know to redraw.
  let dataVersion = 0;

  async function getAdapter() {
    if (!adapter) adapter = await Storage.get();
    return adapter;
  }

  function todayIsoDate() {
    return new Date().toISOString().split('T')[0];
  }

  function dateAddDays(dateText, days) {
    const date = new Date(dateText + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
  }

  function emptyClass() {
    return { synced_date: null, synced_at: null, assets: [], data: {} };
  }

  function emptyMeta() {
    return { schema: null, built_at: null, synced: {} };
  }

  // Assemble the public per-class shape (synced_* bookkeeping + assets + bars)
  // from the meta file and the class file.
  function assembleClass(assetClass, meta, file) {
    const classSync = (meta && meta.synced && meta.synced[assetClass]) || null;
    return {
      synced_date: classSync ? classSync.date : null,
      synced_at: classSync ? classSync.at : null,
      assets: (file && file.assets) || [],
      data: (file && file.data) || {}
    };
  }

  async function readMeta() {
    if (metaCache) return metaCache;
    const storageAdapter = await getAdapter();
    let content = null;
    try { content = await storageAdapter.readIn(RESOURCES_FOLDER, META_FILE); } catch (error) { content = null; }
    let meta = emptyMeta();
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.schema === SCHEMA && parsed.synced && typeof parsed.synced === 'object') {
          meta = parsed;
        }
      } catch (error) { /* corrupted file */ }
    }
    metaCache = meta;
    return meta;
  }

  async function writeMeta(meta) {
    const storageAdapter = await getAdapter();
    meta.schema = SCHEMA;
    await storageAdapter.writeIn(RESOURCES_FOLDER, META_FILE, JSON.stringify(meta));
    metaCache = meta;
  }

  async function readClassFile(assetClass) {
    const classConfig = CLASSES[assetClass];
    if (!classConfig) return null;
    const storageAdapter = await getAdapter();
    let content = null;
    try { content = await storageAdapter.readIn(RESOURCES_FOLDER, classConfig.file); } catch (error) { content = null; }
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
        return { assets: parsed.assets || [], data: parsed.data || {} };
      }
    } catch (error) { /* corrupted file */ }
    return null;
  }

  async function apiJson(url, timeoutMs) {
    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = abortController ? setTimeout(() => abortController.abort(), timeoutMs || REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: abortController ? abortController.signal : undefined
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchAssets() {
    const json = await apiJson(API_BASE + '/finance/assets');
    const grouped = {};
    Object.keys(CLASSES).forEach((assetClass) => {
      const list = json[CLASSES[assetClass].assetsKey] || [];
      grouped[assetClass] = list.map((item) => Object.assign({ class: assetClass }, item));
    });
    return grouped;
  }

  // Range rows as { symbol: [bars...] }. Rows arrive sorted by symbol then
  // date, so each symbol's array stays date-ascending.
  async function fetchHistoryRange(from, to) {
    const json = await apiJson(
      API_BASE + '/' + HISTORY_RANGE_API + '?from=' + from + '&to=' + to);
    const bySymbol = {};
    ((json && json.data) || []).forEach((row) => {
      if (!row || !row.symbol || !row.date) return;
      const { symbol, ...bar } = row;
      (bySymbol[symbol] || (bySymbol[symbol] = [])).push(bar);
    });
    return bySymbol;
  }

  // One calendar year as { symbol: [bars...] }, from per-symbol date-ascending columns.
  async function fetchHistoryYear(year) {
    const json = await apiJson(API_BASE + '/' + HISTORY_YEAR_API + '/' + year);
    const symbols = (json && json.symbols) || {};
    const bySymbol = {};
    Object.keys(symbols).forEach((symbol) => {
      const columns = symbols[symbol];
      bySymbol[symbol] = columns.date.map((date, index) => ({
        date: date, open: columns.open[index], high: columns.high[index], low: columns.low[index], close: columns.close[index], volume: columns.volume[index]
      }));
    });
    return bySymbol;
  }

  // Full history as { symbol: [bars...] }, oldest-to-newest: every year is
  // fetched (a few requests at a time) and the years are joined oldest first.
  async function fetchHistoryFull(today) {
    const lastYear = Number(today.slice(0, 4));
    const years = [];
    for (let year = lastYear - MAX_HISTORY_YEARS + 1; year <= lastYear; year++) years.push(year);
    const results = new Array(years.length);
    let next = 0;
    const worker = async () => {
      while (next < years.length) {
        const index = next++;
        results[index] = await fetchHistoryYear(years[index]);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_YEAR_REQUESTS }, worker));
    const bySymbol = {};
    results.forEach((yearBars) => {
      Object.keys(yearBars).forEach((symbol) => {
        bySymbol[symbol] = (bySymbol[symbol] || []).concat(yearBars[symbol]);
      });
    });
    return bySymbol;
  }

  // Full UTC instant (epoch ms) at which the Randata cache was last rebuilt,
  // or null when the status endpoint is unreachable. Drives the "new data
  // landed on the server" check regardless of the calendar day.
  async function fetchCacheBuiltAt() {
    try {
      const json = await apiJson(API_BASE + '/' + CACHE_STATUS_API);
      const raw = json && json.loaded_at;
      if (!raw) return null;
      const builtAtTime = new Date(raw).getTime();
      return isNaN(builtAtTime) ? null : builtAtTime;
    } catch (error) {
      return null;
    }
  }

  // symbol -> history class, derived from the catalog. Symbols absent from the
  // catalog (e.g. an asset removed server-side) have no class to file under.
  function buildClassBySymbol(groupedAssets) {
    const map = {};
    HISTORY_CLASSES.forEach((assetClass) => {
      ((groupedAssets || {})[assetClass] || []).forEach((asset) => {
        if (asset && asset.symbol) map[asset.symbol] = assetClass;
      });
    });
    return map;
  }

  // Split { symbol: [bars...] } into { class: { symbol: [bars...] } }.
  function groupBarsByClass(barsBySymbol, classBySymbol) {
    const byClass = {};
    HISTORY_CLASSES.forEach((assetClass) => { byClass[assetClass] = {}; });
    Object.keys(barsBySymbol || {}).forEach((symbol) => {
      const assetClass = classBySymbol[symbol];
      if (assetClass) byClass[assetClass][symbol] = barsBySymbol[symbol];
    });
    return byClass;
  }

  // Merge incoming bars into a symbol's existing date-ascending array:
  // same-date bars are replaced (partial intraday closes get corrected),
  // newer dates are appended, order is preserved. Incoming duplicates for a
  // date are collapsed to the last one, so a malformed response cannot corrupt
  // the series with repeated dates.
  function mergeSymbolBars(existing, incoming) {
    const byDate = {};
    (incoming || []).forEach((bar) => { if (bar && bar.date) byDate[bar.date] = bar; });
    const kept = (existing || []).filter((bar) => !(bar && bar.date && byDate[bar.date]));
    const added = Object.keys(byDate).map((date) => byDate[date]);
    return kept.concat(added).sort((first, second) => (first.date < second.date ? -1 : first.date > second.date ? 1 : 0));
  }

  // True when the catalog lists a history symbol we have no local bars for —
  // typically a freshly onboarded asset whose backfilled history we are missing.
  function hasNewCatalogSymbols(groupedAssets, states) {
    return HISTORY_CLASSES.some((assetClass) => {
      const have = (states[assetClass] && states[assetClass].data) || {};
      return ((groupedAssets || {})[assetClass] || []).some(
        (asset) => asset && asset.symbol && !have[asset.symbol]);
    });
  }

  function countRows(data) {
    return Object.keys(data || {}).reduce((total, symbol) => total + (data[symbol] || []).length, 0);
  }

  function summary(status, synced_date) {
    let symbols = 0;
    let rows = 0;
    const classes = {};
    Object.keys(CLASSES).forEach((assetClass) => {
      const classState = cache[assetClass] || emptyClass();
      classes[assetClass] = { synced_date: classState.synced_date };
      symbols += Object.keys(classState.data || {}).length;
      rows += countRows(classState.data);
    });
    return { status: status, synced_date: synced_date, symbols: symbols, rows: rows, classes: classes };
  }

  async function doSync(force) {
    try {
      const today = todayIsoDate();
      const now = new Date().toISOString();
      const storageAdapter = await getAdapter();
      const classKeys = Object.keys(CLASSES);

      // The meta and class files are parsed once per page (~40 MB); afterwards
      // the in-memory copy is current, because every write goes through here.
      const meta = await readMeta();
      const states = {};
      for (const assetClass of classKeys) states[assetClass] = cache[assetClass] || assembleClass(assetClass, meta, await readClassFile(assetClass));
      const syncedOn = (assetClass) => (meta.synced && meta.synced[assetClass] && meta.synced[assetClass].date) || null;

      const stale = classKeys.filter((assetClass) => syncedOn(assetClass) !== today);

      // A full reload is forced by a missing/invalid meta (first run or an
      // older layout) or by a history class we never successfully loaded.
      // Day-staleness alone only needs a small incremental range pull.
      let fullNeeded = meta.schema !== SCHEMA ||
        HISTORY_CLASSES.some((assetClass) => !meta.synced || !meta.synced[assetClass]);

      // Everything is from today and the server was asked moments ago.
      if (!force && !stale.length && !fullNeeded && Date.now() - lastStatusCheck < STATUS_CHECK_INTERVAL_MS) {
        cache = states;
        lastResult = summary('fresh', today);
        return lastResult;
      }

      const remoteBuiltAt = await fetchCacheBuiltAt();
      lastStatusCheck = Date.now();
      // Randata rebuilt its cache after the build instant we last processed
      // (e.g. new data or a new asset landed since our last sync).
      const rebuildDetected = remoteBuiltAt !== null && meta.built_at != null &&
        remoteBuiltAt > new Date(meta.built_at).getTime();

      if (!stale.length && !fullNeeded && !rebuildDetected) {
        cache = states;
        lastResult = summary('fresh', today);
        return lastResult;
      }

      // The catalog is shared by all classes; fetch it once for the whole batch.
      let assetsPromise = null;
      const getAssets = () => assetsPromise || (assetsPromise = fetchAssets());
      const groupedAssets = (stale.length || fullNeeded || rebuildDetected) ? await getAssets() : null;

      // A catalog symbol we never saw before means a full reload: incremental
      // windows would only deliver the new asset's tail, not its backfill.
      if (!fullNeeded && groupedAssets && hasNewCatalogSymbols(groupedAssets, states)) {
        fullNeeded = true;
      }

      const loadedNow = new Set();

      if (fullNeeded) {
        try {
          const bars = await fetchHistoryFull(today);
          const byClass = groupBarsByClass(bars, buildClassBySymbol(groupedAssets));
          let allWritten = true;
          for (const assetClass of HISTORY_CLASSES) {
            try {
              const payload = { assets: (groupedAssets && groupedAssets[assetClass]) || [], data: byClass[assetClass] || {} };
              await storageAdapter.writeIn(RESOURCES_FOLDER, CLASSES[assetClass].file, JSON.stringify(payload));
              meta.synced[assetClass] = { date: today, at: now };
              states[assetClass] = assembleClass(assetClass, meta, payload);
              loadedNow.add(assetClass);
            } catch (error) { allWritten = false; /* keep the cached file */ }
          }
          if (allWritten) {
            meta.built_at = remoteBuiltAt != null ? new Date(remoteBuiltAt).toISOString() : now;
          }
        } catch (error) { /* full load failed: keep existing files; the next sync retries it */ }
      }

      // Incremental: one tail-window pull, merged into every history class.
      // A rebuild also re-pulls the tail even for classes already synced today,
      // so corrected server bars land the same day. Classes that receive no new
      // bars (e.g. equities on a weekend) keep their file untouched. Skipped
      // when a full load was needed: a tail window would mark classes synced
      // without their history, and the full load would never be retried.
      const pending = fullNeeded ? [] : HISTORY_CLASSES.filter((assetClass) =>
        !loadedNow.has(assetClass) && (syncedOn(assetClass) !== today || rebuildDetected));
      if (pending.length) {
        try {
          const oldestPending = pending.map(syncedOn).filter(Boolean).sort()[0] || today;
          const bars = await fetchHistoryRange(
            dateAddDays(oldestPending, -INCREMENTAL_OVERLAP_DAYS), today);
          const byClass = groupBarsByClass(bars, buildClassBySymbol(groupedAssets));
          for (const assetClass of HISTORY_CLASSES) {
            const incoming = byClass[assetClass];
            if (!incoming || !Object.keys(incoming).length) continue;
            try {
              const current = states[assetClass] || { assets: [], data: {} };
              const data = Object.assign({}, current.data);
              Object.keys(incoming).forEach((symbol) => {
                data[symbol] = mergeSymbolBars(data[symbol] || [], incoming[symbol]);
              });
              const payload = {
                assets: (groupedAssets && groupedAssets[assetClass]) || current.assets || [],
                data: data
              };
              await storageAdapter.writeIn(RESOURCES_FOLDER, CLASSES[assetClass].file, JSON.stringify(payload));
              meta.synced[assetClass] = { date: today, at: now };
              states[assetClass] = assembleClass(assetClass, meta, payload);
              loadedNow.add(assetClass);
            } catch (error) { /* keep the cached file */ }
          }
          // Stale classes that received no bars still count as synced for today.
          pending.forEach((assetClass) => {
            if (!loadedNow.has(assetClass)) meta.synced[assetClass] = { date: today, at: now };
          });
          if (remoteBuiltAt != null) meta.built_at = new Date(remoteBuiltAt).toISOString();
        } catch (error) { /* range failed: keep the cached files; still stale tomorrow */ }
      }

      await writeMeta(meta);
      // Reused in-memory classes still carry the sync dates of when they were read.
      classKeys.forEach((assetClass) => { states[assetClass] = assembleClass(assetClass, meta, states[assetClass]); });
      cache = states;
      if (loadedNow.size) dataVersion++;

      // The old combined randata.json is orphaned by the Resources/ layout.
      if (!legacyRemoved) {
        legacyRemoved = true;
        try { await storageAdapter.remove('randata.json'); } catch (error) { /* non-fatal */ }
      }

      // Synced when at least one class is current for today, offline otherwise.
      const anyClassCurrent = classKeys.some((assetClass) => syncedOn(assetClass) === today);
      lastResult = summary(anyClassCurrent ? 'synced' : 'offline', today);
      return lastResult;
    } catch (error) {
      // The in-memory copy may be half updated: read the files again next time.
      metaCache = null;
      cache = {};
      lastResult = { status: 'offline', error: error.message || String(error) };
      return lastResult;
    }
  }

  // options.force: ask the server for news even if it was asked moments ago.
  async function sync(options) {
    if (syncInFlight) return syncInFlight;
    syncInFlight = doSync(!!(options && options.force)).finally(() => { syncInFlight = null; });
    return syncInFlight;
  }

  // Forget the local sync bookkeeping so the next sync does a full reload,
  // which rewrites every class file. The old class files stay until then, so
  // a failed reload never leaves the app without market data.
  async function forgetSync() {
    if (syncInFlight) await syncInFlight;
    const storageAdapter = await getAdapter();
    await storageAdapter.writeIn(RESOURCES_FOLDER, META_FILE, JSON.stringify(emptyMeta()));
    metaCache = null;
    cache = {};
    lastStatusCheck = 0;
  }

  async function readClass(assetClass) {
    if (!CLASSES[assetClass]) return emptyClass();
    if (!cache[assetClass]) {
      const meta = await readMeta();
      cache[assetClass] = assembleClass(assetClass, meta, await readClassFile(assetClass));
    }
    return cache[assetClass];
  }

  // Merged view of every class, for pages that genuinely need all of them.
  async function readFile() {
    const out = { synced_date: null, assets: [], data: {} };
    for (const assetClass of Object.keys(CLASSES)) {
      const classData = await readClass(assetClass);
      if (!classData || !classData.data) continue;
      if (classData.synced_date && (!out.synced_date || classData.synced_date > out.synced_date)) {
        out.synced_date = classData.synced_date;
      }
      (classData.assets || []).forEach((asset) => { if (asset && asset.symbol) out.assets.push(asset); });
      Object.assign(out.data, classData.data || {});
    }
    return out;
  }

  return {
    sync,
    forgetSync,
    readFile,
    readClass,
    getLastResult: () => lastResult,
    dataVersion: () => dataVersion
  };
})();

/* ===== Randata Market Data Layer =====
 *
 * Fetches 10-year historical financial data (indexes / stocks / ETFs / metals /
 * cryptos) plus latest FX closes from the Randata Finance API.
 *
 * History comes from the flat history endpoints (rows sorted by symbol then
 * date: { symbol, date, open, high, low, close, volume }):
 *   - Full load:   the ten-year set is pulled as contiguous one-year
 *     GET /finance/history/range?from=..&to=.. chunks, stopping at the first
 *     empty year. A single /finance/history/all?limit=500000 request carries
 *     ~460k rows and is cut off (HTTP 502) by the host proxy before it can
 *     finish, so chunking is the reliable path.
 *   - Incremental: GET /finance/history/range?from=..&to=.. tail window, served
 *     from the server's in-memory cache when from lies within ~1 year.
 * Bars are grouped per symbol and split into the per-class files by matching
 * each symbol against the /finance/assets catalog. New catalog symbols force
 * a full reload so freshly onboarded assets arrive with their complete
 * backfilled history, not just the incremental window.
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
  const RESOURCES_DIR = 'Resources';
  const API_BASE = 'https://randata.onrender.com';
  const CACHE_STATUS_API = 'finance/cache/status';
  const HISTORY_RANGE_API = 'finance/history/range';
  const FX_RATES_API = 'finance/fx/rates';
  const META_FILE = 'randata-meta.json';

  // The full 10-year set (~460k bars) is pulled as contiguous one-year chunks:
  // a single history/all dump is cut off by the host proxy (~502), while a
  // one-year range window comfortably completes. The loop stops at the first
  // empty year, so the chunk count follows the server's actual data depth.
  const CHUNK_DAYS = 365;
  const MAX_FULL_CHUNKS = 15;
  const REQUEST_TIMEOUT_MS = 90000;
  // Bump when the Resources/ file layout changes: files written under a
  // different schema are ignored, forcing one full reload.
  const SCHEMA = 2;
  // Re-fetch this many days behind the last synced day so bars that were still
  // intraday/partial at the previous sync get replaced, not duplicated.
  const INCREMENTAL_OVERLAP_DAYS = 3;

  // Per asset class: file name inside Resources/ + the key of that class inside
  // the /finance/assets catalog payload. The five history classes are fed by
  // the /finance/history/* endpoints; fx is live and uses /finance/fx/rates.
  const CLASSES = {
    index:  { file: 'indexes.json',  assetsKey: 'indexes' },
    stock:  { file: 'stocks.json',   assetsKey: 'stocks' },
    etf:    { file: 'etfs.json',     assetsKey: 'etfs' },
    metal:  { file: 'metals.json',   assetsKey: 'precious_metals' },
    crypto: { file: 'cryptos.json',  assetsKey: 'crypto' },
    fx:     { file: 'fx.json',       assetsKey: 'fx_pairs' },
  };
  const HISTORY_CLASSES = ['index', 'stock', 'etf', 'metal', 'crypto'];

  let adapter = null;
  let cache = {};
  let metaCache = null;
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

  function dateAddDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  }

  function emptyClass() {
    return { synced_date: null, synced_at: null, assets: [], data: {} };
  }

  function emptyMeta() {
    return { schema: null, built_at: null, synced: {} };
  }

  // Assemble the public per-class shape (synced_* bookkeeping + assets + bars)
  // from the meta file and the class file.
  function assembleClass(cls, meta, file) {
    const s = (meta && meta.synced && meta.synced[cls]) || null;
    return {
      synced_date: s ? s.date : null,
      synced_at: s ? s.at : null,
      assets: (file && file.assets) || [],
      data: (file && file.data) || {}
    };
  }

  async function readMeta() {
    if (metaCache) return metaCache;
    const a = await getAdapter();
    let content = null;
    try { content = await a.readIn(RESOURCES_DIR, META_FILE); } catch (e) { content = null; }
    let meta = emptyMeta();
    if (content) {
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.schema === SCHEMA && parsed.synced && typeof parsed.synced === 'object') {
          meta = parsed;
        }
      } catch (e) { /* corrupted file */ }
    }
    metaCache = meta;
    return meta;
  }

  async function writeMeta(meta) {
    const a = await getAdapter();
    meta.schema = SCHEMA;
    await a.writeIn(RESOURCES_DIR, META_FILE, JSON.stringify(meta));
    metaCache = meta;
  }

  async function readClassFile(cls) {
    const cfg = CLASSES[cls];
    if (!cfg) return null;
    const a = await getAdapter();
    let content = null;
    try { content = await a.readIn(RESOURCES_DIR, cfg.file); } catch (e) { content = null; }
    if (!content) return null;
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
        return { assets: parsed.assets || [], data: parsed.data || {} };
      }
    } catch (e) { /* corrupted file */ }
    return null;
  }

  async function apiJson(url, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  async function fetchHistoryRange(from, to) {
    const json = await apiJson(
      API_BASE + '/' + HISTORY_RANGE_API + '?from=' + from + '&to=' + to);
    return (json && json.data) || [];
  }

  // Full history, oldest-to-newest, assembled from contiguous one-year chunks
  // (no overlap, so no duplicate dates at the seams). Stops at the first year
  // that returns nothing, which also caps newer assets at their inception.
  async function fetchHistoryFull(today) {
    const chunks = [];
    for (let i = 0; i < MAX_FULL_CHUNKS; i++) {
      const to = dateAddDays(today, -CHUNK_DAYS * i);
      const from = dateAddDays(to, -(CHUNK_DAYS - 1));
      const bars = await fetchHistoryRange(from, to);
      if (!bars.length) break;
      chunks.push(bars);
    }
    return chunks.reduce((all, c) => all.concat(c), []);
  }

  async function fetchFxData() {
    const json = await apiJson(API_BASE + '/' + FX_RATES_API);
    const data = {};
    (json || []).forEach((pair) => {
      if (pair && pair.symbol && pair.latest && pair.latest.close != null) {
        data[pair.symbol] = [pair.latest];
      }
    });
    return data;
  }

  // Full UTC instant (epoch ms) at which the Randata cache was last rebuilt,
  // or null when the status endpoint is unreachable. Drives the "new data
  // landed on the server" check regardless of the calendar day.
  async function fetchCacheBuiltAt() {
    try {
      const json = await apiJson(API_BASE + '/' + CACHE_STATUS_API);
      const raw = json && json.loaded_at;
      if (!raw) return null;
      const t = new Date(raw).getTime();
      return isNaN(t) ? null : t;
    } catch (e) {
      return null;
    }
  }

  // symbol -> history class, derived from the catalog. Symbols absent from the
  // catalog (e.g. an asset removed server-side) have no class to file under.
  function buildClassBySymbol(groupedAssets) {
    const map = {};
    HISTORY_CLASSES.forEach((cls) => {
      ((groupedAssets || {})[cls] || []).forEach((asset) => {
        if (asset && asset.symbol) map[asset.symbol] = cls;
      });
    });
    return map;
  }

  // Split a flat bar list into { class: { symbol: [bars...] } }. Rows arrive
  // sorted by symbol then date, so each symbol's array stays date-ascending.
  function groupBarsByClass(bars, classBySymbol) {
    const byClass = {};
    HISTORY_CLASSES.forEach((cls) => { byClass[cls] = {}; });
    (bars || []).forEach((bar) => {
      if (!bar || !bar.symbol || !bar.date) return;
      const cls = classBySymbol[bar.symbol];
      if (!cls) return;
      const bucket = byClass[cls];
      (bucket[bar.symbol] || (bucket[bar.symbol] = [])).push(bar);
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
    (incoming || []).forEach((b) => { if (b && b.date) byDate[b.date] = b; });
    const kept = (existing || []).filter((b) => !(b && b.date && byDate[b.date]));
    const added = Object.keys(byDate).map((d) => byDate[d]);
    return kept.concat(added).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  }

  // True when the catalog lists a history symbol we have no local bars for —
  // typically a freshly onboarded asset whose backfilled history we are missing.
  function hasNewCatalogSymbols(groupedAssets, states) {
    return HISTORY_CLASSES.some((cls) => {
      const have = (states[cls] && states[cls].data) || {};
      return ((groupedAssets || {})[cls] || []).some(
        (asset) => asset && asset.symbol && !have[asset.symbol]);
    });
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
      metaCache = null;
      const today = todayStr();
      const now = new Date().toISOString();
      const a = await getAdapter();
      const classKeys = Object.keys(CLASSES);

      const meta = await readMeta();
      const states = {};
      for (const cls of classKeys) states[cls] = assembleClass(cls, meta, await readClassFile(cls));
      const syncedOn = (cls) => (meta.synced && meta.synced[cls] && meta.synced[cls].date) || null;

      const remoteBuiltAt = await fetchCacheBuiltAt();
      // Randata rebuilt its cache after the build instant we last processed
      // (e.g. new data or a new asset landed since our last sync).
      const rebuildDetected = remoteBuiltAt !== null && meta.built_at != null &&
        remoteBuiltAt > new Date(meta.built_at).getTime();

      const stale = classKeys.filter((cls) => syncedOn(cls) !== today);

      // A full reload is forced by a missing/invalid meta (first run or a
      // pre-v2 layout) or by a history class we never successfully loaded.
      // Day-staleness alone only needs a small incremental range pull.
      let fullNeeded = meta.schema !== SCHEMA ||
        HISTORY_CLASSES.some((cls) => !meta.synced || !meta.synced[cls]);

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
          for (const cls of HISTORY_CLASSES) {
            try {
              const payload = { assets: (groupedAssets && groupedAssets[cls]) || [], data: byClass[cls] || {} };
              await a.writeIn(RESOURCES_DIR, CLASSES[cls].file, JSON.stringify(payload));
              meta.synced[cls] = { date: today, at: now };
              states[cls] = assembleClass(cls, meta, payload);
              loadedNow.add(cls);
            } catch (e) { allWritten = false; /* keep the cached file */ }
          }
          if (allWritten) {
            meta.built_at = remoteBuiltAt != null ? new Date(remoteBuiltAt).toISOString() : now;
          }
        } catch (e) { /* history/all failed: keep existing files; incremental below still covers stale classes */ }
      }

      // Incremental: one tail-window pull, merged into every history class.
      // A rebuild also re-pulls the tail even for classes already synced today,
      // so corrected server bars land the same day. Classes that receive no new
      // bars (e.g. equities on a weekend) keep their file untouched.
      const pending = HISTORY_CLASSES.filter((cls) =>
        !loadedNow.has(cls) && (syncedOn(cls) !== today || rebuildDetected));
      if (pending.length) {
        try {
          const oldestPending = pending.map(syncedOn).filter(Boolean).sort()[0] || today;
          const bars = await fetchHistoryRange(
            dateAddDays(oldestPending, -INCREMENTAL_OVERLAP_DAYS), today);
          const byClass = groupBarsByClass(bars, buildClassBySymbol(groupedAssets));
          for (const cls of HISTORY_CLASSES) {
            const incoming = byClass[cls];
            if (!incoming || !Object.keys(incoming).length) continue;
            try {
              const cur = states[cls] || { assets: [], data: {} };
              const data = Object.assign({}, cur.data);
              Object.keys(incoming).forEach((sym) => {
                data[sym] = mergeSymbolBars(data[sym] || [], incoming[sym]);
              });
              const payload = {
                assets: (groupedAssets && groupedAssets[cls]) || cur.assets || [],
                data: data
              };
              await a.writeIn(RESOURCES_DIR, CLASSES[cls].file, JSON.stringify(payload));
              meta.synced[cls] = { date: today, at: now };
              states[cls] = assembleClass(cls, meta, payload);
              loadedNow.add(cls);
            } catch (e) { /* keep the cached file */ }
          }
          // Stale classes that received no bars still count as synced for today.
          pending.forEach((cls) => {
            if (!loadedNow.has(cls)) meta.synced[cls] = { date: today, at: now };
          });
          if (remoteBuiltAt != null) meta.built_at = new Date(remoteBuiltAt).toISOString();
        } catch (e) { /* range failed: keep the cached files; still stale tomorrow */ }
      }

      if (syncedOn('fx') !== today) {
        try {
          const payload = { assets: (groupedAssets && groupedAssets.fx) || [], data: await fetchFxData() };
          await a.writeIn(RESOURCES_DIR, CLASSES.fx.file, JSON.stringify(payload));
          meta.synced.fx = { date: today, at: now };
          states.fx = assembleClass('fx', meta, payload);
        } catch (e) { /* keep the cached file; a failed class is not fatal */ }
      }

      await writeMeta(meta);
      cache = states;

      // The old combined randata.json is orphaned by the Resources/ layout.
      if (!legacyRemoved) {
        legacyRemoved = true;
        try { await a.remove('randata.json'); } catch (e) { /* non-fatal */ }
      }

      const allCurrent = classKeys.every((cls) => syncedOn(cls) === today);
      const anyCurrent = classKeys.some((cls) => syncedOn(cls) === today);
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
      const meta = await readMeta();
      cache[cls] = assembleClass(cls, meta, await readClassFile(cls));
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

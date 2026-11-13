// Market data sync: js/randata.js against a fake Randata API and a fake storage
const { loadScripts, test, assert } = require('./helpers');

const thisYear = new Date().getUTCFullYear();

// One calendar year in the column format of /finance/history/year/{year}
function yearColumns(year, closes) {
  const dates = closes.map((close, index) => year + '-01-0' + (index + 2));
  return { date: dates, open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 100) };
}

// Loads js/randata.js with in-memory files and a fake API; `failYears` makes the year endpoint answer HTTP 500
function loadRandata({ failYears = false } = {}) {
  const files = {};
  const requests = [];
  let fileReads = 0;
  const adapter = {
    async readIn(folder, name) { fileReads++; const key = folder + '/' + name; return key in files ? files[key] : null; },
    async writeIn(folder, name, content) { files[folder + '/' + name] = content; },
    async remove() {},
  };
  const answers = {
    'finance/cache/status': { loaded_at: '2026-11-13T00:00:00Z' },
    'finance/assets': { indexes: [{ symbol: '^GSPC', name: 'S&P 500' }], stocks: [], etfs: [], precious_metals: [], crypto: [], fx_pairs: [{ symbol: 'CHFUSD=X' }] },
    'finance/fx/rates': [{ symbol: 'CHFUSD=X', latest: { date: thisYear + '-01-03', close: 1.2 } }],
  };
  const fakeFetch = async (url) => {
    const path = url.replace('https://randata.onrender.com/', '');
    requests.push(path);
    const year = /^finance\/history\/year\/(\d+)$/.exec(path);
    if (year) {
      if (failYears) return { ok: false, status: 500 };
      const yearNumber = Number(year[1]);
      // Newer years answer first, as a warm server would.
      await new Promise((resolve) => setTimeout(resolve, (thisYear - yearNumber) * 2));
      const symbols = {};
      if (yearNumber === thisYear - 1) symbols['^GSPC'] = yearColumns(yearNumber, [10, 11]);
      if (yearNumber === thisYear) symbols['^GSPC'] = yearColumns(yearNumber, [12, 13]);
      return { ok: true, status: 200, json: async () => ({ year: yearNumber, symbols }) };
    }
    if (path.startsWith('finance/history/range')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => answers[path] };
  };
  const { Randata } = loadScripts(['js/randata.js'], ['Randata'], { Storage: { async get() { return adapter; } }, fetch: fakeFetch });
  return { Randata, requests, fileReads: () => fileReads };
}

test('a full load stores every symbol oldest bar first, whatever order the years arrive in', async () => {
  const { Randata } = loadRandata();
  const result = await Randata.sync();
  const bars = (await Randata.readClass('index')).data['^GSPC'];
  assert.strictEqual(result.status, 'synced');
  assert.deepStrictEqual(bars.map((bar) => bar.close), [10, 11, 12, 13]);
  assert.strictEqual(bars[bars.length - 1].date, thisYear + '-01-03');
});

test('a sync right after a sync neither calls the API nor reads the files again', async () => {
  const { Randata, requests, fileReads } = loadRandata();
  await Randata.sync();
  const requestsBefore = requests.length;
  const readsBefore = fileReads();
  const versionBefore = Randata.dataVersion();

  const result = await Randata.sync();

  assert.strictEqual(result.status, 'fresh');
  assert.strictEqual(requests.length, requestsBefore);
  assert.strictEqual(fileReads(), readsBefore);
  assert.strictEqual(Randata.dataVersion(), versionBefore);
});

test('a forced sync asks the server even right after a sync', async () => {
  const { Randata, requests } = loadRandata();
  await Randata.sync();
  const requestsBefore = requests.length;
  await Randata.sync({ force: true });
  assert.deepStrictEqual(requests.slice(requestsBefore), ['finance/cache/status']);
});

test('a failed full load leaves the history classes unsynced, so the next sync retries it', async () => {
  const { Randata, requests } = loadRandata({ failYears: true });
  await Randata.sync();
  assert.strictEqual((await Randata.readClass('index')).synced_date, null);
  assert.ok(!requests.some((path) => path.startsWith('finance/history/range')), 'no tail window instead of the full load');

  const requestsBefore = requests.length;
  await Randata.sync();
  assert.ok(requests.slice(requestsBefore).some((path) => path.startsWith('finance/history/year/')));
});

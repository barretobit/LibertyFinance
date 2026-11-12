// Opening, saving and batching a profile: js/db.js against a fake storage
const { loadScripts, test, assert } = require('./helpers');

// Loads js/db.js with a fake Storage holding `files`, opens profile.json and reports what happened
async function openProfile({ kind = 'classic', browserCopy = null, pending = null, market = null } = {}) {
  const files = {};
  if (browserCopy != null) files['profile.json'] = browserCopy;
  if (market != null) files['market.json'] = market;
  const downloads = [];
  const writes = [];
  const adapter = {
    kind,
    async read(name) { return name in files ? files[name] : null; },
    async write(name, content) { files[name] = content; writes.push(name); },
    async backup() {},
  };
  const fakeStorage = {
    async get() { return adapter; },
    consumePendingOpen() { const entry = pending; pending = null; return entry; },
    download(name, content) { downloads.push({ name, content }); },
    timestamp() { return '20261112-150000'; },
  };
  const { DB } = loadScripts(['js/db.js'], ['DB'], { window: { location: { search: '?file=profile.json' } }, Storage: fakeStorage });
  let error = null;
  try { await DB.open(); } catch (caught) { error = caught; }
  writes.length = 0;
  return { DB, files, downloads, writes, error, custodians: error ? null : await DB.getAll('custodians') };
}

const profile = (custodianName) => JSON.stringify({ custodians: [{ id: 1, name: custodianName }] });

test('a picked file wins over the browser copy, which is downloaded first', async () => {
  const result = await openProfile({ browserCopy: profile('Old'), pending: { name: 'profile.json', content: profile('New') } });
  assert.strictEqual(result.custodians[0].name, 'New');
  assert.deepStrictEqual(result.downloads, [{ name: 'profile-browser-copy-20261112-150000.json', content: profile('Old') }]);
  assert.strictEqual(result.files['profile.json'], profile('New'));
});

test('no download when the picked file equals the browser copy, or on a first open', async () => {
  assert.strictEqual((await openProfile({ browserCopy: profile('Same'), pending: { name: 'profile.json', content: profile('Same') } })).downloads.length, 0);
  const firstOpen = await openProfile({ pending: { name: 'profile.json', content: profile('First') } });
  assert.strictEqual(firstOpen.downloads.length, 0);
  assert.strictEqual(firstOpen.files['profile.json'], profile('First'));
});

test('a picked file for another profile, or in folder mode, is ignored', async () => {
  assert.strictEqual((await openProfile({ browserCopy: profile('Old'), pending: { name: 'other.json', content: profile('New') } })).custodians[0].name, 'Old');
  const folderMode = await openProfile({ kind: 'dir', browserCopy: profile('Disk'), pending: { name: 'profile.json', content: profile('New') } });
  assert.strictEqual(folderMode.custodians[0].name, 'Disk');
  assert.strictEqual(folderMode.files['profile.json'], profile('Disk'));
});

test('a damaged profile or market file is refused and left untouched', async () => {
  const damagedPick = await openProfile({ browserCopy: profile('Old'), pending: { name: 'profile.json', content: '{"custodians": [' } });
  assert.strictEqual(damagedPick.error && damagedPick.error.name, 'DamagedFileError');
  assert.strictEqual(damagedPick.files['profile.json'], profile('Old'));
  assert.strictEqual(damagedPick.downloads.length, 0);

  const damagedProfile = await openProfile({ browserCopy: '[1, 2' });
  assert.strictEqual(damagedProfile.error && damagedProfile.error.name, 'DamagedFileError');

  const damagedMarket = await openProfile({ browserCopy: profile('Old'), market: 'not json' });
  assert.strictEqual(damagedMarket.error && damagedMarket.error.name, 'DamagedFileError');
  assert.strictEqual(damagedMarket.files['market.json'], 'not json');
});

test('overlapping saves land in call order: the last one wins', async () => {
  const { DB, files } = await openProfile({ browserCopy: profile('Old') });
  await Promise.all([1, 2, 3, 4, 5].map((number) => DB.put('custodians', { id: 1, name: 'Write ' + number })));
  assert.strictEqual(JSON.parse(files['profile.json']).custodians[0].name, 'Write 5');
});

test('a batch writes the profile once, however many records change', async () => {
  const { DB, files, writes } = await openProfile({ browserCopy: profile('Old') });
  await DB.batch(async () => {
    for (let number = 0; number < 50; number++) await DB.add('custodians', { name: 'Custodian ' + number });
    await DB.batch(async () => DB.del('custodians', 1)); // nested batches write with the outer one
  });
  assert.deepStrictEqual(writes, ['profile.json']);
  assert.strictEqual(JSON.parse(files['profile.json']).custodians.length, 50);
});

test('a failing batch still writes the changes made before the failure', async () => {
  const { DB, files } = await openProfile({ browserCopy: profile('Old') });
  await assert.rejects(DB.batch(async () => {
    await DB.put('custodians', { id: 1, name: 'Changed' });
    throw new Error('halfway');
  }));
  assert.strictEqual(JSON.parse(files['profile.json']).custodians[0].name, 'Changed');
});

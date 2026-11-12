// Data rules in js/app.js: the balance replay run on every open, and deleting an account
const { loadScripts, assertNear, test, assert } = require('./helpers');

// Loads js/app.js on top of js/db.js with `profile` as the only file, and opens it
async function openApp(profile) {
  const files = { 'profile.json': JSON.stringify(profile) };
  const adapter = {
    kind: 'dir',
    async read(name) { return name in files ? files[name] : null; },
    async write(name, content) { files[name] = content; },
    async backup() {},
  };
  const fakeStorage = { async get() { return adapter; }, consumePendingOpen() { return null; } };
  const fakeGlobals = {
    window: { location: { search: '?file=profile.json' } },
    document: { addEventListener() {} },
    Storage: fakeStorage,
  };
  const { App, DB } = loadScripts(['js/utils.js', 'js/valuation.js', 'js/db.js', 'js/app.js'], ['App', 'DB'], fakeGlobals);
  await DB.open();
  return { App, DB, savedProfile: () => JSON.parse(files['profile.json']) };
}

const account = (id, accountType, extra) => ({ id, portfolioId: 1, name: 'Account ' + id, currency: 'CHF', accountType, currentValue: 0, ...extra });

test('replay: balances follow date order, and a first valuation counts its amount, not a stale balance', async () => {
  const { App, savedProfile } = await openApp({
    accounts: [account(1, 'Cash Account', { currentValue: 999 })],
    transactions: [
      { id: 1, accountId: 1, type: 'deposit', amount: 100, date: '2026-03-01', balanceAfter: 999 },
      { id: 2, accountId: 1, type: 'valuation', amount: 500, date: '2026-01-01', balanceAfter: 999 },
      { id: 3, accountId: 1, type: 'withdrawal', amount: -50, date: '2026-04-01', balanceAfter: 999 },
    ],
  });
  await App._recomputeAllBalances();
  const profile = savedProfile();
  const balanceById = Object.fromEntries(profile.transactions.map((transaction) => [transaction.id, transaction.balanceAfter]));
  assert.deepStrictEqual(balanceById, { 1: 600, 2: 500, 3: 550 });
  assert.strictEqual(profile.accounts[0].currentValue, 550);
});

test('replay: metal quantities and values follow date order from the opening quantity', async () => {
  const { App, savedProfile } = await openApp({
    accounts: [account(1, 'Precious Metal', { metalType: 'Gold', quantity: 12, openingQuantity: 10, pricePerGram: 0 })],
    transactions: [
      { id: 1, accountId: 1, type: 'buy', amount: 300, quantity: 5, pricePerGram: 60, date: '2026-02-01', balanceAfter: 0 },
      { id: 2, accountId: 1, type: 'sell', amount: -210, quantity: 3, pricePerGram: 70, date: '2026-01-01', balanceAfter: 0 },
    ],
  });
  await App._recomputeAllBalances();
  const profile = savedProfile();
  const [buy, sell] = profile.transactions;
  assert.strictEqual(sell.quantityAfter, 7);
  assertNear(sell.balanceAfter, 490, 'sell balance');
  assert.strictEqual(buy.quantityAfter, 12);
  assertNear(buy.balanceAfter, 720, 'buy balance');
  assert.strictEqual(profile.accounts[0].quantity, 12);
  assertNear(profile.accounts[0].currentValue, 720, 'account value');
});

test('deleting an account removes it from goals, so a new account with its id is not funding them', async () => {
  const { App, DB, savedProfile } = await openApp({
    accounts: [account(1, 'Cash Account'), account(2, 'Cash Account')],
    goals: [{ id: 1, name: 'Car', target: 1000, order: 1, allocations: [{ accountId: 1, pct: 100 }, { accountId: 2, pct: 100 }] }],
  });
  await App._deleteAccountWithHistory(2);
  const newAccountId = await DB.add('accounts', account(null, 'Cash Account'));
  assert.strictEqual(newAccountId, 2);
  assert.deepStrictEqual(savedProfile().goals[0].allocations, [{ accountId: 1, pct: 100 }]);
});

// A watch bought for 1000 and sold for 1200, with its ADD and SELL rows
const soldWatchProfile = () => ({
  accounts: [account(1, 'Tangible Asset')],
  assets: [{ id: 1, accountId: 1, name: 'Watch', purchaseValue: 1000, depreciationPct: 0, purchaseDate: '2026-01-01', currency: 'CHF', accountType: 'Tangible Asset', sold: true, saleValue: 1200, saleDate: '2026-06-01' }],
  transactions: [
    { id: 1, accountId: 1, assetId: 1, type: 'asset-add', amount: 1000, date: '2026-01-01', balanceAfter: 1000 },
    { id: 2, accountId: 1, assetId: 1, type: 'asset-sell', amount: 1200, date: '2026-06-01', balanceAfter: 0 },
  ],
});

// Opens the app with the confirm dialog answered YES and no page to redraw
async function openAppConfirming(profile) {
  const opened = await openApp(profile);
  Object.assign(opened.App, { confirm: async () => true, toast() {}, route() {} });
  return opened;
}

test('deleting an asset SELL row un-sells the asset, which counts in the account again', async () => {
  const { App, savedProfile } = await openAppConfirming(soldWatchProfile());
  await App.deleteTransaction(2);
  const profile = savedProfile();
  assert.deepStrictEqual(profile.transactions.map((transaction) => transaction.type), ['asset-add']);
  const { sold, saleValue, saleDate } = profile.assets[0];
  assert.deepStrictEqual({ sold, saleValue, saleDate }, { sold: false, saleValue: null, saleDate: null });
  assertNear(profile.accounts[0].currentValue, 1000, 'account value');
});

test('deleting an asset ADD row deletes the asset with all its rows', async () => {
  const { App, savedProfile } = await openAppConfirming(soldWatchProfile());
  await App.deleteTransaction(1);
  const profile = savedProfile();
  assert.deepStrictEqual(profile.assets, []);
  assert.deepStrictEqual(profile.transactions, []);
  assert.strictEqual(profile.accounts[0].currentValue, 0);
});

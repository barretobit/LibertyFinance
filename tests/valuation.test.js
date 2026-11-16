// Shared valuation rules: js/valuation.js on top of js/utils.js
const { loadScripts, assertNear, test, assert } = require('./helpers');

const valuation = loadScripts(['js/utils.js', 'js/valuation.js'], [
  'todayIsoDate', 'capitalFlow', 'isCapitalFlow', 'netDeposit', 'savedAmount', 'latestBalance', 'costBasis', 'createValuationContext', 'valueBreakdown',
]);
const today = valuation.todayIsoDate();

const deposit = (accountId, date, amount, extra) => ({ accountId, type: 'deposit', date, amount, balanceAfter: 0, ...extra });

test('capital flows: deposits in, withdrawals out, opening valuations in, opening contributions not', () => {
  assert.strictEqual(valuation.capitalFlow({ type: 'deposit', amount: 100 }), 100);
  assert.strictEqual(valuation.capitalFlow({ type: 'withdrawal', amount: -40 }), -40);
  assert.strictEqual(valuation.capitalFlow({ type: 'buy', amount: 70 }), 70);
  assert.strictEqual(valuation.capitalFlow({ type: 'sell', amount: -30 }), -30);
  assert.strictEqual(valuation.capitalFlow({ type: 'valuation', amount: 500, notes: 'OPENING VALUATION' }), 500);
  assert.strictEqual(valuation.capitalFlow({ type: 'valuation', amount: 500 }), 0);
  assert.strictEqual(valuation.capitalFlow({ type: 'deposit', amount: 100, notes: 'OPENING CONTRIBUTION' }), 0);
  assert.strictEqual(valuation.capitalFlow({ type: 'asset-add', amount: 900 }), 0);
  assert.strictEqual(valuation.capitalFlow({ type: 'asset-add', amount: 900 }, { includeAssetEvents: true }), 900);
  assert.strictEqual(valuation.capitalFlow({ type: 'asset-sell', amount: 300 }, { includeAssetEvents: true }), -300);
  assert.ok(valuation.isCapitalFlow({ type: 'valuation', opening: true }) && !valuation.isCapitalFlow({ type: 'valuation' }));
});

test('net deposits and saved amounts', () => {
  assert.strictEqual(valuation.netDeposit({ type: 'sell', amount: -30 }), -30);
  assert.strictEqual(valuation.netDeposit({ type: 'deposit', amount: 100, notes: 'OPENING CONTRIBUTION' }), 100);
  assert.strictEqual(valuation.savedAmount({ type: 'buy', amount: 70 }), 0);
  assert.strictEqual(valuation.savedAmount({ type: 'withdrawal', amount: -40 }), -40);
});

test('cost basis: average cost of metal still held', () => {
  const trades = [
    { type: 'buy', date: '2026-01-01', quantity: 10, amount: 100 },
    { type: 'buy', date: '2026-02-01', quantity: 10, amount: 300 },
    { type: 'sell', date: '2026-03-01', quantity: 5, amount: -500 },
  ];
  assertNear(valuation.costBasis(trades), 300, 'cost of the 15 g left at 20 per g');
});

test('cost basis: deposits minus withdrawals plus opening valuations, else the first valuation', () => {
  assertNear(valuation.costBasis([deposit(1, '2026-01-01', 100), { type: 'withdrawal', amount: -30 }, { type: 'valuation', amount: 500, opening: true }]), 570);
  assertNear(valuation.costBasis([{ type: 'valuation', date: '2026-02-01', amount: 900 }, { type: 'valuation', date: '2026-01-01', amount: 800 }]), 800);
});

test('latest balance: by date, the last entered wins on the same day', () => {
  const transactions = [
    { type: 'deposit', date: '2026-01-05', balanceAfter: 100 },
    { type: 'valuation', date: '2026-01-05', balanceAfter: 150 },
    { type: 'deposit', date: '2026-01-01', balanceAfter: 50 },
  ];
  assert.strictEqual(valuation.latestBalance(transactions, 0), 150);
  assert.strictEqual(valuation.latestBalance([], 42), 42);
});

function sampleContext(overrides) {
  return valuation.createValuationContext({
    accounts: [
      { id: 1, name: 'Cash', accountType: 'Cash Account', currency: 'CHF', currentValue: 999 },
      { id: 2, name: 'Euro broker', accountType: 'Investment Account', currency: 'EUR' },
      { id: 3, name: 'Pension', accountType: 'Retirement Fund', currency: 'CHF', includeInLiquidNetWorth: false },
      { id: 4, name: 'Hidden', accountType: 'Cash Account', currency: 'CHF', includeInNetWorth: false, includeInLiquidNetWorth: true },
      { id: 5, name: 'Car', accountType: 'Tangible Asset', currency: 'CHF' },
    ],
    transactions: [
      deposit(1, '2026-01-05', 100, { balanceAfter: 100 }),
      { accountId: 1, type: 'valuation', date: '2026-01-05', amount: 150, balanceAfter: 150 },
      deposit(1, '2026-03-01', 50, { balanceAfter: 200 }),
      deposit(2, '2026-01-10', 1000, { balanceAfter: 1000 }),
      { accountId: 2, type: 'valuation', date: '2026-02-28', amount: 1100, balanceAfter: 1100 },
      deposit(3, '2026-01-01', 5000, { balanceAfter: 5000 }),
      deposit(4, '2026-01-01', 700, { balanceAfter: 700 }),
    ],
    assets: [{ id: 1, accountId: 5, purchaseValue: 20000, depreciationPct: 0, purchaseDate: '2026-02-01', currency: 'CHF', accountType: 'Tangible Asset' }],
    rateEntries: [{ date: '2026-01-01', rates: { EUR: 0.9 } }, { date: '2026-02-15', rates: { EUR: 1.0 } }],
    todaysMetalPrices: null,
    mainCurrency: 'CHF',
    ...overrides,
  });
}

test('account value on a date: last balance on or before it, last entered wins on a day', () => {
  const context = sampleContext();
  const cash = context.accounts[0];
  assert.strictEqual(context.accountValue(cash, '2026-01-04'), 0);
  assert.strictEqual(context.accountValue(cash, '2026-01-05'), 150);
  assert.strictEqual(context.accountValue(cash, '2026-02-01'), 150);
  assert.strictEqual(context.accountValue(cash), 200);
});

test('account value in the main currency uses the rate of the valuation date', () => {
  const context = sampleContext();
  const broker = context.accounts[1];
  assertNear(context.accountValueInMain(broker, '2026-02-01'), 900, '1000 EUR at 0.9');
  assertNear(context.accountValueInMain(broker, '2026-03-01'), 1100, '1100 EUR at 1.0');
});

test('asset accounts are valued from their assets', () => {
  const context = sampleContext();
  const car = context.accounts[4];
  assert.strictEqual(context.accountValue(car, '2026-01-15'), 0);
  assert.strictEqual(context.accountValue(car, '2026-03-01'), 20000);
});

test('net worth leaves out excluded accounts; liquid net worth is a part of it', () => {
  const context = sampleContext();
  const onDate = context.netWorth('2026-03-01');
  assertNear(onDate.netWorth, 200 + 1100 + 5000 + 20000, 'net worth');
  assertNear(onDate.liquidNetWorth, 200 + 1100 + 20000, 'liquid: no pension, and never an account outside net worth');
});

test('monthly returns remove the capital added during the month', () => {
  const context = sampleContext();
  const returns = context.monthlyReturns(new Set([2]));
  assertNear(returns['2026-01'].profitLoss, 0, 'January: 1000 EUR deposited, nothing earned');
  // February: start 900 CHF (1000 EUR at 0.9), end 1100 CHF (1100 EUR at 1.0), no capital added
  assertNear(returns['2026-02'].profitLoss, 200, 'February result');
  assertNear(returns['2026-02'].percent, (200 / 900) * 100, 'February percent');
});

test('value breakdown: money put in so far, and each change split into money added and gain', () => {
  const context = sampleContext();
  const accountIds = new Set([2]);
  const monthTotals = context.monthEndTotals(accountIds);
  const points = Object.keys(monthTotals).sort().map(month => ({ month, value: monthTotals[month] }));
  const { months, summary } = valuation.valueBreakdown(points, context.monthlyReturns(accountIds));
  // January: 1000 EUR deposited at 0.9 (900 CHF). February: worth 1100 CHF, nothing added.
  assertNear(months[0].moneyPutIn, 900, 'January money put in');
  assertNear(months[1].moneyPutIn, 900, 'February money put in');
  assertNear(months[1].capitalAdded, 0, 'February money added');
  assertNear(months[1].gain, 200, 'February gain');
  assertNear(months[1].change, 200, 'February change');
  assertNear(summary.startValue, 0, 'whole range starts before the first deposit');
  assertNear(summary.capitalAdded, 900, 'whole range money added');
  assertNear(summary.profitLoss, 200, 'whole range gain');

  // A range starting in February counts January's deposit as already put in
  const february = valuation.valueBreakdown(points.slice(1), context.monthlyReturns(accountIds));
  assertNear(february.months[0].moneyPutIn, 900, 'money put in before the range');
  assertNear(february.summary.startValue, 900, 'February starts at the January month-end value');
  assertNear(february.summary.percent, (200 / 900) * 100, 'February return');
});

test('monthly values: a property counts its owned share net of the mortgage, repayments are capital', () => {
  const context = valuation.createValuationContext({
    accounts: [{ id: 7, name: 'House', accountType: 'Real Estate', currency: 'CHF' }],
    transactions: [{ id: 1, accountId: 7, assetId: 4, type: 'asset-add', amount: 1000000, date: '2025-01-15', balanceAfter: 100000 }],
    assets: [{
      id: 4, accountId: 7, purchaseValue: 1000000, debt: 800000, ownershipPct: 50, purchaseDate: '2025-01-15', currency: 'CHF', accountType: 'Real Estate',
      mortgageBalances: [{ date: '2025-03-10', amount: 700000 }],
      valuations: [{ date: '2025-05-20', value: 1100000 }],
    }],
    rateEntries: [],
    todaysMetalPrices: null,
    mainCurrency: 'CHF',
  });
  const { totals, results } = context.monthlyValues(new Set([7]));
  assertNear(totals['2025-01'], 100000, '1M house, 800k mortgage, 50% owned: 100k');
  assertNear(results['2025-01'].capitalAdded, 100000, 'the purchase puts in the owned equity');
  assertNear(results['2025-01'].profitLoss, 0, 'no gain on the purchase');
  assertNear(totals['2025-03'], 150000, 'mortgage down to 700k: (1M - 700k) x 50%');
  assertNear(results['2025-03'].capitalAdded, 50000, 'the 100k repayment puts in 50k');
  assertNear(results['2025-03'].profitLoss, 0, 'a repayment is no gain');
  assertNear(totals['2025-05'], 200000, 'valued at 1.1M: (1.1M - 700k) x 50%');
  assertNear(results['2025-05'].profitLoss, 50000, 'the new valuation is gain');
  assertNear(totals[today.substring(0, 7)], context.netWorth().netWorth, 'this month matches net worth');
});

test('performance since a date and recorded totals', () => {
  const context = sampleContext();
  const accountIds = new Set([1]);
  const result = context.performanceSince(accountIds, '2026-02-01', 200);
  // At the cutoff: 150. Capital since: 50 deposited. End: 200. Result: 0.
  assertNear(result.profitLoss, 0, 'performance');
  assertNear(context.recordedTotal(accountIds, '2026-01-05'), 150, 'on the day');
  assertNear(context.recordedTotal(accountIds, '2026-01-05', true), 0, 'strictly before the day');
  assertNear(context.capitalAddedBetween(accountIds, '2026-01-01', '2026-12-31'), 150, 'deposits of 100 and 50');
});

test('buying or selling a property moves only the owned equity as capital', () => {
  const context = valuation.createValuationContext({
    accounts: [{ id: 6, name: 'Flat', accountType: 'Real Estate', currency: 'CHF' }],
    transactions: [
      { id: 1, accountId: 6, assetId: 2, type: 'asset-add', amount: 900000, date: '2024-06-01', balanceAfter: 150000 },
      { id: 2, accountId: 6, assetId: 3, type: 'asset-add', amount: 100000, date: '2024-07-01', balanceAfter: 150000 + 90000 },
    ],
    assets: [
      { id: 2, accountId: 6, purchaseValue: 900000, debt: 600000, ownershipPct: 50, purchaseDate: '2024-06-01', currency: 'CHF', accountType: 'Real Estate' },
      { id: 3, accountId: 6, purchaseValue: 100000, debt: 0, ownershipPct: 100, purchaseDate: '2024-07-01', currency: 'EUR', accountType: 'Real Estate' },
    ],
    rateEntries: [{ date: '2024-01-01', rates: { EUR: 0.9 } }],
    todaysMetalPrices: null,
    mainCurrency: 'CHF',
  });
  const returns = context.monthlyReturns(new Set([6]), { includeAssetEvents: true });
  assertNear(returns['2024-06'].profitLoss, 0, 'a 900k flat with a 600k mortgage at 50% brings in 150k, not 900k');
  assertNear(returns['2024-07'].profitLoss, 0, 'a 100k EUR studio counts at its own currency rate (90k CHF)');
  assertNear(context.capitalInMain({ accountId: 6, assetId: 2, type: 'asset-sell', amount: 1100000 }, { includeAssetEvents: true }), -250000, 'sold for 1.1M: (1.1M - 600k) x 50% leaves');
});

test('an account without transactions counts its stored value only today', () => {
  const context = sampleContext({ transactions: [] });
  const cash = context.accounts[0];
  assert.strictEqual(context.accountValue(cash), 999);
  assert.strictEqual(context.accountValue(cash, today), 999);
  assert.strictEqual(context.accountValue(cash, '2020-01-01'), 0);
});

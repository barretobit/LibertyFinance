// Exchange rates and asset valuation: js/utils.js
const { loadScripts, assertNear, test, assert } = require('./helpers');

const utils = loadScripts(['js/utils.js'], [
  'chfPerUnit', 'currencyRateTo', 'currenciesWithoutRate', 'assetFullValue', 'assetCurrentValue', 'assetOwnedCost',
  'assetRealizedPL', 'assetAccountMetrics', 'isIsoDate', 'escapeHtml', 'signedCurrency', 'signedPercent',
]);

// Rates are stored as "1 unit = rate CHF"
const rates = [
  { date: '2026-01-01', rates: { EUR: 0.95, USD: 0.90 } },
  { date: '2026-06-01', rates: { EUR: 0.93, USD: 0.80 } },
];

test('CHF value of a currency on a date', () => {
  assertNear(utils.chfPerUnit(rates, 'CHF', '2026-03-01'), 1, 'CHF is the base');
  assertNear(utils.chfPerUnit(rates, 'EUR', '2026-03-01'), 0.95, 'latest rate on or before the date');
  assertNear(utils.chfPerUnit(rates, 'EUR', '2025-01-01'), 0.95, 'before every rate: the earliest one');
  assertNear(utils.chfPerUnit(rates, 'EUR', '2026-07-01'), 0.93, 'after every rate: the latest one');
  assert.strictEqual(utils.chfPerUnit(rates, 'JPY', '2026-03-01'), null);
});

test('conversions go through CHF, whatever the main currency', () => {
  assertNear(utils.currencyRateTo(rates, 'EUR', 'CHF', '2026-06-01'), 0.93, 'EUR into CHF');
  assertNear(utils.currencyRateTo(rates, 'CHF', 'EUR', '2026-06-01'), 1 / 0.93, 'CHF into EUR');
  assertNear(utils.currencyRateTo(rates, 'USD', 'EUR', '2026-06-01'), 0.80 / 0.93, 'USD into EUR');
  assertNear(utils.currencyRateTo(rates, 'EUR', 'EUR', '2026-06-01'), 1, 'same currency');
});

test('a currency without any rate counts 1:1 and is reported', () => {
  assertNear(utils.currencyRateTo(rates, 'JPY', 'CHF', '2026-06-01'), 1, 'missing rate');
  assert.deepStrictEqual(utils.currenciesWithoutRate(rates, ['JPY', 'EUR', 'CHF', 'GBP', 'JPY', null]), ['GBP', 'JPY']);
});

const car = { purchaseValue: 20000, purchaseDate: '2026-01-01', depreciationPct: 0, ownershipPct: 50, accountType: 'Tangible Asset', debt: 999 };

test('ownership share applies to value, cost and realized P&L', () => {
  assertNear(utils.assetCurrentValue(car, '2026-06-01'), 10000, 'value of the owned half');
  assertNear(utils.assetOwnedCost(car), 10000, 'cost of the owned half; debt only counts for Real Estate');
  assertNear(utils.assetAccountMetrics([car], '2026-06-01').pl, 0, 'no loss on day one');
  assertNear(utils.assetCurrentValue({ ...car, ownershipPct: 0 }, '2026-06-01'), 0, '0% stays 0%');
  assertNear(utils.assetCurrentValue({ ...car, ownershipPct: undefined }, '2026-06-01'), 20000, 'missing means 100%');
  assertNear(utils.assetRealizedPL({ ...car, sold: true, saleValue: 16000, saleDate: '2026-09-01' }), -2000, 'realized on the owned half');
});

test('an asset counts from its purchase date until its sale date', () => {
  const soldCar = { ...car, sold: true, saleValue: 16000, saleDate: '2026-09-01' };
  assertNear(utils.assetCurrentValue(car, '2025-12-31'), 0, 'before the purchase');
  assertNear(utils.assetCurrentValue(soldCar, '2026-08-31'), 10000, 'before the sale');
  assertNear(utils.assetCurrentValue(soldCar, '2026-09-01'), 0, 'from the sale date');
  assertNear(utils.assetCurrentValue(soldCar), 0, 'today');
});

test('straight-line depreciation, and appreciation with a negative percent', () => {
  const laptop = { purchaseValue: 1000, purchaseDate: '2024-01-01', depreciationPct: 25, accountType: 'Tangible Asset' };
  assert.ok(Math.abs(utils.assetFullValue(laptop, '2026-01-01') - 500) < 1, 'two years at 25% a year');
  assertNear(utils.assetFullValue(laptop, '2030-01-01'), 0, 'never below zero');
  const painting = { ...laptop, depreciationPct: -10 };
  assert.ok(Math.abs(utils.assetFullValue(painting, '2026-01-01') - 1200) < 1, 'two years at +10% a year');
});

const flat = { purchaseValue: 800000, purchaseDate: '2020-01-01', depreciationPct: 0, ownershipPct: 50, debt: 500000, accountType: 'Real Estate' };

test('Real Estate: equity share is the owned part of value minus mortgage', () => {
  assertNear(utils.assetFullValue(flat, '2026-01-01'), 800000, 'full value');
  assertNear(utils.assetCurrentValue(flat, '2026-01-01'), 150000, '(800k - 500k) x 50%');
  assertNear(utils.assetOwnedCost(flat), 150000, 'same for the cost basis');
});

test('Real Estate valuations apply from their date on', () => {
  const valuedFlat = { ...flat, valuations: [{ date: '2024-01-01', value: 900000 }, { date: '2026-01-01', value: 1000000 }] };
  assertNear(utils.assetFullValue(valuedFlat, '2023-12-31'), 800000, 'before the first valuation: purchase value');
  assertNear(utils.assetFullValue(valuedFlat, '2025-06-01'), 900000, 'latest valuation on or before the date');
  assertNear(utils.assetCurrentValue(valuedFlat, '2026-06-01'), 250000, '(1.0M - 500k) x 50%');
  const appreciatingFlat = { ...valuedFlat, depreciationPct: -2 };
  assert.ok(Math.abs(utils.assetFullValue(appreciatingFlat, '2027-01-01') - 1020000) < 100, 'depreciation restarts at the valuation date');
});

test('small helpers', () => {
  assert.ok(utils.isIsoDate('2026-11-12'));
  assert.ok(!utils.isIsoDate("2026-11-12');alert(1)//"));
  assert.ok(!utils.isIsoDate(undefined));
  assert.strictEqual(utils.escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.strictEqual(utils.escapeHtml(null), '');
  assert.strictEqual(utils.signedPercent(1.234, 2), '+1.23%');
  assert.strictEqual(utils.signedPercent(-1.234, 1), '-1.2%');
});

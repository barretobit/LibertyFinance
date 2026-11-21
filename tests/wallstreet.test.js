// Wall Street price conversion: London shares are quoted in pence (GBp), indexes in points.
const { loadScripts, assertNear, test, assert } = require('./helpers');

const { wallStreetStockCurrency, wallStreetRateMap, wallStreetCurrencyScale, wallStreetUsdPerUnit } = loadScripts(
  ['js/pages-wallstreet.js'],
  ['wallStreetStockCurrency', 'wallStreetRateMap', 'wallStreetCurrencyScale', 'wallStreetUsdPerUnit'],
  { Pages: {} },
);

const fxAssets = [{ symbol: 'GBPUSD=X', class: 'fx' }, { symbol: 'CHFUSD=X', class: 'fx' }];
const fxData = { 'GBPUSD=X': [{ date: '2026-11-20', close: 1.3 }], 'CHFUSD=X': [{ date: '2026-11-20', close: 1.25 }] };
const usdPerUnit = wallStreetRateMap(fxData, fxAssets);

test('London shares are quoted in pence, other listings keep their currency', () => {
  assert.strictEqual(wallStreetStockCurrency('HSBA.L'), 'GBp');
  assert.strictEqual(wallStreetStockCurrency('NESN.SW'), 'CHF');
  assert.strictEqual(wallStreetStockCurrency('AAPL'), 'USD');
});

test('a pence quote converts to a hundredth of the pound price', () => {
  // HSBA.L closes around 1280 pence: GBP 12.80, not GBP 1280.
  assertNear(1280 * wallStreetCurrencyScale(usdPerUnit, 'GBp', 'GBP'), 12.8, 'GBP');
  assertNear(1280 * wallStreetCurrencyScale(usdPerUnit, 'GBp', 'USD'), 12.8 * 1.3, 'USD');
  assertNear(1280 * wallStreetCurrencyScale(usdPerUnit, 'GBp', 'CHF'), 12.8 * 1.3 / 1.25, 'CHF');
});

test('pounds and other currencies convert as before', () => {
  assertNear(wallStreetCurrencyScale(usdPerUnit, 'GBP', 'USD'), 1.3, 'GBP to USD');
  assertNear(wallStreetCurrencyScale(usdPerUnit, 'CHF', 'GBP'), 1.25 / 1.3, 'CHF to GBP');
  assert.strictEqual(wallStreetCurrencyScale(usdPerUnit, 'KRW', 'USD'), null);
});

test('pence have no rate without a pound rate', () => {
  assert.strictEqual(wallStreetCurrencyScale({ USD: 1 }, 'GBp', 'USD'), null);
  assert.strictEqual(wallStreetUsdPerUnit(() => null, 'GBp'), null);
});

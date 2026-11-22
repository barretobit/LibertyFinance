// Game rules tests: `node game/engine.test.js`
const { test, assert, assertNear, runRegisteredTests } = require('../tests/helpers');
const GameEngine = require('./engine');
const GameTangibles = require('./tangibles');
const GameIntraday = require('./intraday');

// A market where every symbol's CHF price is fixed per date, else the last earlier one.
// Optional tangible info per symbol ({ depreciation, kind, location }) for cars, watches, art and houses,
// and CHF dividends per unit by symbol and ex-dividend date.
function fakeMarket(pricesBySymbol, tangibleBySymbol = {}, dividendsBySymbol = {}) {
  const quote = (symbol, date) => {
    const dates = Object.keys(pricesBySymbol[symbol] || {}).filter((day) => day <= date).sort();
    const day = dates[dates.length - 1];
    return day ? { priceChf: pricesBySymbol[symbol][day], date: day } : null;
  };
  return {
    quote, benchmark: (date) => (quote('^SSMI', date) || {}).priceChf || null, tangible: (symbol) => tangibleBySymbol[symbol] || null,
    dividend: (symbol, date) => (dividendsBySymbol[symbol] || {})[date] || null,
  };
}

function newGame(difficulty, startDate, location = 'zurich') {
  return GameEngine.newGame({ name: 'Test', location: location, difficulty: difficulty, startDate: startDate });
}

// Cash the trades made, with the salary and bills of the same game without trades taken out.
function cashFromTrades(game, market, date) {
  const withoutTrades = Object.assign({}, game, { trades: [] });
  return GameEngine.replay(game, market, date).cash - GameEngine.replay(withoutTrades, market, date).cash;
}

const swissStock = { symbol: 'NESN.SW', class: 'stock', name: 'Nestle' };
const usEtf = { symbol: 'VOO', class: 'etf', name: 'Vanguard S&P 500' };
const bitcoin = { symbol: 'BTC-USD', class: 'crypto', name: 'Bitcoin' };

test('stamp duty: 0.075% Swiss, 0.15% foreign, none on crypto and metals', () => {
  assert.strictEqual(GameEngine.stampDutyRate(swissStock), 0.00075);
  assert.strictEqual(GameEngine.stampDutyRate(usEtf), 0.0015);
  assert.strictEqual(GameEngine.stampDutyRate(bitcoin), 0);
  assert.strictEqual(GameEngine.stampDutyRate({ symbol: 'GC=F', class: 'metal' }), 0);
});

test('wealth tax: Zürich bands times the multiplier, each city its own tariff', () => {
  assert.strictEqual(GameEngine.wealthTax(80000, 'zurich'), 0);
  assert.strictEqual(GameEngine.wealthTax(-5000, 'zurich'), 0);
  // 238k at 0.05% + 399k at 0.1% + 283k at 0.15% = 942.5 simple tax
  assertNear(GameEngine.wealthTax(1000000, 'zurich'), 942.5 * 2.14, 'tax on 1M');
  // Bern: 200k at 0.25% + 700k at 0.45%
  assertNear(GameEngine.wealthTax(1000000, 'bern'), 500 + 3150, 'Bern tax on 1M');
  const onMillion = ['zug', 'zurich', 'bern', 'basel', 'geneva'].map((city) => GameEngine.wealthTax(1000000, city));
  assert.deepStrictEqual(onMillion.slice().sort((a, b) => a - b), onMillion, 'Zug lowest, Geneva highest: ' + onMillion);
  Object.keys(GameEngine.LOCATIONS).forEach((city) => assert.strictEqual(GameEngine.wealthTax(50000, city), 0, city + ' taxes 50k'));
});

test('salary and income tax depend on the city and the difficulty', () => {
  assert.strictEqual(GameEngine.yearlySalary('zurich', 'medium'), 95000);
  assert.ok(GameEngine.yearlySalary('zurich', 'easy') > GameEngine.yearlySalary('zurich', 'medium'));
  assert.ok(GameEngine.yearlySalary('zurich', 'hard') < GameEngine.yearlySalary('zurich', 'medium'));
  assertNear(GameEngine.incomeTax('zurich', 75000), 75000 * 0.085, 'tax at a table point');
  assertNear(GameEngine.incomeTax('zurich', 87500), 87500 * 0.0975, 'tax halfway between points');
  assert.ok(GameEngine.incomeTax('zug', 100000) < GameEngine.incomeTax('geneva', 100000), 'Zug taxes less than Geneva');
  assert.throws(() => GameEngine.newGame({ name: 'x', location: 'lugano', difficulty: 'easy', startDate: '2026-01-01' }));
  // Every start leaves something to save each month.
  Object.keys(GameEngine.LOCATIONS).forEach((city) => Object.keys(GameEngine.DIFFICULTIES).forEach((level) => {
    const budget = GameEngine.monthlyBudget(newGame(level, '2026-01-01', city), fakeMarket({}), []);
    assert.ok(budget.savingsChf > 0, city + ' ' + level + ' saves ' + budget.savingsChf);
  }));
});

test('salary and bills are paid on the last day of the month, pro rata in the first month', () => {
  const market = fakeMarket({ '^SSMI': { '2026-01-01': 10000 } });
  const game = newGame('medium', '2026-01-16');
  const budget = GameEngine.monthlyBudget(game, market, []);
  assert.ok(budget.expenses.some((line) => line.label.startsWith('RENT')), 'a renter pays rent');
  assert.strictEqual(GameEngine.replay(game, market, '2026-01-30').cash, 100000);
  const state = GameEngine.replay(game, market, '2026-01-31');
  const month = state.events.find((event) => event.type === 'month');
  assertNear(month.salaryChf, budget.netSalaryChf * 16 / 31, 'net salary for 16 days');
  assertNear(month.expensesChf, budget.expensesChf * 16 / 31, 'expenses for 16 days');
  assertNear(state.cash, 100000 + budget.savingsChf * 16 / 31, 'cash after the month');
  // With a flat SMI, the same money in the SMI is worth exactly the money put in.
  const last = state.days[state.days.length - 1];
  assertNear(last.moneyIn, state.cash, 'money put in');
  assertNear(last.benchmark, last.moneyIn, 'benchmark follows the savings');
});

test('buy then price rise: cash, quantity and net worth follow', () => {
  const market = fakeMarket({ 'NESN.SW': { '2026-01-05': 100, '2026-01-07': 110 }, '^SSMI': { '2026-01-05': 10000, '2026-01-07': 10500 } });
  const game = newGame('hard', '2026-01-05');
  const trade = GameEngine.buy(game, market, swissStock, { amountChf: 5000 }, '2026-01-05');
  assert.ok(!trade.error, trade.error);
  assertNear(trade.quantity, 50, 'quantity');
  assertNear(trade.stampDutyChf, 3.75, 'duty');
  game.trades.push(trade);
  const state = GameEngine.replay(game, market, '2026-01-07');
  assertNear(state.cash, 10000 - 5003.75, 'cash');
  assertNear(state.days[2].netWorth, 4996.25 + 50 * 110, 'net worth');
  assertNear(state.days[2].benchmark, 10500, 'benchmark');
  assert.strictEqual(state.days.length, 3);
});

test('buy refuses more than the cash and stale prices', () => {
  const market = fakeMarket({ 'VOO': { '2026-01-05': 500 } });
  const game = newGame('hard', '2026-01-05');
  assert.strictEqual(GameEngine.buy(game, market, usEtf, { amountChf: 10000 }, '2026-01-05').error, 'NOT ENOUGH CASH');
  assert.ok(GameEngine.buy(game, market, usEtf, { amountChf: 100 }, '2026-02-01').error.startsWith('NO RECENT PRICE'));
  assert.strictEqual(GameEngine.buy(game, market, usEtf, { amountChf: 0 }, '2026-01-05').error, 'ENTER AN AMOUNT');
  const preview = GameEngine.previewBuy(game, market, usEtf, { amountChf: 10000 }, '2026-01-05');
  assertNear(preview.cashNeededChf, 10015, 'the preview still shows the costs');
});

test('sell half then all: average cost and the holding go away', () => {
  const market = fakeMarket({ 'BTC-USD': { '2026-01-05': 1000, '2026-03-01': 2000 } });
  const game = newGame('hard', '2026-01-05');
  game.trades.push(GameEngine.buy(game, market, bitcoin, { amountChf: 4000 }, '2026-01-05'));
  game.trades.push(GameEngine.sell(game, market, 'BTC-USD', { fraction: 0.5 }, '2026-03-01'));
  const state = GameEngine.replay(game, market, '2026-03-01');
  assertNear(state.positions[0].quantity, 2, 'quantity left');
  assertNear(state.positions[0].costChf, 2000, 'cost left');
  assertNear(cashFromTrades(game, market, '2026-03-01'), -4000 + 4000, 'cash after half');
  game.trades.push(GameEngine.sell(game, market, 'BTC-USD', { fraction: 1 }, '2026-03-01'));
  assert.strictEqual(GameEngine.replay(game, market, '2026-03-01').positions.length, 0);
  assertNear(cashFromTrades(game, market, '2026-03-01'), 4000, 'cash after all');
});

test('wealth tax on 31 December with the city tariff, pro rata for a game started during the year', () => {
  const market = fakeMarket({});
  ['zurich', 'geneva'].forEach((city) => {
    const game = newGame('easy', '2026-07-02', city);
    const state = GameEngine.replay(game, market, '2027-01-01');
    const tax = state.events.find((event) => event.type === 'tax');
    const daysTaxed = 183; // 2 July to 31 December
    assertNear(tax.amountChf, GameEngine.wealthTax(tax.wealthChf, city) * daysTaxed / 365, city + ' tax');
    assertNear(state.taxesPaid, tax.amountChf, city + ' taxes paid');
  });
});

test('trader status: a quick sale is under review, plus heavy volume is a risk', () => {
  const market = fakeMarket({ 'BTC-USD': { '2026-01-05': 1000 } });
  const game = newGame('hard', '2026-01-05');
  game.trades.push(GameEngine.buy(game, market, bitcoin, { amountChf: 1000 }, '2026-01-05'));
  assert.strictEqual(GameEngine.replay(game, market, '2026-01-05').trader.status, 'private');
  game.trades.push(GameEngine.sell(game, market, 'BTC-USD', { fraction: 1 }, '2026-01-06'));
  assert.strictEqual(GameEngine.replay(game, market, '2026-01-06').trader.status, 'review');
  for (let round = 0; round < 6; round++) {
    game.trades.push(GameEngine.buy(game, market, bitcoin, { amountChf: 9000 }, '2026-01-07'));
    game.trades.push(GameEngine.sell(game, market, 'BTC-USD', { fraction: 1 }, '2026-01-07'));
  }
  const trader = GameEngine.replay(game, market, '2026-01-07').trader;
  assert.ok(trader.volumeMultiple > 5, 'volume multiple ' + trader.volumeMultiple);
  assert.strictEqual(trader.status, 'risk');
});

test('buy by quantity: the amount is quantity times price, stamp duty on top', () => {
  const market = fakeMarket({ 'VOO': { '2026-01-05': 500 } });
  const game = newGame('hard', '2026-01-05');
  const trade = GameEngine.buy(game, market, usEtf, { quantity: 3 }, '2026-01-05');
  assertNear(trade.amountChf, 1500, 'amount');
  assertNear(trade.stampDutyChf, 2.25, 'duty');
  assert.strictEqual(GameEngine.buy(game, market, usEtf, { quantity: 0 }, '2026-01-05').error, 'ENTER A QUANTITY');
});

const familyCar = { symbol: 'car-suv', class: 'car', name: 'Family SUV' };

test('tangibles: whole units only, outside the trader rules', () => {
  const market = fakeMarket({ 'car-suv': { '2026-01-05': 50000 } });
  const game = newGame('medium', '2026-01-05');
  assert.strictEqual(GameEngine.buy(game, market, familyCar, { quantity: 0.5 }, '2026-01-05').error, 'BUY WHOLE UNITS');
  assert.strictEqual(GameEngine.buy(game, market, familyCar, { amountChf: 30000 }, '2026-01-05').error, 'BUY WHOLE UNITS');
  game.trades.push(GameEngine.buy(game, market, familyCar, { quantity: 1 }, '2026-01-05'));
  game.trades.push(GameEngine.sell(game, market, 'car-suv', { fraction: 1 }, '2026-01-06'));
  const state = GameEngine.replay(game, market, '2026-01-06');
  assert.strictEqual(state.trader.status, 'private');
  assertNear(state.trader.volumeMultiple, 0, 'tangibles add no volume');
});

test('cars: one car loses its full rate, two cars share the kilometres and lose less each', () => {
  const prices = { 'car-suv': { '2026-01-05': 50000, '2027-01-05': 50000 } };
  const market = fakeMarket(prices, { 'car-suv': { depreciation: -0.2, kind: 'suv' } });
  const yearLater = '2027-01-05';
  const ageFactor = (rate) => Math.pow(1 + rate, 365 / 365.25);

  const oneCar = newGame('medium', '2026-01-05');
  oneCar.trades.push(GameEngine.buy(oneCar, market, familyCar, { quantity: 1 }, '2026-01-05'));
  assertNear(GameEngine.replay(oneCar, market, yearLater).positions[0].valueChf, 50000 * ageFactor(-0.2), 'one car after a year');

  const twoCars = newGame('medium', '2026-01-05');
  twoCars.trades.push(GameEngine.buy(twoCars, market, familyCar, { quantity: 2 }, '2026-01-05'));
  const state = GameEngine.replay(twoCars, market, yearLater);
  const eachRate = -0.2 * (0.5 + 0.5 / 2);
  assertNear(state.positions[0].valueChf, 2 * 50000 * ageFactor(eachRate), 'two cars after a year');
  const trade = GameEngine.sell(twoCars, market, 'car-suv', { quantity: 1 }, yearLater);
  assertNear(trade.amountChf, 50000 * ageFactor(eachRate), 'sale price');
  assertNear(trade.dealerFeeChf, 5000 * ageFactor(eachRate), 'dealer fee');
  assert.strictEqual(trade.stampDutyChf, 0);
  twoCars.trades.push(trade);
  const afterSale = GameEngine.replay(twoCars, market, yearLater);
  assertNear(afterSale.positions[0].quantity, 1, 'one car left');
  assertNear(afterSale.cash - state.cash, 50000 * ageFactor(eachRate) * 0.9, 'cash from the sale');
  assert.ok(GameEngine.sell(twoCars, market, 'car-suv', { quantity: 2 }, yearLater).error.startsWith('YOU ONLY HOLD'));
});

test('cars: running costs grow with the price, a car replaces the transport pass', () => {
  const cheap = GameEngine.carMonthlyCosts('zurich', { kind: 'compact' }, 30000, 1);
  const dear = GameEngine.carMonthlyCosts('zurich', { kind: 'supercar' }, 300000, 1);
  assert.ok(dear.insuranceChf > cheap.insuranceChf && dear.roadTaxChf > cheap.roadTaxChf && dear.fuelAndServiceChf > cheap.fuelAndServiceChf);
  const shared = GameEngine.carMonthlyCosts('zurich', { kind: 'compact' }, 30000, 2);
  assertNear(shared.fuelAndServiceChf, cheap.fuelAndServiceChf / 2, 'two cars split the kilometres');
  assertNear(shared.insuranceChf, cheap.insuranceChf, 'each car is insured on its own');

  const market = fakeMarket({ 'car-suv': { '2026-01-05': 50000 } }, { 'car-suv': { depreciation: -0.15, kind: 'suv' } });
  const game = newGame('medium', '2026-01-05');
  const before = GameEngine.monthlyBudget(game, market, []);
  game.trades.push(GameEngine.buy(game, market, familyCar, { quantity: 1 }, '2026-01-05'));
  const after = GameEngine.replay(game, market, '2026-01-05').budget;
  const carLine = after.expenses.find((line) => line.label.startsWith('CAR: '));
  assertNear(carLine.amountChf, GameEngine.carMonthlyCosts('zurich', { kind: 'suv' }, 50000, 1).totalChf, 'car line');
  assert.ok(before.expenses.some((line) => line.label === 'PUBLIC TRANSPORT PASS'));
  assert.ok(!after.expenses.some((line) => line.label === 'PUBLIC TRANSPORT PASS'));
});

test('tangible prices: same item and date give the same price, near the trend', () => {
  const first = GameTangibles.quote('watch-rolex-submariner', '2026-06-15');
  assert.strictEqual(first.priceChf, GameTangibles.quote('watch-rolex-submariner', '2026-06-15').priceChf);
  const countOf = (assetClass) => GameTangibles.ITEMS.filter((item) => item.class === assetClass).length;
  assert.deepStrictEqual([countOf('car'), countOf('watch'), countOf('art'), countOf('house')], [30, 20, 10, 20]);
  assert.strictEqual(new Set(GameTangibles.ITEMS.map((item) => item.id)).size, GameTangibles.ITEMS.length, 'ids are unique');
  GameTangibles.ITEMS.forEach((item) => {
    const years = 3;
    const trend = item.priceChf * Math.pow(1 + item.trend, years);
    const { priceChf } = GameTangibles.quote(item.id, '2029-01-01');
    assert.ok(Math.abs(priceChf / trend - 1) <= item.wiggle + 0.01, item.id + ' strays from its trend: ' + priceChf);
    if (item.class === 'house') assert.ok(GameEngine.HOUSE_LOCATIONS[item.location], item.id + ' has no known city');
    if (item.class === 'car') assert.ok(item.kind, item.id + ' has no kind');
  });
  Object.keys(GameEngine.HOUSE_LOCATIONS).forEach((city) => {
    assert.strictEqual(GameTangibles.ITEMS.filter((item) => item.location === city).length, 4, city + ' has four homes');
  });
  assert.strictEqual(GameTangibles.quote('nope', '2026-01-01'), null);
});

test('property gains tax: bands, quick resale surcharge, long holding discount', () => {
  // 400 + 900 + 1600 + 3000 + 6000 + 17500 on the first 100k of gain
  assertNear(GameEngine.propertyGainsTax(100000, 3 * 366), 29400, 'held 3 years');
  assertNear(GameEngine.propertyGainsTax(100000, 100), 29400 * 1.5, 'held under a year');
  assertNear(GameEngine.propertyGainsTax(100000, 500), 29400 * 1.25, 'held under two years');
  assertNear(GameEngine.propertyGainsTax(100000, 10 * 366), 29400 * 0.8, 'held 10 years');
  assertNear(GameEngine.propertyGainsTax(100000, 25 * 366), 29400 * 0.5, 'held 25 years');
  assert.strictEqual(GameEngine.propertyGainsTax(-50000, 1000), 0);
});

const rowHouse = { symbol: 'house-basel', class: 'house', name: 'Row house' };

test('selling a house: purchase costs on buy, agent fee, then gains tax on the profit after both', () => {
  const market = fakeMarket({ 'house-basel': { '2026-01-05': 500000, '2029-01-05': 600000 } }, { 'house-basel': { depreciation: 0, location: 'basel' } });
  const game = newGame('easy', '2026-01-05');
  const buy = GameEngine.buy(game, market, rowHouse, { quantity: 1 }, '2026-01-05');
  assertNear(buy.purchaseCostsChf, 500000 * (0.015 + 0.004), 'Basel transfer tax and notary');
  assert.strictEqual(buy.mortgageChf, 0);
  game.trades.push(buy);
  assertNear(cashFromTrades(game, market, '2026-01-05'), -509500, 'cash for the house');
  const before = GameEngine.replay(game, market, '2029-01-05');
  assertNear(before.positions[0].costChf, 509500, 'purchase costs count in the cost');
  const trade = GameEngine.sell(game, market, 'house-basel', { quantity: 1 }, '2029-01-05');
  assertNear(trade.dealerFeeChf, 18000, 'agent fee');
  // Gain 582,000 - 509,500 = 72,500: 11,900 on the first 50k, 35% on the rest
  const gainsTax = 11900 + 22500 * 0.35;
  assertNear(trade.gainsTaxChf, gainsTax, 'gains tax');
  game.trades.push(trade);
  const after = GameEngine.replay(game, market, '2029-01-05');
  assertNear(after.cash - before.cash, 600000 - 18000 - gainsTax, 'cash from the sale');
  assertNear(after.taxesPaid - before.taxesPaid, gainsTax, 'gains tax counted as tax');
});

test('mortgage: 20% down, monthly payback, no rent, net worth minus the debt, repaid on sale', () => {
  const flat = { symbol: 'house-bern', class: 'house', name: 'Flat' };
  const market = fakeMarket({ 'house-bern': { '2026-03-01': 600000, '2026-04-15': 600000 } }, { 'house-bern': { depreciation: 0, location: 'bern' } });
  const game = newGame('easy', '2026-03-01');
  const preview = GameEngine.previewBuy(game, market, flat, { quantity: 1, downPayment: 0.2 }, '2026-03-01');
  assert.strictEqual(preview.error, null);
  const trade = preview.trade;
  assertNear(trade.mortgageChf, 480000, 'mortgage');
  assertNear(trade.amortizationChf, (480000 - 400000) / 180, 'payback of the part above two thirds over 15 years');
  assertNear(preview.cashNeededChf, 120000 + 600000 * (0.018 + 0.005), 'down payment and purchase costs');
  assert.ok(!preview.budgetAfter.expenses.some((line) => line.label.startsWith('RENT')), 'no rent with a home');
  assert.ok(preview.budgetAfter.expenses.some((line) => line.label.startsWith('MORTGAGE INTEREST')), 'interest is an expense');
  game.trades.push(trade);

  const endOfMonth = GameEngine.replay(game, market, '2026-03-31');
  assertNear(endOfMonth.mortgageChf, 480000 - trade.amortizationChf, 'a full month paid back');
  const last = endOfMonth.days[endOfMonth.days.length - 1];
  assertNear(last.netWorth, endOfMonth.cash + 600000 - endOfMonth.mortgageChf, 'net worth minus the mortgage');

  const sale = GameEngine.sell(game, market, 'house-bern', { quantity: 1 }, '2026-04-15');
  assertNear(sale.mortgageRepaidChf, endOfMonth.mortgageChf, 'the sale pays the mortgage back');
  game.trades.push(sale);
  const afterSale = GameEngine.replay(game, market, '2026-04-15');
  assert.strictEqual(afterSale.mortgageChf, 0);
  assert.ok(afterSale.budget.expenses.some((line) => line.label.startsWith('RENT')), 'rent again after the sale');
  const historyRow = afterSale.events.find((event) => event.type === 'sell');
  assertNear(historyRow.mortgageRepaidChf, sale.mortgageRepaidChf, 'history shows the payback');
});

test('mortgage: payback stops at two thirds of the price', () => {
  const flat = { symbol: 'house-bern', class: 'house', name: 'Flat' };
  const market = fakeMarket({ 'house-bern': { '2026-03-01': 600000 } }, { 'house-bern': { depreciation: 0, location: 'bern' } });
  const game = newGame('easy', '2026-03-01');
  const trade = GameEngine.buy(game, market, flat, { quantity: 1, downPayment: 0.2 }, '2026-03-01');
  game.trades.push(trade);
  // 180 monthly paybacks of 444.44 end in February 2041; the bank keeps the first 400k.
  const later = GameEngine.replay(game, market, '2042-06-30');
  assertNear(later.mortgageChf, 400000, 'two thirds of the price stays');
  assert.strictEqual(later.budget.amortizationChf, 0, 'no payback left in the budget');
  const lastMonth = later.events.filter((event) => event.type === 'month').pop();
  assert.strictEqual(lastMonth.amortizationChf, 0, 'no payback taken from the cash');
});

test('mortgage: at least 20% down and the bank affordability check', () => {
  const villa = { symbol: 'house-villa', class: 'house', name: 'Villa' };
  const market = fakeMarket({ 'house-villa': { '2026-03-01': 1200000 } }, { 'house-villa': { depreciation: 0, location: 'zurich' } });
  const game = newGame('easy', '2026-03-01');
  assert.strictEqual(GameEngine.buy(game, market, villa, { quantity: 1, downPayment: 0.1 }, '2026-03-01').error, 'DOWN PAYMENT: 20% TO 100%');
  // 960k mortgage: 48k interest + 12k upkeep + 10.7k payback, over a third of the 133k salary
  const tooMuch = GameEngine.previewBuy(game, market, villa, { quantity: 1, downPayment: 0.2 }, '2026-03-01');
  assert.ok(tooMuch.error.startsWith('MORTGAGE NOT AFFORDABLE'), tooMuch.error);
  assertNear(tooMuch.affordability.limitChf, 133000 / 3, 'limit');
  // 480k mortgage: 24k + 12k, under the limit
  const trade = GameEngine.buy(game, market, villa, { quantity: 1, downPayment: 0.6 }, '2026-03-01');
  assert.ok(!trade.error, trade.error);
  assert.strictEqual(trade.amortizationChf, 0, 'no payback under two thirds');
});

// The extra income tax a medium Zürich player (CHF 95,000 salary) pays on dividends after `earlierChf` of them this year.
function zurichDividendTax(earlierChf, amountChf) {
  return GameEngine.incomeTax('zurich', 95000 + earlierChf + amountChf) - GameEngine.incomeTax('zurich', 95000 + earlierChf);
}

test('dividends: paid in cash to the units held before the ex-date, minus the extra income tax', () => {
  const market = fakeMarket({ 'NESN.SW': { '2026-04-01': 100 }, '^SSMI': { '2026-04-01': 10000 } }, {}, { 'NESN.SW': { '2026-04-20': 3 } });
  const game = newGame('medium', '2026-04-01');
  game.trades.push(GameEngine.buy(game, market, swissStock, { quantity: 10 }, '2026-04-01'));

  const before = GameEngine.replay(game, market, '2026-04-19');
  const after = GameEngine.replay(game, market, '2026-04-20');
  const taxChf = zurichDividendTax(0, 30);

  assert.ok(taxChf > 30 * 0.15 && taxChf < 30 * 0.3, 'marginal tax ' + taxChf);
  assertNear(after.cash - before.cash, 30 - taxChf, 'net dividend');
  assertNear(after.taxesPaid - before.taxesPaid, taxChf, 'tax counted');
  assert.strictEqual(after.dividendsReceived, 30);
  const event = after.events.find((item) => item.type === 'dividend');
  assert.deepStrictEqual([event.symbol, event.quantity, event.perUnitChf, event.amountChf], ['NESN.SW', 10, 3, 30]);
});

test('dividends: a buy on the ex-date gets nothing, a sale on the ex-date still gets it', () => {
  const market = fakeMarket({ 'NESN.SW': { '2026-04-01': 100 }, '^SSMI': { '2026-04-01': 10000 } }, {}, { 'NESN.SW': { '2026-04-20': 3 } });
  const lateBuyer = newGame('medium', '2026-04-01');
  lateBuyer.trades.push(GameEngine.buy(lateBuyer, market, swissStock, { quantity: 10 }, '2026-04-20'));
  assert.strictEqual(GameEngine.replay(lateBuyer, market, '2026-04-30').dividendsReceived, 0);

  const seller = newGame('medium', '2026-04-01');
  seller.trades.push(GameEngine.buy(seller, market, swissStock, { quantity: 10 }, '2026-04-01'));
  seller.trades.push(GameEngine.sell(seller, market, 'NESN.SW', { fraction: 1 }, '2026-04-20'));
  assert.strictEqual(GameEngine.replay(seller, market, '2026-04-30').dividendsReceived, 30);
});

test('dividends: later ones in the year are taxed at the higher margin, nothing for assets not held', () => {
  const market = fakeMarket(
    { 'NESN.SW': { '2026-01-02': 100 }, VOO: { '2026-01-02': 500 }, '^SSMI': { '2026-01-02': 10000 } }, {},
    { 'NESN.SW': { '2026-04-20': 3, '2026-10-20': 3 }, VOO: { '2026-06-30': 2 } },
  );
  const game = newGame('easy', '2026-01-02');
  game.trades.push(GameEngine.buy(game, market, swissStock, { quantity: 1000 }, '2026-01-02'));
  const state = GameEngine.replay(game, market, '2026-12-30');
  const taxes = state.events.filter((item) => item.type === 'dividend').map((item) => item.taxChf);

  assert.strictEqual(state.dividendsReceived, 6000);
  assert.ok(taxes[1] > taxes[0], 'second dividend pays more: ' + taxes);
  const salary = GameEngine.yearlySalary('zurich', 'easy');
  assertNear(taxes[0] + taxes[1], GameEngine.incomeTax('zurich', salary + 6000) - GameEngine.incomeTax('zurich', salary), 'same as one payment');
});

test('benchmark: reinvests its dividend yield after tax, none without one', () => {
  const prices = { '^SSMI': { '2026-01-01': 10000 } };
  const game = newGame('medium', '2026-01-01');
  assertNear(GameEngine.replay(game, fakeMarket(prices), '2026-12-31').days.pop().benchmark, GameEngine.replay(game, fakeMarket(prices), '2026-12-31').days.pop().moneyIn, 'no yield');

  const withYield = Object.assign(fakeMarket(prices), { benchmarkDividendYield: 0.03 });
  const last = GameEngine.replay(game, withYield, '2026-12-31').days.pop();
  const gain = last.benchmark / last.moneyIn - 1;
  assert.ok(gain > 0.015 && gain < 0.03, 'benchmark gain ' + gain);
});

test('day trading hours: real local hours with daylight saving, each session inside one UTC day', () => {
  const nyWinter = GameIntraday.session('US', '2026-01-14');
  assert.deepStrictEqual([nyWinter.opensAt, nyWinter.closesAt], ['2026-01-14T14:30:00.000Z', '2026-01-14T21:00:00.000Z']);
  assert.strictEqual(GameIntraday.session('US', '2026-07-14').opensAt, '2026-07-14T13:30:00.000Z', 'New York in summer time');
  assert.strictEqual(GameIntraday.session('CH', '2026-07-14').closesAt, '2026-07-14T15:30:00.000Z', 'Zürich in summer time');
  ['2026-01-14', '2026-07-14'].forEach((date) => Object.keys(GameIntraday.MARKETS).forEach((market) => {
    const daySession = GameIntraday.session(market, date);
    assert.ok(daySession.opensAt.startsWith(date) && daySession.opensAt < daySession.closesAt, market + ' opens on ' + date);
    assert.ok(daySession.closesAt <= GameEngine.addDays(date, 1) + 'T00:00:00.000Z', market + ' closes on ' + date);
  }));
  // 2026-11-21 is a Saturday: only crypto trades.
  assert.strictEqual(GameIntraday.session('CH', '2026-11-21'), null);
  assert.strictEqual(GameIntraday.session('FUTURES', '2026-11-21'), null);
  assert.ok(GameIntraday.session('CRYPTO', '2026-11-21'));
  assert.strictEqual(GameIntraday.currentOrNextSession('CH', Date.parse('2026-11-21T10:00:00Z')).date, '2026-11-23', 'opens again on Monday');
  assert.strictEqual(GameIntraday.marketOf('stock', 'JP'), 'JP');
  assert.strictEqual(GameIntraday.marketOf('etf', 'NL'), 'US', 'unknown regions trade in New York');
  assert.strictEqual(GameIntraday.marketOf('car', 'US'), null);
});

test('day trading prices: the same walk for the same asset and day, starting at the last close', () => {
  const closes = Array.from({ length: 61 }, (unused, index) => 100 * Math.exp(0.01 * (index % 2 ? 1 : -1)));
  const first = GameIntraday.tradingDay('NESN.SW', 'CH', '2026-11-23', 100, closes);
  const again = GameIntraday.tradingDay('NESN.SW', 'CH', '2026-11-23', 100, closes);
  const nextDay = GameIntraday.tradingDay('NESN.SW', 'CH', '2026-11-24', 100, closes);
  assert.strictEqual(first.prices.length, 8.5 * 3600 / GameIntraday.STEP_SECONDS + 1);
  assert.strictEqual(first.prices[0], 100);
  assert.deepStrictEqual(Array.from(again.prices), Array.from(first.prices));
  assert.notStrictEqual(nextDay.prices[100], first.prices[100]);
  const opensMs = Date.parse(first.session.opensAt);
  assert.strictEqual(GameIntraday.priceAt(first, opensMs - 1000), 100, 'before the open');
  assert.strictEqual(GameIntraday.priceAt(first, opensMs + 25000), first.prices[2], 'one step every 10 seconds');
  assert.strictEqual(GameIntraday.priceAt(first, Date.parse(first.session.closesAt) + 60000), first.prices[first.prices.length - 1], 'after the close');
  assert.strictEqual(GameIntraday.tradingDay('NESN.SW', 'CH', '2026-11-22', 100, closes), null, 'closed on Sunday');
  assert.ok(Math.abs(GameIntraday.dailyVolatility(closes) - 0.02) < 0.001, 'volatility of +/-2% days');
  assert.strictEqual(GameIntraday.dailyVolatility([100, 101]), 0.02, 'default with too little history');
  // Over many days the walk ends near the start on average, with moves near twice the real 2% a day.
  const ends = Array.from({ length: 400 }, (unused, index) =>
    GameIntraday.tradingDay('TEST', 'CRYPTO', GameEngine.addDays('2026-01-01', index), 100, closes).prices.slice(-1)[0] / 100 - 1);
  const mean = ends.reduce((sum, value) => sum + value, 0) / ends.length;
  const spread = Math.sqrt(ends.reduce((sum, value) => sum + value * value, 0) / ends.length);
  assert.ok(Math.abs(mean) < 0.01, 'mean end move ' + mean);
  assert.ok(spread > 0.03 && spread < 0.05, 'end move spread ' + spread);
});

// A Swiss stock day trade on Monday 2026-11-23, while SIX is open (08:00 to 16:30 UTC).
const sixSession = GameIntraday.session('CH', '2026-11-23');
const duringSession = '2026-11-23T10:00:00.000Z';
const laterInSession = '2026-11-23T14:00:00.000Z';
const afterClose = '2026-11-23T17:00:00.000Z';

function dayTradeGame() {
  const market = fakeMarket({ 'NESN.SW': { '2026-11-20': 100 }, '^SSMI': { '2026-11-20': 10000 } });
  return { market: market, game: newGame('hard', '2026-11-23') };
}

test('day trade: bought and sold the same day, profit after stamp duty on both legs, a quick sale', () => {
  const { market, game } = dayTradeGame();
  const buy = GameEngine.openDayTrade(game, market, swissStock, { amountChf: 5000 }, 100, sixSession, duringSession);
  assert.ok(!buy.error, buy.error);
  assertNear(buy.quantity, 50, 'quantity');
  game.trades.push(buy);
  const open = GameEngine.replay(game, market, '2026-11-23', laterInSession);
  assertNear(open.cash, 10000 - 5003.75, 'cash held while open');
  assertNear(open.days[0].netWorth, 10000 - 3.75, 'net worth counts the open trade at its cost');
  assert.strictEqual(open.positions.length, 0, 'not a holding');
  assert.deepStrictEqual(open.dayTrades.map((item) => [item.symbol, item.quantity, item.closesAt]), [['NESN.SW', 50, sixSession.closesAt]]);

  const sale = GameEngine.closeDayTrade(game, market, 'NESN.SW', { fraction: 1 }, 110, laterInSession);
  assert.ok(!sale.error, sale.error);
  game.trades.push(sale);
  const state = GameEngine.replay(game, market, '2026-11-23', afterClose);
  const profitChf = 5500 - 5500 * 0.00075 - 5003.75;
  assertNear(state.cash, 10000 + profitChf, 'cash after the round trip');
  assertNear(state.dayTradeProfitChf, profitChf, 'day trade profit');
  assertNear(state.feesPaid, 3.75 + 4.125, 'duty on both legs');
  assert.strictEqual(state.dayTrades.length, 0);
  assert.strictEqual(state.trader.status, 'review', 'a day trade is a sale held under six months');
  assertNear(state.trader.volumeMultiple, 10500 / 10000, 'both legs count as volume');
  assert.deepStrictEqual(state.events.filter((event) => event.intraday).map((event) => event.type), ['buy', 'sell']);
  assert.ok(GameEngine.replay(game, market, '2026-11-24').dayTradeProfitChf > 0, 'a closed day trade stays');
});

test('day trade: still open at the close it is reverted, no cash, fees, volume or history left', () => {
  const { market, game } = dayTradeGame();
  game.trades.push(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 5000 }, 100, sixSession, duringSession));
  const without = GameEngine.replay(newGame('hard', '2026-11-23'), market, '2026-11-23');
  [GameEngine.replay(game, market, '2026-11-23', afterClose), GameEngine.replay(game, market, '2026-11-24')].forEach((state) => {
    assertNear(state.cash, without.cash, 'cash back');
    assertNear(state.feesPaid, 0, 'no fees');
    assert.strictEqual(state.events.length, without.events.length, 'no history');
    assert.strictEqual(state.trader.status, 'private');
    assertNear(state.trader.volumeMultiple, 0, 'no volume');
    assert.strictEqual(state.dayTrades.length, 0);
  });
  assert.strictEqual(GameEngine.closeDayTrade(game, market, 'NESN.SW', { fraction: 1 }, 110, afterClose).error, 'NO OPEN DAY TRADE');
  assertNear(GameEngine.previewBuy(game, market, swissStock, { amountChf: 9000 }, '2026-11-23', afterClose).cashChf, 10000, 'its cash is free again');
});

test('day trade: a partly closed trade keeps the sold part and reverts the rest', () => {
  const { market, game } = dayTradeGame();
  game.trades.push(GameEngine.openDayTrade(game, market, swissStock, { quantity: 10 }, 100, sixSession, duringSession));
  game.trades.push(GameEngine.closeDayTrade(game, market, 'NESN.SW', { quantity: 4 }, 90, laterInSession));
  const state = GameEngine.replay(game, market, '2026-11-23', afterClose);
  const profitChf = 360 - 360 * 0.00075 - 400 * 1.00075;
  assertNear(state.cash, 10000 + profitChf, 'only the 4 sold count');
  assertNear(state.feesPaid, 400 * 0.00075 + 360 * 0.00075, 'duty on the 4 units');
  const buyEvent = state.events.find((event) => event.intraday && event.type === 'buy');
  assertNear(buyEvent.quantity, 4, 'history shows the 4 units bought');
  assertNear(buyEvent.amountChf, 400, 'history amount');
});

test('day trade: only while the market is open, with the cash at hand, never tangibles', () => {
  const { market, game } = dayTradeGame();
  assert.strictEqual(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 100 }, 100, sixSession, afterClose).error, 'MARKET CLOSED');
  assert.strictEqual(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 100 }, 100, null, duringSession).error, 'MARKET CLOSED');
  assert.strictEqual(GameEngine.openDayTrade(game, market, familyCar, { quantity: 1 }, 100, sixSession, duringSession).error, 'NOT FOR DAY TRADING');
  assert.strictEqual(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 0 }, 100, sixSession, duringSession).error, 'ENTER AN AMOUNT');
  game.trades.push(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 6000 }, 100, sixSession, duringSession));
  assert.strictEqual(GameEngine.openDayTrade(game, market, swissStock, { amountChf: 5000 }, 100, sixSession, laterInSession).error, 'NOT ENOUGH CASH', 'open trades hold their cash');
  assert.strictEqual(GameEngine.closeDayTrade(game, market, 'NESN.SW', { quantity: 100 }, 100, laterInSession).error, 'YOU ONLY HOLD 60');
  assert.strictEqual(GameEngine.sell(game, market, 'NESN.SW', { fraction: 1 }, '2026-11-23', laterInSession).error, 'NOTHING TO SELL', 'day trades are not holdings');
});

test('saves: version 1 games become a Zürich player with metals in grams, file names are free', () => {
  global.GameEngine = GameEngine;
  global.GameTangibles = GameTangibles;
  const GameSaves = require('./saves');
  const old = { version: 1, difficulty: 'hard', startCash: 10000, startDate: '2026-01-05', trades: [
    { date: '2026-01-05', side: 'buy', symbol: 'GC=F', class: 'metal', name: 'Gold', quantity: 1, priceChf: 3110.34768, amountChf: 3110.34768, stampDutyChf: 0 },
    { date: '2026-01-05', side: 'buy', symbol: 'VOO', class: 'etf', name: 'VOO', quantity: 2, priceChf: 500, amountChf: 1000, stampDutyChf: 1.5 },
  ] };
  const game = GameSaves.migrate(old);
  assert.strictEqual(game.version, 2);
  assert.strictEqual(game.location, 'zurich');
  assertNear(game.trades[0].quantity, 31.1034768, 'grams of gold');
  assertNear(game.trades[0].priceChf, 100, 'price per gram');
  assert.strictEqual(game.trades[1].quantity, 2);
  assert.strictEqual(GameSaves.migrate({ version: 2, trades: [], location: 'nowhere', difficulty: 'easy', startDate: '2026-01-01', startCash: 1 }), null);
  assert.strictEqual(GameSaves.fileNameFor('João Silva', []), 'joao-silva.json');
  assert.strictEqual(GameSaves.fileNameFor('João Silva', ['joao-silva.json', 'JOAO-SILVA-2.json']), 'joao-silva-3.json');
  assert.strictEqual(GameSaves.fileNameFor('!!!', []), 'player.json');
});

runRegisteredTests().then((failures) => process.exit(failures ? 1 : 0));

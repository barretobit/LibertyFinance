// Save file check tests: `node game/validation.test.js`
const { test, assert, assertNear, runRegisteredTests } = require('../tests/helpers');
global.GameEngine = require('./engine');
const GameValidation = require('./validation');

// A market where every symbol's CHF price is fixed per date, else the last earlier one.
function fakeMarket(pricesBySymbol) {
  const quote = (symbol, date) => {
    const dates = Object.keys(pricesBySymbol[symbol] || {}).filter((day) => day <= date).sort();
    const day = dates[dates.length - 1];
    return day ? { priceChf: pricesBySymbol[symbol][day], date: day } : null;
  };
  return { quote, benchmark: (date) => (quote('^SSMI', date) || {}).priceChf || null, tangible: () => null };
}

const market = fakeMarket({ '^SSMI': { '2026-11-02': 12000 }, VOO: { '2026-11-02': 500, '2026-11-03': 510 }, 'HSBA.L': { '2026-11-02': 12 } });
const now = '2026-11-04T10:00:00.000Z';
const voo = { symbol: 'VOO', class: 'etf', name: 'Vanguard S&P 500' };

function newGame() {
  return GameEngine.newGame({ name: 'Test', location: 'zurich', difficulty: 'medium', startDate: '2026-11-02' });
}

function holdingBuy(date, quantity, priceChf) {
  const amountChf = quantity * priceChf;
  return { date: date, side: 'buy', symbol: 'VOO', class: 'etf', name: 'Vanguard S&P 500', quantity: quantity, priceChf: priceChf, amountChf: amountChf, stampDutyChf: amountChf * 0.0015 };
}

const codes = (findings) => findings.map((finding) => finding.code).sort();
const cashOn = (game) => GameEngine.replay(game, market, now.slice(0, 10), now).cash;

test('check: a game made by this version has nothing to report', () => {
  const game = newGame();
  game.trades.push(GameEngine.buy(game, market, voo, { amountChf: 5000 }, '2026-11-02', '2026-11-02T10:00:00.000Z'));
  game.orders.push(GameEngine.placeOrder(game, market, voo, { side: 'sell', type: 'limit', priceChf: 600, fraction: 1 }, '2026-11-03', '2026-11-03T10:00:00.000Z'));
  game.reinvestPeriods = [{ from: '2026-11-02', to: '2026-11-03' }, { from: '2026-11-03' }];
  assert.deepStrictEqual(GameValidation.inspect(game, market, now), []);
});

test('check: fields and settings left by older versions go, and the numbers stay the same', () => {
  const game = Object.assign(newGame(), { splits: {} });
  game.trades.push(Object.assign(holdingBuy('2026-11-02', 10, 500), { quoteDate: '2026-11-02' }));
  // RESET used to keep the orders and the dividend settings of the game before.
  game.orders.push({ at: '2026-10-20T10:00:00.000Z', date: '2026-10-20', symbol: 'VOO', class: 'etf', name: 'VOO', side: 'buy', type: 'limit', priceChf: 400, amountChf: 1000, quoteDate: '2026-10-19' });
  game.reinvestPeriods = [{ from: '2026-09-01', to: '2026-10-01' }, { from: '2026-10-01', note: 'old' }];
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['game-field', 'order-before-start', 'period-before-start', 'period-field', 'period-unused', 'trade-field']);
  assert.ok(findings.every((finding) => finding.kind === 'fix' && !finding.changesResults));

  const fixed = GameValidation.repair(game, findings);
  assert.strictEqual(fixed.splits, undefined);
  assert.strictEqual(fixed.trades[0].quoteDate, undefined);
  assert.deepStrictEqual(fixed.orders, []);
  assert.deepStrictEqual(fixed.reinvestPeriods, [{ from: '2026-11-02' }]);
  assert.strictEqual(cashOn(fixed), cashOn(game));
  assert.deepStrictEqual(GameValidation.inspect(fixed, market, now), [], 'nothing left after the repair');
  // The game itself is not changed.
  assert.strictEqual(game.trades[0].quoteDate, '2026-11-02');
  assert.strictEqual(game.orders.length, 1);
});

test('check: reverted day trades and trades that close nothing go, and the numbers stay the same', () => {
  const game = newGame();
  game.trades.push(holdingBuy('2026-11-02', 10, 500));
  const dayTrade = (fields) => Object.assign({
    date: '2026-11-02', intraday: true, at: '2026-11-02T15:00:00.000Z', symbol: 'VOO', class: 'etf', name: 'VOO',
    quantity: 2, priceChf: 500, amountChf: 1000, stampDutyChf: 1.5,
  }, fields);
  // Left open at the close, so reverted.
  game.trades.push(dayTrade({ side: 'buy', closesAt: '2026-11-02T21:00:00.000Z' }));
  // Closes a day trade, a short and an option that are not there.
  game.trades.push(dayTrade({ side: 'sell', at: '2026-11-03T15:00:00.000Z', date: '2026-11-03', lotAt: '2026-11-01T15:00:00.000Z' }));
  game.trades.push({ date: '2026-11-03', side: 'buy', short: true, symbol: 'VOO', class: 'etf', name: 'VOO', quantity: 1, priceChf: 510, amountChf: 510, stampDutyChf: 0.765 });
  game.trades.push({
    date: '2026-11-03', at: '2026-11-03T15:00:00.000Z', side: 'sell', symbol: 'VOO', class: 'etf', name: 'VOO', optionAt: '2026-10-01T10:00:00.000Z',
    option: { kind: 'call', strike: 500, expiry: '2026-11-20', written: false, volatility: 0.2 }, quantity: 1, priceChf: 20, amountChf: 20,
  });
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['trade-closes-nothing', 'trade-closes-nothing', 'trade-closes-nothing', 'trade-reverted']);
  const fixed = GameValidation.repair(game, findings);
  assert.deepStrictEqual(fixed.trades, [game.trades[0]]);
  assertNear(cashOn(fixed), cashOn(game), 'cash');
});

test('check: a day trade still open today, or partly closed before the close, is kept', () => {
  const game = newGame();
  const open = { date: '2026-11-04', side: 'buy', intraday: true, at: '2026-11-04T09:00:00.000Z', closesAt: '2026-11-04T21:00:00.000Z', symbol: 'VOO', class: 'etf', name: 'VOO', quantity: 2, priceChf: 510, amountChf: 1020, stampDutyChf: 1.53 };
  const partly = Object.assign({}, open, { date: '2026-11-03', at: '2026-11-03T09:00:00.000Z', closesAt: '2026-11-03T21:00:00.000Z' });
  const close = Object.assign({}, partly, { side: 'sell', at: '2026-11-03T12:00:00.000Z', quantity: 1, amountChf: 510, stampDutyChf: 0.765, lotAt: partly.at });
  delete close.closesAt;
  game.trades.push(open, partly, close);
  assert.deepStrictEqual(GameValidation.inspect(game, market, now), []);
});

test('check: trades that cannot be replayed, or were counted wrongly, go and the numbers move', () => {
  const game = newGame();
  game.trades.push(holdingBuy('2026-11-02', 10, 500));
  game.trades.push(Object.assign(holdingBuy('2026-11-03', 1, 510), { amountChf: undefined }));
  game.trades.push(Object.assign(holdingBuy('2026-10-30', 1, 500)));
  game.trades.push({ date: '2026-11-03', side: 'sell', symbol: 'VOO', class: 'etf', name: 'VOO', quantity: 15, priceChf: 510, amountChf: 7650, stampDutyChf: 11.475, dealerFeeChf: 0, gainsTaxChf: 0, mortgageRepaidChf: 0 });
  assert.ok(isNaN(cashOn(game)), 'the broken trade spoils the cash');
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['trade-before-start', 'trade-broken', 'trade-oversold']);
  assert.ok(findings.every((finding) => finding.changesResults));
  const fixed = GameValidation.repair(game, findings);
  assert.deepStrictEqual(fixed.trades, [game.trades[0]]);
  assert.ok(isFinite(cashOn(fixed)));
});

test('check: a Lombard loan of less than a centime is paid off', () => {
  const game = newGame();
  game.trades.push(holdingBuy('2026-11-02', 10, 500));
  game.trades.push({ date: '2026-11-02', side: 'borrow', amountChf: 1000 });
  // Repaid as the rounded figure the page showed before repaying snapped to what is owed.
  game.trades.push({ date: '2026-11-03', side: 'repay', amountChf: 999.996 });
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['loan-dust']);
  const fixed = GameValidation.repair(game, findings);
  assert.strictEqual(fixed.trades.length, 4);
  assert.strictEqual(fixed.trades[3].side, 'repay');
  assert.strictEqual(GameEngine.replay(fixed, market, '2026-11-04', now).loanChf, 0);
});

test('check: trades dated after today or far from the close are only warnings', () => {
  const game = newGame();
  game.trades.push(holdingBuy('2026-11-02', 10, 500));
  game.trades.push(holdingBuy('2026-11-09', 1, 510));
  // A London share at its price in pence, a hundred times the close.
  game.trades.push({ date: '2026-11-02', side: 'buy', symbol: 'HSBA.L', class: 'stock', name: 'HSBC', quantity: 1, priceChf: 1200, amountChf: 1200, stampDutyChf: 1.8 });
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['trade-future', 'trade-price']);
  assert.ok(findings.every((finding) => finding.kind === 'warning'));
  assert.deepStrictEqual(GameValidation.repair(game, findings), game);
  const summary = GameValidation.summarize(findings);
  assert.deepStrictEqual(summary.map((group) => group.code), ['trade-future', 'trade-price']);
  assert.ok(summary[1].details[0].includes('100 TIMES'), summary[1].details[0]);
});

test('check: orders that can never fill go', () => {
  const game = newGame();
  game.trades.push(holdingBuy('2026-11-02', 10, 500));
  const order = { at: '2026-11-03T10:00:00.000Z', date: '2026-11-03', symbol: 'VOO', class: 'etf', name: 'VOO', side: 'sell', type: 'stop', priceChf: 400, fraction: 1, quoteDate: '2026-11-03' };
  game.orders.push(order, Object.assign({}, order, { type: 'market' }), Object.assign({}, order, { quoteDate: undefined }));
  game.orders.push('junk');
  const findings = GameValidation.inspect(game, market, now);
  assert.deepStrictEqual(codes(findings), ['order-broken', 'order-broken', 'order-broken']);
  assert.deepStrictEqual(GameValidation.repair(game, findings).orders, [order]);
});

runRegisteredTests().then((failures) => process.exit(failures ? 1 : 0));

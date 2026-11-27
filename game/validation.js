/* ===== Vaulty: save file check =====
 *
 * Finds what a save file carries that the game does not use, or cannot replay: fields left by older versions of
 * the game (trades priced for the stock split handling kept a quoteDate), trades and orders from before the start
 * date (RESET used to keep the orders and the dividend settings), day trades reverted at the close, trades that
 * close nothing, sales of more units than were held, and a Lombard loan of less than a centime left when repaying
 * did not round yet. inspect() lists them; repair() returns a copy with the fixes applied.
 *
 * Most fixes only take out what the replay never counts, so cash, holdings and history stay as they are. The ones
 * marked changesResults take out trades that were counted wrongly, so the numbers move. Warnings (a trade dated
 * after today, a price far from the market close of its day) need the player and are never changed.
 * Pure: no DOM and no storage, so it can be tested in plain node.
 */

const GameValidation = (() => {
  // What each finding is about, by code: whether repair() fixes it, and whether that moves the numbers.
  const CHECKS = {
    'game-field': { kind: 'fix', text: 'GAME FIELDS FROM OLDER VERSIONS: REMOVED' },
    'game-list': { kind: 'fix', text: 'ORDERS OR DIVIDEND SETTINGS THAT ARE NOT A LIST: EMPTIED' },
    'trade-field': { kind: 'fix', text: 'TRADE FIELDS FROM OLDER VERSIONS: REMOVED' },
    'trade-broken': { kind: 'fix', changesResults: true, text: 'TRADES THAT CANNOT BE REPLAYED: REMOVED' },
    'trade-before-start': { kind: 'fix', changesResults: true, text: 'TRADES FROM BEFORE THE GAME STARTED: REMOVED' },
    'trade-closes-nothing': { kind: 'fix', text: 'TRADES THAT CLOSE NOTHING: REMOVED' },
    'trade-reverted': { kind: 'fix', text: 'DAY TRADES REVERTED AT THE CLOSE: REMOVED' },
    'trade-oversold': { kind: 'fix', changesResults: true, text: 'SALES OF MORE UNITS THAN WERE HELD: REMOVED' },
    'order-field': { kind: 'fix', text: 'ORDER FIELDS FROM OLDER VERSIONS: REMOVED' },
    'order-broken': { kind: 'fix', text: 'ORDERS THAT CAN NEVER FILL: REMOVED' },
    'order-before-start': { kind: 'fix', text: 'ORDERS FROM BEFORE THE GAME STARTED: REMOVED' },
    'period-field': { kind: 'fix', text: 'DIVIDEND SETTING FIELDS FROM OLDER VERSIONS: REMOVED' },
    'period-broken': { kind: 'fix', text: 'DIVIDEND REINVESTMENT PERIODS THAT CANNOT BE READ: REMOVED' },
    'period-unused': { kind: 'fix', text: 'DIVIDEND REINVESTMENT PERIODS WITH NO DAY IN THE GAME: REMOVED' },
    'period-before-start': { kind: 'fix', text: 'DIVIDEND REINVESTMENT STARTING BEFORE THE GAME: MOVED TO THE START DATE' },
    'loan-dust': { kind: 'fix', changesResults: true, text: 'A LOMBARD LOAN OF LESS THAN A CENTIME: PAID OFF TODAY' },
    'trade-future': { kind: 'warning', text: 'TRADES DATED AFTER TODAY: CHECK THE CLOCK OF THE COMPUTER THAT MADE THEM' },
    'trade-price': { kind: 'warning', text: 'TRADES FAR FROM THE MARKET CLOSE OF THEIR DAY, LIKELY FROM AN OLDER PRICE FEED' },
    'replay-failed': { kind: 'warning', text: 'THE GAME CANNOT BE REPLAYED' },
  };

  const GAME_FIELDS = ['version', 'name', 'location', 'difficulty', 'startCash', 'startDate', 'trades', 'orders', 'reinvestPeriods'];
  // Every field a saved trade of any kind can have: holdings, day trades, shorts, options, the loan, filled orders.
  const TRADE_FIELDS = [
    'date', 'side', 'symbol', 'class', 'name', 'quantity', 'priceChf', 'amountChf', 'stampDutyChf',
    'purchaseCostsChf', 'mortgageChf', 'amortizationChf', 'dealerFeeChf', 'gainsTaxChf', 'mortgageRepaidChf',
    'intraday', 'at', 'closesAt', 'lotAt', 'short', 'option', 'optionAt', 'orderType',
  ];
  const ORDER_FIELDS = [
    'at', 'date', 'symbol', 'class', 'name', 'side', 'type', 'priceChf', 'fraction', 'quantity', 'amountChf',
    'short', 'lotAt', 'trailPercent', 'referenceChf', 'quoteDate', 'intraday', 'closesAt',
  ];
  const PERIOD_FIELDS = ['from', 'to'];
  // Fees and taxes a trade may leave out; when one is there it must be a number.
  const OPTIONAL_AMOUNTS = ['purchaseCostsChf', 'mortgageChf', 'amortizationChf', 'dealerFeeChf', 'gainsTaxChf', 'mortgageRepaidChf'];
  // Prices of these classes come from the market data, so a trade's price can be held against the close of its day.
  const QUOTED_CLASSES = ['stock', 'etf', 'crypto', 'metal'];
  // A price this many times above or below the close is not a market move: London shares were once read in pence,
  // a hundred times their price, and metals were once counted in troy ounces, 31 times a gram. A stock split after
  // the trade moves the close as well, but splits this large are rare enough to be worth a look.
  const PRICE_FACTOR_LIMIT = 20;
  const LOAN_DUST_CHF = 0.01;

  const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);
  const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value + 'T00:00:00Z'));
  const isTime = (value) => typeof value === 'string' && !isNaN(Date.parse(value));
  const isAmount = (value) => typeof value === 'number' && isFinite(value) && value >= 0;
  const isPositive = (value) => typeof value === 'number' && isFinite(value) && value > 0;

  function unknownFields(entry, known) {
    return Object.keys(entry).filter((field) => !known.includes(field));
  }

  // A short line naming a trade or an order, for the list of findings.
  function describe(entry) {
    if (!isObject(entry)) return 'UNREADABLE: ' + JSON.stringify(entry);
    const date = isDate(entry.date) ? entry.date : 'NO DATE';
    if (entry.side === 'borrow' || entry.side === 'repay') return date + ' LOMBARD LOAN ' + entry.side.toUpperCase();
    let action = typeof entry.side === 'string' ? entry.side.toUpperCase() : '?';
    if (entry.short) action = entry.side === 'sell' ? 'SHORT' : 'BUY BACK';
    if (isObject(entry.option) && typeof entry.option.kind === 'string') action += ' ' + entry.option.kind.toUpperCase();
    if (entry.intraday) action = 'DAY TRADE ' + action;
    return date + ' ' + action + ' ' + String(entry.name || entry.symbol || '?').toUpperCase();
  }

  // Why a saved trade cannot be replayed, or null.
  function tradeProblem(trade) {
    if (!isObject(trade)) return 'NOT A TRADE';
    if (!isDate(trade.date)) return 'NO DATE';
    if (trade.side === 'borrow' || trade.side === 'repay') return isPositive(trade.amountChf) ? null : 'NO AMOUNT';
    if (trade.side !== 'buy' && trade.side !== 'sell') return 'UNKNOWN SIDE';
    if (typeof trade.symbol !== 'string' || !trade.symbol) return 'NO ASSET';
    if (!isPositive(trade.quantity)) return 'NO QUANTITY';
    if (!isAmount(trade.priceChf) || !isAmount(trade.amountChf)) return 'NO PRICE';
    const missingAmount = OPTIONAL_AMOUNTS.find((field) => trade[field] != null && !isAmount(trade[field]));
    if (missingAmount) return 'BAD ' + missingAmount;
    if (trade.option) {
      const option = trade.option;
      if (!isObject(option) || (option.kind !== 'call' && option.kind !== 'put') || !isPositive(option.strike) || !isDate(option.expiry)) return 'BAD OPTION';
      // An option is opened under its time and closed by naming it.
      if (!trade.optionAt && typeof trade.at !== 'string') return 'NO TIME';
      return null;
    }
    if (!isAmount(trade.stampDutyChf)) return 'NO STAMP DUTY';
    if (trade.intraday) {
      if (!isTime(trade.at)) return 'NO TIME';
      const opens = trade.side === (trade.short ? 'sell' : 'buy');
      if (opens && !isTime(trade.closesAt)) return 'NO MARKET CLOSE';
    }
    return null;
  }

  // Why a kept order can never fill, or null.
  function orderProblem(order) {
    if (!isObject(order)) return 'NOT AN ORDER';
    if (!isDate(order.date) || !isTime(order.at)) return 'NO DATE';
    if (typeof order.symbol !== 'string' || !order.symbol) return 'NO ASSET';
    if (order.side !== 'buy' && order.side !== 'sell') return 'UNKNOWN SIDE';
    if (!['limit', 'stop', 'trail'].includes(order.type)) return 'UNKNOWN TYPE';
    if (!isPositive(order.priceChf)) return 'NO PRICE';
    if (order.type === 'trail' && !(isPositive(order.trailPercent) && order.trailPercent < 1 && isPositive(order.referenceChf))) return 'BAD TRAIL';
    const sized = isPositive(order.fraction) || isPositive(order.quantity) || isPositive(order.amountChf);
    if (!sized) return 'NO SIZE';
    // A regular order fills at closes newer than the one it was placed against; a day order ends at its market's close.
    if (order.intraday ? !isTime(order.closesAt) : !isDate(order.quoteDate)) return order.intraday ? 'NO MARKET CLOSE' : 'NO PRICE DATE';
    return null;
  }

  // Everything worth knowing about `game` as of `now` (ISO time), in a list of findings: { code, kind ('fix' or
  // 'warning'), changesResults, detail, and for a fix the change: list ('trades', 'orders', 'reinvestPeriods' or
  // null for the game), index, action ('remove-field', 'remove-entry', 'set-field', 'add-entry'), field, value }.
  function inspect(game, market, now) {
    const today = now.slice(0, 10);
    const findings = [];
    const add = (code, detail, change) => {
      const check = CHECKS[code];
      findings.push(Object.assign({ code: code, kind: check.kind, changesResults: !!check.changesResults, detail: detail }, change));
    };

    unknownFields(game, GAME_FIELDS).forEach((field) => add('game-field', field, { list: null, action: 'remove-field', field: field }));
    ['orders', 'reinvestPeriods'].forEach((list) => {
      if (game[list] != null && !Array.isArray(game[list])) add('game-list', list, { list: null, action: 'set-field', field: list, value: [] });
    });

    // Trades the replay can work with, kept in a copy of the game so the replay can tell which do nothing.
    const replayable = [];
    const tradeIndexes = new Map();
    game.trades.forEach((trade, index) => {
      const problem = tradeProblem(trade);
      if (problem) { add('trade-broken', describe(trade) + ': ' + problem, { list: 'trades', index: index, action: 'remove-entry' }); return; }
      unknownFields(trade, TRADE_FIELDS).forEach((field) => add('trade-field', field, { list: 'trades', index: index, action: 'remove-field', field: field }));
      if (trade.date < game.startDate) { add('trade-before-start', describe(trade), { list: 'trades', index: index, action: 'remove-entry' }); return; }
      if (trade.date > today) add('trade-future', describe(trade));
      replayable.push(trade);
      tradeIndexes.set(trade, index);

      const priced = !trade.option && QUOTED_CLASSES.includes(trade.class) && market.quote(trade.symbol, trade.date);
      if (priced && priced.priceChf > 0 && trade.priceChf > 0 && GameEngine.daysBetween(priced.date, trade.date) <= GameEngine.MAX_QUOTE_AGE_DAYS) {
        const factor = trade.priceChf / priced.priceChf;
        if (factor > PRICE_FACTOR_LIMIT || factor < 1 / PRICE_FACTOR_LIMIT) {
          add('trade-price', describe(trade) + ' AT ' + factor.toFixed(factor >= 1 ? 0 : 3) + ' TIMES THE CLOSE');
        }
      }
    });

    const orders = Array.isArray(game.orders) ? game.orders : [];
    orders.forEach((order, index) => {
      const problem = orderProblem(order);
      if (problem) { add('order-broken', describe(order) + ': ' + problem, { list: 'orders', index: index, action: 'remove-entry' }); return; }
      unknownFields(order, ORDER_FIELDS).forEach((field) => add('order-field', field, { list: 'orders', index: index, action: 'remove-field', field: field }));
      if (order.date < game.startDate) add('order-before-start', describe(order), { list: 'orders', index: index, action: 'remove-entry' });
    });

    const periods = Array.isArray(game.reinvestPeriods) ? game.reinvestPeriods : [];
    const keptPeriods = [];
    periods.forEach((period, index) => {
      const change = { list: 'reinvestPeriods', index: index };
      if (!isObject(period) || !isDate(period.from) || (period.to != null && !isDate(period.to))) {
        add('period-broken', JSON.stringify(period), Object.assign(change, { action: 'remove-entry' }));
        return;
      }
      unknownFields(period, PERIOD_FIELDS).forEach((field) => add('period-field', field, Object.assign({}, change, { action: 'remove-field', field: field })));
      // A period covers its `from` day up to the day before its `to`.
      if (period.to != null && (period.to <= period.from || period.to <= game.startDate)) {
        add('period-unused', period.from + ' TO ' + period.to, Object.assign(change, { action: 'remove-entry' }));
        return;
      }
      if (period.from < game.startDate) {
        add('period-before-start', period.from, Object.assign(change, { action: 'set-field', field: 'from', value: game.startDate }));
      }
      keptPeriods.push(Object.assign({}, period, { from: period.from < game.startDate ? game.startDate : period.from }));
    });

    // The replay of what is left: trades it skipped or reverted can go, sales of more than was held are flagged.
    const candidate = Object.assign({}, game, { trades: replayable, orders: [], reinvestPeriods: keptPeriods });
    let state;
    try {
      state = GameEngine.replay(candidate, market, today, now);
    } catch (error) {
      add('replay-failed', String((error && error.message) || error));
      return findings;
    }
    const removeTraded = (code, trades) => trades.forEach((trade) => {
      if (tradeIndexes.has(trade)) add(code, describe(trade), { list: 'trades', index: tradeIndexes.get(trade), action: 'remove-entry' });
    });
    removeTraded('trade-closes-nothing', state.skippedTrades);
    removeTraded('trade-reverted', state.revertedTrades);
    removeTraded('trade-oversold', state.oversoldTrades);

    // Repaying used to leave the fraction of a centime the page rounded away; a repay of exactly that clears it.
    if (state.loanChf > 0 && state.loanChf < LOAN_DUST_CHF) {
      const repay = GameEngine.loanTrade(candidate, market, 'repay', state.loanChf, today, now);
      if (!repay.error) add('loan-dust', 'CHF ' + state.loanChf.toFixed(6), { list: 'trades', action: 'add-entry', value: repay });
    }
    return findings;
  }

  // A copy of `game` with the fixes among `findings` (from inspect on this same game) applied; `game` is not changed.
  function repair(game, findings) {
    const fixed = JSON.parse(JSON.stringify(game));
    const removed = { trades: new Set(), orders: new Set(), reinvestPeriods: new Set() };
    const added = [];
    findings.filter((finding) => finding.kind === 'fix').forEach((finding) => {
      const target = finding.list ? fixed[finding.list] && fixed[finding.list][finding.index] : fixed;
      if (finding.action === 'remove-entry') removed[finding.list].add(finding.index);
      else if (finding.action === 'add-entry') added.push(Object.assign({}, finding.value));
      else if (finding.action === 'remove-field' && isObject(target)) delete target[finding.field];
      else if (finding.action === 'set-field' && isObject(target)) target[finding.field] = finding.value;
    });
    Object.keys(removed).forEach((list) => {
      if (removed[list].size && Array.isArray(fixed[list])) fixed[list] = fixed[list].filter((entry, index) => !removed[list].has(index));
    });
    fixed.trades = fixed.trades.concat(added);
    return fixed;
  }

  // The findings by code, in the order of CHECKS: { code, kind, changesResults, text, count, details }.
  function summarize(findings) {
    return Object.keys(CHECKS).map((code) => {
      const matching = findings.filter((finding) => finding.code === code);
      return {
        code: code, kind: CHECKS[code].kind, changesResults: !!CHECKS[code].changesResults, text: CHECKS[code].text,
        count: matching.length, details: [...new Set(matching.map((finding) => finding.detail))],
      };
    }).filter((group) => group.count > 0);
  }

  return { CHECKS, inspect, repair, summarize };
})();

if (typeof module !== 'undefined') module.exports = GameValidation;

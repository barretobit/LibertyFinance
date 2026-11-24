/* ===== Vaulty: page =====
 *
 * Public page, no profile. Saves are files in the Game/ folder of the data
 * folder (game/saves.js); market data is the Randata cache in Resources/ of
 * the same folder, synced on load. All rules live in game/engine.js; this
 * file only builds the market, draws the board and turns clicks into trades.
 */

const GAME_BENCHMARK_SYMBOL = '^SSMI';
// shortcut: the SMI is a price index, so the benchmark gets the SMI's usual dividend yield as a fixed rate; refresh it by hand when it drifts.
const GAME_BENCHMARK_DIVIDEND_YIELD = 0.03;
const GAME_MARKET_CLASSES = ['stock', 'etf', 'crypto', 'metal'];
// Units of the commodity futures; precious metals are counted in grams.
const GAME_PRICE_UNITS = { 'HG=F': 'LB', 'CL=F': 'BARREL' };
// Stock regions in the buy list, from the listing venue (wallStreetStockRegion reads the exchange suffix).
const GAME_STOCK_REGIONS = [
  { label: 'SWITZERLAND', codes: ['CH'] },
  { label: 'EUROPE', codes: ['DE', 'FR', 'GB', 'IT'] },
  { label: 'UNITED STATES', codes: ['US'] },
  { label: 'ASIA', codes: ['JP', 'HK', 'KR', 'IN'] },
];
function gameStockRegion(asset) {
  const code = wallStreetStockRegion(asset.symbol);
  const region = GAME_STOCK_REGIONS.find((item) => item.codes.includes(code));
  return region ? region.label : 'OTHER';
}
// The buy panel's two tabs, each split into categories. A category's list can be split into option groups
// (groupOf, in groupOrder or catalog order) and sorted cheapest first (byPrice).
const GAME_BUY_CATEGORIES = {
  market: [
    { label: 'STOCKS', matches: (asset) => asset.class === 'stock', groupOf: gameStockRegion, groupOrder: GAME_STOCK_REGIONS.map((region) => region.label) },
    { label: 'ETFS', matches: (asset) => asset.class === 'etf' },
    { label: 'CRYPTO', matches: (asset) => asset.class === 'crypto' },
    { label: 'COMMODITIES', matches: (asset) => asset.class === 'metal' && !GameTangibles.PRECIOUS_METALS[asset.symbol] },
  ],
  // Precious metals, then cars by type, watches, art and houses by city ("CARS: SUV" groups as "SUV").
  tangible: [{ label: 'PRECIOUS METALS', matches: (asset) => asset.class === 'metal' && !!GameTangibles.PRECIOUS_METALS[asset.symbol], byPrice: true }]
    .concat(Object.keys(GameTangibles.CATEGORIES).map((assetClass) => ({
      label: GameTangibles.CATEGORIES[assetClass], matches: (asset) => asset.class === assetClass,
      groupOf: (asset) => asset.group.replace(/^.*: /, ''), byPrice: true,
    }))),
};
// Options are on stocks and ETFs.
const GAME_OPTION_CATEGORIES = GAME_BUY_CATEGORIES.market.filter((category) => category.label === 'STOCKS' || category.label === 'ETFS');
// The strategies of the options tab: the option each opens and what it means for the player.
const GAME_OPTION_STRATEGIES = {
  'buy-call': { kind: 'call', written: false, note: 'THE RIGHT TO BUY AT THE STRIKE: GAINS WHAT THE PRICE ENDS ABOVE IT, LOSES AT MOST THE PREMIUM.' },
  'buy-put': { kind: 'put', written: false, note: 'THE RIGHT TO SELL AT THE STRIKE: GAINS WHAT THE PRICE ENDS BELOW IT, LOSES AT MOST THE PREMIUM.' },
  'protective-put': { kind: 'put', written: false, protective: true, note: 'A PUT ON UNITS YOU HOLD: INSURANCE THAT PAYS WHAT THE PRICE ENDS BELOW THE STRIKE.' },
  'covered-call': { kind: 'call', written: true, note: 'SELLS A CALL ON UNITS YOU HOLD: YOU KEEP THE PREMIUM, BUT YOUR UNITS GO AT THE STRIKE IF THE PRICE ENDS ABOVE IT.' },
  'secured-put': { kind: 'put', written: true, note: 'SELLS A PUT WITH CASH SET ASIDE: YOU KEEP THE PREMIUM, BUT BUY THE UNITS AT THE STRIKE IF THE PRICE ENDS BELOW IT.' },
};
// Who takes the cut when a tangible is sold.
const GAME_SELLER_LABELS = { car: 'DEALER', watch: 'DEALER', art: 'AUCTION HOUSE', house: 'ESTATE AGENT' };

const GamePage = {
  market: null,
  assets: [],
  saves: [],
  saveFile: null,
  game: null,
  view: 'board',
  currency: 'CHF',
  // Day of the last market data sync (Randata), null when there is no data.
  marketDate: null,
  chart: null,
  buyTab: 'market',
  buyCategory: { market: 'STOCKS', tangible: 'PRECIOUS METALS' },
  buyMode: 'amount',
  dayCategory: 'STOCKS',
  // Simulated trading days by "symbol|date" (game/intraday.js), null when closed.
  tradingDays: new Map(),
  // The replay the day trading panel was drawn from, and its UTC date.
  dayState: null,
  dayDate: null,
  dayChart: null,
  dayChartKey: '',
  dayZoom: '1H',
  // Day trades are bought by 'amount' (CHF) or 'quantity' (units).
  dayMode: 'amount',
  // The buy dialog and the day trading panel buy 'now' or place a 'limit' order.
  buyKind: 'now',
  // The buy dialog buys ('long') or shorts a stock or ETF ('short').
  buyDirection: 'long',
  dayKind: 'now',
  // The day trading panel buys ('long') or sells short ('short').
  dayDirection: 'long',
  // The options tab's strategy (a GAME_OPTION_STRATEGIES key) and category.
  optionStrategy: 'buy-call',
  optionCategory: 'STOCKS',
  // What the sell order dialog is for: { symbol, lotAt (an open day trade's buy, else null), type, fraction }.
  sellOrder: null,
  // True while reached orders are being saved as trades.
  settlingOrders: false,
};
// Day trading chart zooms: how much time the chart shows, null for the whole session.
const GAME_DAY_ZOOMS = { '15M': 15 * 60000, '1H': 60 * 60000, '4H': 4 * 60 * 60000, DAY: null };

function gameToast(message) {
  document.getElementById('toast-body').textContent = message;
  bootstrap.Toast.getOrCreateInstance(document.getElementById('toast-msg')).show();
}

// Last bar with a close on or before `date`, by binary search over date-ascending bars.
function gameBarOnOrBefore(bars, date) {
  if (!bars || !bars.length) return null;
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (bars[middle].date <= date) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  for (let index = found; index >= 0; index--) {
    if (bars[index].close != null) return bars[index];
  }
  return null;
}

function gameAssetCurrency(asset) {
  if (asset.class === 'index') return _WALL_STREET_INDEX_CURRENCY[asset.symbol] || 'USD';
  if (asset.class === 'stock') return wallStreetStockCurrency(asset.symbol);
  return 'USD';
}

// The engine's market: CHF closes per symbol and date, from the Randata cache,
// and CHF dividends per unit by ex-dividend date (Randata.readDividends()).
function gameBuildMarket(file, dividends) {
  const data = file.data || {};
  const dividendByDate = {};
  Object.keys(dividends || {}).forEach((symbol) => {
    dividendByDate[symbol] = {};
    dividends[symbol].forEach((payment) => { dividendByDate[symbol][payment.date] = payment.amount; });
  });
  const assetBySymbol = {};
  const fxBars = {};
  (file.assets || []).forEach((asset) => {
    if (!asset || !asset.symbol) return;
    assetBySymbol[asset.symbol] = asset;
    if (asset.class === 'fx' && asset.symbol.endsWith('USD=X')) fxBars[asset.symbol.slice(0, 3)] = data[asset.symbol];
  });
  const usdPerUnit = (currency, date) => {
    if (currency === 'USD') return 1;
    const bar = gameBarOnOrBefore(fxBars[currency], date);
    return bar ? bar.close : null;
  };
  const rate = (fromCurrency, toCurrency, date) => {
    const usdPerUnitOn = (currency) => usdPerUnit(currency, date);
    const fromUsd = wallStreetUsdPerUnit(usdPerUnitOn, fromCurrency);
    const toUsd = wallStreetUsdPerUnit(usdPerUnitOn, toCurrency);
    return fromUsd && toUsd ? fromUsd / toUsd : null;
  };
  const quote = (symbol, date) => {
    if (GameTangibles.isTangible(symbol)) return GameTangibles.quote(symbol, date);
    const asset = assetBySymbol[symbol];
    const bar = asset && gameBarOnOrBefore(data[symbol], date);
    const toChf = bar && rate(gameAssetCurrency(asset), 'CHF', date);
    const unitsPerQuote = GameTangibles.PRECIOUS_METALS[symbol] ? GameTangibles.GRAMS_PER_TROY_OUNCE : 1;
    return toChf ? { priceChf: bar.close * toChf / unitsPerQuote, date: bar.date } : null;
  };
  // Yahoo reports dividends in the same unit as the prices, so they convert exactly like the quote, on the ex-date.
  const dividend = (symbol, date) => {
    const amount = dividendByDate[symbol] && dividendByDate[symbol][date];
    const asset = amount && assetBySymbol[symbol];
    const toChf = asset && rate(gameAssetCurrency(asset), 'CHF', date);
    return toChf ? amount * toChf : null;
  };
  // Every daily close on or before `date`, oldest first, in the quote currency: for the day trading volatility.
  const closes = (symbol, date) => (data[symbol] || []).filter((bar) => bar.date <= date && bar.close != null).map((bar) => bar.close);
  // The yearly volatility of the daily closes up to `date`, for pricing options; a day's closes never change, so it is kept.
  const volatilities = new Map();
  const volatility = (symbol, date) => {
    const key = symbol + '|' + date;
    if (!volatilities.has(key)) volatilities.set(key, GameIntraday.dailyVolatility(closes(symbol, date)) * Math.sqrt(252));
    return volatilities.get(key);
  };
  return {
    quote: quote,
    closes: closes,
    volatility: volatility,
    benchmark: (date) => { const benchmarkQuote = quote(GAME_BENCHMARK_SYMBOL, date); return benchmarkQuote ? benchmarkQuote.priceChf : null; },
    benchmarkDividendYield: GAME_BENCHMARK_DIVIDEND_YIELD,
    dividend: dividend,
    tangible: GameTangibles.item,
    rate: rate,
  };
}

function gameMoney(amountChf, date) {
  const code = GamePage.currency;
  const scale = code === 'CHF' ? 1 : GamePage.market.rate('CHF', code, date || todayIsoDate());
  const symbol = scale == null ? 'CHF' : _WALL_STREET_CURRENCY_SYMBOL[code] || code;
  const amount = scale == null ? amountChf : amountChf * scale;
  // Rounding noise such as -0.0000001 would print as "-0.00".
  return symbol + ' ' + (Math.abs(amount) < 0.005 ? 0 : amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function gameSignedMoney(amountChf, date) {
  return (Number(amountChf.toFixed(2)) > 0 ? '+' : '') + gameMoney(amountChf, date);
}

function gamePercent(value) {
  const percent = Number((value * 100).toFixed(2)) || 0; // || 0 turns -0 into 0
  return (percent > 0 ? '+' : '') + percent.toFixed(2) + '%';
}

// A rate as a short percentage: 0.0015 -> "0.15%", 0.035 -> "3.5%".
function gameRate(value) {
  return Number((value * 100).toFixed(3)) + '%';
}

// Green for a gain, red for a loss, grey when it shows as zero. Ratios shown as percentages need 4 decimals.
function gameSignClass(value, decimals = 2) {
  const rounded = Number(value.toFixed(decimals));
  return rounded > 0 ? 'game-pos' : rounded < 0 ? 'game-neg' : 'game-zero';
}

function gameQuantity(quantity) {
  return quantity.toLocaleString('en-GB', { maximumFractionDigits: quantity < 1 ? 6 : 4 });
}

// The unit an asset is counted in: grams for precious metals, the futures unit for commodities, else none.
function gameUnit(asset) {
  if (GameTangibles.PRECIOUS_METALS[asset.symbol]) return 'G';
  return GAME_PRICE_UNITS[asset.symbol] || '';
}

function gameQuantityWithUnit(asset, quantity) {
  const unit = gameUnit(asset);
  return gameQuantity(quantity) + (unit ? ' ' + unit : '');
}

// Second line under an asset name: the category for tangibles, the ticker otherwise.
function gameClassLabel(asset) {
  return GameTangibles.CATEGORIES[asset.class] || escapeHtml(asset.symbol);
}

// Holdings are grouped like the buy panel: stocks, ETFs, crypto, commodities, then metals, cars, watches, art, houses.
const GAME_HOLDING_CATEGORIES = GAME_BUY_CATEGORIES.market.concat(GAME_BUY_CATEGORIES.tangible);

// Holdings in the buy panel's categories, in the same order; what fits none goes last as OTHER.
function gameHoldingGroups(positions) {
  const groups = GAME_HOLDING_CATEGORIES.map((category) => ({ label: category.label, positions: positions.filter(category.matches) }))
    .filter((group) => group.positions.length);
  const grouped = new Set(groups.flatMap((group) => group.positions));
  const others = positions.filter((position) => !grouped.has(position));
  if (others.length) groups.push({ label: 'OTHER', positions: others });
  return groups;
}

// Second line under a holding: ticker (and region for stocks), car type or city, and since when it is held.
function gameHoldingDetail(position) {
  const parts = [];
  const item = GameTangibles.item(position.symbol);
  if (item) {
    const subgroup = item.group.replace(/^.*: /, '');
    if (subgroup !== item.group) parts.push(subgroup);
  } else if (!GameTangibles.PRECIOUS_METALS[position.symbol]) {
    parts.push(escapeHtml(position.symbol));
    if (position.class === 'stock') parts.push(gameStockRegion(position));
  }
  if (position.lots.length) parts.push('SINCE ' + formatDate(position.lots[0].date));
  return parts.join(' · ');
}

// Grams from 1 kg up are shown in kilos.
function gameHoldingQuantity(position) {
  if (gameUnit(position) === 'G' && position.quantity >= 1000) return gameQuantity(position.quantity / 1000) + ' KG';
  return gameQuantityWithUnit(position, position.quantity);
}

function gameCarUnits(state) {
  return state.positions.filter((position) => position.class === 'car').reduce((sum, position) => sum + position.quantity, 0);
}

// ---------- Saves ----------

async function gameWriteCurrent() {
  await GameSaves.write(GamePage.saveFile, GamePage.game);
  const save = GamePage.saves.find((item) => item.file === GamePage.saveFile);
  if (save) save.game = GamePage.game;
}

async function gameOpenSave(file) {
  const game = await GameSaves.read(file);
  if (!game) { gameToast('THIS SAVE FILE CANNOT BE READ'); gameRender(); return; }
  GamePage.game = game;
  GamePage.saveFile = file;
  GamePage.view = 'board';
  GameSaves.setLastFile(file);
  gameRender();
}

async function gameStartNew(difficulty) {
  const game = GameEngine.newGame({
    name: document.getElementById('game-name').value,
    location: document.getElementById('game-location').value,
    difficulty: difficulty,
    startDate: todayIsoDate(),
  });
  let file;
  try {
    file = await GameSaves.create(game);
  } catch (error) {
    gameToast('COULD NOT WRITE THE SAVE FILE: ' + (error.message || error));
    return;
  }
  GamePage.saves.push({ file: file, game: game });
  GamePage.saves.sort((a, b) => String(a.game.name).localeCompare(String(b.game.name)));
  GamePage.game = game;
  GamePage.saveFile = file;
  GamePage.view = 'board';
  GameSaves.setLastFile(file);
  document.getElementById('game-name').value = '';
  gameRender();
}

// ---------- Rendering ----------

function gameShow(view) {
  ['loading', 'connect', 'start', 'board'].forEach((name) => {
    document.getElementById('game-' + name).style.display = name === view ? '' : 'none';
  });
}

function gameRenderHeader() {
  const game = GamePage.game;
  document.getElementById('game-saves-btn').style.display = GamePage.saves.length ? '' : 'none';
  const select = document.getElementById('game-save');
  select.innerHTML = GamePage.saves.map((save) => {
    const label = save.game.name + ' (' + GameEngine.LOCATIONS[save.game.location].label + ')';
    return '<option value="' + escapeHtml(save.file) + '">' + escapeHtml(label) + '</option>';
  }).join('');
  if (GamePage.saveFile) select.value = GamePage.saveFile;
  const folder = GameSaves.folderName();
  select.title = 'Saved as ' + (folder ? folder + '/' : '') + GameSaves.FOLDER + '/' + (GamePage.saveFile || '');
  document.getElementById('game-reset-btn').style.display = game && GamePage.view === 'board' ? '' : 'none';
  document.getElementById('game-save-details').textContent = game
    ? GameEngine.DIFFICULTIES[game.difficulty].label + ' · SINCE ' + formatDate(game.startDate)
    : '';
  const today = todayIsoDate();
  const parts = game && GamePage.view === 'board'
    ? [escapeHtml(game.name), GameEngine.LOCATIONS[game.location].label, 'DAY ' + (GameEngine.daysBetween(game.startDate, today) + 1)]
    : [];
  parts.push(gameMarketDataAge(today));
  const player = document.getElementById('game-player');
  player.innerHTML = parts.join(' · ');
  player.title = GamePage.marketDate ? 'Market data synced on ' + formatDate(GamePage.marketDate) : '';
}

function gameMarketDataAge(today) {
  if (!GamePage.marketDate) return 'NO MARKET DATA';
  const age = GameEngine.daysBetween(GamePage.marketDate, today);
  return 'MARKET DATA FROM ' + (age <= 0 ? 'TODAY' : age === 1 ? '1 DAY AGO' : age + ' DAYS AGO');
}

function gameRenderStart() {
  const locationSelect = document.getElementById('game-location');
  if (!locationSelect.options.length) {
    locationSelect.innerHTML = Object.keys(GameEngine.LOCATIONS).map((key) =>
      '<option value="' + key + '">' + GameEngine.LOCATIONS[key].label + '</option>').join('');
    locationSelect.onchange = gameRenderStart;
  }
  const location = locationSelect.value;
  document.getElementById('game-start-back').style.display = GamePage.game ? '' : 'none';
  document.getElementById('game-difficulty-grid').innerHTML = Object.keys(GameEngine.DIFFICULTIES).map((key) => {
    const level = GameEngine.DIFFICULTIES[key];
    const budget = GameEngine.monthlyBudget({ location: location, difficulty: key }, GamePage.market, []);
    return '<div class="col-12 col-md-4 mb-3"><button class="game-level" data-level="' + key + '">' +
      '<span class="game-level-name">' + level.label + '</span>' +
      '<span class="game-level-story">' + escapeHtml(level.story) + '</span>' +
      '<span class="game-level-cash">CHF ' + level.startCash.toLocaleString('en-GB') + '</span>' +
      '<span class="game-level-salary">GROSS SALARY CHF ' + GameEngine.yearlySalary(location, key).toLocaleString('en-GB') + ' A YEAR<br>' +
      'TAKE HOME ' + gameMoney(budget.netSalaryChf) + ' · COSTS ' + gameMoney(budget.expensesChf) + ' A MONTH</span></button></div>';
  }).join('');
  document.querySelectorAll('.game-level').forEach((button) => {
    button.onclick = () => gameStartNew(button.dataset.level);
  });
}

function gameRenderStats(state, today) {
  const days = state.days;
  const last = days[days.length - 1];
  // The first day is measured from the start cash, so its trades show up in TODAY too.
  const startCash = GamePage.game.startCash;
  const previous = days.length > 1 ? days[days.length - 2] : { netWorth: startCash, moneyIn: startCash };
  const invested = state.positions.reduce((sum, position) => sum + position.valueChf, 0) + state.dayTrades.reduce((sum, position) => sum + position.amountChf, 0);
  const totalChange = last.moneyIn > 0 ? last.netWorth / last.moneyIn - 1 : null;
  const benchmarkChange = last.benchmark != null && last.moneyIn > 0 ? last.benchmark / last.moneyIn - 1 : null;
  // Salary and bills paid today are not a gain or a loss.
  const dayChange = (last.netWorth - previous.netWorth) - (last.moneyIn - previous.moneyIn);
  const traderText = { private: 'PRIVATE INVESTOR', review: 'UNDER REVIEW', risk: 'PRO TRADER RISK' }[state.trader.status];
  const traderTitle = 'This year: ' + state.trader.shortSales + ' sale(s) held under 6 months, trade volume ' +
    state.trader.volumeMultiple.toFixed(1) + 'x your wealth at the start of the year (limit 5x).';
  const stat = (label, value, extraClass, title) =>
    '<div class="game-stat"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
    '<span class="game-stat-label">' + label + '</span><span class="game-stat-value ' + (extraClass || '') + '">' + value + '</span></div>';
  const group = (label, stats) =>
    '<div class="stat-card game-stat-group"><span class="stat-label">' + label + '</span>' +
    '<div class="game-stat-grid">' + stats.join('') + '</div></div>';
  // Net worth and cash sit above the tabs; the other figures live in the tab they belong to.
  document.getElementById('game-stats').innerHTML =
    '<div class="stat-card game-hero">' +
      '<div><span class="stat-label">NET WORTH</span><span class="stat-value game-hero-value">' + gameMoney(last.netWorth, today) + '</span></div>' +
      '<div class="game-stat-grid game-hero-side">' + [
        stat('TODAY', gameSignedMoney(dayChange, today), gameSignClass(dayChange)),
        stat('TOTAL RETURN', totalChange == null ? '—' : gamePercent(totalChange), totalChange == null ? '' : gameSignClass(totalChange, 4),
          'Net worth against the money put in: your start cash plus what you saved from your salary.'),
        stat('VS SMI', benchmarkChange == null || totalChange == null ? '—' : gamePercent(totalChange - benchmarkChange) + ' PTS',
          benchmarkChange == null || totalChange == null ? '' : gameSignClass(totalChange - benchmarkChange, 4), 'Your return minus the return of the same money put into the SMI on the same days.'),
        stat('CASH', gameMoney(state.cash, today), state.cash < 0 ? 'game-neg' : ''),
      ].join('') + '</div>' +
    '</div>';
  document.getElementById('game-money').innerHTML = group('MONEY', [
    stat('INVESTED', gameMoney(invested, today)),
    stat('MORTGAGES', state.mortgageChf > 0 ? '-' + gameMoney(state.mortgageChf, today) : gameMoney(0, today), state.mortgageChf > 0 ? 'game-neg' : ''),
    stat('LOMBARD LOAN', state.loanChf > 0 ? '-' + gameMoney(state.loanChf, today) : gameMoney(0, today), state.loanChf > 0 ? 'game-neg' : ''),
    stat('MONEY PUT IN', gameMoney(last.moneyIn, today), '', 'Your start cash plus what you saved from your salary after expenses.'),
  ]);
  // Saved per month is in the budget table beside this card.
  document.getElementById('game-costs').innerHTML = group('SINCE YOU STARTED', [
    stat('DIVIDENDS', gameMoney(state.dividendsReceived, today), '', 'Dividends paid to you before income tax. The tax on them is in the taxes paid.'),
    stat('TAXES &amp; FEES PAID', gameMoney(state.taxesPaid + state.feesPaid, today), '',
      'Wealth tax, income tax on dividends, property gains tax, stamp duty, purchase costs, dealer cuts and Lombard interest.'),
    stat('EXPENSES PAID', gameMoney(state.expensesPaid, today)),
    stat('TAX STATUS THIS YEAR', traderText, 'game-trader-' + state.trader.status, traderTitle),
  ]);
}

// The board's tabs; the open one is kept in the URL hash so a reload stays on it.
const GAME_TABS = ['overview', 'portfolio', 'day-trading', 'options', 'budget', 'history'];
function gameShowTab(tab) {
  const open = GAME_TABS.includes(tab) ? tab : 'overview';
  history.replaceState(null, '', '#' + open);
  GAME_TABS.forEach((name) => {
    document.getElementById('game-tab-' + name).setAttribute('aria-selected', String(name === open));
    document.getElementById('game-panel-' + name).hidden = name !== open;
  });
}

function gameRenderChart(state) {
  const accent = readAccent();
  const scaleOn = (date) => (GamePage.currency === 'CHF' ? 1 : GamePage.market.rate('CHF', GamePage.currency, date) || 1);
  const points = (key) => state.days.filter((day) => day[key] != null).map((day) => ({ x: day.date, y: day[key] * scaleOn(day.date) }));
  if (GamePage.chart) GamePage.chart.destroy();
  GamePage.chart = null;
  // One day is a single dot in an empty frame: show a note until there is a line to draw.
  const enoughDays = state.days.length > 1;
  document.getElementById('game-chart-empty').style.display = enoughDays ? 'none' : '';
  document.querySelector('.game-chart-wrap').style.display = enoughDays ? '' : 'none';
  if (!enoughDays) return;
  GamePage.chart = new Chart(document.getElementById('game-chart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'NET WORTH', data: points('netWorth'), borderColor: accent, backgroundColor: accent, pointRadius: state.days.length < 3 ? 3 : 0, borderWidth: 2 },
        { label: 'SMI', data: points('benchmark'), borderColor: '#4da6ff', backgroundColor: '#4da6ff', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 },
        { label: 'MONEY PUT IN', data: points('moneyIn'), borderColor: '#888888', backgroundColor: '#888888', borderDash: [2, 3], pointRadius: 0, borderWidth: 1.5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time', time: { unit: state.days.length > 90 ? 'month' : 'day', tooltipFormat: 'dd LLL yyyy' }, grid: { color: '#1f1f1f' }, ticks: { color: '#888' } },
        y: { grid: { color: '#1f1f1f' }, ticks: { color: '#888' } },
      },
      plugins: {
        legend: { labels: { color: '#d0d0d0' } },
        tooltip: { callbacks: { label: (item) => item.dataset.label + ': ' + (_WALL_STREET_CURRENCY_SYMBOL[GamePage.currency] || GamePage.currency) + ' ' + item.parsed.y.toLocaleString('en-GB', { maximumFractionDigits: 2 }) } },
      },
    },
  });
}

function gameRenderHoldings(state, today) {
  const container = document.getElementById('game-holdings');
  const reinvesting = GameEngine.reinvestsOn(GamePage.game, today);
  const reinvestButton = document.getElementById('game-reinvest-btn');
  reinvestButton.textContent = 'DIVIDENDS: ' + (reinvesting ? 'REINVEST' : 'CASH');
  reinvestButton.setAttribute('aria-pressed', String(reinvesting));
  if (!state.positions.length) {
    container.innerHTML = '<div class="empty-state">NO HOLDINGS YET. BUY SOMETHING.</div>';
    return;
  }
  const sum = (positions, key) => positions.reduce((total, position) => total + position[key], 0);
  const totalChf = sum(state.positions, 'valueChf');
  const shareOfHoldings = (valueChf) => (totalChf > 0 ? (valueChf / totalChf * 100).toFixed(1) + '% OF HOLDINGS' : '');
  const profitCell = (valueChf, costChf) => {
    const profitLoss = valueChf - costChf;
    return '<td class="text-end ' + gameSignClass(profitLoss) + '">' + gameSignedMoney(profitLoss, today) +
      '<br><small>' + gamePercent(costChf ? profitLoss / costChf : 0) + '</small></td>';
  };

  const groups = gameHoldingGroups(state.positions);

  const row = (position) => {
    const symbol = escapeHtml(position.symbol);
    const unit = gameUnit(position);
    const perUnit = unit ? ' / ' + unit : '';
    // Whole units for cars, watches, art and houses: sell one at a time, never half a car.
    const partialSell = GameEngine.isTangible(position.class)
      ? '<button class="btn btn-gta btn-sm game-sell" data-symbol="' + symbol + '" data-quantity="1">SELL 1</button> '
      : '<button class="btn btn-gta btn-sm game-sell-order" data-symbol="' + symbol + '">ORDER</button> ' +
        '<button class="btn btn-gta btn-sm game-sell" data-symbol="' + symbol + '" data-fraction="0.5">SELL 50%</button> ';
    const mortgage = position.mortgageChf > 0 ? '<br><small class="game-neg">MORTGAGE -' + gameMoney(position.mortgageChf, today) + '</small>' : '';
    return '<tr><td><span class="game-symbol">' + escapeHtml(position.name) + '</span><span class="game-name">' + gameHoldingDetail(position) + '</span></td>' +
      '<td class="text-end">' + gameHoldingQuantity(position) + '</td>' +
      '<td class="text-end">' + gameMoney(position.unitValueChf, today) + perUnit +
        '<br><small class="game-dim">PAID ' + gameMoney(position.quantity ? position.costChf / position.quantity : 0, today) + perUnit + '</small></td>' +
      '<td class="text-end">' + gameMoney(position.valueChf, today) + '<br><small class="game-dim">' + shareOfHoldings(position.valueChf) + '</small>' + mortgage + '</td>' +
      profitCell(position.valueChf, position.costChf) +
      '<td class="text-end text-nowrap">' + partialSell +
      '<button class="btn btn-gta btn-sm btn-danger-del game-sell" data-symbol="' + symbol + '" data-fraction="1">SELL ALL</button></td></tr>';
  };
  const rows = groups.map((group) => {
    const valueChf = sum(group.positions, 'valueChf');
    return '<tr class="game-holdings-group"><td colspan="3">' + group.label + ' <span class="game-dim">· ' + group.positions.length + '</span></td>' +
      '<td class="text-end">' + gameMoney(valueChf, today) + '<br><small class="game-dim">' + shareOfHoldings(valueChf) + '</small></td>' +
      profitCell(valueChf, sum(group.positions, 'costChf')) + '<td></td></tr>' +
      group.positions.slice().sort((first, second) => second.valueChf - first.valueChf).map(row).join('');
  }).join('');
  container.innerHTML = '<table class="table-gta w-100"><thead><tr><th>ASSET</th><th class="text-end">QUANTITY</th><th class="text-end">PRICE</th>' +
    '<th class="text-end">VALUE</th><th class="text-end">P&amp;L</th><th></th></tr></thead><tbody>' + rows + '</tbody>' +
    '<tfoot><tr class="game-holdings-total"><td colspan="3">TOTAL</td><td class="text-end">' + gameMoney(totalChf, today) + '</td>' +
    profitCell(totalChf, sum(state.positions, 'costChf')) + '<td></td></tr></tfoot></table>';
  container.querySelectorAll('.game-sell').forEach((button) => {
    const order = button.dataset.quantity ? { quantity: Number(button.dataset.quantity) } : { fraction: Number(button.dataset.fraction) };
    button.onclick = () => gameTrade(GameEngine.sell(GamePage.game, GamePage.market, button.dataset.symbol, order, todayIsoDate(), new Date().toISOString()));
  });
  container.querySelectorAll('.game-sell-order').forEach((button) => {
    button.onclick = () => gameOpenSellOrder(button.dataset.symbol, null);
  });
}

// The short holdings under the holdings table: what each would gain or lose if bought back at the last close.
function gameRenderShorts(state, today) {
  const container = document.getElementById('game-shorts');
  if (!state.shorts.length) { container.innerHTML = ''; return; }
  container.innerHTML = '<table class="table-gta w-100 mt-3"><thead><tr><th>SHORTS · ' + state.shorts.length + '</th><th class="text-end">QUANTITY</th>' +
    '<th class="text-end">PRICE</th><th class="text-end">TO BUY BACK</th><th class="text-end">P&amp;L</th><th></th></tr></thead><tbody>' +
    state.shorts.map((short) => {
      const symbol = escapeHtml(short.symbol);
      const profitChf = short.soldChf - short.dutyChf - short.valueChf * (1 + GameEngine.stampDutyRate(short));
      const buybackPriceChf = short.heldChf / GameEngine.SHORT_MAINTENANCE / short.quantity;
      return '<tr><td><span class="game-symbol">' + escapeHtml(short.name) + '</span><span class="game-name">' + symbol + ' · <span class="game-neg">SHORT</span></span></td>' +
        '<td class="text-end">' + gameQuantityWithUnit(short, short.quantity) + '</td>' +
        '<td class="text-end">' + gameMoney(short.valueChf / short.quantity, today) + '<br><small class="game-dim">SOLD AT ' + gameMoney(short.priceChf, today) + '</small></td>' +
        '<td class="text-end">' + gameMoney(short.valueChf, today) + '<br><small class="game-dim">BANK BUYS BACK AT ' + gameMoney(buybackPriceChf, today) + '</small></td>' +
        '<td class="text-end ' + gameSignClass(profitChf) + '">' + gameSignedMoney(profitChf, today) + '<br><small>' + gamePercent(profitChf / short.soldChf) + '</small></td>' +
        '<td class="text-end text-nowrap"><button class="btn btn-gta btn-sm game-cover" data-symbol="' + symbol + '" data-fraction="0.5">BUY BACK 50%</button> ' +
        '<button class="btn btn-gta btn-sm btn-danger-del game-cover" data-symbol="' + symbol + '" data-fraction="1">BUY BACK ALL</button></td></tr>';
    }).join('') + '</tbody></table><p class="game-note">THE SALE AMOUNT AND HALF OF IT AGAIN ARE HELD AS COLLATERAL. A ' +
    gameRate(GameEngine.SHORT_BORROW_FEE_RATE) + ' BORROW FEE IS PAID EVERY MONTH, AND THE DIVIDENDS GO TO THE LENDER.</p>';
  container.querySelectorAll('.game-cover').forEach((button) => {
    button.onclick = () => gameTrade(GameEngine.coverShort(GamePage.game, GamePage.market, button.dataset.symbol, { fraction: Number(button.dataset.fraction) },
      todayIsoDate(), new Date().toISOString()));
  });
}

// A list of labeled bars: name, figure and a thin bar per row. Every value is printed, so the list is its own table view.
// A row's `share` (0..1) fills the bar from the left; a row's `change` (-1..1) grows right for a gain, left for a loss.
function gameMeterList(rows) {
  return '<div class="game-meters">' + rows.map((row) => {
    let fill = '<div class="game-meter-fill" style="width:' + (Math.max(0, row.share) * 100).toFixed(2) + '%"></div>';
    if (row.change != null) {
      const width = (Math.min(1, Math.abs(row.change)) * 50).toFixed(2) + '%';
      fill = '<div class="game-meter-zero"></div>' + (row.change > 0 ? '<div class="game-meter-fill game-meter-gain" style="left:50%;width:' + width + '"></div>'
        : row.change < 0 ? '<div class="game-meter-fill game-meter-loss" style="right:50%;width:' + width + '"></div>' : '');
    }
    return '<div class="game-meter"' + (row.title ? ' title="' + escapeHtml(row.title) + '"' : '') + '>' +
      '<div class="game-meter-text"><span class="game-meter-name">' + row.name + '</span><span class="game-meter-figure ' + (row.figureClass || '') + '">' + row.figure + '</span></div>' +
      '<div class="game-meter-track' + (row.change != null ? ' game-meter-track-neutral' : '') + '">' + fill + '</div></div>';
  }).join('') + '</div>';
}

// Allocation of cash and holdings, the weight of each holding and each holding's return.
function gameRenderPortfolioCharts(state, today) {
  const sum = (positions) => positions.reduce((total, position) => total + position.valueChf, 0);
  const share = (part, whole) => (whole > 0 ? part / whole : 0);
  const percentText = (value) => (value * 100).toFixed(1) + '%';

  const parts = [{ name: 'CASH', valueChf: Math.max(0, state.cash) }, { name: 'DAY TRADES', valueChf: state.dayTrades.reduce((sum, position) => sum + position.amountChf, 0) }]
    .concat(gameHoldingGroups(state.positions).map((group) => ({ name: group.label, valueChf: sum(group.positions) })))
    .filter((part) => part.valueChf > 0)
    .sort((first, second) => second.valueChf - first.valueChf);
  const assetsChf = parts.reduce((total, part) => total + part.valueChf, 0);
  document.getElementById('game-allocation').innerHTML = gameMeterList(parts.map((part) => ({
    name: part.name, figure: gameMoney(part.valueChf, today) + ' · ' + percentText(share(part.valueChf, assetsChf)), share: share(part.valueChf, assetsChf),
  })));

  const empty = '<div class="game-dim">NO HOLDINGS YET.</div>';
  const holdingsChf = sum(state.positions);
  const byValue = state.positions.slice().sort((first, second) => second.valueChf - first.valueChf);
  // Eight bars at most: the rest fold into one OTHER row.
  const top = byValue.length > 8 ? byValue.slice(0, 7) : byValue;
  const rest = byValue.slice(top.length);
  const weights = top.map((position) => ({ name: escapeHtml(position.name), valueChf: position.valueChf }));
  if (rest.length) weights.push({ name: 'OTHER (' + rest.length + ')', valueChf: sum(rest) });
  document.getElementById('game-weights').innerHTML = !weights.length ? empty : gameMeterList(weights.map((weight) => ({
    name: weight.name, figure: percentText(share(weight.valueChf, holdingsChf)), share: share(weight.valueChf, holdingsChf),
  })));

  const returns = state.positions.map((position) => ({ position: position, change: position.costChf ? position.valueChf / position.costChf - 1 : 0 }))
    .sort((first, second) => second.change - first.change);
  // Bars scale to the biggest move, so small returns still show.
  const biggestMove = Math.max(...returns.map((item) => Math.abs(item.change)), 0);
  document.getElementById('game-returns').innerHTML = !returns.length ? empty : gameMeterList(returns.map((item) => ({
    name: escapeHtml(item.position.name), figure: gamePercent(item.change), figureClass: gameSignClass(item.change, 4),
    change: biggestMove > 0 ? item.change / biggestMove : 0,
    title: 'P&L ' + gameSignedMoney(item.position.valueChf - item.position.costChf, today),
  })));
}

// The Lombard loan card: what the holdings let you borrow, what is owed and its interest.
function gameRenderLoan(state, today) {
  const rate = GameEngine.LOMBARD_INTEREST_RATE;
  const ratios = GameEngine.LOMBARD_LOAN_TO_VALUE;
  document.getElementById('game-loan-note').textContent = gameRate(rate) + ' A YEAR';
  const availableChf = Math.max(0, state.lendingValueChf - state.loanChf);
  document.getElementById('game-loan').innerHTML = gamePreviewTable([
    ['LENDING VALUE', gameMoney(state.lendingValueChf, today)],
    ['YOU OWE', '<span class="' + (state.loanChf > 0 ? 'game-neg' : '') + '">' + gameMoney(state.loanChf, today) + '</span>'],
    ['YOU CAN BORROW', gameMoney(availableChf, today)],
    ['INTEREST A MONTH', gameMoney(state.loanChf * rate / 12, today)],
  ]) + '<div class="game-dim mt-1">THE BANK LENDS ' + gameRate(ratios.stock) + ' OF YOUR STOCKS, ' + gameRate(ratios.etf) + ' OF YOUR ETFS AND ' +
    gameRate(ratios.metal) + ' OF YOUR METALS. IF PRICES FALL AND YOU OWE MORE THAN THAT, YOUR CASH PAYS IT DOWN FIRST, THEN YOUR HOLDINGS ARE SOLD.</div>';
}

function gameRenderBudget(state, today) {
  const budget = state.budget;
  document.getElementById('game-budget-title').textContent = 'MONTHLY BUDGET · ' + GameEngine.LOCATIONS[GamePage.game.location].label;
  const line = (label, amountChf, note, extraClass) =>
    '<tr class="' + (extraClass || '') + '"><td>' + escapeHtml(label) + (note ? '<span class="game-name">' + escapeHtml(note) + '</span>' : '') + '</td>' +
    '<td class="text-end text-nowrap">' + gameMoney(amountChf, today) + '</td></tr>';
  const heading = (label) => '<tr class="game-budget-heading"><td colspan="2">' + label + '</td></tr>';
  const yearlySalary = '<tr class="game-budget-note"><td colspan="2">GROSS SALARY CHF ' +
    GameEngine.yearlySalary(GamePage.game.location, GamePage.game.difficulty).toLocaleString('en-GB') + ' A YEAR</td></tr>';
  const rows = [heading('INCOME'), yearlySalary]
    .concat(budget.income.map((item) => line(item.label, item.amountChf)))
    .concat([line('TAKE HOME', budget.netSalaryChf, '', 'game-budget-total'), heading('EXPENSES')])
    .concat(budget.expenses.map((item) => line(item.label, -item.amountChf, item.note)))
    .concat([line('TOTAL EXPENSES', -budget.expensesChf, '', 'game-budget-total')])
    .concat([line('SAVED PER MONTH', budget.savingsChf, '', 'game-budget-total ' + gameSignClass(budget.savingsChf))]);
  if (budget.amortizationChf > 0) rows.push(line('MORTGAGE PAYBACK', -budget.amortizationChf, 'PAYS DOWN THE DEBT, NOT AN EXPENSE'));
  document.getElementById('game-budget').innerHTML = '<table class="table-gta w-100 game-budget"><tbody>' + rows.join('') + '</tbody></table>' +
    '<p class="game-note">Paid on the last day of each month, pro rata for the days you own things. Rent stops while you own a home.</p>';
}

function gameRenderHistory(state) {
  const container = document.getElementById('game-history');
  const events = state.events.slice().reverse();
  if (!events.length) {
    container.innerHTML = '<div class="empty-state">NO TRADES YET.</div>';
    return;
  }
  const rows = events.map((event) => {
    if (event.type === 'tax') {
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-tax">WEALTH TAX ' + event.year + '</span></td>' +
        '<td colspan="3">ON NET WORTH ' + gameMoney(event.wealthChf, event.date) + '</td><td class="text-end game-neg">-' + gameMoney(event.amountChf, event.date) + '</td></tr>';
    }
    if (event.type === 'dividend') {
      const cashChange = event.amountChf - event.taxChf;
      // A short pays the dividend to the lender of its units, without tax.
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-dividend">DIVIDEND' + (event.short ? ' PAID' : '') + '</span></td>' +
        '<td><span class="game-symbol">' + escapeHtml(event.name) + '</span><span class="game-name">' + gameClassLabel(event) + '</span></td>' +
        '<td class="text-end">' + gameQuantityWithUnit(event, event.quantity) + ' × ' + gameMoney(event.perUnitChf, event.date) + '</td>' +
        '<td class="text-end">' + (event.short ? 'TO THE LENDER' : 'INCOME TAX ' + gameMoney(event.taxChf, event.date)) + '</td>' +
        '<td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
    }
    if (event.type === 'expiry') {
      const option = event.option;
      const inTheMoney = option.kind === 'call' ? event.spotChf > option.strike : event.spotChf < option.strike;
      const result = !inTheMoney ? (option.written ? 'WORTHLESS, PREMIUM KEPT' : 'WORTHLESS') : option.written ? 'ASSIGNED AT THE STRIKE' : 'PAID OUT';
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-month">OPTION ENDED</span></td>' +
        '<td><span class="game-symbol">' + escapeHtml(event.name) + ' ' + gameOptionContract(option, event.date) + '</span><span class="game-name">' +
          (option.written ? 'WRITTEN' : 'BOUGHT') + ' · CLOSE ' + gameMoney(event.spotChf, event.date) + '</span></td>' +
        '<td class="text-end">' + gameQuantity(event.quantity) + ' UNITS · ' + result + '</td>' +
        '<td class="text-end"><span class="' + gameSignClass(event.profitChf) + '">P&amp;L ' + gameSignedMoney(event.profitChf, event.date) + '</span></td>' +
        '<td class="text-end ' + gameSignClass(event.cashChf) + '">' + gameSignedMoney(event.cashChf, event.date) + '</td></tr>';
    }
    if (event.type === 'borrow' || event.type === 'repay') {
      const cashChange = event.type === 'borrow' ? event.amountChf : -event.amountChf;
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-month">LOMBARD ' + event.type.toUpperCase() + '</span></td>' +
        '<td colspan="3">' + (event.type === 'borrow' ? 'BORROWED AGAINST YOUR HOLDINGS' : 'PAID BACK') + '</td>' +
        '<td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
    }
    if (event.type === 'margin') {
      // The sales show their proceeds on their own rows; both those and the cash go to the bank here.
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-tax">MARGIN CALL</span></td>' +
        '<td colspan="3">LOAN ABOVE THE LENDING VALUE: ' + gameMoney(event.fromCashChf, event.date) + ' PAID FROM CASH' +
        (event.fromSalesChf > 0 ? ', ' + gameMoney(event.fromSalesChf, event.date) + ' FROM SELLING HOLDINGS' : '') + '</td>' +
        '<td class="text-end game-neg">-' + gameMoney(event.fromCashChf + event.fromSalesChf, event.date) + '</td></tr>';
    }
    if (event.type === 'month') {
      const cashChange = event.salaryChf - event.expensesChf - event.amortizationChf - (event.lombardInterestChf || 0) - (event.borrowFeeChf || 0);
      const parts = ['SALARY ' + gameSignedMoney(event.salaryChf, event.date), 'EXPENSES -' + gameMoney(event.expensesChf, event.date)];
      if (event.amortizationChf > 0) parts.push('MORTGAGE PAYBACK -' + gameMoney(event.amortizationChf, event.date));
      if (event.lombardInterestChf > 0) parts.push('LOMBARD INTEREST -' + gameMoney(event.lombardInterestChf, event.date));
      if (event.borrowFeeChf > 0) parts.push('BORROW FEE ON SHORTS -' + gameMoney(event.borrowFeeChf, event.date));
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-month">MONTH</span></td>' +
        '<td colspan="3">' + parts.join(' · ') + '</td><td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
    }
    // A short sale holds its amount like a buy; a closed day trade carries its own cash change.
    const cashChange = event.cashChf != null ? event.cashChf
      : event.type === 'buy' || event.short ? -(event.amountChf - event.mortgageChf + event.stampDutyChf + event.purchaseCostsChf)
      : event.amountChf - event.stampDutyChf - event.dealerFeeChf - event.gainsTaxChf - event.mortgageRepaidChf;
    const fees = [];
    if (event.stampDutyChf) fees.push('DUTY ' + gameMoney(event.stampDutyChf, event.date));
    if (event.purchaseCostsChf) fees.push('TRANSFER TAX &amp; NOTARY ' + gameMoney(event.purchaseCostsChf, event.date));
    if (event.mortgageChf) fees.push('MORTGAGE ' + gameMoney(event.mortgageChf, event.date));
    if (event.dealerFeeChf) fees.push((GAME_SELLER_LABELS[event.class] || 'DEALER') + ' ' + gameMoney(event.dealerFeeChf, event.date));
    if (event.gainsTaxChf) fees.push('GAINS TAX ' + gameMoney(event.gainsTaxChf, event.date));
    if (event.profitChf != null) fees.push('<span class="' + gameSignClass(event.profitChf) + '">P&amp;L ' + gameSignedMoney(event.profitChf, event.date) + '</span>');
    if (event.mortgageRepaidChf) fees.push('MORTGAGE PAID BACK ' + gameMoney(event.mortgageRepaidChf, event.date));
    const orderType = { limit: 'LIMIT ', stop: 'STOP ', trail: 'TRAILING STOP ' }[event.orderType] || '';
    const action = event.option ? (event.optionAt ? 'CLOSE ' : event.option.written ? 'WRITE ' : 'BUY ') + event.option.kind.toUpperCase()
      : event.short ? (event.type === 'sell' ? 'SHORT' : 'BUY BACK') : event.type.toUpperCase();
    return '<tr><td>' + formatDate(event.date) + (event.at ? ' ' + gameClock(event.at) : '') + '</td><td><span class="game-badge game-badge-' + event.type + '">' +
      (event.intraday ? 'DAY ' : '') + (event.reinvested ? 'DIVIDEND ' : '') + (event.marginCall ? 'MARGIN CALL ' : '') + (event.assigned ? 'ASSIGNED ' : '') +
      orderType + action + '</span></td>' +
      '<td><span class="game-symbol">' + escapeHtml(event.name) + (event.option ? ' ' + gameOptionContract(event.option, event.date) : '') + '</span>' +
      '<span class="game-name">' + gameClassLabel(event) + (event.option ? ' · ENDS ' + formatDate(event.option.expiry) : '') + '</span></td>' +
      '<td class="text-end">' + gameQuantityWithUnit(event, event.quantity) + ' @ ' + gameMoney(event.priceChf, event.date) + '</td>' +
      '<td class="text-end">' + (fees.length ? fees.join('<br>') : '—') + '</td>' +
      '<td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
  }).join('');
  container.innerHTML = '<table class="table-gta w-100"><thead><tr><th>DATE</th><th>TYPE</th><th>ASSET</th><th class="text-end">QUANTITY</th>' +
    '<th class="text-end">FEES</th><th class="text-end">CASH</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

// The asset list of one buy category: today's price on every option, in option groups when the category has several.
function gameAssetOptions(category, today) {
  const groups = new Map();
  GamePage.assets.filter(category.matches).forEach((asset) => {
    const label = category.groupOf ? category.groupOf(asset) : '';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ asset: asset, quote: GamePage.market.quote(asset.symbol, today) });
  });
  // Groups keep the catalog order (compact cars before supercars); only the items inside a group go cheapest first.
  const priceOf = (entry) => (entry.quote ? entry.quote.priceChf : 0);
  if (category.byPrice) groups.forEach((entries) => entries.sort((first, second) => priceOf(first) - priceOf(second)));
  const order = category.groupOrder || [];
  const rank = (label) => (order.includes(label) ? order.indexOf(label) : order.length);
  const labels = [...groups.keys()].sort((first, second) => rank(first) - rank(second));
  const option = (entry) => {
    const asset = entry.asset;
    const physical = GameTangibles.isTangible(asset.symbol) || GameTangibles.PRECIOUS_METALS[asset.symbol];
    const name = physical ? asset.name || asset.symbol : (asset.name || asset.symbol) + ' (' + asset.symbol + ')';
    const unit = gameUnit(asset);
    const price = entry.quote ? gameMoney(entry.quote.priceChf, today) + (unit ? ' / ' + unit : '') : 'NO PRICE';
    return '<option value="' + escapeHtml(asset.symbol) + '">' + escapeHtml(name + ' · ' + price) + '</option>';
  };
  if (labels.length === 1) return groups.get(labels[0]).map(option).join('');
  return labels.map((label) => '<optgroup label="' + escapeHtml(label) + '">' + groups.get(label).map(option).join('') + '</optgroup>').join('');
}

function gameSelectedAsset() {
  return GamePage.assets.find((item) => item.symbol === document.getElementById('game-asset').value);
}

// Cars, watches, art and houses come in whole units, so they are always bought by quantity.
function gameBuyMode(asset) {
  return asset && GameEngine.isTangible(asset.class) ? 'quantity' : GamePage.buyMode;
}

function gameOrder(asset) {
  const value = Number(document.getElementById('game-amount').value);
  if (gameBuyMode(asset) === 'amount') return { amountChf: value };
  const kilos = GameTangibles.PRECIOUS_METALS[asset.symbol] && document.getElementById('game-unit').value === 'kg';
  const order = { quantity: kilos ? value * 1000 : value };
  if (asset.class === 'house') order.downPayment = Number(document.getElementById('game-down').value) / 100;
  return order;
}

// What the selected asset is and what owning it costs, before any amount is typed, as [label, value, note] rows.
function gameAssetDetails(asset, state, priceChf, today) {
  const rows = [];
  const metal = GameTangibles.PRECIOUS_METALS[asset.symbol];
  if (metal) return [['MARKET', 'PHYSICAL ' + metal + ' AT THE REAL PRICE, PER GRAM'], ['TAX', 'NO STAMP DUTY, GAINS ARE TAX FREE']];
  if (!GameEngine.isTangible(asset.class)) {
    const dutyRate = GameEngine.stampDutyRate(asset);
    rows.push(['STAMP DUTY', dutyRate ? gameRate(dutyRate) + (asset.symbol.toUpperCase().endsWith('.SW') ? ' (SWISS)' : ' (FOREIGN)') + ' ON EVERY BUY AND SELL' : 'NONE']);
    rows.push(['GAINS', 'TAX FREE WHILE YOU STAY A PRIVATE INVESTOR']);
    return rows;
  }
  const item = GameTangibles.item(asset.symbol);
  rows.push(['MARKET', (item.trend >= 0 ? 'RISES' : 'FALLS') + ' ABOUT ' + gameRate(Math.abs(item.trend)) + ' A YEAR']);
  if (asset.class === 'car') {
    const carsAfter = gameCarUnits(state) + 1;
    if (!item.depreciation) rows.push(['YOURS', 'NO EXTRA VALUE LOSS, A CLASSIC FOLLOWS THE MARKET PRICE']);
    else {
      rows.push(['YOURS', 'LOSES ABOUT ' + gameRate(-item.depreciation) + ' A YEAR AS YOUR ONLY CAR',
        'HALF FROM AGE AND HALF FROM ' + GameEngine.CAR_KM_PER_YEAR.toLocaleString('en-GB') + ' KM A YEAR']);
      if (carsAfter > 1) {
        rows.push(['WITH ' + carsAfter + ' CARS', 'LOSES ABOUT ' + gameRate(-GameEngine.ownedYearlyChange(GamePage.market, asset.symbol, 'car', carsAfter)) + ' A YEAR',
          'EACH CAR DRIVES ' + Math.round(GameEngine.CAR_KM_PER_YEAR / carsAfter).toLocaleString('en-GB') + ' KM A YEAR']);
      }
    }
    const costs = GameEngine.carMonthlyCosts(GamePage.game.location, item, priceChf, carsAfter);
    rows.push(['RUNNING COSTS', gameMoney(costs.totalChf, today) + ' A MONTH', 'INSURANCE ' + gameMoney(costs.insuranceChf, today) + ', ROAD TAX ' +
      gameMoney(costs.roadTaxChf, today) + ', PARKING ' + gameMoney(costs.parkingChf, today) + ', FUEL &amp; SERVICE ' + gameMoney(costs.fuelAndServiceChf, today)]);
  } else if (asset.class === 'house') {
    const city = GameEngine.HOUSE_LOCATIONS[item.location];
    const costs = GameEngine.houseMonthlyCosts(item.location, priceChf);
    rows.push(['YOURS', 'FOLLOWS THE MARKET PRICE']);
    rows.push(['PURCHASE COSTS', gameRate(GameEngine.housePurchaseCostRate(item.location)) + ' OF THE PRICE', 'TRANSFER TAX ' + gameRate(city.transferTaxRate) +
      ' (' + city.label + '), NOTARY &amp; LAND REGISTRY ' + gameRate(city.notaryRate)]);
    rows.push(['RUNNING COSTS', gameMoney(costs.totalChf, today) + ' A MONTH', 'UPKEEP ' + gameMoney(costs.maintenanceChf, today) + ', ENERGY &amp; INSURANCE ' +
      gameMoney(costs.utilitiesChf, today) + ', PROPERTY TAX ' + gameMoney(costs.propertyTaxChf, today) + '. NO RENT WHILE YOU OWN A HOME']);
    rows.push(['MORTGAGE', gameRate(GameEngine.MORTGAGE_INTEREST_RATE) + ' A YEAR, AT LEAST 20% DOWN', 'THE PART ABOVE 2/3 OF THE PRICE IS PAID BACK EVERY MONTH OVER 15 YEARS. ' +
      'THE BANK CHECKS THAT 5% INTEREST, 1% UPKEEP AND THE PAYBACK STAY UNDER 1/3 OF YOUR GROSS SALARY']);
  } else {
    rows.push(['YOURS', item.depreciation ? 'LOSES ABOUT ' + gameRate(-item.depreciation) + ' A YEAR ON TOP OF THE MARKET PRICE' : 'FOLLOWS THE MARKET PRICE, NO EXTRA VALUE LOSS']);
  }
  rows.push(['WHEN YOU SELL', GAME_SELLER_LABELS[asset.class] + ' KEEPS ' + Math.round(GameEngine.dealerFeeRate(asset.class) * 100) + '%']);
  if (asset.class === 'house') rows.push(['GAINS TAX', 'ON THE PROFIT: HIGHER IF SOLD WITHIN 2 YEARS, LOWER AFTER 5']);
  return rows;
}

// The cost preview of the order being typed; returns whether it can be bought.
function gameRenderPreview(asset, today) {
  const container = document.getElementById('game-preview');
  const value = Number(document.getElementById('game-amount').value);
  if (!asset || !(value > 0)) {
    container.innerHTML = '<span class="game-dim">' + (gameBuyMode(asset) === 'quantity' ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT') + ' TO SEE THE COSTS</span>';
    return false;
  }
  const preview = GameEngine.previewBuy(GamePage.game, GamePage.market, asset, gameOrder(asset), today, new Date().toISOString());
  const errorLine = preview.error ? '<div class="game-neg game-preview-error">' + escapeHtml(preview.error) + '</div>' : '';
  if (!preview.trade) { container.innerHTML = errorLine; return false; }
  const trade = preview.trade;
  const unit = gameUnit(asset);
  const rows = [
    ['PRICE PER ' + (unit === 'G' ? 'GRAM' : unit || 'UNIT'), gameMoney(trade.priceChf, today)],
    ['QUANTITY', gameQuantityWithUnit(asset, trade.quantity)],
    ['SUBTOTAL', gameMoney(trade.amountChf, today)],
  ];
  if (trade.stampDutyChf) rows.push(['STAMP DUTY ' + gameRate(GameEngine.stampDutyRate(asset)), gameMoney(trade.stampDutyChf, today)]);
  if (trade.purchaseCostsChf) rows.push(['TRANSFER TAX &amp; NOTARY', gameMoney(trade.purchaseCostsChf, today)]);
  if (trade.mortgageChf) rows.push(['MORTGAGE ' + gameRate(trade.mortgageChf / trade.amountChf), '-' + gameMoney(trade.mortgageChf, today)]);
  rows.push(['<strong>CASH NEEDED</strong>', '<strong>' + gameMoney(preview.cashNeededChf, today) + '</strong>']);
  const cashAfter = preview.cashChf - preview.cashNeededChf;
  rows.push(['CASH LEFT', '<span class="' + (cashAfter < 0 ? 'game-neg' : '') + '">' + gameMoney(cashAfter, today) + '</span>']);
  if (trade.mortgageChf) {
    rows.push(['INTEREST A MONTH', gameMoney(trade.mortgageChf * GameEngine.MORTGAGE_INTEREST_RATE / 12, today)]);
    rows.push(['PAYBACK A MONTH', gameMoney(trade.amortizationChf, today)]);
  }
  if (preview.affordability) {
    rows.push(['BANK CHECK', '<span class="' + (preview.affordability.yearlyChf > preview.affordability.limitChf ? 'game-neg' : 'game-pos') + '">' +
      gameMoney(preview.affordability.yearlyChf, today) + ' / ' + gameMoney(preview.affordability.limitChf, today) + ' A YEAR</span>']);
  }
  const savingsBefore = preview.budgetBefore.savingsChf;
  const savingsAfter = preview.budgetAfter.savingsChf;
  if (Math.abs(savingsAfter - savingsBefore) > 0.005) {
    rows.push(['SAVED PER MONTH', gameMoney(savingsBefore, today) + ' &rarr; <span class="' + gameSignClass(savingsAfter) + '">' + gameMoney(savingsAfter, today) + '</span>']);
  }
  container.innerHTML = '<table class="w-100 game-preview-table"><tbody>' +
    rows.map((row) => '<tr><td>' + row[0] + '</td><td class="text-end">' + row[1] + '</td></tr>').join('') + '</tbody></table>' + errorLine;
  return !preview.error;
}

// The preview of a short sale being typed, at the last close; returns whether it can be made.
function gameRenderShortPreview(asset, today) {
  const container = document.getElementById('game-preview');
  const order = gameOrder(asset);
  const quote = GamePage.market.quote(asset.symbol, today);
  const byQuantity = order.quantity != null;
  if (!quote || !((byQuantity ? order.quantity : order.amountChf) > 0)) {
    container.innerHTML = '<span class="game-dim">' + (byQuantity ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT') + ' TO SEE THE COSTS</span>';
    return false;
  }
  const trade = GameEngine.openShort(GamePage.game, GamePage.market, asset, order, today, new Date().toISOString());
  const amountChf = byQuantity ? order.quantity * quote.priceChf : order.amountChf;
  const dutyRate = GameEngine.stampDutyRate(asset);
  const rows = [
    ['PRICE PER UNIT', gameMoney(quote.priceChf, today)],
    byQuantity ? ['AMOUNT SHORTED', gameMoney(amountChf, today)] : ['QUANTITY', gameQuantityWithUnit(asset, amountChf / quote.priceChf)],
  ];
  if (dutyRate) rows.push(['STAMP DUTY ' + gameRate(dutyRate), gameMoney(amountChf * dutyRate, today)]);
  rows.push(['COLLATERAL HELD', gameMoney(amountChf * GameEngine.SHORT_COLLATERAL, today)]);
  rows.push(['<strong>CASH NEEDED</strong>', '<strong>' + gameMoney(amountChf * (GameEngine.SHORT_COLLATERAL - 1 + dutyRate), today) + '</strong>']);
  rows.push(['BORROW FEE A MONTH', gameMoney(amountChf * GameEngine.SHORT_BORROW_FEE_RATE / 12, today)]);
  rows.push(['BOUGHT BACK BY THE BANK AT', gameMoney(quote.priceChf * GameEngine.SHORT_COLLATERAL / GameEngine.SHORT_MAINTENANCE, today)]);
  container.innerHTML = gamePreviewTable(rows) +
    '<div class="game-dim mt-1">SELLS UNITS YOU BORROW: YOU GAIN WHAT THE PRICE FALLS AND LOSE WHAT IT RISES. YOU PAY THE DIVIDENDS TO THE LENDER. ' +
    'THE SALE AMOUNT AND THE CASH ABOVE ARE HELD UNTIL YOU BUY BACK.</div>' +
    (trade.error ? '<div class="game-neg game-preview-error">' + escapeHtml(trade.error) + '</div>' : '');
  return !trade.error;
}

// The limit buy typed in the buy dialog, as GameEngine.placeOrder fields.
function gameLimitFields(asset) {
  return Object.assign({ side: 'buy', type: 'limit', priceChf: Number(document.getElementById('game-limit').value) }, gameOrder(asset));
}

// The preview of the limit buy being typed, at its limit price; returns whether it can be placed.
function gameRenderLimitPreview(asset, today) {
  const container = document.getElementById('game-preview');
  const fields = asset && gameLimitFields(asset);
  const byQuantity = !!fields && fields.quantity != null;
  if (!fields || !(fields.priceChf > 0) || !((byQuantity ? fields.quantity : fields.amountChf) > 0)) {
    container.innerHTML = '<span class="game-dim">ENTER A LIMIT PRICE AND ' + (gameBuyMode(asset) === 'quantity' ? 'A QUANTITY' : 'AN AMOUNT') + '</span>';
    return false;
  }
  const order = GameEngine.placeOrder(GamePage.game, GamePage.market, asset, fields, today, new Date().toISOString());
  const amountChf = byQuantity ? fields.quantity * fields.priceChf : fields.amountChf;
  const dutyChf = amountChf * GameEngine.stampDutyRate(asset);
  const rows = [byQuantity ? ['AMOUNT AT THE LIMIT', gameMoney(amountChf, today)] : ['QUANTITY AT THE LIMIT', gameQuantityWithUnit(asset, amountChf / fields.priceChf)]];
  if (dutyChf) rows.push(['STAMP DUTY ' + gameRate(GameEngine.stampDutyRate(asset)), gameMoney(dutyChf, today)]);
  rows.push(['<strong>CASH NEEDED AT THE LIMIT</strong>', '<strong>' + gameMoney(amountChf + dutyChf, today) + '</strong>']);
  container.innerHTML = gamePreviewTable(rows) +
    '<div class="game-dim mt-1">BUYS AT THE FIRST NEW CLOSE AT OR BELOW THE LIMIT, IF YOU HAVE THE CASH THEN. OPEN UNTIL IT FILLS OR YOU CANCEL IT.</div>' +
    (order.error ? '<div class="game-neg game-preview-error">' + escapeHtml(order.error) + '</div>' : '');
  return !order.error;
}

// Fills a category list from `categoryList` (one tab of GAME_BUY_CATEGORIES) and the asset list of the
// `chosenLabel` category, or the first one, keeping the picked asset.
function gameFillAssetLists(categorySelect, assetSelect, categoryList, chosenLabel, today) {
  const categories = categoryList.map((category) => Object.assign({ count: GamePage.assets.filter(category.matches).length }, category))
    .filter((category) => category.count > 0);
  const category = categories.find((item) => item.label === chosenLabel) || categories[0];
  // Rebuilt only when the list changes: prices move with the day and the display currency.
  const listKey = [categories.map((item) => item.label).join(','), category && category.label, GamePage.currency, today].join('|');
  if (assetSelect.dataset.key === listKey) return;
  assetSelect.dataset.key = listKey;
  categorySelect.innerHTML = categories.map((item) =>
    '<option value="' + escapeHtml(item.label) + '">' + escapeHtml(item.label) + ' (' + item.count + ')</option>').join('');
  if (category) categorySelect.value = category.label;
  const selected = assetSelect.value;
  assetSelect.innerHTML = category ? gameAssetOptions(category, today) : '';
  if ([...assetSelect.options].some((option) => option.value === selected)) assetSelect.value = selected;
}

function gameRenderBuyForm(state) {
  const today = todayIsoDate();
  if (!state) state = GameEngine.replay(GamePage.game, GamePage.market, today, new Date().toISOString());
  document.querySelectorAll('[data-buy-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buyTab === GamePage.buyTab)));
  gameFillAssetLists(document.getElementById('game-category'), document.getElementById('game-asset'),
    GAME_BUY_CATEGORIES[GamePage.buyTab], GamePage.buyCategory[GamePage.buyTab], today);

  const asset = gameSelectedAsset();
  const mode = gameBuyMode(asset);
  const wholeUnits = !!asset && GameEngine.isTangible(asset.class);
  const preciousMetal = !!asset && !!GameTangibles.PRECIOUS_METALS[asset.symbol];
  document.getElementById('game-mode-toggle').style.display = wholeUnits ? 'none' : '';
  document.querySelectorAll('[data-buy-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buyMode === mode)));
  document.getElementById('game-amount').step = wholeUnits ? '1' : 'any';
  document.getElementById('game-unit').style.display = preciousMetal && mode === 'quantity' ? '' : 'none';
  document.getElementById('game-down-wrap').style.display = asset && asset.class === 'house' ? '' : 'none';
  const unit = asset ? gameUnit(asset) : '';
  document.getElementById('game-amount-label').textContent = mode === 'amount' ? 'AMOUNT (CHF)'
    : preciousMetal ? 'QUANTITY' : 'QUANTITY (' + (unit || 'UNITS') + ')';
  // Only stocks and ETFs can be shorted, at the last close; cars, watches, art and houses are bought now only.
  const canShort = !!asset && (asset.class === 'stock' || asset.class === 'etf');
  const short = canShort && GamePage.buyDirection === 'short';
  const limit = !wholeUnits && !short && GamePage.buyKind === 'limit';
  document.getElementById('game-direction-toggle').style.display = canShort ? '' : 'none';
  document.querySelectorAll('[data-buy-direction]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buyDirection === (short ? 'short' : 'long'))));
  document.getElementById('game-kind-toggle').style.display = wholeUnits || short ? 'none' : '';
  document.querySelectorAll('[data-buy-kind]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buyKind === (limit ? 'limit' : 'now'))));
  document.getElementById('game-limit-wrap').style.display = limit ? '' : 'none';
  document.getElementById('game-limit-label').textContent = 'LIMIT PRICE (CHF' + (unit ? ' PER ' + (unit === 'G' ? 'GRAM' : unit) : '') + ')';
  document.getElementById('game-buy-btn').textContent = short ? 'SHORT' : limit ? 'PLACE LIMIT ORDER' : 'BUY';

  const quote = asset && GamePage.market.quote(asset.symbol, today);
  document.getElementById('game-quote').innerHTML = !quote ? 'NO PRICE'
    : 'PRICE ' + gameMoney(quote.priceChf, today) + (unit ? ' PER ' + (unit === 'G' ? 'GRAM' : unit) : '') +
      ' <span class="game-dim">(' + (wholeUnits ? 'TODAY' : 'CLOSE ' + formatDate(quote.date)) + ')</span>';
  document.getElementById('game-details').innerHTML = !asset || !quote ? '' : '<table class="w-100 game-details-table"><tbody>' +
    gameAssetDetails(asset, state, quote.priceChf, today).map((row) => '<tr><th>' + row[0] + '</th><td>' + row[1] +
      (row[2] ? '<span class="game-details-note">' + row[2] + '</span>' : '') + '</td></tr>').join('') + '</tbody></table>';
  document.getElementById('game-buy-btn').disabled = !(short ? gameRenderShortPreview(asset, today) : limit ? gameRenderLimitPreview(asset, today) : gameRenderPreview(asset, today));
}

function gameRender() {
  gameRenderHeader();
  if (!GamePage.game || GamePage.view === 'start') {
    gameShow('start');
    gameRenderStart();
    return;
  }
  gameShow('board');
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const state = GameEngine.replay(GamePage.game, GamePage.market, today, now);
  gameRenderStats(state, today);
  gameRenderChart(state);
  gameRenderBuyForm(state);
  gameRenderDayTrading(state, today);
  gameRenderOptionsForm(state);
  gameRenderOptions(state, today);
  gameRenderHoldings(state, today);
  gameRenderShorts(state, today);
  gameRenderPortfolioCharts(state, today);
  gameRenderLoan(state, today);
  gameRenderBudget(state, today);
  gameRenderHistory(state);
  gameRenderOrders(today);
  gameSettleOrders();
}

async function gameTrade(trade) {
  if (trade.error) { gameToast(trade.error); return; }
  GamePage.game.trades.push(trade);
  try {
    await gameWriteCurrent();
  } catch (error) {
    // Keep the page in line with the file: a trade that is not saved did not happen.
    GamePage.game.trades.pop();
    gameToast('COULD NOT SAVE, TRADE CANCELLED: ' + (error.message || error));
    return;
  }
  if (trade.side === 'borrow' || trade.side === 'repay') gameToast((trade.side === 'borrow' ? 'BORROWED ' : 'PAID BACK ') + gameMoney(trade.amountChf));
  else {
    gameToast((trade.intraday ? 'DAY TRADE: ' : '') + gameTradeVerb(trade) + ' ' + (trade.option
      ? gameQuantity(trade.quantity) + ' ' + trade.option.kind.toUpperCase() + 'S ON ' + trade.name : gameQuantityWithUnit(trade, trade.quantity) + ' ' + trade.name));
  }
  if (!trade.intraday) bootstrap.Modal.getOrCreateInstance(document.getElementById('game-buy-modal')).hide();
  gameRender();
}

// 'BOUGHT' or 'SOLD'; for a short 'SHORTED' or 'BOUGHT BACK'; for an option also 'WROTE'.
function gameTradeVerb(trade) {
  if (trade.option) return trade.optionAt ? (trade.option.written ? 'BOUGHT BACK' : 'SOLD') : (trade.option.written ? 'WROTE' : 'BOUGHT');
  if (trade.short) return trade.side === 'sell' ? 'SHORTED' : 'BOUGHT BACK';
  return trade.side === 'buy' ? 'BOUGHT' : 'SOLD';
}

// ---------- Day trading ----------

// Local clock time of an ISO time: "14:05".
function gameClock(isoTime) {
  return new Date(isoTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// "1D 7H", "3H 12M", "12M", "45S".
function gameDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return seconds + 'S';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return Math.floor(hours / 24) + 'D ' + (hours % 24) + 'H';
  return minutes < 60 ? minutes + 'M' : hours + 'H ' + (minutes % 60) + 'M';
}

function gameDayMarket(asset) {
  return GameIntraday.marketOf(asset.class, wallStreetStockRegion(asset.symbol));
}

// The simulated trading day of an asset on a UTC date, from its last real close before that day; null when
// its market is closed that day or the close is too old.
function gameTradingDay(asset, date) {
  const key = asset.symbol + '|' + date;
  if (!GamePage.tradingDays.has(key)) {
    const dayBefore = GameEngine.addDays(date, -1);
    const anchor = GamePage.market.quote(asset.symbol, dayBefore);
    const fresh = anchor && GameEngine.daysBetween(anchor.date, date) <= GameEngine.MAX_QUOTE_AGE_DAYS;
    GamePage.tradingDays.set(key, fresh
      ? GameIntraday.tradingDay(asset.symbol, gameDayMarket(asset), date, anchor.priceChf, GamePage.market.closes(asset.symbol, dayBefore))
      : null);
  }
  return GamePage.tradingDays.get(key);
}

function gameDayAsset() {
  return GamePage.assets.find((item) => item.symbol === document.getElementById('game-day-asset').value);
}

// The panel's lists and open trades; the live parts are drawn by gameDayTick.
function gameRenderDayTrading(state, today) {
  GamePage.dayState = state;
  GamePage.dayDate = today;
  gameFillAssetLists(document.getElementById('game-day-category'), document.getElementById('game-day-asset'),
    GAME_BUY_CATEGORIES.market, GamePage.dayCategory, today);

  // Open day trades are reverted at the close, so the tab shows them while another tab is open.
  document.getElementById('game-tab-day-trading').textContent = 'DAY TRADING' + (state.dayTrades.length ? ' · ' + state.dayTrades.length + ' OPEN' : '');
  const container = document.getElementById('game-day-positions');
  const profitChf = state.dayTradeProfitChf;
  document.getElementById('game-day-summary').innerHTML = 'CLOSED DAY TRADES, ALL TIME <span class="' + gameSignClass(profitChf) + '">' +
    gameSignedMoney(profitChf, today) + '</span>';
  if (!state.dayTrades.length) {
    container.innerHTML = '<div class="game-dim">NO OPEN DAY TRADES. PICK AN ASSET WHOSE MARKET IS OPEN AND BUY OR SHORT IT ABOVE.</div>';
  } else {
    // Price, value, P&L and time left are filled in every second by gameDayTick.
    container.innerHTML = '<table class="table-gta w-100"><thead><tr><th>ASSET</th><th class="text-end">QUANTITY</th><th class="text-end">PRICE</th>' +
      '<th class="text-end">VALUE</th><th class="text-end">P&amp;L</th><th class="text-end">CLOSES IN</th><th></th></tr></thead><tbody>' +
      // One row per buy or short sale, so the same asset traded at different prices shows each; a close closes that one only.
      state.dayTrades.map((position) => {
        const symbol = escapeHtml(position.symbol);
        const at = escapeHtml(position.at);
        const unit = gameUnit(position);
        return '<tr data-day-row="' + symbol + '" data-day-lot="' + at + '"><td><button type="button" class="game-day-pick" data-symbol="' + symbol + '">' +
          '<span class="game-symbol">' + escapeHtml(position.name) + '</span><span class="game-name">' + symbol + ' · ' +
          (position.short ? '<span class="game-neg">SHORTED</span> ' : 'BOUGHT ') + gameClock(position.at) + '</span></button></td>' +
          '<td class="text-end">' + gameQuantityWithUnit(position, position.quantity) + '</td>' +
          '<td class="text-end"><span data-day-cell="price"></span><br><small class="game-dim">' + (position.short ? 'SOLD AT ' : 'PAID ') +
            gameMoney(position.priceChf, today) + (unit ? ' / ' + unit : '') + '</small></td>' +
          '<td class="text-end" data-day-cell="value"></td><td class="text-end" data-day-cell="profit"></td>' +
          '<td class="text-end"><span data-day-cell="closes"></span><br><small class="game-dim">AT ' + gameClock(position.closesAt) + '</small></td>' +
          '<td class="text-end text-nowrap"><button class="btn btn-gta btn-sm game-day-order" data-symbol="' + symbol + '" data-lot="' + at + '">ORDER</button> ' +
          '<button class="btn btn-gta btn-sm game-day-close" data-lot="' + at + '" data-fraction="0.5">CLOSE 50%</button> ' +
          '<button class="btn btn-gta btn-sm btn-danger-del game-day-close" data-lot="' + at + '" data-fraction="1">CLOSE ALL</button></td></tr>';
      }).join('') + '</tbody></table><p class="game-note">P&amp;L if you close now, after stamp duty. Still open when its market closes, a trade is reverted.</p>';
    container.querySelectorAll('.game-day-close').forEach((button) => {
      button.onclick = () => {
        const now = new Date().toISOString();
        const position = GamePage.dayState.dayTrades.find((item) => item.at === button.dataset.lot);
        const day = position && gameTradingDay(position, now.slice(0, 10));
        gameTrade(day ? GameEngine.closeDayTrade(GamePage.game, GamePage.market, position.symbol, { fraction: Number(button.dataset.fraction), lotAt: position.at },
          GameIntraday.priceAt(day, Date.parse(now)), now) : { error: 'MARKET CLOSED' });
      };
    });
    container.querySelectorAll('.game-day-pick').forEach((button) => {
      button.onclick = () => gameDaySelect(button.dataset.symbol);
    });
    container.querySelectorAll('.game-day-order').forEach((button) => {
      button.onclick = () => gameOpenSellOrder(button.dataset.symbol, button.dataset.lot);
    });
  }
  GamePage.dayChartKey = '';
  gameDayTick();
}

// Shows an asset in the panel's lists and chart, switching to its category.
function gameDaySelect(symbol) {
  const asset = GamePage.assets.find((item) => item.symbol === symbol);
  const category = asset && GAME_BUY_CATEGORIES.market.find((item) => item.matches(asset));
  if (!category) return;
  GamePage.dayCategory = category.label;
  const assetSelect = document.getElementById('game-day-asset');
  gameFillAssetLists(document.getElementById('game-day-category'), assetSelect, GAME_BUY_CATEGORIES.market, GamePage.dayCategory, todayIsoDate());
  assetSelect.value = symbol;
  gameDayTick();
  // The chart sits above the open trades.
  document.getElementById('game-day-quote').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// The selected asset's price line, from the open to now, in the display currency.
function gameRenderDayChart(day, nowMs, today) {
  const step = day && nowMs >= Date.parse(day.session.opensAt) ? GameIntraday.stepAt(day, nowMs) : -1;
  const key = [day ? day.symbol + '|' + day.session.date : '', step, GamePage.currency, GamePage.dayZoom].join('|');
  document.querySelectorAll('[data-day-zoom]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dayZoom === GamePage.dayZoom)));
  if (key === GamePage.dayChartKey) return;
  GamePage.dayChartKey = key;
  if (GamePage.dayChart) GamePage.dayChart.destroy();
  GamePage.dayChart = null;
  document.getElementById('game-day-chart-empty').style.display = step < 0 ? '' : 'none';
  document.querySelector('.game-day-chart-wrap').style.display = step < 0 ? 'none' : '';
  document.querySelector('.game-day-zoom').style.display = step < 0 ? 'none' : '';
  if (step < 0) return;
  const scale = GamePage.currency === 'CHF' ? 1 : GamePage.market.rate('CHF', GamePage.currency, today) || 1;
  const opensMs = Date.parse(day.session.opensAt);
  const closesMs = Date.parse(day.session.closesAt);
  const stepMs = GameIntraday.STEP_SECONDS * 1000;
  // A zoom window ends a little after the current step, so little future time is shown; DAY shows the whole session.
  const windowMs = GAME_DAY_ZOOMS[GamePage.dayZoom];
  const nowStepMs = opensMs + step * stepMs;
  const maxMs = windowMs ? Math.min(closesMs, nowStepMs + windowMs * 0.05) : closesMs;
  const minMs = windowMs ? Math.max(opensMs, maxMs - windowMs) : opensMs;
  const firstStep = Math.ceil((minMs - opensMs) / stepMs);
  // A trade fills at the price of its 10 second step, so it is drawn at the start of that step, where the line has that price.
  const tradeStep = (event) => GameIntraday.stepAt(day, Date.parse(event.at));
  const tradeX = (event) => opensMs + tradeStep(event) * stepMs;
  // This asset's day trades today; reverted ones are gone from the events.
  const tradesShown = GamePage.dayState.events.filter((event) => event.intraday && event.symbol === day.symbol && event.date === day.session.date &&
    tradeX(event) >= minMs && tradeX(event) <= maxMs);
  // At most about 360 points, so a 24 hour crypto day stays light; the current price and every trade's step are always
  // points, so the trade dots sit on the line.
  const stride = Math.max(1, Math.ceil((step - firstStep) / 360));
  const indexes = new Set([step]);
  for (let index = firstStep; index <= step; index += stride) indexes.add(index);
  tradesShown.forEach((event) => indexes.add(tradeStep(event)));
  const points = [...indexes].sort((first, second) => first - second).map((index) => ({ x: opensMs + index * stepMs, y: day.prices[index] * scale }));
  const markers = (side) => tradesShown.filter((event) => event.type === side).map((event) => ({
    x: tradeX(event), y: event.priceChf * scale,
    text: gameTradeVerb(event) + ' ' + gameQuantityWithUnit(event, event.quantity) + ' @ ' + gameMoney(event.priceChf, today),
  }));
  const sideColors = { buy: '#00a5ff', sell: '#ffcc00' };
  // A small solid dot on the exact price, ringed in the background color so it stands out from the line.
  // Order -1 draws it over the price line, which Chart.js otherwise draws on top as the first dataset.
  const markerDataset = (label, data, color) => ({
    type: 'scatter', label: label, data: data, order: -1, pointStyle: 'circle', pointRadius: 5, pointHoverRadius: 7,
    backgroundColor: color, borderColor: '#0a0a0a', borderWidth: 2, pointHoverBackgroundColor: color, pointHoverBorderColor: '#0a0a0a',
  });
  // Each trade also gets a dashed line across the chart, behind the price, and a BUY tag at the top or a SELL tag at the bottom.
  const tradeLines = {
    id: 'gameDayTradeLines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      tradesShown.forEach((event) => {
        const x = chart.scales.x.getPixelForValue(tradeX(event));
        ctx.strokeStyle = sideColors[event.type];
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      });
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = 'bold 10px ' + Chart.defaults.font.family;
      ctx.textBaseline = 'middle';
      tradesShown.forEach((event) => {
        const text = event.type === 'buy' ? 'BUY' : 'SELL';
        const width = ctx.measureText(text).width + 8;
        const height = 14;
        const x = Math.min(chartArea.right - width, Math.max(chartArea.left, chart.scales.x.getPixelForValue(tradeX(event)) - width / 2));
        const y = event.type === 'buy' ? chartArea.top : chartArea.bottom - height;
        ctx.fillStyle = sideColors[event.type];
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = '#0a0a0a';
        ctx.fillText(text, x + 4, y + height / 2);
      });
      ctx.restore();
    },
  };
  const accent = readAccent();
  GamePage.dayChart = new Chart(document.getElementById('game-day-chart'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'PRICE', data: points, borderColor: accent, backgroundColor: accent, pointRadius: 0, borderWidth: 2 },
        markerDataset('BUY', markers('buy'), sideColors.buy),
        markerDataset('SELL', markers('sell'), sideColors.sell),
      ],
    },
    plugins: [tradeLines],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'time', min: minMs, max: maxMs, time: { tooltipFormat: 'HH:mm:ss', displayFormats: { minute: 'HH:mm', hour: 'HH:mm' } },
          grid: { color: '#1f1f1f' }, ticks: { color: '#888', maxTicksLimit: 9 },
        },
        // Room above and below the price for the BUY and SELL tags.
        y: { grace: tradesShown.length ? '15%' : 0, grid: { color: '#1f1f1f' }, ticks: { color: '#888' } },
      },
      plugins: {
        // Only the trade markers get a legend entry, and only when there are some.
        legend: { display: tradesShown.length > 0, labels: { color: '#d0d0d0', usePointStyle: true, filter: (item, data) => item.datasetIndex > 0 && data.datasets[item.datasetIndex].data.length > 0 } },
        tooltip: { callbacks: { label: (item) => item.raw.text || (_WALL_STREET_CURRENCY_SYMBOL[GamePage.currency] || GamePage.currency) + ' ' + item.parsed.y.toLocaleString('en-GB', { maximumFractionDigits: 2 }) } },
      },
    },
  });
}

// Every second: the live price, market status, chart, order preview and the open trades' P&L. A new day, or an
// open trade's market closing, replays the game so reverted trades give their cash back.
function gameDayTick() {
  if (!GamePage.game || GamePage.view !== 'board' || !GamePage.dayState) return;
  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (today !== GamePage.dayDate || GamePage.dayState.dayTrades.some((position) => nowMs >= Date.parse(position.closesAt))) { gameRender(); return; }
  // The live price moves every step, so day orders are checked every second.
  if ((GamePage.game.orders || []).some((order) => order.intraday)) gameSettleOrders();

  const asset = gameDayAsset();
  const day = asset ? gameTradingDay(asset, today) : null;
  const open = !!day && GameIntraday.isOpen(day.session, nowMs);
  const quote = document.getElementById('game-day-quote');
  if (!asset) quote.innerHTML = 'PICK AN ASSET';
  else {
    const market = GameIntraday.MARKETS[gameDayMarket(asset)];
    const next = GameIntraday.currentOrNextSession(gameDayMarket(asset), nowMs);
    const status = open ? '<span class="game-pos">OPEN</span> · CLOSES IN ' + gameDuration(Date.parse(day.session.closesAt) - nowMs)
      : '<span class="game-neg">CLOSED</span>' + (next ? ' · OPENS ' + new Date(next.opensAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase() +
        ', IN ' + gameDuration(Date.parse(next.opensAt) - nowMs) : '');
    const unit = gameUnit(asset);
    const priceLine = !day ? '<span class="game-dim">NO SIMULATED PRICE TODAY</span>' : (() => {
      const priceChf = GameIntraday.priceAt(day, nowMs);
      // The change over the chosen zoom, up to now or the close; DAY and windows reaching back past the open use the last close.
      const windowMs = GAME_DAY_ZOOMS[GamePage.dayZoom];
      const referenceChf = windowMs ? GameIntraday.priceAt(day, Math.min(nowMs, Date.parse(day.session.closesAt)) - windowMs) : day.anchorPriceChf;
      const change = priceChf / referenceChf - 1;
      return '<span class="game-day-price">' + gameMoney(priceChf, today) + (unit ? ' / ' + unit : '') + '</span> ' +
        '<span class="' + gameSignClass(change, 4) + '">' + gamePercent(change) + '</span> <span class="game-dim">' +
        (windowMs ? 'IN THE LAST ' + GamePage.dayZoom + ', FROM ' : 'SINCE THE LAST CLOSE, ') + gameMoney(referenceChf, today) +
        (nowMs >= Date.parse(day.session.closesAt) ? ' · FINAL PRICE TODAY' : '') + '</span>';
    })();
    quote.innerHTML = '<div>' + escapeHtml(market.label) + ' · ' + status + '</div><div>' + priceLine + '</div>';
  }
  gameRenderDayChart(day, nowMs, today);

  // Preview from the last replay's cash; the buy itself checks again.
  const byQuantity = GamePage.dayMode === 'quantity';
  const value = Number(document.getElementById('game-day-amount').value);
  document.querySelectorAll('[data-day-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dayMode === GamePage.dayMode)));
  document.querySelectorAll('[data-day-preset]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.dayPreset) === value)));
  const assetUnit = asset ? gameUnit(asset) : '';
  document.getElementById('game-day-amount-label').textContent = byQuantity ? 'QUANTITY' + (assetUnit ? ' (' + assetUnit + ')' : '') : 'AMOUNT (CHF)';
  // A limit order is previewed at its limit price: a buy below the live price, a short sale above it.
  const short = GamePage.dayDirection === 'short';
  const limit = GamePage.dayKind === 'limit';
  const limitChf = Number(document.getElementById('game-day-limit').value);
  const atLimit = limit ? ' AT THE LIMIT' : '';
  document.querySelectorAll('[data-day-direction]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dayDirection === GamePage.dayDirection)));
  document.querySelectorAll('[data-day-kind]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dayKind === GamePage.dayKind)));
  document.getElementById('game-day-limit-wrap').style.display = limit ? '' : 'none';
  document.getElementById('game-day-limit-label').textContent = 'LIMIT PRICE (CHF' + (assetUnit ? ' PER ' + assetUnit : '') + ')';
  document.getElementById('game-day-buy-btn').textContent = limit ? 'PLACE LIMIT ORDER' : short ? 'SHORT AT THE LIVE PRICE' : 'BUY AT THE LIVE PRICE';
  const preview = document.getElementById('game-day-preview');
  let canBuy = false;
  if (!open) preview.innerHTML = '<span class="game-dim">THE MARKET IS CLOSED</span>';
  else if (!(value > 0) || (limit && !(limitChf > 0))) {
    preview.innerHTML = '<span class="game-dim">' + (limit ? 'ENTER A LIMIT PRICE AND ' : 'ENTER ') + (byQuantity ? 'A QUANTITY' : 'AN AMOUNT') + ' TO SEE THE COSTS</span>';
  } else {
    const livePriceChf = GameIntraday.priceAt(day, nowMs);
    const priceChf = limit ? limitChf : livePriceChf;
    const amountChf = byQuantity ? value * priceChf : value;
    const dutyChf = amountChf * GameEngine.stampDutyRate(asset);
    const cashLeftChf = GamePage.dayState.cash - amountChf - dutyChf;
    const limitReached = limit && GameEngine.orderReached({ side: short ? 'sell' : 'buy', type: 'limit', priceChf: limitChf }, livePriceChf);
    const error = limitReached ? (short ? 'A LIMIT SHORT MUST BE ABOVE THE PRICE' : 'A LIMIT BUY MUST BE BELOW THE PRICE')
      : cashLeftChf < -0.005 ? 'NOT ENOUGH CASH' : '';
    canBuy = !error;
    const rows = [byQuantity ? ['AMOUNT' + atLimit, gameMoney(amountChf, today)] : ['QUANTITY' + atLimit, gameQuantityWithUnit(asset, amountChf / priceChf)]];
    if (dutyChf) rows.push(['STAMP DUTY ' + gameRate(GameEngine.stampDutyRate(asset)), gameMoney(dutyChf, today)]);
    rows.push(['<strong>' + (short ? 'CASH HELD' : 'CASH NEEDED') + atLimit + '</strong>', '<strong>' + gameMoney(amountChf + dutyChf, today) + '</strong>']);
    rows.push(['CASH LEFT', '<span class="' + (cashLeftChf < -0.005 ? 'game-neg' : '') + '">' + gameMoney(cashLeftChf, today) + '</span>']);
    const notes = [];
    if (short) notes.push('SELLS UNITS YOU DO NOT OWN: YOU GAIN WHAT THE PRICE FALLS BEFORE YOU BUY THEM BACK, AND LOSE WHAT IT RISES. THE CASH IS HELD UNTIL THEN.');
    if (limit) notes.push((short ? 'SHORTS AT THE FIRST LIVE PRICE AT OR ABOVE' : 'BUYS AT THE FIRST LIVE PRICE AT OR BELOW') + ' THE LIMIT, IF YOU HAVE THE CASH THEN. ENDS AT THE CLOSE.');
    preview.innerHTML = gamePreviewTable(rows) + notes.map((note) => '<div class="game-dim mt-1">' + note + '</div>').join('') +
      (error ? '<div class="game-neg game-preview-error">' + error + '</div>' : '');
  }
  document.getElementById('game-day-buy-btn').disabled = !canBuy;

  // The open trade whose chart is shown is highlighted.
  document.querySelectorAll('[data-day-row]').forEach((row) => row.classList.toggle('game-day-selected', !!asset && row.dataset.dayRow === asset.symbol));
  GamePage.dayState.dayTrades.forEach((position) => {
    const positionDay = gameTradingDay(position, today);
    const row = document.querySelector('[data-day-lot="' + CSS.escape(position.at) + '"]');
    if (!positionDay || !row) return;
    const priceChf = GameIntraday.priceAt(positionDay, nowMs);
    const valueChf = position.quantity * priceChf;
    // A short gains what it got (its amount less the duty paid) minus the buyback with its duty.
    const dutyRate = GameEngine.stampDutyRate(position);
    const profitChf = position.short ? 2 * position.amountChf - position.costChf - valueChf * (1 + dutyRate) : valueChf * (1 - dutyRate) - position.costChf;
    const positionUnit = gameUnit(position);
    row.querySelector('[data-day-cell="price"]').textContent = gameMoney(priceChf, today) + (positionUnit ? ' / ' + positionUnit : '');
    row.querySelector('[data-day-cell="value"]').textContent = gameMoney(valueChf, today);
    row.querySelector('[data-day-cell="closes"]').textContent = gameDuration(Date.parse(position.closesAt) - nowMs);
    const profitCell = row.querySelector('[data-day-cell="profit"]');
    profitCell.className = 'text-end ' + gameSignClass(profitChf);
    profitCell.innerHTML = gameSignedMoney(profitChf, today) + '<br><small>' + gamePercent(profitChf / position.costChf) + '</small>';
  });
}

// ---------- Options ----------

function gameOptionAsset() {
  return GamePage.assets.find((item) => item.symbol === document.getElementById('game-option-asset').value);
}

// 'CALL 65.00' with the strike in the display currency.
function gameOptionContract(option, date) {
  return option.kind.toUpperCase() + ' ' + gameMoney(option.strike, date);
}

// The option the form describes, as GameEngine.openOption's order.
function gameOptionOrder() {
  const strategy = GAME_OPTION_STRATEGIES[GamePage.optionStrategy];
  return {
    kind: strategy.kind, written: strategy.written, expiry: document.getElementById('game-option-expiry').value,
    strike: Number(document.getElementById('game-option-strike').value), quantity: Number(document.getElementById('game-option-quantity').value),
  };
}

// The new option form: the chosen stock's expiries and strikes, and what the option costs or brings in.
function gameRenderOptionsForm(state) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  if (!state) state = GameEngine.replay(GamePage.game, GamePage.market, today, now);
  const strategy = GAME_OPTION_STRATEGIES[GamePage.optionStrategy];
  document.querySelectorAll('[data-option-strategy]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.optionStrategy === GamePage.optionStrategy)));
  document.getElementById('game-option-strategy-note').textContent = strategy.note;
  gameFillAssetLists(document.getElementById('game-option-category'), document.getElementById('game-option-asset'), GAME_OPTION_CATEGORIES, GamePage.optionCategory, today);
  const asset = gameOptionAsset();
  const chain = asset ? GameEngine.optionChain(GamePage.market, asset, today) : { error: 'PICK A STOCK' };
  const quote = document.getElementById('game-option-quote');
  const preview = document.getElementById('game-option-preview');
  const button = document.getElementById('game-option-btn');
  button.textContent = (strategy.written ? 'SELL THE ' : 'BUY THE ') + strategy.kind.toUpperCase();
  button.disabled = true;
  if (chain.error) { quote.textContent = chain.error; preview.innerHTML = ''; return; }

  // The lists are rebuilt for another stock, day or strategy; a strategy picks its usual strike: at the price, above it
  // for a covered call, below it for a protective or cash-secured put.
  const expirySelect = document.getElementById('game-option-expiry');
  const strikeSelect = document.getElementById('game-option-strike');
  const listKey = [asset.symbol, today, GamePage.optionStrategy, GamePage.currency].join('|');
  if (strikeSelect.dataset.key !== listKey) {
    strikeSelect.dataset.key = listKey;
    const expiry = expirySelect.value;
    expirySelect.innerHTML = chain.expiries.map((item) => '<option value="' + item + '">' + formatDate(item) + '</option>').join('');
    if (chain.expiries.includes(expiry)) expirySelect.value = expiry;
    strikeSelect.innerHTML = chain.strikes.map((item) => '<option value="' + item + '">' + gameMoney(item, today) + '</option>').join('');
    const nearest = chain.strikes.reduce((best, item) => (Math.abs(item - chain.priceChf) < Math.abs(best - chain.priceChf) ? item : best));
    const above = chain.strikes.find((item) => item > chain.priceChf);
    const below = chain.strikes.filter((item) => item < chain.priceChf).pop();
    strikeSelect.value = String(strategy.written && strategy.kind === 'call' ? above || nearest : strategy.kind === 'put' && strategy.written || strategy.protective ? below || nearest : nearest);
  }
  const position = state.positions.find((item) => item.symbol === asset.symbol);
  quote.innerHTML = 'LAST CLOSE ' + gameMoney(chain.priceChf, today) + ' · VOLATILITY ' + gameRate(Number(chain.volatility.toFixed(3))) + ' A YEAR' +
    (position ? '<br><span class="game-dim">YOU HOLD ' + gameQuantity(position.quantity) + ' UNITS</span>' : '');

  const order = gameOptionOrder();
  if (!(order.quantity > 0)) {
    preview.innerHTML = '<span class="game-dim">ENTER THE UNITS' + (strategy.protective || strategy.written && strategy.kind === 'call' ? ', UP TO THE UNITS YOU HOLD' : '') + '</span>';
    return;
  }
  const trade = GameEngine.openOption(GamePage.game, GamePage.market, asset, order, today, now);
  const premiumChf = GameEngine.optionPrice(order.kind, chain.priceChf, order.strike, GameEngine.daysBetween(today, order.expiry) / 365, chain.volatility);
  const totalChf = premiumChf * order.quantity;
  const breakEvenChf = order.kind === 'call' ? order.strike + premiumChf : order.strike - premiumChf;
  const rows = [
    ['PREMIUM PER UNIT', gameMoney(premiumChf, today)],
    ['<strong>' + (order.written ? 'YOU GET' : 'YOU PAY') + '</strong>', '<strong>' + gameMoney(totalChf, today) + '</strong>'],
    ['BREAK-EVEN AT', gameMoney(breakEvenChf, today)],
    ['DAYS LEFT', String(GameEngine.daysBetween(today, order.expiry))],
  ];
  if (order.written && order.kind === 'put') rows.push(['CASH HELD UNTIL IT ENDS', gameMoney(order.strike * order.quantity, today)]);
  if (order.written && order.kind === 'call') rows.push(['UNITS LOCKED UNTIL IT ENDS', gameQuantity(order.quantity)]);
  if (strategy.protective && !position) rows.push(['<span class="game-neg">YOU HOLD NONE</span>', 'A PLAIN PUT THEN']);
  preview.innerHTML = gamePreviewTable(rows) + '<div class="game-dim mt-1">IT ENDS AT THE CLOSE OF ' + formatDate(order.expiry) +
    (order.written ? '. IN THE MONEY THEN, THE UNITS CHANGE HANDS AT THE STRIKE.' : ', PAYING WHAT IT IS IN THE MONEY IN CASH.') + '</div>' +
    (trade.error ? '<div class="game-neg game-preview-error">' + escapeHtml(trade.error) + '</div>' : '');
  button.disabled = !!trade.error;
}

// The open options with their value at the last close; each can be closed early at that price.
function gameRenderOptions(state, today) {
  const container = document.getElementById('game-options');
  if (!state.options.length) {
    container.innerHTML = '<div class="game-dim">NO OPEN OPTIONS. PICK A STRATEGY AND A STOCK ON THE LEFT.</div>';
    return;
  }
  container.innerHTML = '<table class="table-gta w-100"><thead><tr><th>OPTION</th><th class="text-end">UNITS</th><th class="text-end">PRICE</th>' +
    '<th class="text-end">P&amp;L</th><th class="text-end">ENDS</th><th></th></tr></thead><tbody>' +
    state.options.map((option) => {
      const at = escapeHtml(option.at);
      const profitChf = (option.written ? option.premiumChf - option.priceChf : option.priceChf - option.premiumChf) * option.quantity;
      const held = option.written ? (option.kind === 'put' ? 'CASH HELD ' + gameMoney(option.heldChf, today) : 'COVERED BY YOUR UNITS') : 'BOUGHT';
      return '<tr><td><span class="game-symbol">' + escapeHtml(option.name) + ' ' + gameOptionContract(option, today) + '</span>' +
        '<span class="game-name">' + escapeHtml(option.symbol) + ' · ' + (option.written ? '<span class="game-neg">WRITTEN</span> · ' + held : held) + '</span></td>' +
        '<td class="text-end">' + gameQuantity(option.quantity) + '</td>' +
        '<td class="text-end">' + gameMoney(option.priceChf, today) + '<br><small class="game-dim">' + (option.written ? 'GOT ' : 'PAID ') + gameMoney(option.premiumChf, today) + '</small></td>' +
        '<td class="text-end ' + gameSignClass(profitChf) + '">' + gameSignedMoney(profitChf, today) + '</td>' +
        '<td class="text-end">' + formatDate(option.expiry) + '<br><small class="game-dim">' + Math.max(0, GameEngine.daysBetween(today, option.expiry)) + ' DAYS</small></td>' +
        '<td class="text-end text-nowrap"><button class="btn btn-gta btn-sm game-option-close" data-option="' + at + '" data-fraction="0.5">CLOSE 50%</button> ' +
        '<button class="btn btn-gta btn-sm btn-danger-del game-option-close" data-option="' + at + '" data-fraction="1">CLOSE ALL</button></td></tr>';
    }).join('') + '</tbody></table><p class="game-note">P&amp;L AT THE LAST CLOSE. CLOSING SELLS A BOUGHT OPTION BACK, OR BUYS A WRITTEN ONE BACK, AT THAT PRICE.</p>';
  container.querySelectorAll('.game-option-close').forEach((button) => {
    button.onclick = () => gameTrade(GameEngine.closeOption(GamePage.game, GamePage.market, button.dataset.option, { fraction: Number(button.dataset.fraction) },
      todayIsoDate(), new Date().toISOString()));
  });
}

// ---------- Orders ----------

// 'LIMIT BUY', 'LIMIT SELL', 'LIMIT SHORT', 'STOP-LOSS' or 'TRAILING STOP'.
function gameOrderLabel(order) {
  if (order.type === 'stop') return 'STOP-LOSS';
  return order.type === 'trail' ? 'TRAILING STOP' : 'LIMIT ' + (order.short ? 'SHORT' : order.side.toUpperCase());
}

// An order's level now: its price, or for a trailing stop how far it has followed the price since it was placed.
function gameOrderLevel(order, nowMs) {
  if (order.type !== 'trail') return order.priceChf;
  const trigger = GameEngine.orderTrigger(order);
  if (!order.intraday) GameEngine.newCloses(GamePage.market, order, new Date(nowMs).toISOString().slice(0, 10)).forEach((close) => trigger(close.priceChf));
  const day = order.intraday && gameTradingDay(order, order.date);
  if (day) day.prices.slice(GameIntraday.stepAt(day, Date.parse(order.at)) + 1, GameIntraday.stepAt(day, nowMs) + 1).forEach(trigger);
  return trigger.level();
}

// When an order fills (GameEngine.orderReached): 'AT OR BELOW' or 'AT OR ABOVE' its price.
function gameOrderCondition(order) {
  return (order.type === 'limit') === (order.side === 'buy') ? 'AT OR BELOW' : 'AT OR ABOVE';
}

// A cost preview of [label, value] rows.
function gamePreviewTable(rows) {
  return '<table class="w-100 game-preview-table"><tbody>' +
    rows.map((row) => '<tr><td>' + row[0] + '</td><td class="text-end">' + row[1] + '</td></tr>').join('') + '</tbody></table>';
}

// Writes the game; if that fails, the lists in `before` ({ orders, trades }) are put back, so the page matches the file.
async function gameSaveOrUndo(before, failText) {
  try {
    await gameWriteCurrent();
    return true;
  } catch (error) {
    Object.assign(GamePage.game, before);
    gameToast(failText + ': ' + (error.message || error));
    return false;
  }
}

// Keeps an order from GameEngine.placeOrder or placeDayOrder in the save; returns whether it was placed.
async function gamePlaceOrder(order) {
  if (order.error) { gameToast(order.error); return false; }
  const before = { orders: GamePage.game.orders || [] };
  GamePage.game.orders = before.orders.concat(order);
  if (!(await gameSaveOrUndo(before, 'COULD NOT SAVE, ORDER NOT PLACED'))) return false;
  gameToast(gameOrderLabel(order) + ' PLACED: ' + order.name + ' ' + gameOrderCondition(order) + ' ' + gameMoney(order.priceChf));
  gameRender();
  return true;
}

async function gameCancelOrder(at) {
  const before = { orders: GamePage.game.orders };
  GamePage.game.orders = before.orders.filter((order) => order.at !== at);
  if (!(await gameSaveOrUndo(before, 'COULD NOT SAVE, ORDER STILL OPEN'))) return;
  gameToast('ORDER CANCELLED');
  gameRender();
}

// Open orders whose price was reached become their trades, earliest first, at the price that reached it. Orders that
// cannot trade any more are dropped: one whose holding or day trade is gone (quietly), a day order after its close,
// or a fill the rules refuse, such as a buy without the cash. Reads the last render's replay (GamePage.dayState).
async function gameSettleOrders() {
  const game = GamePage.game;
  const state = GamePage.dayState;
  if (!game || !state || !(game.orders || []).length || GamePage.settlingOrders) return;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const kept = [];
  const fills = [];
  const messages = [];
  game.orders.forEach((order) => {
    if (!order.intraday) {
      // Only a close that comes in late could fill a sell after its holding was sold by hand, so that one is dropped first.
      if (order.side === 'sell' && !state.positions.some((position) => position.symbol === order.symbol)) return;
      const fill = GameEngine.orderFill(GamePage.market, order, now.slice(0, 10));
      if (fill) fills.push({ order: order, time: fill.date });
      else kept.push(order);
      return;
    }
    // An order closing a day trade (lotAt) is checked even when that trade is gone: the page may have been closed
    // when the price was reached.
    const day = gameTradingDay(order, order.date);
    const fill = day && GameIntraday.firstStepReaching(day, Date.parse(order.at), Math.min(nowMs, Date.parse(order.closesAt) - 1), GameEngine.orderTrigger(order));
    if (fill) fills.push({ order: order, time: fill.at, priceChf: fill.priceChf, session: day.session });
    else if (order.lotAt && !state.dayTrades.some((lot) => lot.at === order.lotAt)) return;
    else if (nowMs < Date.parse(order.closesAt)) kept.push(order);
    else messages.push(gameOrderLabel(order) + ' ' + order.name + ' ENDED AT THE CLOSE');
  });
  if (kept.length === game.orders.length) return;

  const before = { orders: game.orders, trades: game.trades.slice() };
  game.orders = kept;
  fills.sort((first, second) => (first.time < second.time ? -1 : first.time > second.time ? 1 : 0)).forEach((fill, index) => {
    const order = fill.order;
    // The order is its own asset and order for the trade. Day orders reached at the same step get their own
    // millisecond, so each day trade keeps its own time.
    const at = fill.session && new Date(Date.parse(fill.time) + index).toISOString();
    const market = GamePage.market;
    let trade;
    if (!fill.session) trade = order.side === 'buy' ? GameEngine.buy(game, market, order, order, fill.time, now) : GameEngine.sell(game, market, order.symbol, order, fill.time, now);
    else if (order.lotAt) trade = GameEngine.closeDayTrade(game, market, order.symbol, order, fill.priceChf, at);
    else trade = GameEngine.openDayTrade(game, market, order, order, fill.priceChf, fill.session, at);
    if (trade.error) { messages.push(gameOrderLabel(order) + ' ' + order.name + ' DROPPED: ' + trade.error); return; }
    trade.orderType = order.type;
    game.trades.push(trade);
    messages.push(gameOrderLabel(order) + ': ' + gameTradeVerb(trade) + ' ' + gameQuantityWithUnit(trade, trade.quantity) + ' ' + trade.name);
  });
  GamePage.settlingOrders = true;
  const saved = await gameSaveOrUndo(before, 'COULD NOT SAVE THE FILLED ORDERS');
  GamePage.settlingOrders = false;
  if (!saved) return;
  if (messages.length) gameToast(messages.join(' · '));
  gameRender();
}

// The open orders: regular ones on the portfolio tab, day orders on the day trading tab, each with a cancel button.
function gameRenderOrders(today) {
  const orders = GamePage.game.orders || [];
  [
    ['game-orders', false, 'NO OPEN ORDERS. PICK LIMIT ORDER IN THE BUY DIALOG, OR ORDER ON A HOLDING FOR A STOP-LOSS OR LIMIT SELL.'],
    ['game-day-orders', true, 'NO OPEN DAY ORDERS. PICK LIMIT ORDER ABOVE, OR ORDER ON AN OPEN DAY TRADE FOR A STOP-LOSS OR TAKE PROFIT.'],
  ].forEach(([containerId, intraday, emptyText]) => {
    const container = document.getElementById(containerId);
    const list = orders.filter((order) => !!order.intraday === intraday);
    if (!list.length) { container.innerHTML = '<div class="game-dim">' + emptyText + '</div>'; return; }
    container.innerHTML = '<table class="table-gta w-100"><thead><tr><th>PLACED</th><th>ORDER</th><th>ASSET</th><th class="text-end">PRICE</th>' +
      '<th class="text-end">SIZE</th><th></th></tr></thead><tbody>' + list.map((order) => {
        const unit = gameUnit(order);
        const size = order.fraction != null
          ? (order.fraction >= 1 ? 'ALL' : Math.round(order.fraction * 100) + '%') + (order.lotAt ? ' OF THE ' + gameClock(order.lotAt) + (order.side === 'buy' ? ' SHORT' : ' BUY') : '')
          : order.quantity != null ? gameQuantityWithUnit(order, order.quantity) : gameMoney(order.amountChf, today);
        return '<tr><td>' + (intraday ? gameClock(order.at) + '<br><small class="game-dim">ENDS ' + gameClock(order.closesAt) + '</small>' : formatDate(order.date)) + '</td>' +
          '<td><span class="game-badge game-badge-' + order.side + '">' + gameOrderLabel(order) + '</span></td>' +
          '<td><span class="game-symbol">' + escapeHtml(order.name) + '</span><span class="game-name">' + escapeHtml(order.symbol) + '</span></td>' +
          '<td class="text-end">' + (order.type === 'trail' ? 'TRAILS ' + gameRate(order.trailPercent) + ' · ' : '') + gameOrderCondition(order) + ' ' +
            gameMoney(gameOrderLevel(order, Date.now()), today) + (unit ? ' / ' + unit : '') + '</td>' +
          '<td class="text-end">' + size + '</td>' +
          '<td class="text-end"><button class="btn btn-gta btn-sm btn-danger-del game-order-cancel" data-order="' + escapeHtml(order.at) + '">CANCEL</button></td></tr>';
      }).join('') + '</tbody></table>';
    container.querySelectorAll('.game-order-cancel').forEach((button) => {
      button.onclick = () => gameCancelOrder(button.dataset.order);
    });
  });
}

// The holding, or the open day trade (GamePage.sellOrder.lotAt), the sell order dialog is for; undefined once it is gone.
function gameSellOrderTarget() {
  const choice = GamePage.sellOrder;
  return choice.lotAt ? GamePage.dayState.dayTrades.find((lot) => lot.at === choice.lotAt)
    : GamePage.dayState.positions.find((position) => position.symbol === choice.symbol);
}

// The dialog's order: a sale, or for a short day trade a buyback.
function gameSellOrderFields() {
  const choice = GamePage.sellOrder;
  // The one number is the price, or for a trailing stop the trail in percent.
  const value = Number(document.getElementById('game-order-price').value);
  const fields = { side: choice.short ? 'buy' : 'sell', type: choice.type, fraction: choice.fraction };
  if (choice.type === 'trail') fields.trailPercent = value / 100;
  else fields.priceChf = value;
  if (choice.lotAt) fields.lotAt = choice.lotAt;
  return fields;
}

// The dialog's order from the rules, against the last close or, for a day trade, the live price: the order, or { error }.
function gameSellOrderResult(target, nowMs) {
  const now = new Date(nowMs).toISOString();
  if (!GamePage.sellOrder.lotAt) return GameEngine.placeOrder(GamePage.game, GamePage.market, target, gameSellOrderFields(), now.slice(0, 10), now);
  const day = gameTradingDay(target, now.slice(0, 10));
  return day ? GameEngine.placeDayOrder(GamePage.game, GamePage.market, target, gameSellOrderFields(), GameIntraday.priceAt(day, nowMs), day.session, now)
    : { error: 'MARKET CLOSED' };
}

function gameOpenSellOrder(symbol, lotAt) {
  const shortLot = !!lotAt && GamePage.dayState.dayTrades.some((lot) => lot.at === lotAt && lot.short);
  GamePage.sellOrder = { symbol: symbol, lotAt: lotAt || null, short: shortLot, type: 'stop', fraction: 1 };
  document.getElementById('game-order-price').value = '';
  gameRenderSellOrder();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('game-order-modal')).show();
}

// The sell order dialog: the price now, and what the order sells when.
function gameRenderSellOrder() {
  const choice = GamePage.sellOrder;
  const target = gameSellOrderTarget();
  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  document.getElementById('game-order-title').textContent = choice.lotAt ? 'DAY TRADE ORDER' : 'SELL ORDER';
  document.querySelectorAll('[data-order-type]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.orderType === choice.type)));
  document.getElementById('game-order-limit-btn').textContent = choice.short ? 'LIMIT BUY' : 'LIMIT SELL';
  document.querySelectorAll('[data-order-fraction]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.orderFraction) === choice.fraction)));
  const quote = document.getElementById('game-order-quote');
  const preview = document.getElementById('game-order-preview');
  const button = document.getElementById('game-order-btn');
  const day = target && choice.lotAt ? gameTradingDay(target, today) : null;
  const lastClose = target && !choice.lotAt ? GamePage.market.quote(target.symbol, today) : null;
  const priceNowChf = day ? GameIntraday.priceAt(day, nowMs) : lastClose ? lastClose.priceChf : null;
  if (!target || !priceNowChf) {
    quote.textContent = target ? 'NO PRICE NOW' : 'NOTHING LEFT TO SELL';
    preview.innerHTML = '';
    button.disabled = true;
    return;
  }
  const unit = gameUnit(target);
  const perUnit = unit ? ' / ' + unit : '';
  const fields = gameSellOrderFields();
  const trail = choice.type === 'trail';
  document.getElementById('game-order-price-label').textContent = trail ? 'TRAIL (%)'
    : (choice.short ? 'BUY BACK ' : 'SELL ') + gameOrderCondition(fields) + ' (CHF' + (unit ? ' PER ' + unit : '') + ')';
  quote.innerHTML = '<span class="game-symbol">' + escapeHtml(target.name) + '</span> ' +
    (choice.lotAt ? (choice.short ? 'SHORTED ' : 'BOUGHT ') + gameClock(choice.lotAt) + ' · LIVE PRICE ' : 'LAST CLOSE ') + gameMoney(priceNowChf, today) + perUnit;
  if (!((trail ? fields.trailPercent : fields.priceChf) > 0)) {
    preview.innerHTML = '<span class="game-dim">' + (trail ? 'ENTER HOW FAR IT TRAILS, IN %' : 'ENTER A PRICE') + '</span>';
    button.disabled = true;
    return;
  }
  const result = gameSellOrderResult(target, nowMs);
  const quantity = target.quantity * choice.fraction;
  // A trailing stop starts at its trail from the price now.
  const levelChf = trail ? priceNowChf * (choice.short ? 1 + fields.trailPercent : 1 - fields.trailPercent) : fields.priceChf;
  const priceName = choice.lotAt ? 'LIVE PRICE' : 'CLOSE';
  preview.innerHTML = gamePreviewTable([
    [choice.short ? 'BUYS BACK' : 'SELLS', gameQuantityWithUnit(target, quantity) + (choice.fraction < 1 ? ' (50%)' : ' (ALL)')],
    trail ? ['WHEN THE ' + priceName, (choice.short ? 'RISES ' : 'FALLS ') + gameRate(fields.trailPercent) + ' FROM ITS ' + (choice.short ? 'LOWEST' : 'HIGHEST') + ' SINCE NOW']
      : ['WHEN THE ' + priceName + ' IS', gameOrderCondition(fields) + ' ' + gameMoney(levelChf, today) + perUnit],
    [trail ? 'LEVEL NOW' : 'FROM NOW', trail ? gameMoney(levelChf, today) + perUnit + ', MOVING WITH THE PRICE' : gamePercent(levelChf / priceNowChf - 1)],
    [choice.short ? 'COST AT THAT PRICE' : 'VALUE AT THAT PRICE', gameMoney(quantity * levelChf, today)],
  ]) + '<div class="game-dim mt-1">' + (choice.lotAt ? 'ENDS AT THE CLOSE IF THE PRICE IS NOT REACHED.'
    : 'OPEN UNTIL IT FILLS OR YOU CANCEL IT. A CLOSE CAN JUMP PAST YOUR PRICE: IT THEN SELLS AT THAT CLOSE.') + '</div>' +
    (result.error ? '<div class="game-neg game-preview-error">' + escapeHtml(result.error) + '</div>' : '');
  button.disabled = !!result.error;
}

// ---------- Boot ----------

function gameBindControls() {
  const currencySelect = document.getElementById('game-currency');
  currencySelect.innerHTML = _WALL_STREET_CURRENCIES.map((code) => '<option value="' + code + '">' + code + '</option>').join('');
  currencySelect.value = 'CHF';
  currencySelect.onchange = () => { GamePage.currency = currencySelect.value; if (GamePage.market) gameRender(); };

  document.querySelectorAll('[data-game-tab]').forEach((button) => {
    button.onclick = () => gameShowTab(button.dataset.gameTab);
  });
  gameShowTab(location.hash.slice(1));
  window.addEventListener('hashchange', () => gameShowTab(location.hash.slice(1)));

  ['borrow', 'repay'].forEach((side) => {
    document.getElementById('game-' + side + '-btn').onclick = () => {
      const amountChf = Number(document.getElementById('game-loan-amount').value);
      const trade = GameEngine.loanTrade(GamePage.game, GamePage.market, side, amountChf, todayIsoDate(), new Date().toISOString());
      if (!trade.error) document.getElementById('game-loan-amount').value = '';
      gameTrade(trade);
    };
  });
  // Dividends from today on are reinvested, or paid in cash again; earlier ones stay as they were.
  document.getElementById('game-reinvest-btn').onclick = async () => {
    const game = GamePage.game;
    const today = todayIsoDate();
    const before = { reinvestPeriods: game.reinvestPeriods || [] };
    const periods = before.reinvestPeriods.map((period) => Object.assign({}, period));
    if (GameEngine.reinvestsOn(game, today)) periods[periods.length - 1].to = today;
    else periods.push({ from: today });
    game.reinvestPeriods = periods;
    if (await gameSaveOrUndo(before, 'COULD NOT SAVE')) {
      gameToast(GameEngine.reinvestsOn(game, today) ? 'DIVIDENDS ARE REINVESTED FROM TODAY' : 'DIVIDENDS ARE PAID IN CASH FROM TODAY');
      gameRender();
    }
  };
  document.getElementById('game-open-buy').onclick = () => {
    gameRenderBuyForm();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('game-buy-modal')).show();
  };
  document.getElementById('game-category').onchange = (event) => { GamePage.buyCategory[GamePage.buyTab] = event.target.value; gameRenderBuyForm(); };
  document.getElementById('game-asset').onchange = () => gameRenderBuyForm();
  document.getElementById('game-amount').oninput = () => gameRenderBuyForm();
  document.getElementById('game-unit').onchange = () => gameRenderBuyForm();
  document.getElementById('game-down').oninput = () => gameRenderBuyForm();
  document.querySelectorAll('[data-buy-tab]').forEach((button) => {
    button.onclick = () => { GamePage.buyTab = button.dataset.buyTab; gameRenderBuyForm(); };
  });
  document.querySelectorAll('[data-buy-mode]').forEach((button) => {
    button.onclick = () => { GamePage.buyMode = button.dataset.buyMode; gameRenderBuyForm(); };
  });
  document.querySelectorAll('[data-buy-kind]').forEach((button) => {
    button.onclick = () => { GamePage.buyKind = button.dataset.buyKind; gameRenderBuyForm(); };
  });
  document.getElementById('game-limit').oninput = () => gameRenderBuyForm();
  document.querySelectorAll('[data-buy-direction]').forEach((button) => {
    button.onclick = () => { GamePage.buyDirection = button.dataset.buyDirection; gameRenderBuyForm(); };
  });

  document.querySelectorAll('[data-option-strategy]').forEach((button) => {
    button.onclick = () => { GamePage.optionStrategy = button.dataset.optionStrategy; gameRenderOptionsForm(); };
  });
  document.getElementById('game-option-category').onchange = (event) => { GamePage.optionCategory = event.target.value; gameRenderOptionsForm(); };
  ['game-option-asset', 'game-option-expiry', 'game-option-strike'].forEach((id) => { document.getElementById(id).onchange = () => gameRenderOptionsForm(); });
  document.getElementById('game-option-quantity').oninput = () => gameRenderOptionsForm();
  document.getElementById('game-option-btn').onclick = () => {
    const asset = gameOptionAsset();
    if (!asset) { gameToast('PICK A STOCK'); return; }
    gameTrade(GameEngine.openOption(GamePage.game, GamePage.market, asset, gameOptionOrder(), todayIsoDate(), new Date().toISOString()));
  };
  document.getElementById('game-buy-btn').onclick = async () => {
    const asset = gameSelectedAsset();
    if (!asset) { gameToast('PICK AN ASSET'); return; }
    if (GamePage.buyDirection === 'short' && (asset.class === 'stock' || asset.class === 'etf')) {
      gameTrade(GameEngine.openShort(GamePage.game, GamePage.market, asset, gameOrder(asset), todayIsoDate(), new Date().toISOString()));
      return;
    }
    if (GamePage.buyKind === 'limit' && !GameEngine.isTangible(asset.class)) {
      const order = GameEngine.placeOrder(GamePage.game, GamePage.market, asset, gameLimitFields(asset), todayIsoDate(), new Date().toISOString());
      if (await gamePlaceOrder(order)) bootstrap.Modal.getOrCreateInstance(document.getElementById('game-buy-modal')).hide();
      return;
    }
    gameTrade(GameEngine.buy(GamePage.game, GamePage.market, asset, gameOrder(asset), todayIsoDate(), new Date().toISOString()));
  };

  document.querySelectorAll('[data-order-type]').forEach((button) => {
    button.onclick = () => { GamePage.sellOrder.type = button.dataset.orderType; gameRenderSellOrder(); };
  });
  document.querySelectorAll('[data-order-fraction]').forEach((button) => {
    button.onclick = () => { GamePage.sellOrder.fraction = Number(button.dataset.orderFraction); gameRenderSellOrder(); };
  });
  document.getElementById('game-order-price').oninput = () => gameRenderSellOrder();
  document.getElementById('game-order-btn').onclick = async () => {
    const target = gameSellOrderTarget();
    const order = target ? gameSellOrderResult(target, Date.now()) : { error: 'NOTHING LEFT TO SELL' };
    if (await gamePlaceOrder(order)) bootstrap.Modal.getOrCreateInstance(document.getElementById('game-order-modal')).hide();
  };

  document.getElementById('game-day-category').onchange = (event) => {
    GamePage.dayCategory = event.target.value;
    gameFillAssetLists(document.getElementById('game-day-category'), document.getElementById('game-day-asset'), GAME_BUY_CATEGORIES.market, GamePage.dayCategory, todayIsoDate());
    gameDayTick();
  };
  document.getElementById('game-day-asset').onchange = () => gameDayTick();
  document.querySelectorAll('[data-day-zoom]').forEach((button) => {
    button.onclick = () => { GamePage.dayZoom = button.dataset.dayZoom; gameDayTick(); };
  });
  const dayAmountInput = document.getElementById('game-day-amount');
  dayAmountInput.oninput = () => gameDayTick();
  document.querySelectorAll('[data-day-mode]').forEach((button) => {
    // The same number means something else in the other mode, so it is cleared.
    button.onclick = () => { GamePage.dayMode = button.dataset.dayMode; dayAmountInput.value = ''; gameDayTick(); };
  });
  document.querySelectorAll('[data-day-preset]').forEach((button) => {
    button.onclick = () => { dayAmountInput.value = button.dataset.dayPreset; gameDayTick(); };
  });
  document.querySelectorAll('[data-day-kind]').forEach((button) => {
    button.onclick = () => { GamePage.dayKind = button.dataset.dayKind; gameDayTick(); };
  });
  document.querySelectorAll('[data-day-direction]').forEach((button) => {
    button.onclick = () => { GamePage.dayDirection = button.dataset.dayDirection; gameDayTick(); };
  });
  document.getElementById('game-day-limit').oninput = () => gameDayTick();
  document.getElementById('game-day-buy-btn').onclick = () => {
    const asset = gameDayAsset();
    if (!asset) { gameToast('PICK AN ASSET'); return; }
    const now = new Date().toISOString();
    const day = gameTradingDay(asset, now.slice(0, 10));
    const value = Number(dayAmountInput.value);
    const short = GamePage.dayDirection === 'short';
    const order = Object.assign(GamePage.dayMode === 'quantity' ? { quantity: value } : { amountChf: value }, short ? { short: true } : {});
    if (!day) { gameToast('MARKET CLOSED'); return; }
    const priceChf = GameIntraday.priceAt(day, Date.parse(now));
    if (GamePage.dayKind === 'limit') {
      const fields = Object.assign({ side: short ? 'sell' : 'buy', type: 'limit', priceChf: Number(document.getElementById('game-day-limit').value) }, order);
      gamePlaceOrder(GameEngine.placeDayOrder(GamePage.game, GamePage.market, asset, fields, priceChf, day.session, now));
      return;
    }
    gameTrade(GameEngine.openDayTrade(GamePage.game, GamePage.market, asset, order, priceChf, day.session, now));
  };

  const savesDialog = () => bootstrap.Modal.getOrCreateInstance(document.getElementById('game-saves-modal'));
  document.getElementById('game-save').onchange = (event) => { savesDialog().hide(); gameOpenSave(event.target.value); };
  document.getElementById('game-new-btn').onclick = () => { savesDialog().hide(); GamePage.view = 'start'; gameRender(); };
  document.getElementById('game-start-back').onclick = () => { GamePage.view = 'board'; gameRender(); };
  document.getElementById('game-reset-btn').onclick = async () => {
    const game = GamePage.game;
    if (!confirm('Start "' + game.name + '" again from today? All its trades and history are deleted.')) return;
    savesDialog().hide();
    const before = { startDate: game.startDate, trades: game.trades };
    game.startDate = todayIsoDate();
    game.trades = [];
    try {
      await gameWriteCurrent();
    } catch (error) {
      Object.assign(game, before);
      gameToast('COULD NOT SAVE: ' + (error.message || error));
      return;
    }
    gameRender();
  };
}

async function gameBoot() {
  gameShow('loading');
  const loading = document.getElementById('game-loading');
  try {
    await GameSaves.importLegacy();
  } catch (error) {
    gameToast('COULD NOT MOVE YOUR OLD GAME TO A SAVE FILE: ' + (error.message || error));
  }

  const player = document.getElementById('game-player');
  player.textContent = 'SYNCING MARKET DATA...';
  loading.textContent = 'SYNCING MARKET DATA INTO RESOURCES...';
  const result = await Randata.sync();
  const file = await Randata.readFile();
  GamePage.marketDate = file.synced_date || null;
  gameRenderHeader();
  if (result && result.status === 'offline') gameToast('MARKET DATA OFFLINE');

  GamePage.market = gameBuildMarket(file, await Randata.readDividends());
  const today = todayIsoDate();
  GamePage.assets = (file.assets || [])
    .filter((asset) => asset && GAME_MARKET_CLASSES.includes(asset.class) && GamePage.market.quote(asset.symbol, today))
    .sort((a, b) => String(a.name || a.symbol).localeCompare(String(b.name || b.symbol)))
    .concat(GameTangibles.ITEMS.map((item) => ({ symbol: item.id, class: item.class, group: item.group, name: item.name })));
  if (!GamePage.assets.some((asset) => !GameTangibles.isTangible(asset.symbol))) {
    loading.textContent = 'NO MARKET DATA. CHECK YOUR CONNECTION AND RELOAD.';
    return;
  }

  try {
    GamePage.saves = await GameSaves.list();
  } catch (error) {
    loading.textContent = 'COULD NOT READ THE GAME FOLDER: ' + (error.message || error);
    return;
  }
  const last = GamePage.saves.find((save) => save.file === GameSaves.lastFile()) || GamePage.saves[0];
  if (last) {
    GamePage.game = last.game;
    GamePage.saveFile = last.file;
  }
  gameRender();
  setInterval(gameDayTick, 1000);
}

(async () => {
  document.documentElement.style.setProperty('--radius', '10px');
  gameBindControls();
  if (await GameSaves.connect()) { gameBoot(); return; }
  // Folder mode without access yet: the browser only shows the folder picker after a click.
  gameShow('connect');
  document.getElementById('game-connect-btn').onclick = async () => {
    if (await GameSaves.connect()) gameBoot();
    else gameToast('NO FOLDER CHOSEN');
  };
})();

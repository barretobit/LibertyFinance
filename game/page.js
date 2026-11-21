/* ===== Zuri Vault: page =====
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
  chart: null,
  buyTab: 'market',
  buyCategory: { market: 'STOCKS', tangible: 'PRECIOUS METALS' },
  buyMode: 'amount',
};

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
  return {
    quote: quote,
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
  const controls = document.getElementById('game-save-controls');
  controls.style.display = GamePage.saves.length ? '' : 'none';
  const select = document.getElementById('game-save');
  select.innerHTML = GamePage.saves.map((save) => {
    const label = save.game.name + ' (' + GameEngine.DIFFICULTIES[save.game.difficulty].label + ', ' + GameEngine.LOCATIONS[save.game.location].label + ')';
    return '<option value="' + escapeHtml(save.file) + '">' + escapeHtml(label) + '</option>';
  }).join('');
  if (GamePage.saveFile) select.value = GamePage.saveFile;
  const folder = GameSaves.folderName();
  select.title = 'Saved as ' + (folder ? folder + '/' : '') + GameSaves.FOLDER + '/' + (GamePage.saveFile || '');
  document.getElementById('game-reset-btn').style.display = game && GamePage.view === 'board' ? '' : 'none';
  document.getElementById('game-player').innerHTML = game && GamePage.view === 'board'
    ? escapeHtml(game.name) + ' · ' + GameEngine.LOCATIONS[game.location].label + ' · ' + GameEngine.DIFFICULTIES[game.difficulty].label +
      ' · SINCE ' + formatDate(game.startDate) + ' · GROSS SALARY CHF ' + GameEngine.yearlySalary(game.location, game.difficulty).toLocaleString('en-GB') + ' A YEAR'
    : '';
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
  const previous = days.length > 1 ? days[days.length - 2] : null;
  const invested = state.positions.reduce((sum, position) => sum + position.valueChf, 0);
  const totalChange = last.moneyIn > 0 ? last.netWorth / last.moneyIn - 1 : null;
  const benchmarkChange = last.benchmark != null && last.moneyIn > 0 ? last.benchmark / last.moneyIn - 1 : null;
  // Salary and bills paid today are not a gain or a loss.
  const dayChange = previous ? (last.netWorth - previous.netWorth) - (last.moneyIn - previous.moneyIn) : 0;
  const traderText = { private: 'PRIVATE INVESTOR', review: 'UNDER REVIEW', risk: 'PRO TRADER RISK' }[state.trader.status];
  const traderTitle = 'This year: ' + state.trader.shortSales + ' sale(s) held under 6 months, trade volume ' +
    state.trader.volumeMultiple.toFixed(1) + 'x your wealth at the start of the year (limit 5x).';
  const stat = (label, value, extraClass, title) =>
    '<div class="game-stat"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' +
    '<span class="game-stat-label">' + label + '</span><span class="game-stat-value ' + (extraClass || '') + '">' + value + '</span></div>';
  const group = (label, stats) =>
    '<div class="col-12 col-xl-6"><div class="stat-card game-stat-group"><span class="stat-label">' + label + '</span>' +
    '<div class="game-stat-grid">' + stats.join('') + '</div></div></div>';
  document.getElementById('game-stats').innerHTML =
    '<div class="col-12"><div class="stat-card game-hero">' +
      '<div><span class="stat-label">NET WORTH</span><span class="stat-value game-hero-value">' + gameMoney(last.netWorth, today) + '</span></div>' +
      '<div class="game-stat-grid game-hero-side">' + [
        stat('TODAY', gameSignedMoney(dayChange, today), gameSignClass(dayChange)),
        stat('TOTAL RETURN', totalChange == null ? '—' : gamePercent(totalChange), totalChange == null ? '' : gameSignClass(totalChange, 4),
          'Net worth against the money put in: your start cash plus what you saved from your salary.'),
        stat('VS SMI', benchmarkChange == null || totalChange == null ? '—' : gamePercent(totalChange - benchmarkChange) + ' PTS',
          benchmarkChange == null || totalChange == null ? '' : gameSignClass(totalChange - benchmarkChange, 4), 'Your return minus the return of the same money put into the SMI on the same days.'),
      ].join('') + '</div>' +
    '</div></div>' +
    group('MONEY', [
      stat('CASH', gameMoney(state.cash, today), state.cash < 0 ? 'game-neg' : ''),
      stat('INVESTED', gameMoney(invested, today)),
      stat('MORTGAGES', state.mortgageChf > 0 ? '-' + gameMoney(state.mortgageChf, today) : gameMoney(0, today), state.mortgageChf > 0 ? 'game-neg' : ''),
      stat('MONEY PUT IN', gameMoney(last.moneyIn, today), '', 'Your start cash plus what you saved from your salary after expenses.'),
    ]) +
    group('COSTS &amp; SAVINGS', [
      stat('DIVIDENDS', gameMoney(state.dividendsReceived, today), '', 'Dividends paid to you before income tax. The tax on them is in the taxes paid.'),
      stat('TAXES &amp; FEES PAID', gameMoney(state.taxesPaid + state.feesPaid, today), '', 'Wealth tax, income tax on dividends, property gains tax, stamp duty, purchase costs and dealer cuts.'),
      stat('EXPENSES PAID', gameMoney(state.expensesPaid, today)),
      stat('SAVED PER MONTH', gameSignedMoney(state.budget.savingsChf, today), gameSignClass(state.budget.savingsChf), 'Take home salary minus this month\'s expenses.'),
      stat('TAX STATUS', traderText, 'game-trader-' + state.trader.status, traderTitle),
    ]);
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
      : '<button class="btn btn-gta btn-sm game-sell" data-symbol="' + symbol + '" data-fraction="0.5">SELL 50%</button> ';
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
    button.onclick = () => gameTrade(GameEngine.sell(GamePage.game, GamePage.market, button.dataset.symbol, order, todayIsoDate()));
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

  const parts = [{ name: 'CASH', valueChf: Math.max(0, state.cash) }]
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

function gameRenderBudget(state, today) {
  const budget = state.budget;
  document.getElementById('game-budget-title').textContent = 'MONTHLY BUDGET · ' + GameEngine.LOCATIONS[GamePage.game.location].label;
  const line = (label, amountChf, note, extraClass) =>
    '<tr class="' + (extraClass || '') + '"><td>' + escapeHtml(label) + (note ? '<span class="game-name">' + escapeHtml(note) + '</span>' : '') + '</td>' +
    '<td class="text-end text-nowrap">' + gameMoney(amountChf, today) + '</td></tr>';
  const heading = (label) => '<tr class="game-budget-heading"><td colspan="2">' + label + '</td></tr>';
  const rows = [heading('INCOME')]
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
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-dividend">DIVIDEND</span></td>' +
        '<td><span class="game-symbol">' + escapeHtml(event.name) + '</span><span class="game-name">' + gameClassLabel(event) + '</span></td>' +
        '<td class="text-end">' + gameQuantityWithUnit(event, event.quantity) + ' × ' + gameMoney(event.perUnitChf, event.date) + '</td>' +
        '<td class="text-end">INCOME TAX ' + gameMoney(event.taxChf, event.date) + '</td>' +
        '<td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
    }
    if (event.type === 'month') {
      const cashChange = event.salaryChf - event.expensesChf - event.amortizationChf;
      const parts = ['SALARY ' + gameSignedMoney(event.salaryChf, event.date), 'EXPENSES -' + gameMoney(event.expensesChf, event.date)];
      if (event.amortizationChf > 0) parts.push('MORTGAGE PAYBACK -' + gameMoney(event.amortizationChf, event.date));
      return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-month">MONTH</span></td>' +
        '<td colspan="3">' + parts.join(' · ') + '</td><td class="text-end ' + gameSignClass(cashChange) + '">' + gameSignedMoney(cashChange, event.date) + '</td></tr>';
    }
    const cashChange = event.type === 'buy'
      ? -(event.amountChf - event.mortgageChf + event.stampDutyChf + event.purchaseCostsChf)
      : event.amountChf - event.stampDutyChf - event.dealerFeeChf - event.gainsTaxChf - event.mortgageRepaidChf;
    const fees = [];
    if (event.stampDutyChf) fees.push('DUTY ' + gameMoney(event.stampDutyChf, event.date));
    if (event.purchaseCostsChf) fees.push('TRANSFER TAX &amp; NOTARY ' + gameMoney(event.purchaseCostsChf, event.date));
    if (event.mortgageChf) fees.push('MORTGAGE ' + gameMoney(event.mortgageChf, event.date));
    if (event.dealerFeeChf) fees.push((GAME_SELLER_LABELS[event.class] || 'DEALER') + ' ' + gameMoney(event.dealerFeeChf, event.date));
    if (event.gainsTaxChf) fees.push('GAINS TAX ' + gameMoney(event.gainsTaxChf, event.date));
    if (event.mortgageRepaidChf) fees.push('MORTGAGE PAID BACK ' + gameMoney(event.mortgageRepaidChf, event.date));
    return '<tr><td>' + formatDate(event.date) + '</td><td><span class="game-badge game-badge-' + event.type + '">' + event.type.toUpperCase() + '</span></td>' +
      '<td><span class="game-symbol">' + escapeHtml(event.name) + '</span><span class="game-name">' + gameClassLabel(event) + '</span></td>' +
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
  const preview = GameEngine.previewBuy(GamePage.game, GamePage.market, asset, gameOrder(asset), today);
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

function gameRenderBuyForm(state) {
  const today = todayIsoDate();
  if (!state) state = GameEngine.replay(GamePage.game, GamePage.market, today);
  document.querySelectorAll('[data-buy-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buyTab === GamePage.buyTab)));
  const categories = GAME_BUY_CATEGORIES[GamePage.buyTab].map((category) => Object.assign({ count: GamePage.assets.filter(category.matches).length }, category))
    .filter((category) => category.count > 0);
  const category = categories.find((item) => item.label === GamePage.buyCategory[GamePage.buyTab]) || categories[0];
  const select = document.getElementById('game-asset');
  // Rebuilt only when the list changes: prices move with the day and the display currency.
  const listKey = [GamePage.buyTab, category && category.label, GamePage.currency, today].join('|');
  if (select.dataset.key !== listKey) {
    select.dataset.key = listKey;
    const categorySelect = document.getElementById('game-category');
    categorySelect.innerHTML = categories.map((item) =>
      '<option value="' + escapeHtml(item.label) + '">' + escapeHtml(item.label) + ' (' + item.count + ')</option>').join('');
    if (category) categorySelect.value = category.label;
    const selected = select.value;
    select.innerHTML = category ? gameAssetOptions(category, today) : '';
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  }

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

  const quote = asset && GamePage.market.quote(asset.symbol, today);
  document.getElementById('game-quote').innerHTML = !quote ? 'NO PRICE'
    : 'PRICE ' + gameMoney(quote.priceChf, today) + (unit ? ' PER ' + (unit === 'G' ? 'GRAM' : unit) : '') +
      ' <span class="game-dim">(' + (wholeUnits ? 'TODAY' : 'CLOSE ' + formatDate(quote.date)) + ')</span>';
  document.getElementById('game-details').innerHTML = !asset || !quote ? '' : '<table class="w-100 game-details-table"><tbody>' +
    gameAssetDetails(asset, state, quote.priceChf, today).map((row) => '<tr><th>' + row[0] + '</th><td>' + row[1] +
      (row[2] ? '<span class="game-details-note">' + row[2] + '</span>' : '') + '</td></tr>').join('') + '</tbody></table>';
  document.getElementById('game-buy-btn').disabled = !gameRenderPreview(asset, today);
}

function gameRender() {
  gameRenderHeader();
  if (!GamePage.game || GamePage.view === 'start') {
    gameShow('start');
    gameRenderStart();
    return;
  }
  gameShow('board');
  const today = todayIsoDate();
  const state = GameEngine.replay(GamePage.game, GamePage.market, today);
  gameRenderStats(state, today);
  gameRenderChart(state);
  gameRenderBuyForm(state);
  gameRenderHoldings(state, today);
  gameRenderPortfolioCharts(state, today);
  gameRenderBudget(state, today);
  gameRenderHistory(state);
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
  gameToast((trade.side === 'buy' ? 'BOUGHT ' : 'SOLD ') + gameQuantityWithUnit(trade, trade.quantity) + ' ' + trade.name);
  if (trade.side === 'buy') bootstrap.Modal.getOrCreateInstance(document.getElementById('game-buy-modal')).hide();
  gameRender();
}

// ---------- Boot ----------

function gameBindControls() {
  const currencySelect = document.getElementById('game-currency');
  currencySelect.innerHTML = _WALL_STREET_CURRENCIES.map((code) => '<option value="' + code + '">' + code + '</option>').join('');
  currencySelect.value = 'CHF';
  currencySelect.onchange = () => { GamePage.currency = currencySelect.value; if (GamePage.market) gameRender(); };

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
  document.getElementById('game-buy-btn').onclick = () => {
    const asset = gameSelectedAsset();
    if (!asset) { gameToast('PICK AN ASSET'); return; }
    gameTrade(GameEngine.buy(GamePage.game, GamePage.market, asset, gameOrder(asset), todayIsoDate()));
  };

  document.getElementById('game-save').onchange = (event) => gameOpenSave(event.target.value);
  document.getElementById('game-new-btn').onclick = () => { GamePage.view = 'start'; gameRender(); };
  document.getElementById('game-start-back').onclick = () => { GamePage.view = 'board'; gameRender(); };
  document.getElementById('game-reset-btn').onclick = async () => {
    const game = GamePage.game;
    if (!confirm('Start "' + game.name + '" again from today? All its trades and history are deleted.')) return;
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

  const syncLabel = document.getElementById('game-sync-label');
  syncLabel.textContent = 'SYNCING MARKET DATA...';
  loading.textContent = 'SYNCING MARKET DATA INTO RESOURCES...';
  const result = await Randata.sync();
  const file = await Randata.readFile();
  syncLabel.textContent = file.synced_date ? 'MARKET DATA: ' + formatDate(file.synced_date) : 'MARKET DATA: NO DATA';
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

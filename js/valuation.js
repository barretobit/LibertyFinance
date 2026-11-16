/* ===== Valuation =====
 *
 * The rules every page shares: which transactions move a balance, which of them
 * bring in new capital, and what an account or the whole profile is worth on a
 * date in the main currency. A page builds one context per render with
 * createValuationContext() and asks it, so every page gets the same numbers.
 */

const ACCOUNT_TYPE = {
  cash: 'Cash Account',
  investment: 'Investment Account',
  retirement: 'Retirement Fund',
  tangibleAsset: 'Tangible Asset',
  realEstate: 'Real Estate',
  preciousMetal: 'Precious Metal',
};

// Transactions that set or move an account's balance (they carry balanceAfter)
const BALANCE_TRANSACTION_TYPES = ['deposit', 'withdrawal', 'valuation', 'buy', 'sell', 'asset-add', 'asset-sell'];

const POSITIVE_COLOR = '#33ff33';
const NEGATIVE_COLOR = '#ff3333';
const MISSING_VALUE_COLOR = '#555';

function profitLossColor(value) {
  return value >= 0 ? POSITIVE_COLOR : NEGATIVE_COLOR;
}

// Colors for portfolios, expenses and other series; the accent color comes first
function chartPalette() {
  return [readAccent(), '#33ccff', '#ffaa00', '#ff6633', '#cc33ff', '#33ffcc', '#ff3388'];
}

function isAssetAccount(account) {
  return account.accountType === ACCOUNT_TYPE.tangibleAsset || account.accountType === ACCOUNT_TYPE.realEstate;
}

function isBalanceTransaction(transaction) {
  return BALANCE_TRANSACTION_TYPES.includes(transaction.type);
}

function compareByDate(first, second) {
  return (first.date || '').localeCompare(second.date || '');
}

// Pre-existing wealth entering tracking: recorded as a valuation that carries its own value
function isOpeningValuation(transaction) {
  return !!(transaction && transaction.type === 'valuation' && (transaction.opening === true || transaction.notes === 'OPENING VALUATION'));
}

// Deposit created together with an opening valuation when an account is set up.
// Its amount is already part of that valuation, so it is not new capital.
function isOpeningContribution(transaction) {
  return !!(transaction && transaction.type === 'deposit' && transaction.notes === 'OPENING CONTRIBUTION');
}

// Capital a transaction brings into (+) or takes out of (−) an account, in the
// account's currency. Opening valuations count as capital; opening contributions
// do not (see above). Tangible asset purchases and sales only count when
// includeAssetEvents is set.
function capitalFlow(transaction, { includeAssetEvents = false } = {}) {
  const amount = Math.abs(transaction.amount || 0);
  switch (transaction.type) {
    case 'deposit': return isOpeningContribution(transaction) ? 0 : amount;
    case 'withdrawal': return -amount;
    case 'buy': return amount;
    case 'sell': return -amount;
    case 'valuation': return isOpeningValuation(transaction) ? amount : 0;
    case 'asset-add': return includeAssetEvents ? amount : 0;
    case 'asset-sell': return includeAssetEvents ? -amount : 0;
    default: return 0;
  }
}

// True for the transactions capitalFlow() counts (without asset events)
function isCapitalFlow(transaction) {
  if (['deposit', 'withdrawal', 'buy', 'sell'].includes(transaction.type)) return !isOpeningContribution(transaction);
  return isOpeningValuation(transaction);
}

// Money moved in by deposits and buys, minus withdrawals and sells ("NET DEPOSITS")
function netDeposit(transaction) {
  const amount = Math.abs(transaction.amount || 0);
  if (transaction.type === 'deposit' || transaction.type === 'buy') return amount;
  if (transaction.type === 'withdrawal' || transaction.type === 'sell') return -amount;
  return 0;
}

// Money saved into an account: deposits minus withdrawals ("TOTAL SAVED")
function savedAmount(transaction) {
  const amount = Math.abs(transaction.amount || 0);
  if (transaction.type === 'deposit') return amount;
  if (transaction.type === 'withdrawal') return -amount;
  return 0;
}

// Balance after the latest balance transaction, or `fallback` when there is none
function latestBalance(transactions, fallback) {
  const balanceTransactions = transactions.filter(isBalanceTransaction).sort(compareByDate);
  return balanceTransactions.length > 0 ? (balanceTransactions[balanceTransactions.length - 1].balanceAfter || 0) : (fallback || 0);
}

// Cost basis of an account from its transactions, in its own currency.
// Precious metals: average cost of the metal still held. Others: deposits minus
// withdrawals plus opening valuations; with none of those, the first valuation.
function costBasis(transactions) {
  const metalTrades = transactions.filter(transaction => transaction.type === 'buy' || transaction.type === 'sell');
  if (metalTrades.length > 0) {
    let spent = 0;
    let quantity = 0;
    [...metalTrades].sort(compareByDate).forEach(trade => {
      if (trade.type === 'buy') {
        spent += Math.abs(trade.amount || 0);
        quantity += Math.abs(trade.quantity || 0);
      } else {
        const soldQuantity = Math.abs(trade.quantity || 0);
        if (quantity > 0) {
          spent = Math.max(0, spent - (spent / quantity) * soldQuantity);
          quantity = Math.max(0, quantity - soldQuantity);
        }
      }
    });
    return spent;
  }

  let basis = 0;
  let hasCapitalFlow = false;
  transactions.forEach(transaction => {
    if (transaction.type === 'deposit') { basis += Math.abs(transaction.amount); hasCapitalFlow = true; }
    if (transaction.type === 'withdrawal') { basis -= Math.abs(transaction.amount); hasCapitalFlow = true; }
    if (isOpeningValuation(transaction)) { basis += Math.abs(transaction.amount); hasCapitalFlow = true; }
  });
  if (!hasCapitalFlow) {
    const valuations = transactions.filter(transaction => transaction.type === 'valuation').sort(compareByDate);
    if (valuations.length > 0) basis = valuations[0].amount || 0;
  }
  return basis;
}

// Profit or loss of a period: the end value minus the start value minus the
// capital added in between, and that result relative to start value + capital.
function periodResult(startValue, endValue, capitalAdded) {
  const profitLoss = endValue - startValue - capitalAdded;
  const base = startValue + capitalAdded;
  return { profitLoss, percent: base !== 0 ? (profitLoss / base) * 100 : 0 };
}

// Splits a value chart's month-end `points` (oldest first) with monthlyReturns():
// per point the money put in so far and the month's change, split into capital
// added and investment gain; `summary` covers the whole range, from the value
// before its first month to its last value.
function valueBreakdown(points, monthlyResults) {
  const noResult = { profitLoss: 0, percent: 0, capitalAdded: 0 };
  const firstMonth = points.length ? points[0].month : '';
  let moneyPutIn = Object.keys(monthlyResults)
    .filter(month => month < firstMonth)
    .reduce((sum, month) => sum + monthlyResults[month].capitalAdded, 0);
  let capitalAdded = 0;
  let gain = 0;
  const months = points.map(point => {
    const result = monthlyResults[point.month] || noResult;
    moneyPutIn += result.capitalAdded;
    capitalAdded += result.capitalAdded;
    gain += result.profitLoss;
    return { moneyPutIn, change: result.capitalAdded + result.profitLoss, capitalAdded: result.capitalAdded, gain: result.profitLoss, percent: result.percent };
  });
  const endValue = points.length ? points[points.length - 1].value : 0;
  const startValue = endValue - capitalAdded - gain;
  return { months, summary: { startValue, endValue, capitalAdded, ...periodResult(startValue, endValue, capitalAdded) } };
}

function createValuationContext({ accounts, transactions, assets, rateEntries, todaysMetalPrices, mainCurrency }) {
  const today = todayIsoDate();
  const accountsById = {};
  accounts.forEach(account => { accountsById[account.id] = account; });
  const accountCurrency = (accountId) => (accountsById[accountId] && accountsById[accountId].currency) || 'CHF';

  // Date order; same-day transactions keep their entry order
  const balanceTransactions = transactions.filter(isBalanceTransaction).sort(compareByDate);
  const balanceTransactionsByAccount = {};
  balanceTransactions.forEach(transaction => {
    if (!balanceTransactionsByAccount[transaction.accountId]) balanceTransactionsByAccount[transaction.accountId] = [];
    balanceTransactionsByAccount[transaction.accountId].push(transaction);
  });
  const transactionsByAccount = {};
  transactions.forEach(transaction => {
    if (!transactionsByAccount[transaction.accountId]) transactionsByAccount[transaction.accountId] = [];
    transactionsByAccount[transaction.accountId].push(transaction);
  });
  const assetsByAccount = {};
  const assetsById = {};
  assets.forEach(asset => {
    if (!assetsByAccount[asset.accountId]) assetsByAccount[asset.accountId] = [];
    assetsByAccount[asset.accountId].push(asset);
    assetsById[asset.id] = asset;
  });

  const rateToMain = (currency, date) => currencyRateTo(rateEntries, currency || 'CHF', mainCurrency, date);
  const toMain = (amount, currency, date) => amount * rateToMain(currency, date);
  // Converts an asset's currency into its account's currency
  const assetRateToAccount = (account) => (assetCurrency, date) => currencyRateTo(rateEntries, assetCurrency || 'CHF', account.currency || 'CHF', date);

  // The account's last balance transaction on or before `date` (strictly before
  // when `before` is set); no date: the last one of all. On a day with several,
  // the one entered last wins.
  function lastBalanceTransaction(accountId, date, before = false) {
    const accountTransactions = balanceTransactionsByAccount[accountId] || [];
    for (let index = accountTransactions.length - 1; index >= 0; index--) {
      const transactionDate = accountTransactions[index].date || '';
      if (!date || (before ? transactionDate < date : transactionDate <= date)) return accountTransactions[index];
    }
    return null;
  }

  // Value of the account in its own currency on `date`; no date: its current value.
  // Asset accounts: their assets on that date. Precious metals: today's spot price
  // when it is about today. Everything else: the recorded balance.
  function accountValue(account, date) {
    const isCurrent = !date || date === today;
    if (isAssetAccount(account)) return assetAccountMetrics(assetsByAccount[account.id], date || today, assetRateToAccount(account)).value;
    if (account.accountType === ACCOUNT_TYPE.preciousMetal && isCurrent) {
      return metalAccountValue(account, todaysMetalPrices, rateEntries, today);
    }
    const last = lastBalanceTransaction(account.id, date);
    if (last) return last.balanceAfter || 0;
    return isCurrent ? account.currentValue || 0 : 0;
  }

  // Cost basis of the account in its own currency; asset accounts: the owned cost of the assets held
  function accountCostBasis(account) {
    if (isAssetAccount(account)) return assetAccountMetrics(assetsByAccount[account.id], today, assetRateToAccount(account)).cost;
    return costBasis(transactionsByAccount[account.id] || []);
  }

  // Value of the account in the main currency, at the exchange rate of `date` (no date: today)
  function accountValueInMain(account, date) {
    return toMain(accountValue(account, date), account.currency, date || today);
  }

  // Net worth and liquid net worth in the main currency on `date` (no date: now).
  // Liquid net worth is the part of net worth flagged "Include in Liquid Net Worth".
  function netWorth(date) {
    let total = 0;
    let liquid = 0;
    accounts.forEach(account => {
      if (account.includeInNetWorth === false) return;
      const value = accountValueInMain(account, date);
      total += value;
      if (account.includeInLiquidNetWorth !== false) liquid += value;
    });
    return { netWorth: total, liquidNetWorth: liquid };
  }

  function isLiquidAccount(account) {
    return account.includeInNetWorth !== false && account.includeInLiquidNetWorth !== false;
  }

  // Balance transactions of the given accounts, in date order
  function balanceTransactionsOf(accountIds) {
    return balanceTransactions.filter(transaction => accountIds.has(transaction.accountId));
  }

  // Replays the balance transactions of `accountIds` in date order and calls
  // visit(transaction, totalBefore, totalAfter). A total is the sum of each
  // account's latest recorded balance, converted at that balance's own date.
  function replayBalances(accountIds, visit) {
    const balances = {};
    accountIds.forEach(id => { balances[id] = 0; });
    const sumOfBalances = () => Object.values(balances).reduce((sum, balance) => sum + balance, 0);
    let total = 0;
    balanceTransactionsOf(accountIds).forEach(transaction => {
      const totalBefore = total;
      balances[transaction.accountId] = toMain(transaction.balanceAfter || 0, accountCurrency(transaction.accountId), transaction.date);
      total = sumOfBalances();
      visit(transaction, totalBefore, total);
    });
    return total;
  }

  // Total recorded balance of `accountIds` after their last transaction of each month
  function monthEndTotals(accountIds) {
    const totals = {};
    replayBalances(accountIds, (transaction, totalBefore, totalAfter) => {
      const month = (transaction.date || '').substring(0, 7);
      if (month) totals[month] = totalAfter;
    });
    return totals;
  }

  // Capital a transaction moves, in the main currency (see capitalFlow()). An asset
  // purchase or sale moves only the owned equity: the owned share of the price,
  // net of the mortgage, in the asset's own currency. The full price would count
  // a 900k flat bought with a 600k mortgage at 50% as 900k put in for 150k of equity.
  function capitalInMain(transaction, flowOptions = {}) {
    const asset = assetsById[transaction.assetId];
    const isAssetEvent = transaction.type === 'asset-add' || transaction.type === 'asset-sell';
    if (isAssetEvent && flowOptions.includeAssetEvents && asset) {
      const ownedEquity = (Math.abs(transaction.amount || 0) - assetMortgage(asset, transaction.date)) * assetOwnershipShare(asset);
      return toMain(transaction.type === 'asset-add' ? ownedEquity : -ownedEquity, asset.currency, transaction.date);
    }
    return toMain(capitalFlow(transaction, flowOptions), accountCurrency(transaction.accountId), transaction.date);
  }

  // Investment result per month of `accountIds`: { 'YYYY-MM': { profitLoss, percent, capitalAdded } }, see periodResult()
  function monthlyReturns(accountIds, flowOptions) {
    const results = {};
    let month = null;
    let startTotal = 0;
    let capitalAdded = 0;
    const finalTotal = replayBalances(accountIds, (transaction, totalBefore) => {
      const transactionMonth = (transaction.date || '').substring(0, 7);
      if (!transactionMonth) return;
      if (transactionMonth !== month) {
        if (month !== null) results[month] = { ...periodResult(startTotal, totalBefore, capitalAdded), capitalAdded };
        month = transactionMonth;
        startTotal = totalBefore;
        capitalAdded = 0;
      }
      capitalAdded += capitalInMain(transaction, flowOptions);
    });
    if (month !== null) results[month] = { ...periodResult(startTotal, finalTotal, capitalAdded), capitalAdded };
    return results;
  }

  // Month-end value of `accountIds` in the main currency for every month from
  // their first balance transaction to this month (this month: the current value), and each
  // month's result: { totals: { 'YYYY-MM': value }, results: { 'YYYY-MM': { profitLoss, percent, capitalAdded } } }.
  // Asset accounts are valued from their assets (owned share, net of the
  // mortgage), so a new property valuation shows as gain and a mortgage
  // repayment as capital put in, as in assetOwnedCost().
  function monthlyValues(accountIds) {
    const transactions = balanceTransactionsOf(accountIds).filter(transaction => transaction.date);
    if (transactions.length === 0) return { totals: {}, results: {} };
    const assetAccounts = [...accountIds].map(id => accountsById[id]).filter(account => account && isAssetAccount(account));
    const otherAccountIds = new Set([...accountIds].filter(id => !assetAccounts.some(account => account.id === id)));
    // No date: the current value, exactly as netWorth() counts it
    const valueOn = date => (date
      ? recordedTotal(otherAccountIds, date) + assetAccounts.reduce((sum, account) => sum + accountValueInMain(account, date), 0)
      : [...accountIds].reduce((sum, id) => sum + (accountsById[id] ? accountValueInMain(accountsById[id]) : 0), 0));

    const capitalByMonth = {};
    const addCapital = (date, amount) => { capitalByMonth[date.substring(0, 7)] = (capitalByMonth[date.substring(0, 7)] || 0) + amount; };
    transactions.forEach(transaction => addCapital(transaction.date, capitalInMain(transaction, { includeAssetEvents: true })));
    // Mortgage repayments while the property is held; the purchase and the sale
    // already count the mortgage owed on their own date
    assetAccounts.forEach(account => (assetsByAccount[account.id] || []).filter(isRealEstateAsset).forEach(asset => {
      let owed = parseFloat(asset.debt) || 0;
      (asset.mortgageBalances || []).filter(entry => entry && entry.date).sort(compareByDate).forEach(entry => {
        const amount = parseFloat(entry.amount) || 0;
        const isHeld = (!asset.purchaseDate || entry.date > asset.purchaseDate) && !isAssetSoldOn(asset, entry.date);
        if (isHeld) addCapital(entry.date, toMain((owed - amount) * assetOwnershipShare(asset), asset.currency, entry.date));
        owed = amount;
      });
    }));

    const totals = {};
    const results = {};
    const currentMonth = today.substring(0, 7);
    let previousValue = 0;
    for (let month = transactions[0].date.substring(0, 7); month <= currentMonth;) {
      const [year, monthNumber] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const value = valueOn(month === currentMonth ? null : month + '-' + String(lastDay).padStart(2, '0'));
      const capitalAdded = capitalByMonth[month] || 0;
      totals[month] = value;
      results[month] = { ...periodResult(previousValue, value, capitalAdded), capitalAdded };
      previousValue = value;
      month = new Date(Date.UTC(year, monthNumber, 1)).toISOString().substring(0, 7);
    }
    return { totals, results };
  }

  // Investment result of `accountIds` from `cutoffDate` until now, see periodResult()
  function performanceSince(accountIds, cutoffDate, currentTotal) {
    let totalAtCutoff = 0;
    let capitalAdded = 0;
    replayBalances(accountIds, (transaction, totalBefore, totalAfter) => {
      if (transaction.date < cutoffDate) totalAtCutoff = totalAfter;
      else capitalAdded += capitalInMain(transaction);
    });
    return periodResult(totalAtCutoff, currentTotal, capitalAdded);
  }

  // Sum of the recorded balances of `accountIds` on `date` (strictly before it
  // when `before` is set), each converted at its own date. An account without
  // any transaction yet counts its stored value when the date is today.
  function recordedTotal(accountIds, date, before = false) {
    let total = 0;
    accountIds.forEach(id => {
      const last = lastBalanceTransaction(id, date, before);
      if (last) total += toMain(last.balanceAfter || 0, accountCurrency(id), last.date);
      else if (!before && date === today && accountsById[id]) total += toMain(accountsById[id].currentValue || 0, accountCurrency(id), date);
    });
    return total;
  }

  // Capital added to `accountIds` between two dates (both included), in the main currency
  function capitalAddedBetween(accountIds, startDate, endDate) {
    return balanceTransactionsOf(accountIds)
      .filter(transaction => (transaction.date || '') >= startDate && (transaction.date || '') <= endDate)
      .reduce((sum, transaction) => sum + capitalInMain(transaction), 0);
  }

  return {
    today,
    mainCurrency,
    accounts,
    transactions,
    balanceTransactions,
    assets,
    assetsByAccount,
    rateEntries,
    todaysMetalPrices,
    rateToMain,
    toMain,
    accountCurrency,
    transactionsOf: (accountId) => transactionsByAccount[accountId] || [],
    assetRateToAccount,
    accountValue,
    accountCostBasis,
    accountValueInMain,
    capitalInMain,
    netWorth,
    isLiquidAccount,
    balanceTransactionsOf,
    replayBalances,
    monthEndTotals,
    monthlyReturns,
    monthlyValues,
    performanceSince,
    recordedTotal,
    capitalAddedBetween,
  };
}

// Builds the valuation context from the stored data (one call per page render)
async function loadValuationContext() {
  const settings = await DB.getSettings();
  return createValuationContext({
    accounts: await DB.getAll('accounts'),
    transactions: await DB.getAll('transactions'),
    assets: await DB.getAll('assets'),
    rateEntries: await DB.getAll('exchangeRates'),
    todaysMetalPrices: await DB.getMetalPricesForDate(todayIsoDate()),
    mainCurrency: settings.mainCurrency || 'CHF',
  });
}

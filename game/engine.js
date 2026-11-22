/* ===== Vaulty: rules engine =====
 *
 * Pure game rules, no DOM and no storage, so they can be tested in plain node.
 * Everything is in CHF. A game is its player (name, city, difficulty), its
 * starting cash, its start date and the list of trades; cash, holdings,
 * salary, expenses, taxes and the daily net worth are always replayed from
 * that list against the market prices.
 *
 * The market passed in is { quote(symbol, date) -> { priceChf, date } | null,
 * benchmark(date) -> number | null, tangible(symbol) -> item | null,
 * dividend(symbol, date) -> CHF per unit | null, benchmarkDividendYield }:
 * quote gives the last price on or before the date, converted to CHF.
 * dividend (optional) is the cash dividend per unit whose ex-dividend day is
 * exactly that date. benchmarkDividendYield (optional, default 0) is the
 * yearly dividend yield of the benchmark, whose price index pays none.
 * tangible (optional) describes a car, watch, artwork or house:
 * { depreciation, kind, location }. depreciation is how much a unit you own
 * loses per year on top of the market price, e.g. -0.15 for a new car; kind
 * is the car type ('electric', 'classic', ...); location is a house's city.
 *
 * Life in the game (single person, no church tax):
 *   - The player's city sets a gross salary (scaled by difficulty), the
 *     income tax, rent, health insurance and living costs.
 *   - Salary and expenses build up day by day and are paid on the last day of
 *     each month, so a month is pro rata for the days something was owned.
 *   - Without a house the player pays rent. Cars and houses add running
 *     costs; the more expensive they are, the more they cost each month.
 *   - Houses can be bought with a mortgage (at least 20% down). Interest is
 *     an expense; the part above two thirds of the price is paid back
 *     (amortized) within 15 years. A new mortgage must pass the banks'
 *     affordability check.
 *   - A Lombard loan (trades with side 'borrow' or 'repay') lends cash against
 *     stocks, ETFs and metals, up to a share of their value. Its interest is
 *     paid at the end of each month. A loan above that lending value is paid
 *     down by the cash first, then by selling holdings (a margin call).
 *   - Stocks and ETFs can be shorted (trades with short: true, a 'sell' to
 *     open, a 'buy' to buy back). The sale amount and half of it again from
 *     the cash are held as collateral; a borrow fee is paid monthly on the
 *     value shorted, and every dividend goes to the lender. Once the units
 *     are worth more than the collateral allows, they are bought back.
 *   - Options on stocks and ETFs (trades with an `option`): calls and puts,
 *     bought, or written when covered (a call by units held, a put by cash).
 *     They are priced with Black-Scholes and end the day after their expiry
 *     at its close: a bought one pays out in cash, a written one in the money
 *     is assigned, delivering or buying the units at the strike. Options pay
 *     no stamp duty; their premiums count as trading volume.
 * Swiss rules modelled for a private investor:
 *   - Capital gains on movable assets are tax free.
 *   - Dividends are income: each one is paid in cash to the units held at the
 *     end of the day before its ex-dividend day, and the income tax it adds on
 *     top of the salary and the year's earlier dividends is taken at once.
 *     While reinvesting (game.reinvestPeriods), what is left after the tax
 *     buys more of the same at that day's price.
 *   - Securities transfer stamp duty on every stock and ETF trade:
 *     0.075% for Swiss securities, 0.15% for foreign ones. Crypto and
 *     physical precious metals pay none.
 *   - Wealth tax on the net worth held on 31 December, with the player's
 *     city tariff, pro rata for the days of that year the game was running.
 *   - Professional trader check (federal safe harbour rules): selling
 *     securities within six months of buying, or a yearly securities volume
 *     above five times the wealth at the start of the year, puts the tax free
 *     status at risk. Cars, watches, art and houses do not count.
 *   - Property gains tax when a house is sold at a profit, and the purchase
 *     costs (transfer tax, notary, land registry) when one is bought.
 * Cars, watches, art and houses are bought in whole units and sold through a
 * dealer, auction house or estate agent, who keeps a share of the sale price.
 * Day trades (trade.intraday) are bought and sold at the simulated prices of
 * game/intraday.js and live apart from the holdings: they pay stamp duty and
 * count for the professional trader check, but get no dividends. A short day
 * trade (trade.short) is sold first and bought back later, so it gains when
 * the price falls; it holds its sale amount as cash, like a buy, and loses
 * more than that if the price more than doubles. A day trade
 * still open when its market closes (trade.closesAt) is reverted: it never
 * happened, so no cash moves and no fees are paid. Until it is closed or
 * reverted, its cash is held and it counts in the net worth at what it cost.
 * Orders (game.orders) wait for a price: a limit buys at or below its level
 * and sells at or above it, a stop-loss sells at or below it. A regular order
 * fills at the first newer daily close that reaches its level and stays open
 * until then; a day order fills at the first simulated price that reaches it
 * and ends at its market's close. The page turns a reached order into a
 * normal trade (trade.orderType), so the replay never sees orders. Their cash
 * is not held: a buy that cannot be paid when it fills is dropped.
 * Not modelled: interest on cash, the withholding taxes on dividends (Swiss
 * 35% refunded, foreign ones credited: the net effect is the income tax
 * above), the pension fund savings in the social contributions, imputed
 * rental value, and the lower tax value of property.
 */

const GameEngine = (() => {
  const DIFFICULTIES = {
    easy: {
      label: 'EASY', startCash: 1000000, salaryFactor: 1.4,
      story: 'Your parents are rich and you got an early inheritance. A good school and their contacts landed you a well paid job.',
    },
    medium: {
      label: 'MEDIUM', startCash: 100000, salaryFactor: 1,
      story: 'Your parents had steady office jobs and helped you through your studies. You saved a little and earn an average salary.',
    },
    hard: {
      label: 'HARD', startCash: 10000, salaryFactor: 0.75,
      story: "Your parents didn't have office jobs. You landed a job, but the pay is not perfect.",
    },
  };

  // Gross salary points for the effective income tax rates below.
  const INCOME_TAX_POINTS = [50000, 75000, 100000, 150000, 250000];

  // shortcut: rough 2026 figures for the capital of each canton (single person, no church tax), refresh them by hand
  // when they drift. salaryChf: average gross yearly salary. incomeTaxRates: effective federal + cantonal + communal
  // income tax on the gross salary at INCOME_TAX_POINTS. rentChf: a 3.5 room flat. healthInsuranceChf: basic health
  // insurance per month. livingIndex: scales the living costs. carTaxChf: road tax a year for a CHF 40,000 car.
  // Wealth tax: the next `width` CHF of wealth is taxed at `rate`, times the multiplier (Zürich keeps its simple tax
  // times the canton and city multipliers; the other cities are already total rates).
  const LOCATIONS = {
    zurich: {
      label: 'ZÜRICH', salaryChf: 95000, rentChf: 2500, healthInsuranceChf: 470, livingIndex: 1, parkingChf: 200, carTaxChf: 420,
      incomeTaxRates: [0.055, 0.085, 0.11, 0.15, 0.2],
      wealthTax: {
        multiplier: 2.14,
        bands: [
          { width: 80000, rate: 0 }, { width: 238000, rate: 0.0005 }, { width: 399000, rate: 0.001 }, { width: 637000, rate: 0.0015 },
          { width: 956000, rate: 0.002 }, { width: 1274000, rate: 0.0025 }, { width: Infinity, rate: 0.003 },
        ],
      },
    },
    bern: {
      label: 'BERN', salaryChf: 86000, rentChf: 1700, healthInsuranceChf: 500, livingIndex: 0.93, parkingChf: 140, carTaxChf: 380,
      incomeTaxRates: [0.085, 0.12, 0.145, 0.185, 0.23],
      wealthTax: {
        multiplier: 1,
        bands: [{ width: 100000, rate: 0 }, { width: 200000, rate: 0.0025 }, { width: 700000, rate: 0.0045 }, { width: 1000000, rate: 0.0055 }, { width: Infinity, rate: 0.0057 }],
      },
    },
    basel: {
      label: 'BASEL', salaryChf: 92000, rentChf: 1800, healthInsuranceChf: 590, livingIndex: 0.95, parkingChf: 150, carTaxChf: 480,
      incomeTaxRates: [0.08, 0.115, 0.14, 0.18, 0.23],
      wealthTax: {
        multiplier: 1,
        bands: [{ width: 100000, rate: 0 }, { width: 200000, rate: 0.0045 }, { width: 700000, rate: 0.006 }, { width: 1000000, rate: 0.0075 }, { width: Infinity, rate: 0.0079 }],
      },
    },
    zug: {
      label: 'ZUG', salaryChf: 100000, rentChf: 2600, healthInsuranceChf: 380, livingIndex: 1.02, parkingChf: 180, carTaxChf: 260,
      incomeTaxRates: [0.035, 0.055, 0.075, 0.105, 0.14],
      wealthTax: {
        multiplier: 1,
        bands: [{ width: 100000, rate: 0 }, { width: 200000, rate: 0.0005 }, { width: 700000, rate: 0.0009 }, { width: 1000000, rate: 0.0015 }, { width: Infinity, rate: 0.0017 }],
      },
    },
    geneva: {
      label: 'GENEVA', salaryChf: 100000, rentChf: 2400, healthInsuranceChf: 610, livingIndex: 1.05, parkingChf: 200, carTaxChf: 520,
      incomeTaxRates: [0.06, 0.1, 0.135, 0.185, 0.24],
      wealthTax: {
        multiplier: 1,
        bands: [{ width: 87000, rate: 0 }, { width: 213000, rate: 0.0035 }, { width: 700000, rate: 0.007 }, { width: 1000000, rate: 0.009 }, { width: Infinity, rate: 0.01 }],
      },
    },
  };

  // AHV/IV/EO 5.3%, unemployment 1.1%, pension fund and accident insurance on top.
  const SOCIAL_CONTRIBUTION_RATE = 0.125;
  // Monthly, before the city's livingIndex.
  const LIVING_COSTS = [
    { label: 'GROCERIES', amountChf: 650 },
    { label: 'RESTAURANTS & LEISURE', amountChf: 400 },
    { label: 'CLOTHING', amountChf: 100 },
    { label: 'PHONE & INTERNET', amountChf: 90 },
    { label: 'HOUSEHOLD & LIABILITY INSURANCE', amountChf: 35 },
  ];
  const RENTER_ENERGY_CHF = 110;
  const PUBLIC_TRANSPORT_CHF = 90;
  // The yearly radio and TV fee, CHF 335, per month.
  const SERAFE_FEE_CHF = 335 / 12;

  // Kilometres driven a year, shared between the cars you own.
  const CAR_KM_PER_YEAR = 12000;
  // Share of an owned car's yearly value loss that comes from the kilometres
  // driven; the rest comes from age. Two cars each drive half as much.
  const CAR_MILEAGE_SHARE = 0.5;
  const CAR_MIN_INSURANCE_CHF = 800;

  // shortcut: rough buyer costs per house city, refresh them by hand when they drift. transferTaxRate: property
  // transfer tax paid by the buyer; notaryRate: notary, land registry and mortgage note fees; propertyTaxRate: yearly
  // property tax on the purchase price.
  const HOUSE_LOCATIONS = {
    zurich: { label: 'ZÜRICH', transferTaxRate: 0, notaryRate: 0.0025, propertyTaxRate: 0 },
    geneva: { label: 'GENEVA', transferTaxRate: 0.03, notaryRate: 0.01, propertyTaxRate: 0.001 },
    lausanne: { label: 'LAUSANNE', transferTaxRate: 0.033, notaryRate: 0.006, propertyTaxRate: 0.0015 },
    bern: { label: 'BERN', transferTaxRate: 0.018, notaryRate: 0.005, propertyTaxRate: 0.0012 },
    basel: { label: 'BASEL', transferTaxRate: 0.015, notaryRate: 0.004, propertyTaxRate: 0 },
  };
  // Upkeep a year, on the purchase price, plus energy, water and building insurance a month.
  const HOUSE_MAINTENANCE_RATE = 0.008;
  const HOUSE_UTILITIES_CHF = 250;

  const MORTGAGE_INTEREST_RATE = 0.018;
  const MIN_DOWN_PAYMENT = 0.2;
  const FIRST_MORTGAGE_SHARE = 2 / 3;
  const AMORTIZATION_MONTHS = 15 * 12;
  // Banks' affordability check: 5% imputed interest, 1% upkeep and the
  // amortization must stay under a third of the gross salary.
  const AFFORDABILITY_INTEREST_RATE = 0.05;
  const AFFORDABILITY_UPKEEP_RATE = 0.01;
  const AFFORDABILITY_INCOME_SHARE = 1 / 3;

  // Only the part of a lot's mortgage above two thirds of its price is paid back.
  function mortgageAboveFirstShareChf(lot) {
    return Math.max(0, (lot.mortgageChf || 0) - lot.quantity * lot.priceChf * FIRST_MORTGAGE_SHARE);
  }

  function monthlyPaybackChf(lot) {
    return Math.min(mortgageAboveFirstShareChf(lot), lot.amortizationChf || 0);
  }

  const STAMP_DUTY_DOMESTIC = 0.00075;
  const STAMP_DUTY_FOREIGN = 0.0015;
  // Share of the sale price a dealer (cars, watches), auction house (art) or estate agent (houses) keeps.
  const DEALER_FEE_RATES = { car: 0.10, watch: 0.15, art: 0.25, house: 0.03 };

  // shortcut: the Zurich property gains tax for every house city, upgrade to a per canton table when it matters.
  // Progressive bands on the gain, then a surcharge for quick resales or a discount for long holdings.
  const PROPERTY_GAINS_TAX_BANDS = [
    { width: 4000, rate: 0.10 },
    { width: 6000, rate: 0.15 },
    { width: 8000, rate: 0.20 },
    { width: 12000, rate: 0.25 },
    { width: 20000, rate: 0.30 },
    { width: 50000, rate: 0.35 },
    { width: Infinity, rate: 0.40 },
  ];

  // shortcut: one Lombard rate and flat loan-to-value ratios per asset class, roughly what Swiss private banks lend;
  // refresh them by hand when they drift.
  const LOMBARD_INTEREST_RATE = 0.03;
  const LOMBARD_LOAN_TO_VALUE = { stock: 0.5, etf: 0.6, metal: 0.5 };

  // Short sales of stocks and ETFs: the bank keeps the sale amount plus half of it again from the cash as collateral,
  // and buys the units back once that collateral falls under 125% of their value, after a rise of 20%.
  // shortcut: one flat borrow fee for every stock; real fees run from about 0.25% to far more for hard to borrow names.
  const SHORT_COLLATERAL = 1.5;
  const SHORT_MAINTENANCE = 1.25;
  const SHORT_BORROW_FEE_RATE = 0.01;

  // Options on stocks and ETFs: monthly expiries (third Friday) for the next three months, strikes from 80% to 120% of
  // the price, priced with Black-Scholes from the stock's volatility (market.volatility, yearly) at the time of the trade.
  // shortcut: no bid-ask spread, no interest rate (CHF rates are near zero) and no dividends in the price; add them when they matter.
  const OPTION_EXPIRY_COUNT = 3;
  const OPTION_STRIKE_STEPS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];
  const DEFAULT_VOLATILITY = 0.25;

  const SHORT_HOLDING_DAYS = 183;
  const MAX_VOLUME_MULTIPLE = 5;
  // A trade needs a price no older than this, so delisted or stale assets cannot be traded.
  const MAX_QUOTE_AGE_DAYS = 10;
  const EMPTY_QUANTITY = 1e-9;

  function addDays(dateText, days) {
    const date = new Date(dateText + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().split('T')[0];
  }

  function daysBetween(fromDate, toDate) {
    return Math.round((Date.parse(toDate + 'T00:00:00Z') - Date.parse(fromDate + 'T00:00:00Z')) / 86400000);
  }

  function daysInYear(year) {
    return daysBetween(year + '-01-01', (year + 1) + '-01-01');
  }

  function daysInMonth(dateText) {
    const year = Number(dateText.slice(0, 4));
    const month = Number(dateText.slice(5, 7));
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function isMonthEnd(dateText) {
    return Number(dateText.slice(8, 10)) === daysInMonth(dateText);
  }

  // options: { name, location, difficulty, startDate }
  function newGame(options) {
    const level = DIFFICULTIES[options.difficulty];
    if (!level) throw new Error('Unknown difficulty: ' + options.difficulty);
    if (!LOCATIONS[options.location]) throw new Error('Unknown location: ' + options.location);
    const name = String(options.name || '').trim().slice(0, 40) || 'PLAYER';
    return {
      version: 2, name: name, location: options.location, difficulty: options.difficulty,
      startCash: level.startCash, startDate: options.startDate, trades: [], orders: [],
    };
  }

  // Gross yearly salary for a city and difficulty, rounded to CHF 1,000.
  function yearlySalary(location, difficulty) {
    return Math.round(LOCATIONS[location].salaryChf * DIFFICULTIES[difficulty].salaryFactor / 1000) * 1000;
  }

  // Yearly income tax on a gross salary: the city's effective rate between the
  // points, falling to zero below the first one and flat above the last one.
  function incomeTax(location, grossChf) {
    const rates = LOCATIONS[location].incomeTaxRates;
    const points = INCOME_TAX_POINTS;
    let rate = rates[rates.length - 1];
    if (grossChf <= points[0]) rate = rates[0] * Math.max(0, grossChf) / points[0];
    else {
      for (let index = 1; index < points.length; index++) {
        if (grossChf <= points[index]) {
          const progress = (grossChf - points[index - 1]) / (points[index] - points[index - 1]);
          rate = rates[index - 1] + (rates[index] - rates[index - 1]) * progress;
          break;
        }
      }
    }
    return grossChf * rate;
  }

  function tangibleInfo(market, symbol) {
    return (market.tangible && market.tangible(symbol)) || {};
  }

  // Cars, watches, art and houses: whole units, dealer fee on sale, outside the trader rules.
  function isTangible(assetClass) {
    return DEALER_FEE_RATES[assetClass] != null;
  }

  function stampDutyRate(asset) {
    if (asset.class !== 'stock' && asset.class !== 'etf') return 0;
    return String(asset.symbol).toUpperCase().endsWith('.SW') ? STAMP_DUTY_DOMESTIC : STAMP_DUTY_FOREIGN;
  }

  function dealerFeeRate(assetClass) {
    return DEALER_FEE_RATES[assetClass] || 0;
  }

  function housePurchaseCostRate(houseLocation) {
    const rates = HOUSE_LOCATIONS[houseLocation] || HOUSE_LOCATIONS.zurich;
    return rates.transferTaxRate + rates.notaryRate;
  }

  function wealthTax(wealth, location) {
    const tariff = LOCATIONS[location].wealthTax;
    let remaining = Math.max(0, wealth);
    let simpleTax = 0;
    for (const band of tariff.bands) {
      const taxed = Math.min(remaining, band.width);
      simpleTax += taxed * band.rate;
      remaining -= taxed;
      if (remaining <= 0) break;
    }
    return simpleTax * tariff.multiplier;
  }

  // Tax on the gain from selling a property held `heldDays`: +50% under one
  // year, +25% under two, then from five full years 5% off plus 3% per extra
  // year, up to 50% off at twenty years.
  function propertyGainsTax(gainChf, heldDays) {
    let remaining = Math.max(0, gainChf);
    let tax = 0;
    for (const band of PROPERTY_GAINS_TAX_BANDS) {
      const taxed = Math.min(remaining, band.width);
      tax += taxed * band.rate;
      remaining -= taxed;
      if (remaining <= 0) break;
    }
    const heldYears = Math.floor(heldDays / 365.25);
    if (heldYears < 1) return tax * 1.5;
    if (heldYears < 2) return tax * 1.25;
    if (heldYears < 5) return tax;
    return tax * (1 - Math.min(0.5, 0.05 + 0.03 * (heldYears - 5)));
  }

  // Yearly change of an owned unit on top of the market price. A car's loss
  // is half age, half kilometres, and the kilometres are shared between cars.
  function ownedYearlyChange(market, symbol, assetClass, carUnits) {
    const rate = tangibleInfo(market, symbol).depreciation || 0;
    if (assetClass !== 'car' || !(carUnits > 1)) return rate;
    return rate * (1 - CAR_MILEAGE_SHARE + CAR_MILEAGE_SHARE / carUnits);
  }

  // Monthly running costs of one car bought for `priceChf`, while `carUnits` cars share the kilometres.
  function carMonthlyCosts(location, item, priceChf, carUnits) {
    const kind = (item && item.kind) || '';
    const kmPerYear = CAR_KM_PER_YEAR / Math.max(1, carUnits);
    const insuranceChf = Math.max(CAR_MIN_INSURANCE_CHF, priceChf * (kind === 'classic' ? 0.01 : 0.025)) / 12;
    const roadTaxChf = LOCATIONS[location].carTaxChf * Math.sqrt(priceChf / 40000) * (kind === 'electric' ? 0.5 : 1) / 12;
    const parkingChf = LOCATIONS[location].parkingChf;
    const costPerKmChf = (0.10 + priceChf * 0.000002) * (kind === 'electric' ? 0.6 : 1);
    const fuelAndServiceChf = kmPerYear * costPerKmChf / 12;
    return {
      kmPerYear: kmPerYear, insuranceChf: insuranceChf, roadTaxChf: roadTaxChf, parkingChf: parkingChf, fuelAndServiceChf: fuelAndServiceChf,
      totalChf: insuranceChf + roadTaxChf + parkingChf + fuelAndServiceChf,
    };
  }

  // Monthly running costs of one house bought for `priceChf`, without the mortgage.
  function houseMonthlyCosts(houseLocation, priceChf) {
    const rates = HOUSE_LOCATIONS[houseLocation] || HOUSE_LOCATIONS.zurich;
    const maintenanceChf = priceChf * HOUSE_MAINTENANCE_RATE / 12;
    const propertyTaxChf = priceChf * rates.propertyTaxRate / 12;
    return {
      maintenanceChf: maintenanceChf, utilitiesChf: HOUSE_UTILITIES_CHF, propertyTaxChf: propertyTaxChf,
      totalChf: maintenanceChf + HOUSE_UTILITIES_CHF + propertyTaxChf,
    };
  }

  function unitsOf(positions, assetClass) {
    return positions.filter((position) => position.class === assetClass).reduce((sum, position) => sum + position.quantity, 0);
  }

  // A full month of salary and expenses with these holdings. Amortization is
  // listed apart: it pays back debt, so it is not an expense.
  function monthlyBudget(game, market, positions) {
    const location = LOCATIONS[game.location];
    const grossChf = yearlySalary(game.location, game.difficulty);
    const income = [
      { label: 'GROSS SALARY', amountChf: grossChf / 12 },
      { label: 'SOCIAL CONTRIBUTIONS (AHV, PENSION, UNEMPLOYMENT)', amountChf: -grossChf * SOCIAL_CONTRIBUTION_RATE / 12 },
      { label: 'INCOME TAX (' + location.label + ')', amountChf: -incomeTax(game.location, grossChf) / 12 },
    ];
    const carUnits = unitsOf(positions, 'car');
    const houseUnits = unitsOf(positions, 'house');
    const expenses = [];
    let amortizationChf = 0;
    if (!houseUnits) expenses.push({ label: 'RENT (3.5 ROOM FLAT, ' + location.label + ')', amountChf: location.rentChf });
    positions.filter((position) => position.class === 'house').forEach((position) => {
      const houseLocation = tangibleInfo(market, position.symbol).location;
      let runningChf = 0;
      let interestChf = 0;
      position.lots.forEach((lot) => {
        runningChf += lot.quantity * houseMonthlyCosts(houseLocation, lot.priceChf).totalChf;
        interestChf += (lot.mortgageChf || 0) * MORTGAGE_INTEREST_RATE / 12;
        amortizationChf += monthlyPaybackChf(lot);
      });
      expenses.push({ label: 'HOUSE: ' + position.name, amountChf: runningChf, note: 'UPKEEP, ENERGY, INSURANCE, PROPERTY TAX' });
      if (interestChf > 0) expenses.push({ label: 'MORTGAGE INTEREST: ' + position.name, amountChf: interestChf, note: (MORTGAGE_INTEREST_RATE * 100).toFixed(1) + '% A YEAR' });
    });
    positions.filter((position) => position.class === 'car').forEach((position) => {
      const item = tangibleInfo(market, position.symbol);
      const totalChf = position.lots.reduce((sum, lot) => sum + lot.quantity * carMonthlyCosts(game.location, item, lot.priceChf, carUnits).totalChf, 0);
      expenses.push({
        label: 'CAR: ' + position.name + (position.quantity > 1 ? ' (' + position.quantity + 'x)' : ''), amountChf: totalChf,
        note: 'INSURANCE, ROAD TAX, PARKING, FUEL & SERVICE, ' + Math.round(CAR_KM_PER_YEAR / carUnits).toLocaleString('en-GB') + ' KM A YEAR EACH',
      });
    });
    expenses.push({ label: 'HEALTH INSURANCE', amountChf: location.healthInsuranceChf });
    LIVING_COSTS.forEach((cost) => expenses.push({ label: cost.label, amountChf: cost.amountChf * location.livingIndex }));
    if (!houseUnits) expenses.push({ label: 'ELECTRICITY & HEATING', amountChf: RENTER_ENERGY_CHF * location.livingIndex });
    if (!carUnits) expenses.push({ label: 'PUBLIC TRANSPORT PASS', amountChf: PUBLIC_TRANSPORT_CHF * location.livingIndex });
    expenses.push({ label: 'RADIO & TV FEE (SERAFE)', amountChf: SERAFE_FEE_CHF });

    const netSalaryChf = income.reduce((sum, line) => sum + line.amountChf, 0);
    const expensesChf = expenses.reduce((sum, line) => sum + line.amountChf, 0);
    return {
      grossSalaryChf: grossChf / 12, income: income, netSalaryChf: netSalaryChf, expenses: expenses, expensesChf: expensesChf,
      amortizationChf: amortizationChf, savingsChf: netSalaryChf - expensesChf,
    };
  }

  function positionValue(market, position, date) {
    const quote = market.quote(position.symbol, date);
    const priceChf = quote ? quote.priceChf : position.lastPriceChf;
    return position.lots.reduce((sum, lot) => sum + lot.quantity * priceChf * lot.wearFactor, 0);
  }

  // One day of value loss for every owned car, watch, artwork and house.
  function applyWear(positions, market) {
    const list = Object.keys(positions).map((symbol) => positions[symbol]);
    const carUnits = unitsOf(list, 'car');
    list.forEach((position) => {
      const rate = ownedYearlyChange(market, position.symbol, position.class, carUnits);
      if (!rate) return;
      const factor = Math.pow(1 + rate, 1 / 365.25);
      position.lots.forEach((lot) => { lot.wearFactor *= factor; });
    });
  }

  // Applies a trade's units to the positions map. Sales go first in, first out;
  // returns the mortgage paid back and how many lots were held under six months.
  function applyTrade(positions, trade) {
    const position = positions[trade.symbol] || (positions[trade.symbol] = {
      symbol: trade.symbol, class: trade.class, name: trade.name, quantity: 0, costChf: 0, lots: [], lastPriceChf: trade.priceChf,
    });
    position.lastPriceChf = trade.priceChf;
    if (trade.side === 'buy') {
      position.quantity += trade.quantity;
      position.costChf += trade.amountChf + trade.stampDutyChf + (trade.purchaseCostsChf || 0);
      position.lots.push({
        date: trade.date, quantity: trade.quantity, priceChf: trade.priceChf, wearFactor: 1,
        mortgageChf: trade.mortgageChf || 0, amortizationChf: trade.amortizationChf || 0, amortizationDueChf: 0,
      });
      return { mortgageRepaidChf: 0, shortSales: 0 };
    }
    let mortgageRepaidChf = 0;
    let shortSales = 0;
    const soldShare = Math.min(1, trade.quantity / position.quantity);
    position.costChf -= position.costChf * soldShare;
    position.quantity -= trade.quantity;
    let toSell = trade.quantity;
    while (toSell > EMPTY_QUANTITY && position.lots.length) {
      const lot = position.lots[0];
      if (daysBetween(lot.date, trade.date) < SHORT_HOLDING_DAYS) shortSales++;
      const used = Math.min(lot.quantity, toSell);
      const mortgageShare = lot.mortgageChf * used / lot.quantity;
      mortgageRepaidChf += mortgageShare;
      lot.mortgageChf -= mortgageShare;
      lot.amortizationChf -= (lot.amortizationChf || 0) * used / lot.quantity;
      lot.quantity -= used;
      toSell -= used;
      if (lot.quantity <= EMPTY_QUANTITY) position.lots.shift();
    }
    if (position.quantity <= EMPTY_QUANTITY) delete positions[trade.symbol];
    return { mortgageRepaidChf: mortgageRepaidChf, shortSales: shortSales };
  }

  // The standard normal distribution, from the Abramowitz-Stegun approximation of erf (error under 1.5e-7).
  function normalCdf(value) {
    const t = 1 / (1 + 0.3275911 * Math.abs(value) / Math.SQRT2);
    const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-value * value / 2);
    return value >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }

  // The Black-Scholes price of one unit of a European call or put, without interest or dividends. At or after expiry
  // (`years` <= 0) it is what exercising pays.
  function optionPrice(kind, spotChf, strikeChf, years, volatility) {
    const intrinsicChf = kind === 'call' ? Math.max(0, spotChf - strikeChf) : Math.max(0, strikeChf - spotChf);
    if (!(years > 0) || !(volatility > 0)) return intrinsicChf;
    const spread = volatility * Math.sqrt(years);
    const upper = (Math.log(spotChf / strikeChf) + spread * spread / 2) / spread;
    const lower = upper - spread;
    return kind === 'call' ? spotChf * normalCdf(upper) - strikeChf * normalCdf(lower) : strikeChf * normalCdf(-lower) - spotChf * normalCdf(-upper);
  }

  function optionYears(date, expiry) {
    return daysBetween(date, expiry) / 365;
  }

  // The third Friday of a month, monthIndex 0 for January (later ones roll into the next years).
  function thirdFriday(year, monthIndex) {
    const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    return new Date(Date.UTC(year, monthIndex, 1 + (5 - firstWeekday + 7) % 7 + 14)).toISOString().slice(0, 10);
  }

  // What can be traded on a stock or ETF on `date`: the next expiries at least a week away, strikes around the last close
  // rounded to a power of ten under 5% of it, and the volatility options are priced with. { error } without a recent price.
  function optionChain(market, asset, date) {
    const quote = tradeQuote(market, asset.symbol, date);
    if (quote.error) return quote;
    const year = Number(date.slice(0, 4));
    const monthIndex = Number(date.slice(5, 7)) - 1;
    const expiries = [0, 1, 2, 3, 4].map((offset) => thirdFriday(year, monthIndex + offset)).filter((expiry) => daysBetween(date, expiry) >= 7)
      .slice(0, OPTION_EXPIRY_COUNT);
    const tick = Math.pow(10, Math.floor(Math.log10(quote.priceChf * 0.05)));
    const strikes = [...new Set(OPTION_STRIKE_STEPS.map((step) => Number((Math.round(quote.priceChf * step / tick) * tick).toFixed(10))))];
    const volatility = market.volatility ? market.volatility(asset.symbol, date) : DEFAULT_VOLATILITY;
    return { priceChf: quote.priceChf, expiries: expiries, strikes: strikes, volatility: volatility };
  }

  // Whether dividends paid on `date` are reinvested: game.reinvestPeriods holds { from, to (excluded, none while on) }.
  function reinvestsOn(game, date) {
    return (game.reinvestPeriods || []).some((period) => period.from <= date && (!period.to || date < period.to));
  }

  function copyPositions(list) {
    const positions = {};
    list.forEach((position) => {
      positions[position.symbol] = Object.assign({}, position, { lots: position.lots.map((lot) => Object.assign({}, lot)) });
    });
    return positions;
  }

  // Cash, holdings, taxes and the budget as of the end of `untilDate`, plus one
  // entry per calendar day from the start date for the net worth chart.
  // moneyIn is the start cash plus what the player saved from the salary; the
  // benchmark puts the same money into the SMI on the same days.
  // `now` (optional ISO time) reverts the day trades of `untilDate` whose market
  // has closed by then; without it they stay open. Earlier days' are always reverted.
  function replay(game, market, untilDate, now) {
    let cash = game.startCash;
    let moneyIn = game.startCash;
    const positions = {};
    const events = [];
    const days = [];
    let taxesPaid = 0;
    let feesPaid = 0;
    let salaryReceived = 0;
    let expensesPaid = 0;
    let dividendsReceived = 0;
    const yearDividends = {};
    const grossSalaryChf = yearlySalary(game.location, game.difficulty);
    // The extra income tax on `amountChf` of dividends after `earlierChf` of them this year.
    const dividendTax = (earlierChf, amountChf) =>
      incomeTax(game.location, grossSalaryChf + earlierChf + amountChf) - incomeTax(game.location, grossSalaryChf + earlierChf);
    // The benchmark reinvests its yield every day, after the same income tax at the salary's margin.
    const benchmarkDailyGrowth = 1 + (market.benchmarkDividendYield || 0) * (1 - dividendTax(0, 10000) / 10000) / 365.25;
    const trades = game.trades.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let tradeIndex = 0;
    const benchmarkStart = market.benchmark(game.startDate);
    let benchmarkUnits = benchmarkStart ? game.startCash / benchmarkStart : null;
    const yearStartWealth = {};
    const yearVolume = {};
    const yearShortSales = {};
    const newMonth = () => ({ salaryChf: 0, expensesChf: 0, lombardInterestChf: 0, borrowFeeChf: 0 });
    let month = newMonth();
    // Day trades with units not closed yet, a buy or a short sale each: { trade, quantity, event }.
    let openDayLots = [];
    let dayTradeProfitChf = 0;
    let loanChf = 0;
    // Short holdings by symbol: { symbol, class, name, lots: [{ date, quantity, priceChf, heldChf, dutyChf }] }.
    const shorts = {};
    // Open options, one per opening trade: { at, symbol, class, name, kind, strike, expiry, written, volatility,
    // quantity, premiumChf (per unit), heldChf (the cash securing a written put) }.
    let options = [];

    const positionList = () => Object.keys(positions).map((symbol) => positions[symbol]);
    const allLots = () => positionList().flatMap((position) => position.lots);
    const mortgageBalance = () => allLots().reduce((sum, lot) => sum + lot.mortgageChf, 0);
    const openDayAmountChf = () => openDayLots.reduce((sum, lot) => sum + lot.trade.amountChf * lot.quantity / lot.trade.quantity, 0);
    const shortList = () => Object.keys(shorts).map((symbol) => shorts[symbol]);
    const lotSum = (lots, key) => lots.reduce((sum, lot) => sum + lot[key], 0);
    const shortPriceOn = (short, date) => {
      const quote = market.quote(short.symbol, date);
      return quote ? quote.priceChf : short.lots[short.lots.length - 1].priceChf;
    };
    // A short is worth its collateral minus what buying the units back would cost.
    const shortsWorthOn = (date) => shortList().reduce((sum, short) =>
      sum + lotSum(short.lots, 'heldChf') - lotSum(short.lots, 'quantity') * shortPriceOn(short, date), 0);
    // A bought option is worth its price, a written one owes it; a written put also holds its cash.
    const optionsWorthOn = (date) => options.reduce((sum, option) => {
      const quote = market.quote(option.symbol, date);
      const priceChf = quote ? optionPrice(option.kind, quote.priceChf, option.strike, optionYears(date, option.expiry), option.volatility) : option.premiumChf;
      return sum + (option.written ? -priceChf : priceChf) * option.quantity + option.heldChf;
    }, 0);
    const netWorthOn = (date) => cash + positionList().reduce((sum, position) => sum + positionValue(market, position, date), 0) + openDayAmountChf() +
      shortsWorthOn(date) + optionsWorthOn(date) - mortgageBalance() - loanChf;

    const applyDayTrade = (trade, year) => {
      // A buy opens a long trade, a short sale (trade.short) a short one; both hold their amount and pay the duty.
      const opens = trade.side === (trade.short ? 'sell' : 'buy');
      // A close closes the trade named by trade.lotAt, else first in, first out. With nothing open to close (a save
      // edited by hand) it is skipped, so it cannot make cash out of nothing.
      const closing = opens ? [] : openDayLots.filter((lot) => lot.trade.symbol === trade.symbol && !!lot.trade.short === !!trade.short &&
        (!trade.lotAt || lot.trade.at === trade.lotAt));
      if (!opens && !closing.length) return;
      feesPaid += trade.stampDutyChf;
      yearVolume[year] = (yearVolume[year] || 0) + trade.amountChf;
      const event = Object.assign({ type: trade.side }, trade, { dealerFeeChf: 0, gainsTaxChf: 0, purchaseCostsChf: 0, mortgageChf: 0, mortgageRepaidChf: 0 });
      events.push(event);
      if (opens) {
        cash -= trade.amountChf + trade.stampDutyChf;
        openDayLots.push({ trade: trade, quantity: trade.quantity, event: event });
        return;
      }
      // Every trade it closes is a sale held under six months.
      let toClose = trade.quantity;
      let openedChf = 0;
      let openingDutyChf = 0;
      closing.forEach((lot) => {
        if (toClose <= EMPTY_QUANTITY) return;
        const used = Math.min(lot.quantity, toClose);
        openedChf += lot.trade.amountChf * used / lot.trade.quantity;
        openingDutyChf += lot.trade.stampDutyChf * used / lot.trade.quantity;
        lot.quantity -= used;
        toClose -= used;
        yearShortSales[year] = (yearShortSales[year] || 0) + 1;
      });
      openDayLots = openDayLots.filter((lot) => lot.quantity > EMPTY_QUANTITY);
      // A sale gets its price. Buying back a short gives back the amount held plus what the short sale got, minus the buyback.
      const cashChf = trade.short ? 2 * openedChf - trade.amountChf - trade.stampDutyChf : trade.amountChf - trade.stampDutyChf;
      cash += cashChf;
      event.cashChf = cashChf;
      event.profitChf = trade.short ? openedChf - openingDutyChf - trade.amountChf - trade.stampDutyChf
        : trade.amountChf - trade.stampDutyChf - openedChf - openingDutyChf;
      dayTradeProfitChf += event.profitChf;
    };

    // A trade of the holdings: units, cash, fees, taxes, the trader check and its line in the history.
    const applyHoldingTrade = (trade, year) => {
      const dealerFeeChf = trade.dealerFeeChf || 0;
      const gainsTaxChf = trade.gainsTaxChf || 0;
      const purchaseCostsChf = trade.purchaseCostsChf || 0;
      const mortgageChf = trade.mortgageChf || 0;
      const result = applyTrade(positions, trade);
      feesPaid += trade.stampDutyChf + dealerFeeChf + purchaseCostsChf;
      taxesPaid += gainsTaxChf;
      if (!isTangible(trade.class)) {
        yearVolume[year] = (yearVolume[year] || 0) + trade.amountChf;
        yearShortSales[year] = (yearShortSales[year] || 0) + result.shortSales;
      }
      if (trade.side === 'buy') cash -= trade.amountChf - mortgageChf + trade.stampDutyChf + purchaseCostsChf;
      else cash += trade.amountChf - trade.stampDutyChf - dealerFeeChf - gainsTaxChf - result.mortgageRepaidChf;
      events.push(Object.assign({ type: trade.side }, trade, {
        dealerFeeChf: dealerFeeChf, gainsTaxChf: gainsTaxChf, purchaseCostsChf: purchaseCostsChf, mortgageChf: mortgageChf,
        mortgageRepaidChf: result.mortgageRepaidChf,
      }));
    };

    // A short sale of a holding, or its buyback, first in, first out; every buyback counts as a quick sale. A buyback
    // with nothing shorted (a save edited by hand) is skipped.
    const applyShortTrade = (trade, year) => {
      if (trade.side === 'buy' && !shorts[trade.symbol]) return;
      feesPaid += trade.stampDutyChf;
      yearVolume[year] = (yearVolume[year] || 0) + trade.amountChf;
      const event = Object.assign({ type: trade.side }, trade, { dealerFeeChf: 0, gainsTaxChf: 0, purchaseCostsChf: 0, mortgageChf: 0, mortgageRepaidChf: 0 });
      events.push(event);
      const short = shorts[trade.symbol] || (shorts[trade.symbol] = { symbol: trade.symbol, class: trade.class, name: trade.name, lots: [] });
      if (trade.side === 'sell') {
        const heldChf = trade.amountChf * SHORT_COLLATERAL;
        // The bank keeps the sale amount; the cash adds the rest of the collateral and the duty.
        event.cashChf = -(heldChf - trade.amountChf + trade.stampDutyChf);
        cash += event.cashChf;
        short.lots.push({ date: trade.date, quantity: trade.quantity, priceChf: trade.priceChf, heldChf: heldChf, dutyChf: trade.stampDutyChf });
        return;
      }
      let toClose = trade.quantity;
      let heldBackChf = 0;
      let soldChf = 0;
      let openingDutyChf = 0;
      while (toClose > EMPTY_QUANTITY && short.lots.length) {
        const lot = short.lots[0];
        const used = Math.min(lot.quantity, toClose);
        const share = used / lot.quantity;
        heldBackChf += lot.heldChf * share;
        soldChf += lot.priceChf * used;
        openingDutyChf += lot.dutyChf * share;
        lot.heldChf -= lot.heldChf * share;
        lot.dutyChf -= lot.dutyChf * share;
        lot.quantity -= used;
        toClose -= used;
        yearShortSales[year] = (yearShortSales[year] || 0) + 1;
        if (lot.quantity <= EMPTY_QUANTITY) short.lots.shift();
      }
      if (!short.lots.length) delete shorts[trade.symbol];
      event.cashChf = heldBackChf - trade.amountChf - trade.stampDutyChf;
      cash += event.cashChf;
      event.profitChf = soldChf - openingDutyChf - trade.amountChf - trade.stampDutyChf;
    };
    // Once the collateral of a short falls under SHORT_MAINTENANCE times the value of its units, they are bought back.
    const callShorts = (date, year) => {
      shortList().forEach((short) => {
        const quote = market.quote(short.symbol, date);
        const quantity = lotSum(short.lots, 'quantity');
        if (!quote || lotSum(short.lots, 'heldChf') >= SHORT_MAINTENANCE * quantity * quote.priceChf) return;
        const amountChf = quantity * quote.priceChf;
        applyShortTrade({
          date: date, side: 'buy', short: true, marginCall: true, symbol: short.symbol, class: short.class, name: short.name,
          quantity: quantity, priceChf: quote.priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(short),
        }, year);
      });
    };

    // An option trade: buying or writing one opens it, the opposite trade on the same option (trade.optionAt) closes it;
    // one closing an option that is not open (a save edited by hand) is skipped. Options pay no stamp duty; their
    // premiums count as trading volume.
    const applyOptionTrade = (trade, year) => {
      const option = trade.option;
      const open = trade.optionAt && options.find((item) => item.at === trade.optionAt);
      if (trade.optionAt && !open) return;
      yearVolume[year] = (yearVolume[year] || 0) + trade.amountChf;
      const event = Object.assign({ type: trade.side }, trade, { stampDutyChf: 0, dealerFeeChf: 0, gainsTaxChf: 0, purchaseCostsChf: 0, mortgageChf: 0, mortgageRepaidChf: 0 });
      events.push(event);
      if (!trade.optionAt) {
        // A written put holds its strike times the units as cash until it ends.
        const heldChf = option.written && option.kind === 'put' ? option.strike * trade.quantity : 0;
        event.cashChf = (option.written ? trade.amountChf : -trade.amountChf) - heldChf;
        cash += event.cashChf;
        options.push({
          at: trade.at, symbol: trade.symbol, class: trade.class, name: trade.name, kind: option.kind, strike: option.strike, expiry: option.expiry,
          written: option.written, volatility: option.volatility, quantity: trade.quantity, premiumChf: trade.priceChf, heldChf: heldChf,
        });
        return;
      }
      const share = Math.min(1, trade.quantity / open.quantity);
      const releasedChf = open.heldChf * share;
      event.cashChf = (option.written ? -trade.amountChf : trade.amountChf) + releasedChf;
      cash += event.cashChf;
      event.profitChf = (option.written ? open.premiumChf - trade.priceChf : trade.priceChf - open.premiumChf) * trade.quantity;
      open.heldChf -= releasedChf;
      open.quantity -= trade.quantity;
      options = options.filter((item) => item.quantity > EMPTY_QUANTITY);
    };
    // The day after its expiry an option ends at that day's close. A bought one pays what exercising it is worth in cash.
    // A written call that ends above its strike delivers the units at the strike (cash for any no longer held); a written
    // put gives its cash back and, below its strike, buys the units at the strike with it.
    const expireOptions = (date, year) => {
      options.filter((option) => option.expiry < date).forEach((option) => {
        const quote = market.quote(option.symbol, option.expiry);
        const spotChf = quote ? quote.priceChf : option.strike;
        const payoutChf = optionPrice(option.kind, spotChf, option.strike, 0, 0) * option.quantity;
        const event = {
          type: 'expiry', date: date, symbol: option.symbol, class: option.class, name: option.name, option: option, quantity: option.quantity,
          spotChf: spotChf, profitChf: (option.written ? -1 : 1) * (payoutChf - option.premiumChf * option.quantity),
        };
        events.push(event);
        let cashChf = option.written ? option.heldChf : payoutChf;
        cash += cashChf;
        // Assigned, a written option's units change hands at the strike.
        if (option.written && payoutChf > 0) {
          const held = positions[option.symbol] ? positions[option.symbol].quantity : 0;
          const quantity = option.kind === 'put' ? option.quantity : Math.min(option.quantity, held);
          if (quantity > EMPTY_QUANTITY) {
            const amountChf = option.strike * quantity;
            const trade = {
              date: date, side: option.kind === 'put' ? 'buy' : 'sell', assigned: true, symbol: option.symbol, class: option.class, name: option.name,
              quantity: quantity, priceChf: option.strike, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(option),
            };
            applyHoldingTrade(trade, year);
            cashChf += trade.side === 'buy' ? -amountChf - trade.stampDutyChf : amountChf - trade.stampDutyChf;
          }
          // A call on units no longer held is settled in cash.
          const missingChf = (spotChf - option.strike) * (option.quantity - quantity);
          cash -= missingChf;
          cashChf -= missingChf;
        }
        event.cashChf = cashChf;
      });
      options = options.filter((option) => option.expiry >= date);
    };

    // The Lombard loan: borrowing pays out cash, repaying takes it back.
    const applyLoan = (trade) => {
      const signedChf = trade.side === 'borrow' ? trade.amountChf : -trade.amountChf;
      loanChf += signedChf;
      cash += signedChf;
      events.push({ type: trade.side, date: trade.date, amountChf: trade.amountChf });
    };
    const lendingValueOn = (date) => positionList().reduce((sum, position) =>
      sum + positionValue(market, position, date) * (LOMBARD_LOAN_TO_VALUE[position.class] || 0), 0);
    // A loan above the lending value is paid down by the cash first, then by selling the same share of every pledged
    // holding at that day's close, just enough to bring the loan back to the lending value of what is left.
    const callLoan = (date, year) => {
      if (loanChf <= 0) return;
      const excessChf = loanChf - lendingValueOn(date);
      if (excessChf <= 0.005) return;
      const fromCashChf = Math.min(Math.max(0, cash), excessChf);
      loanChf -= fromCashChf;
      cash -= fromCashChf;
      let fromSalesChf = 0;
      const lendingChf = lendingValueOn(date);
      if (loanChf - lendingChf > 0.005) {
        const pledged = positionList().filter((position) => LOMBARD_LOAN_TO_VALUE[position.class] > 0 && market.quote(position.symbol, date));
        // Selling a share f of each brings in f times their value after duty and lowers the lending value by f times it.
        const afterDutyChf = pledged.reduce((sum, position) => sum + positionValue(market, position, date) * (1 - stampDutyRate(position)), 0);
        const fraction = Math.min(1, (loanChf - lendingChf) / (afterDutyChf - lendingChf));
        pledged.forEach((position) => {
          const priceChf = market.quote(position.symbol, date).priceChf;
          const quantity = position.quantity * fraction;
          const amountChf = quantity * priceChf;
          const stampDutyChf = amountChf * stampDutyRate(position);
          applyHoldingTrade({
            date: date, side: 'sell', symbol: position.symbol, class: position.class, name: position.name, marginCall: true,
            quantity: quantity, priceChf: priceChf, amountChf: amountChf, stampDutyChf: stampDutyChf,
          }, year);
          fromSalesChf += amountChf - stampDutyChf;
        });
        fromSalesChf = Math.min(fromSalesChf, loanChf);
        loanChf -= fromSalesChf;
        cash -= fromSalesChf;
      }
      // With no cash and nothing left to sell, nothing happens, and the history stays quiet.
      if (fromCashChf + fromSalesChf > 0.005) events.push({ type: 'margin', date: date, fromCashChf: fromCashChf, fromSalesChf: fromSalesChf, loanChf: loanChf });
    };

    // The units still open at the close are taken out as if never bought: cash, fees, volume and history.
    const revertDayLots = (date, year) => {
      openDayLots = openDayLots.filter((lot) => {
        const closed = date < untilDate || (now != null && Date.parse(now) >= Date.parse(lot.trade.closesAt));
        if (!closed) return true;
        const share = lot.quantity / lot.trade.quantity;
        cash += (lot.trade.amountChf + lot.trade.stampDutyChf) * share;
        feesPaid -= lot.trade.stampDutyChf * share;
        yearVolume[year] -= lot.trade.amountChf * share;
        if (share >= 1 - EMPTY_QUANTITY) events.splice(events.indexOf(lot.event), 1);
        else {
          lot.event.quantity -= lot.quantity;
          lot.event.amountChf -= lot.trade.amountChf * share;
          lot.event.stampDutyChf -= lot.trade.stampDutyChf * share;
        }
        return false;
      });
    };

    for (let date = game.startDate; date <= untilDate; date = addDays(date, 1)) {
      if (date !== game.startDate) {
        applyWear(positions, market);
        if (benchmarkUnits != null) benchmarkUnits *= benchmarkDailyGrowth;
      }
      const year = Number(date.slice(0, 4));
      if (yearStartWealth[year] == null) yearStartWealth[year] = date === game.startDate ? game.startCash : netWorthOn(date);

      // Before today's trades: a unit bought on the ex-dividend day gets nothing, one sold that day still does.
      if (market.dividend) {
        positionList().forEach((position) => {
          const perUnitChf = market.dividend(position.symbol, date);
          if (!(perUnitChf > 0)) return;
          const amountChf = perUnitChf * position.quantity;
          const taxChf = dividendTax(yearDividends[year] || 0, amountChf);
          yearDividends[year] = (yearDividends[year] || 0) + amountChf;
          cash += amountChf - taxChf;
          taxesPaid += taxChf;
          dividendsReceived += amountChf;
          events.push({
            type: 'dividend', date: date, symbol: position.symbol, class: position.class, name: position.name,
            quantity: position.quantity, perUnitChf: perUnitChf, amountChf: amountChf, taxChf: taxChf,
          });
          // Reinvested, the dividend after tax buys more of the same at that day's price, stamp duty included; without a
          // recent price it stays cash.
          const quote = reinvestsOn(game, date) && tradeQuote(market, position.symbol, date);
          if (!quote || quote.error || !(amountChf > taxChf)) return;
          const dutyRate = stampDutyRate(position);
          const reinvestedChf = (amountChf - taxChf) / (1 + dutyRate);
          const trade = {
            date: date, side: 'buy', symbol: position.symbol, class: position.class, name: position.name, reinvested: true,
            quantity: reinvestedChf / quote.priceChf, priceChf: quote.priceChf, amountChf: reinvestedChf, stampDutyChf: reinvestedChf * dutyRate,
          };
          applyTrade(positions, trade);
          cash -= amountChf - taxChf;
          feesPaid += trade.stampDutyChf;
          yearVolume[year] = (yearVolume[year] || 0) + reinvestedChf;
          events.push(Object.assign({ type: 'buy' }, trade, { dealerFeeChf: 0, gainsTaxChf: 0, purchaseCostsChf: 0, mortgageChf: 0, mortgageRepaidChf: 0 }));
        });
        // A short pays the dividend to the lender of its units.
        shortList().forEach((short) => {
          const perUnitChf = market.dividend(short.symbol, date);
          if (!(perUnitChf > 0)) return;
          const quantity = lotSum(short.lots, 'quantity');
          cash -= perUnitChf * quantity;
          events.push({
            type: 'dividend', short: true, date: date, symbol: short.symbol, class: short.class, name: short.name,
            quantity: quantity, perUnitChf: perUnitChf, amountChf: -perUnitChf * quantity, taxChf: 0,
          });
        });
      }

      expireOptions(date, year);
      while (tradeIndex < trades.length && trades[tradeIndex].date <= date) {
        const trade = trades[tradeIndex++];
        if (trade.intraday) applyDayTrade(trade, year);
        else if (trade.side === 'borrow' || trade.side === 'repay') applyLoan(trade);
        else if (trade.option) applyOptionTrade(trade, year);
        else if (trade.short) applyShortTrade(trade, year);
        else applyHoldingTrade(trade, year);
      }
      revertDayLots(date, year);
      callLoan(date, year);
      callShorts(date, year);
      month.lombardInterestChf += loanChf * LOMBARD_INTEREST_RATE / daysInYear(year);
      month.borrowFeeChf += shortList().reduce((sum, short) => sum + lotSum(short.lots, 'quantity') * shortPriceOn(short, date), 0) *
        SHORT_BORROW_FEE_RATE / daysInYear(year);

      // Today's share of the month, with what is owned at the end of the day.
      const share = 1 / daysInMonth(date);
      const budget = monthlyBudget(game, market, positionList());
      month.salaryChf += budget.netSalaryChf * share;
      month.expensesChf += budget.expensesChf * share;
      allLots().forEach((lot) => { if (lot.amortizationChf) lot.amortizationDueChf += lot.amortizationChf * share; });

      if (isMonthEnd(date)) {
        let amortizationChf = 0;
        allLots().forEach((lot) => {
          const paid = Math.min(mortgageAboveFirstShareChf(lot), lot.amortizationDueChf || 0);
          lot.mortgageChf -= paid;
          lot.amortizationDueChf = 0;
          amortizationChf += paid;
        });
        const savingsChf = month.salaryChf - month.expensesChf;
        // Lombard interest and borrow fees are costs of investing, not of living, so they are not taken from the money put in.
        cash += savingsChf - amortizationChf - month.lombardInterestChf - month.borrowFeeChf;
        feesPaid += month.lombardInterestChf + month.borrowFeeChf;
        moneyIn += savingsChf;
        salaryReceived += month.salaryChf;
        expensesPaid += month.expensesChf;
        const benchmarkToday = market.benchmark(date);
        if (benchmarkUnits != null && benchmarkToday) benchmarkUnits += savingsChf / benchmarkToday;
        events.push({
          type: 'month', date: date, salaryChf: month.salaryChf, expensesChf: month.expensesChf, amortizationChf: amortizationChf,
          lombardInterestChf: month.lombardInterestChf, borrowFeeChf: month.borrowFeeChf,
        });
        month = newMonth();
      }

      let netWorth = netWorthOn(date);
      if (date.slice(5) === '12-31') {
        const taxedFrom = game.startDate > year + '-01-01' ? game.startDate : year + '-01-01';
        const daysTaxed = daysBetween(taxedFrom, date) + 1;
        const tax = wealthTax(netWorth, game.location) * daysTaxed / daysInYear(year);
        if (tax > 0) {
          cash -= tax;
          netWorth -= tax;
          taxesPaid += tax;
          events.push({ type: 'tax', date: date, amountChf: tax, wealthChf: netWorth + tax, year: year });
        }
      }

      const benchmarkNow = market.benchmark(date);
      days.push({
        date: date,
        cash: cash,
        netWorth: netWorth,
        moneyIn: moneyIn,
        benchmark: benchmarkUnits != null && benchmarkNow ? benchmarkUnits * benchmarkNow : null,
      });
    }

    const currentYear = Number(untilDate.slice(0, 4));
    const volumeMultiple = (yearVolume[currentYear] || 0) / (yearStartWealth[currentYear] || game.startCash);
    const shortSales = yearShortSales[currentYear] || 0;
    const failedRules = (shortSales > 0 ? 1 : 0) + (volumeMultiple > MAX_VOLUME_MULTIPLE ? 1 : 0);

    return {
      cash: cash,
      moneyIn: moneyIn,
      mortgageChf: mortgageBalance(),
      positions: positionList().map((position) => {
        const valueChf = positionValue(market, position, untilDate);
        return {
          symbol: position.symbol, class: position.class, name: position.name, quantity: position.quantity, lastPriceChf: position.lastPriceChf,
          costChf: position.costChf, valueChf: valueChf, unitValueChf: valueChf / position.quantity,
          mortgageChf: position.lots.reduce((sum, lot) => sum + lot.mortgageChf, 0),
          lots: position.lots.map((lot) => Object.assign({}, lot)),
        };
      }),
      budget: monthlyBudget(game, market, positionList()),
      events: events,
      days: days,
      taxesPaid: taxesPaid,
      feesPaid: feesPaid,
      salaryReceived: salaryReceived,
      expensesPaid: expensesPaid,
      dividendsReceived: dividendsReceived,
      trader: { status: ['private', 'review', 'risk'][failedRules], shortSales: shortSales, volumeMultiple: volumeMultiple },
      dayTrades: openDayPositions(openDayLots),
      dayTradeProfitChf: dayTradeProfitChf,
      loanChf: loanChf,
      lendingValueChf: lendingValueOn(untilDate),
      // Each short: units, what the sale got (soldChf) and its duty, the collateral held and what buying back costs now.
      shorts: shortList().map((short) => {
        const quantity = lotSum(short.lots, 'quantity');
        const soldChf = short.lots.reduce((sum, lot) => sum + lot.quantity * lot.priceChf, 0);
        return {
          symbol: short.symbol, class: short.class, name: short.name, quantity: quantity, priceChf: soldChf / quantity, soldChf: soldChf,
          dutyChf: lotSum(short.lots, 'dutyChf'), heldChf: lotSum(short.lots, 'heldChf'), valueChf: quantity * shortPriceOn(short, untilDate),
        };
      }),
      // Each open option, with its price per unit at the last close (priceChf).
      options: options.map((option) => {
        const quote = market.quote(option.symbol, untilDate);
        const priceChf = quote ? optionPrice(option.kind, quote.priceChf, option.strike, optionYears(untilDate, option.expiry), option.volatility) : option.premiumChf;
        return Object.assign({}, option, { priceChf: priceChf });
      }),
    };
  }

  // Open day trades, one per buy or short sale with units left, in that order: `at` and priceChf of the opening
  // trade, short when it was a short sale, amountChf at that price (the cash held), costChf with the stamp duty paid.
  function openDayPositions(lots) {
    return lots.map((lot) => {
      const share = lot.quantity / lot.trade.quantity;
      return {
        symbol: lot.trade.symbol, class: lot.trade.class, name: lot.trade.name, at: lot.trade.at, short: !!lot.trade.short, priceChf: lot.trade.priceChf, quantity: lot.quantity,
        amountChf: lot.trade.amountChf * share, costChf: (lot.trade.amountChf + lot.trade.stampDutyChf) * share, closesAt: lot.trade.closesAt,
      };
    });
  }

  // A recent quote for trading on `date`, or an error message.
  function tradeQuote(market, symbol, date) {
    const quote = market.quote(symbol, date);
    if (!quote || !(quote.priceChf > 0)) return { error: 'NO PRICE FOR THIS ASSET' };
    if (daysBetween(quote.date, date) > MAX_QUOTE_AGE_DAYS) return { error: 'NO RECENT PRICE (LAST ' + quote.date + ')' };
    return quote;
  }

  // Everything a buy would cost, before deciding if it is allowed. `order` is
  // { amountChf } or { quantity }; a house also takes { downPayment } (0.2 to
  // 1, the share paid in cash; the rest is the mortgage). Returns { error }
  // when the order cannot be priced, else { trade, error (null when allowed),
  // cashChf, cashNeededChf, budgetBefore, budgetAfter, affordability }.
  // `now` (optional) is passed to replay, so cash held by closed day trades is free again.
  function previewBuy(game, market, asset, order, date, now) {
    const quote = tradeQuote(market, asset.symbol, date);
    if (quote.error) return quote;
    const quantity = order.quantity != null ? order.quantity : order.amountChf / quote.priceChf;
    if (!(quantity > 0) || !isFinite(quantity)) return { error: order.quantity != null ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT' };
    if (isTangible(asset.class) && !Number.isInteger(quantity)) return { error: 'BUY WHOLE UNITS' };
    const amountChf = order.quantity != null ? quantity * quote.priceChf : order.amountChf;
    const trade = {
      date: date, side: 'buy', symbol: asset.symbol, class: asset.class, name: asset.name || asset.symbol,
      quantity: quantity, priceChf: quote.priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(asset),
    };
    if (asset.class === 'house') {
      const downPayment = order.downPayment == null ? 1 : order.downPayment;
      if (!(downPayment >= MIN_DOWN_PAYMENT - 1e-9 && downPayment <= 1)) return { error: 'DOWN PAYMENT: 20% TO 100%' };
      trade.purchaseCostsChf = amountChf * housePurchaseCostRate(tangibleInfo(market, asset.symbol).location);
      trade.mortgageChf = amountChf * (1 - downPayment);
      trade.amortizationChf = Math.max(0, trade.mortgageChf - amountChf * FIRST_MORTGAGE_SHARE) / AMORTIZATION_MONTHS;
    }

    const state = replay(game, market, date, now);
    const positionsAfter = copyPositions(state.positions);
    applyTrade(positionsAfter, trade);
    const listAfter = Object.keys(positionsAfter).map((symbol) => positionsAfter[symbol]);
    const cashNeededChf = amountChf - (trade.mortgageChf || 0) + trade.stampDutyChf + (trade.purchaseCostsChf || 0);
    let affordability = null;
    let error = null;
    if (trade.mortgageChf > 0) {
      const yearlyChf = listAfter.filter((position) => position.class === 'house').reduce((sum, position) => sum + position.lots.reduce((lotSum, lot) =>
        lotSum + lot.mortgageChf * AFFORDABILITY_INTEREST_RATE + lot.quantity * lot.priceChf * AFFORDABILITY_UPKEEP_RATE + monthlyPaybackChf(lot) * 12, 0), 0);
      affordability = { yearlyChf: yearlyChf, limitChf: yearlySalary(game.location, game.difficulty) * AFFORDABILITY_INCOME_SHARE };
    }
    if (cashNeededChf > state.cash + 0.005) error = 'NOT ENOUGH CASH';
    else if (affordability && affordability.yearlyChf > affordability.limitChf) error = 'MORTGAGE NOT AFFORDABLE: RAISE THE DOWN PAYMENT';
    return {
      trade: trade, error: error, cashChf: state.cash, cashNeededChf: cashNeededChf,
      budgetBefore: state.budget, budgetAfter: monthlyBudget(game, market, listAfter), affordability: affordability,
    };
  }

  // The buy trade for `order` (see previewBuy), or { error }.
  function buy(game, market, asset, order, date, now) {
    const preview = previewBuy(game, market, asset, order, date, now);
    if (!preview.trade) return { error: preview.error };
    return preview.error ? { error: preview.error } : preview.trade;
  }

  // The sell trade for `order` ({ fraction } of the holding, or { quantity }), or { error }.
  // Units covering written calls cannot be sold: a fraction is of the units that are free.
  function sell(game, market, symbol, order, date, now) {
    const state = replay(game, market, date, now);
    const position = state.positions.find((item) => item.symbol === symbol);
    if (!position) return { error: 'NOTHING TO SELL' };
    const quote = tradeQuote(market, symbol, date);
    if (quote.error) return quote;
    const free = Math.max(0, uncoveredUnits(state, symbol));
    const quantity = order.quantity != null ? order.quantity : free * Math.min(1, Math.max(0, order.fraction));
    if (!(quantity > 0)) return { error: free > 0 ? 'NOTHING TO SELL' : 'ALL UNITS COVER WRITTEN CALLS' };
    if (quantity > position.quantity + EMPTY_QUANTITY) return { error: 'YOU ONLY HOLD ' + position.quantity };
    if (quantity > free + EMPTY_QUANTITY) return { error: 'ONLY ' + free + ' UNITS ARE NOT COVERING WRITTEN CALLS' };
    if (isTangible(position.class) && !Number.isInteger(Math.round(quantity * 1e6) / 1e6)) return { error: 'SELL WHOLE UNITS' };
    // The oldest units go first, each with its own wear. A house also pays tax
    // on its gain after the agent's fee, per unit and holding period, and pays
    // back its share of the mortgage.
    const feeRate = dealerFeeRate(position.class);
    const costPerUnit = position.costChf / position.quantity;
    let amountChf = 0;
    let gainsTaxChf = 0;
    let mortgageRepaidChf = 0;
    let toSell = quantity;
    for (const lot of position.lots) {
      if (toSell <= EMPTY_QUANTITY) break;
      const used = Math.min(lot.quantity, toSell);
      const saleChf = used * quote.priceChf * lot.wearFactor;
      amountChf += saleChf;
      mortgageRepaidChf += lot.mortgageChf * used / lot.quantity;
      if (position.class === 'house') gainsTaxChf += propertyGainsTax(saleChf * (1 - feeRate) - used * costPerUnit, daysBetween(lot.date, date));
      toSell -= used;
    }
    return {
      date: date, side: 'sell', symbol: symbol, class: position.class, name: position.name,
      quantity: quantity, priceChf: amountChf / quantity, amountChf: amountChf,
      stampDutyChf: amountChf * stampDutyRate({ symbol: symbol, class: position.class }),
      dealerFeeChf: amountChf * feeRate,
      gainsTaxChf: gainsTaxChf,
      mortgageRepaidChf: mortgageRepaidChf,
    };
  }

  // A trade at `now` on `date` that opens an option on a stock or ETF: `order` is { kind: 'call' | 'put', strike, expiry
  // (from optionChain), written, quantity }. A bought option is paid at its price now; a written one gets that premium
  // and must be covered: a call by units held and not covering another call, a put by its strike times the units in
  // cash, held until it ends. Returns the trade, or { error }.
  function openOption(game, market, asset, order, date, now) {
    if (asset.class !== 'stock' && asset.class !== 'etf') return { error: 'OPTIONS ARE FOR STOCKS AND ETFS ONLY' };
    const chain = optionChain(market, asset, date);
    if (chain.error) return chain;
    if (order.kind !== 'call' && order.kind !== 'put') return { error: 'UNKNOWN OPTION' };
    if (!chain.strikes.includes(order.strike)) return { error: 'PICK A STRIKE' };
    if (!chain.expiries.includes(order.expiry)) return { error: 'PICK AN EXPIRY' };
    if (!(order.quantity > 0) || !isFinite(order.quantity)) return { error: 'ENTER A QUANTITY' };
    const priceChf = optionPrice(order.kind, chain.priceChf, order.strike, optionYears(date, order.expiry), chain.volatility);
    const amountChf = priceChf * order.quantity;
    const state = replay(game, market, date, now);
    if (!order.written && amountChf > state.cash + 0.005) return { error: 'NOT ENOUGH CASH' };
    if (order.written && order.kind === 'put' && order.strike * order.quantity - amountChf > state.cash + 0.005) return { error: 'NOT ENOUGH CASH TO SECURE THE PUT' };
    if (order.written && order.kind === 'call' && order.quantity > uncoveredUnits(state, asset.symbol) + EMPTY_QUANTITY) {
      return { error: 'NOT ENOUGH UNITS TO COVER THE CALL' };
    }
    return {
      date: date, at: now || date, side: order.written ? 'sell' : 'buy', symbol: asset.symbol, class: asset.class, name: asset.name || asset.symbol,
      option: { kind: order.kind, strike: order.strike, expiry: order.expiry, written: !!order.written, volatility: chain.volatility },
      quantity: order.quantity, priceChf: priceChf, amountChf: amountChf,
    };
  }

  // The trade that closes `order` ({ fraction } or { quantity }) of the option opened at `optionAt`, at its price on
  // `date`: selling back a bought one, buying back a written one. Returns the trade, or { error }.
  function closeOption(game, market, optionAt, order, date, now) {
    const state = replay(game, market, date, now);
    const open = state.options.find((item) => item.at === optionAt);
    if (!open) return { error: 'NO OPEN OPTION' };
    const quote = tradeQuote(market, open.symbol, date);
    if (quote.error) return quote;
    const quantity = order.quantity != null ? order.quantity : open.quantity * Math.min(1, Math.max(0, order.fraction));
    if (!(quantity > 0)) return { error: 'ENTER A QUANTITY' };
    if (quantity > open.quantity + EMPTY_QUANTITY) return { error: 'YOU ONLY HAVE ' + open.quantity };
    const priceChf = optionPrice(open.kind, quote.priceChf, open.strike, optionYears(date, open.expiry), open.volatility);
    const amountChf = priceChf * quantity;
    if (open.written && amountChf > state.cash + open.heldChf * quantity / open.quantity + 0.005) return { error: 'NOT ENOUGH CASH' };
    return {
      date: date, at: now || date, side: open.written ? 'buy' : 'sell', symbol: open.symbol, class: open.class, name: open.name, optionAt: optionAt,
      option: { kind: open.kind, strike: open.strike, expiry: open.expiry, written: open.written, volatility: open.volatility },
      quantity: quantity, priceChf: priceChf, amountChf: amountChf,
    };
  }

  // Units of a holding not already covering written calls.
  function uncoveredUnits(state, symbol) {
    const position = state.positions.find((item) => item.symbol === symbol);
    const covering = state.options.filter((option) => option.symbol === symbol && option.written && option.kind === 'call')
      .reduce((sum, option) => sum + option.quantity, 0);
    return (position ? position.quantity : 0) - covering;
  }

  // A short sale of a stock or ETF at its last close on `date`: `order` is { amountChf } or { quantity }. The cash pays
  // the duty and half the amount as extra collateral. Returns the trade (side 'sell', short), or { error }.
  function openShort(game, market, asset, order, date, now) {
    if (asset.class !== 'stock' && asset.class !== 'etf') return { error: 'ONLY STOCKS AND ETFS CAN BE SHORTED' };
    const quote = tradeQuote(market, asset.symbol, date);
    if (quote.error) return quote;
    const quantity = order.quantity != null ? order.quantity : order.amountChf / quote.priceChf;
    if (!(quantity > 0) || !isFinite(quantity)) return { error: order.quantity != null ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT' };
    const amountChf = quantity * quote.priceChf;
    const trade = {
      date: date, side: 'sell', short: true, symbol: asset.symbol, class: asset.class, name: asset.name || asset.symbol,
      quantity: quantity, priceChf: quote.priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(asset),
    };
    if (amountChf * (SHORT_COLLATERAL - 1) + trade.stampDutyChf > replay(game, market, date, now).cash + 0.005) return { error: 'NOT ENOUGH CASH' };
    return trade;
  }

  // The buyback of `order` ({ fraction } of a short, or { quantity }) at the last close on `date`, or { error }.
  function coverShort(game, market, symbol, order, date, now) {
    const short = replay(game, market, date, now).shorts.find((item) => item.symbol === symbol);
    if (!short) return { error: 'NOTHING TO BUY BACK' };
    const quote = tradeQuote(market, symbol, date);
    if (quote.error) return quote;
    const quantity = order.quantity != null ? order.quantity : short.quantity * Math.min(1, Math.max(0, order.fraction));
    if (!(quantity > 0)) return { error: 'NOTHING TO BUY BACK' };
    if (quantity > short.quantity + EMPTY_QUANTITY) return { error: 'YOU ONLY SHORTED ' + short.quantity };
    const amountChf = quantity * quote.priceChf;
    return {
      date: date, side: 'buy', short: true, symbol: symbol, class: short.class, name: short.name,
      quantity: quantity, priceChf: quote.priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(short),
    };
  }

  // A Lombard loan trade on `date`: { date, side: 'borrow' | 'repay', amountChf }, or { error }. Borrowing goes up to
  // the lending value of the holdings; repaying up to what is owed, from the cash at hand.
  function loanTrade(game, market, side, amountChf, date, now) {
    if (!(amountChf > 0) || !isFinite(amountChf)) return { error: 'ENTER AN AMOUNT' };
    const state = replay(game, market, date, now);
    if (side === 'borrow' && amountChf > state.lendingValueChf - state.loanChf + 0.005) return { error: 'MORE THAN YOUR HOLDINGS LET YOU BORROW' };
    if (side === 'repay' && amountChf > state.loanChf + 0.005) return { error: 'MORE THAN YOU OWE' };
    if (side === 'repay' && amountChf > state.cash + 0.005) return { error: 'NOT ENOUGH CASH' };
    return { date: date, side: side, amountChf: amountChf };
  }

  // A day trade buy at the simulated `priceChf` at `now` (ISO time), while `session` ({ opensAt, closesAt }, ISO) is
  // open. `order` is { amountChf } or { quantity }; with { short: true } it is a short sale instead, which gains when
  // the price falls. Either way its amount and stamp duty are paid from the cash. Returns the trade, or { error }.
  function openDayTrade(game, market, asset, order, priceChf, session, now) {
    if (isTangible(asset.class)) return { error: 'NOT FOR DAY TRADING' };
    const nowMs = Date.parse(now);
    if (!session || nowMs < Date.parse(session.opensAt) || nowMs >= Date.parse(session.closesAt)) return { error: 'MARKET CLOSED' };
    if (!(priceChf > 0)) return { error: 'NO PRICE FOR THIS ASSET' };
    const quantity = order.quantity != null ? order.quantity : order.amountChf / priceChf;
    if (!(quantity > 0) || !isFinite(quantity)) return { error: order.quantity != null ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT' };
    const amountChf = quantity * priceChf;
    const date = now.slice(0, 10);
    const trade = {
      date: date, side: order.short ? 'sell' : 'buy', intraday: true, at: now, closesAt: session.closesAt, symbol: asset.symbol, class: asset.class,
      name: asset.name || asset.symbol, quantity: quantity, priceChf: priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate(asset),
    };
    if (order.short) trade.short = true;
    if (amountChf + trade.stampDutyChf > replay(game, market, date, now).cash + 0.005) return { error: 'NOT ENOUGH CASH' };
    return trade;
  }

  // The trade that closes `order` ({ fraction } of the open units, or { quantity }) at the simulated `priceChf` at
  // `now` (ISO time), before its market closes: a sale for bought units, a buyback for shorted ones. With order.lotAt
  // (the opening trade's `at`) it closes that trade only, else the symbol's buys, or short sales with order.short,
  // first in, first out. Returns the trade, or { error }.
  function closeDayTrade(game, market, symbol, order, priceChf, now) {
    const date = now.slice(0, 10);
    const lots = replay(game, market, date, now).dayTrades.filter((item) => item.symbol === symbol &&
      (order.lotAt ? item.at === order.lotAt : item.short === !!order.short));
    if (!lots.length) return { error: 'NO OPEN DAY TRADE' };
    if (Date.parse(now) >= Date.parse(lots[0].closesAt)) return { error: 'MARKET CLOSED' };
    if (!(priceChf > 0)) return { error: 'NO PRICE FOR THIS ASSET' };
    const short = lots[0].short;
    const openQuantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
    const quantity = order.quantity != null ? order.quantity : openQuantity * Math.min(1, Math.max(0, order.fraction));
    if (!(quantity > 0)) return { error: short ? 'NOTHING TO BUY BACK' : 'NOTHING TO SELL' };
    if (quantity > openQuantity + EMPTY_QUANTITY) return { error: (short ? 'YOU ONLY SHORTED ' : 'YOU ONLY HOLD ') + openQuantity };
    const amountChf = quantity * priceChf;
    const trade = {
      date: date, side: short ? 'buy' : 'sell', intraday: true, at: now, symbol: symbol, class: lots[0].class, name: lots[0].name,
      quantity: quantity, priceChf: priceChf, amountChf: amountChf, stampDutyChf: amountChf * stampDutyRate({ symbol: symbol, class: lots[0].class }),
    };
    if (short) trade.short = true;
    if (order.lotAt) trade.lotAt = order.lotAt;
    return trade;
  }

  // Whether `priceChf` reaches an order's level (`levelChf`, by default its priceChf): a limit buys at or below it and
  // sells at or above it; a stop-loss or trailing stop does the opposite, selling at or below it, or buying back a
  // short at or above it.
  function orderReached(order, priceChf, levelChf = order.priceChf) {
    return (order.type === 'limit') === (order.side === 'buy') ? priceChf <= levelChf : priceChf >= levelChf;
  }

  // A test to feed an order's prices in time order: whether each one reaches its level. `test.level()` is the level
  // so far. A trailing stop's level follows the best price since it was placed (order.referenceChf): trailPercent
  // below the highest for a sell, above the lowest for a buyback.
  function orderTrigger(order) {
    let bestChf = order.referenceChf;
    const level = () => {
      if (order.type !== 'trail') return order.priceChf;
      return order.side === 'sell' ? bestChf * (1 - order.trailPercent) : bestChf * (1 + order.trailPercent);
    };
    const test = (priceChf) => {
      if (order.type === 'trail') bestChf = order.side === 'sell' ? Math.max(bestChf, priceChf) : Math.min(bestChf, priceChf);
      return orderReached(order, priceChf, level());
    };
    test.level = level;
    return test;
  }

  // A trailing stop's fields with its starting level and the price it trails (referenceChf); other orders' as they are.
  function withTrailLevel(fields, priceChf) {
    if (fields.type !== 'trail') return fields;
    const factor = fields.side === 'sell' ? 1 - fields.trailPercent : 1 + fields.trailPercent;
    return Object.assign({}, fields, { referenceChf: priceChf, priceChf: priceChf * factor });
  }

  // Whether an order closes something: one naming a day trade (lotAt), or a sale that is not a short sale.
  function closesPosition(fields) {
    return !!fields.lotAt || (fields.side === 'sell' && !fields.short);
  }

  // Why `fields` cannot be an order on `asset` while its price is `priceChf`, or null.
  function orderError(asset, fields, priceChf) {
    if (isTangible(asset.class)) return 'NO ORDERS FOR THIS ASSET';
    // Stop-losses and trailing stops only close something; a buying one protects a short.
    const known = (fields.side === 'buy' || fields.side === 'sell') &&
      (fields.type === 'limit' || ((fields.type === 'stop' || fields.type === 'trail') && closesPosition(fields)));
    if (!known) return 'UNKNOWN ORDER';
    if (fields.type === 'trail' && !(fields.trailPercent > 0 && fields.trailPercent < 1)) return 'ENTER A TRAIL ABOVE 0% AND BELOW 100%';
    if (!(fields.priceChf > 0) || !isFinite(fields.priceChf)) return 'ENTER A PRICE';
    // A level the price already reaches would trade now: that is a normal buy or sale.
    if (orderReached(fields, priceChf)) {
      return (fields.type === 'stop' ? 'A STOP-LOSS' : 'A LIMIT ' + fields.side.toUpperCase()) + ' MUST BE ' +
        (orderReached(fields, 0) ? 'BELOW' : 'ABOVE') + ' THE PRICE';
    }
    if (closesPosition(fields)) return fields.fraction > 0 && fields.fraction <= 1 ? null : 'NOTHING TO SELL';
    const size = fields.quantity != null ? fields.quantity : fields.amountChf;
    return size > 0 && isFinite(size) ? null : fields.quantity != null ? 'ENTER A QUANTITY' : 'ENTER AN AMOUNT';
  }

  // The order kept in game.orders, or { error } when it closes something not held (`held`) or a buy at its level
  // costs more than the cash in `state`. `extra` holds what only a regular or a day order has.
  function keptOrder(state, asset, fields, held, nothingHeldError, date, now, extra) {
    const closing = closesPosition(fields);
    if (closing && !held) return { error: nothingHeldError };
    const amountChf = fields.quantity != null ? fields.quantity * fields.priceChf : fields.amountChf;
    if (!closing && amountChf * (1 + stampDutyRate(asset)) > state.cash + 0.005) return { error: 'NOT ENOUGH CASH' };
    const order = {
      at: now, date: date, symbol: asset.symbol, class: asset.class, name: asset.name || asset.symbol,
      side: fields.side, type: fields.type, priceChf: fields.priceChf,
    };
    if (closing) order.fraction = fields.fraction;
    else if (fields.quantity != null) order.quantity = fields.quantity;
    else order.amountChf = fields.amountChf;
    if (!closing && fields.short) order.short = true;
    if (fields.lotAt) order.lotAt = fields.lotAt;
    if (fields.type === 'trail') Object.assign(order, { trailPercent: fields.trailPercent, referenceChf: fields.referenceChf });
    return Object.assign(order, extra);
  }

  // A limit, stop-loss or trailing stop order placed at `now` on `date`, kept in game.orders until a newer close
  // reaches its level (see orderFill); it then trades at that close through buy or sell, given the order itself as
  // their order. `fields` is { side: 'buy' | 'sell', type: 'limit' | 'stop' | 'trail', priceChf (the level) or
  // trailPercent (0.05 trails 5% behind the best close) } plus { amountChf } or { quantity } for a buy, or
  // { fraction } of what is held when it fills for a sell. Returns the order, or { error }.
  function placeOrder(game, market, asset, fields, date, now) {
    // A limit order opening a short exists for day trades only (placeDayOrder); filled here it would sell the holding.
    if (fields.short) return { error: 'UNKNOWN ORDER' };
    const quote = tradeQuote(market, asset.symbol, date);
    if (quote.error) return quote;
    const leveled = withTrailLevel(fields, quote.priceChf);
    const error = orderError(asset, leveled, quote.priceChf);
    if (error) return { error: error };
    const state = replay(game, market, date, now);
    const held = state.positions.some((position) => position.symbol === asset.symbol);
    return keptOrder(state, asset, leveled, held, 'NOTHING TO SELL', date, now, { quoteDate: quote.date });
  }

  // A day order like placeOrder's, at the live `priceChf` while `session` ({ opensAt, closesAt }, ISO) is open. It is
  // kept until the simulated price reaches its level (GameIntraday.firstStepReaching), then trades at that price through
  // openDayTrade or closeDayTrade, or it ends at the close. An order that closes a day trade names it (fields.lotAt):
  // a sell closes a buy, a buy closes a short sale. A limit sell with fields.short opens a short sale at or above its level.
  function placeDayOrder(game, market, asset, fields, priceChf, session, now) {
    const nowMs = Date.parse(now);
    if (!session || nowMs < Date.parse(session.opensAt) || nowMs >= Date.parse(session.closesAt)) return { error: 'MARKET CLOSED' };
    if (!(priceChf > 0)) return { error: 'NO PRICE FOR THIS ASSET' };
    const leveled = withTrailLevel(fields, priceChf);
    const error = orderError(asset, leveled, priceChf);
    if (error) return { error: error };
    const date = now.slice(0, 10);
    const state = replay(game, market, date, now);
    const held = state.dayTrades.some((lot) => lot.symbol === asset.symbol && lot.at === fields.lotAt && lot.short === (fields.side === 'buy'));
    return keptOrder(state, asset, leveled, held, 'NO OPEN DAY TRADE', date, now, { intraday: true, closesAt: session.closesAt });
  }

  // The closes a regular order has seen: from the order's own day up to `untilDate`, each day with a close newer than
  // the last one seen, starting after the close it was placed against: [{ date, priceChf }] in date order.
  function newCloses(market, order, untilDate) {
    const closes = [];
    let lastSeen = order.quoteDate;
    for (let date = order.date; date <= untilDate; date = addDays(date, 1)) {
      const quote = market.quote(order.symbol, date);
      if (quote && quote.date > lastSeen) {
        lastSeen = quote.date;
        closes.push({ date: date, priceChf: quote.priceChf });
      }
    }
    return closes;
  }

  // The first of an order's new closes (see newCloses) that reaches its level: { date, priceChf }, or null. The order
  // trades on that day at that close.
  function orderFill(market, order, untilDate) {
    const reached = orderTrigger(order);
    return newCloses(market, order, untilDate).find((close) => reached(close.priceChf)) || null;
  }

  return {
    DIFFICULTIES, LOCATIONS, HOUSE_LOCATIONS, CAR_KM_PER_YEAR, CAR_MILEAGE_SHARE, MORTGAGE_INTEREST_RATE, MIN_DOWN_PAYMENT, MAX_QUOTE_AGE_DAYS,
    newGame, yearlySalary, incomeTax, isTangible, stampDutyRate, dealerFeeRate, housePurchaseCostRate, wealthTax, propertyGainsTax,
    ownedYearlyChange, carMonthlyCosts, houseMonthlyCosts, monthlyBudget, replay, previewBuy, buy, sell, openDayTrade, closeDayTrade,
    orderReached, orderTrigger, placeOrder, placeDayOrder, newCloses, orderFill, reinvestsOn,
    LOMBARD_INTEREST_RATE, LOMBARD_LOAN_TO_VALUE, loanTrade,
    SHORT_COLLATERAL, SHORT_MAINTENANCE, SHORT_BORROW_FEE_RATE, openShort, coverShort,
    optionPrice, optionChain, openOption, closeOption,
    addDays, daysBetween,
  };
})();

if (typeof module !== 'undefined') module.exports = GameEngine;

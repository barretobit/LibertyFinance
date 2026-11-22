/* ===== Vaulty: day trading market =====
 *
 * Randata only has daily closes, so the price during the day is simulated.
 * Each asset gets one random walk per trading day, starting at the last real
 * close before that day. The walk is seeded by the symbol and the date, so
 * every reload and every player sees the same prices. It has no drift and no
 * pull back to the start price, so waiting gives no edge.
 *
 * Markets keep their real regular hours in their own time zone. Every session
 * falls inside one UTC day, the same day as the game's date. Crypto trades
 * the whole UTC day, every day; commodity futures the whole UTC day on
 * weekdays.
 *
 * Pure functions, no DOM, so they can be tested in plain node.
 */

const GameIntraday = (() => {
  const STEP_SECONDS = 10;
  // shortcut: the simulated day moves twice as much as the asset's real days, so there is more to trade on; set it to 1 for real volatility.
  const VOLATILITY_MULTIPLIER = 2;
  const VOLATILITY_DAYS = 60;
  // Daily volatility when an asset has too little history, and the range it is kept in.
  const DEFAULT_DAILY_VOLATILITY = 0.02;
  const MIN_DAILY_VOLATILITY = 0.005;
  const MAX_DAILY_VOLATILITY = 0.15;

  // shortcut: regular hours only, no lunch breaks (Tokyo, Hong Kong) and no exchange holidays; add a holiday calendar when it matters.
  const MARKETS = {
    CH: { label: 'SIX SWISS EXCHANGE', timeZone: 'Europe/Zurich', opens: '09:00', closes: '17:30' },
    DE: { label: 'XETRA', timeZone: 'Europe/Berlin', opens: '09:00', closes: '17:30' },
    FR: { label: 'EURONEXT PARIS', timeZone: 'Europe/Paris', opens: '09:00', closes: '17:30' },
    IT: { label: 'BORSA ITALIANA', timeZone: 'Europe/Rome', opens: '09:00', closes: '17:30' },
    GB: { label: 'LONDON STOCK EXCHANGE', timeZone: 'Europe/London', opens: '08:00', closes: '16:30' },
    US: { label: 'NEW YORK', timeZone: 'America/New_York', opens: '09:30', closes: '16:00' },
    JP: { label: 'TOKYO', timeZone: 'Asia/Tokyo', opens: '09:00', closes: '15:30' },
    HK: { label: 'HONG KONG', timeZone: 'Asia/Hong_Kong', opens: '09:30', closes: '16:00' },
    KR: { label: 'KOREA EXCHANGE', timeZone: 'Asia/Seoul', opens: '09:00', closes: '15:30' },
    IN: { label: 'NSE INDIA', timeZone: 'Asia/Kolkata', opens: '09:15', closes: '15:30' },
    CRYPTO: { label: 'CRYPTO', timeZone: 'UTC', opens: '00:00', closes: '24:00', weekends: true },
    FUTURES: { label: 'FUTURES', timeZone: 'UTC', opens: '00:00', closes: '24:00' },
  };

  // The market an asset trades on: `region` is the listing region of a stock or ETF (CH, US, ...).
  function marketOf(assetClass, region) {
    if (assetClass === 'crypto') return 'CRYPTO';
    if (assetClass === 'metal') return 'FUTURES';
    if (assetClass === 'stock' || assetClass === 'etf') return MARKETS[region] ? region : 'US';
    return null;
  }

  const formatters = {};
  // How far ahead of UTC the zone's clock is at `utcMs`, in ms.
  function zoneOffsetMs(timeZone, utcMs) {
    const formatter = formatters[timeZone] || (formatters[timeZone] = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    const parts = {};
    formatter.formatToParts(new Date(utcMs)).forEach((part) => { parts[part.type] = Number(part.value); });
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(utcMs / 1000) * 1000;
  }

  // The UTC time of a wall clock time ('09:30', '24:00') on `date` in `timeZone`.
  function zonedTimeMs(date, time, timeZone) {
    const [hours, minutes] = time.split(':').map(Number);
    const wallMs = Date.parse(date + 'T00:00:00Z') + (hours * 60 + minutes) * 60000;
    const guessMs = wallMs - zoneOffsetMs(timeZone, wallMs);
    return wallMs - zoneOffsetMs(timeZone, guessMs);
  }

  // The trading session of a market on a UTC date, or null when it is closed that day.
  function session(market, date) {
    const hours = MARKETS[market];
    if (!hours) return null;
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
    if (!hours.weekends && (weekday === 0 || weekday === 6)) return null;
    return {
      market: market, date: date,
      opensAt: new Date(zonedTimeMs(date, hours.opens, hours.timeZone)).toISOString(),
      closesAt: new Date(zonedTimeMs(date, hours.closes, hours.timeZone)).toISOString(),
    };
  }

  // The session open at `nowMs`, else the next one to open, within a week.
  function currentOrNextSession(market, nowMs) {
    for (let days = 0; days <= 7; days++) {
      const date = new Date(nowMs + days * 86400000).toISOString().split('T')[0];
      const found = session(market, date);
      if (found && Date.parse(found.closesAt) > nowMs) return found;
    }
    return null;
  }

  function stepCount(daySession) {
    return Math.round((Date.parse(daySession.closesAt) - Date.parse(daySession.opensAt)) / 1000 / STEP_SECONDS);
  }

  // Standard deviation of the daily log returns of the last closes, or the default with too little history.
  function dailyVolatility(closes) {
    const prices = (closes || []).filter((close) => close > 0).slice(-(VOLATILITY_DAYS + 1));
    const returns = prices.slice(1).map((close, index) => Math.log(close / prices[index]));
    if (returns.length < 10) return DEFAULT_DAILY_VOLATILITY;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (returns.length - 1);
    return Math.min(MAX_DAILY_VOLATILITY, Math.max(MIN_DAILY_VOLATILITY, Math.sqrt(variance)));
  }

  // Deterministic random numbers in [0, 1) for a text: an FNV-1a hash seeds a mulberry32 generator.
  function seededRandom(text) {
    let state = 2166136261;
    for (let index = 0; index < text.length; index++) state = Math.imul(state ^ text.charCodeAt(index), 16777619);
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One simulated trading day of an asset on a UTC date: its session and one CHF price per step from the
  // open to the close (steps + 1 prices). `closes` are the real daily closes up to the day before. Null when closed.
  function tradingDay(symbol, market, date, anchorPriceChf, closes) {
    const daySession = session(market, date);
    if (!daySession || !(anchorPriceChf > 0)) return null;
    const steps = stepCount(daySession);
    const stepVolatility = dailyVolatility(closes) * VOLATILITY_MULTIPLIER / Math.sqrt(steps);
    // Minus half the variance keeps the expected price at the start price.
    const drift = -stepVolatility * stepVolatility / 2;
    const random = seededRandom(symbol + ':' + date);
    const prices = new Float64Array(steps + 1);
    let logPrice = Math.log(anchorPriceChf);
    prices[0] = anchorPriceChf;
    for (let step = 1; step <= steps; step++) {
      // Box-Muller: two uniform numbers give one normal one.
      const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
      logPrice += drift + stepVolatility * normal;
      prices[step] = Math.exp(logPrice);
    }
    return { symbol: symbol, session: daySession, anchorPriceChf: anchorPriceChf, prices: prices };
  }

  // The step reached at `nowMs`: 0 before the open, the last step after the close.
  function stepAt(day, nowMs) {
    const step = Math.floor((nowMs - Date.parse(day.session.opensAt)) / 1000 / STEP_SECONDS);
    return Math.min(day.prices.length - 1, Math.max(0, step));
  }

  function priceAt(day, nowMs) {
    return day.prices[stepAt(day, nowMs)];
  }

  function isOpen(daySession, nowMs) {
    return !!daySession && nowMs >= Date.parse(daySession.opensAt) && nowMs < Date.parse(daySession.closesAt);
  }

  return {
    STEP_SECONDS, VOLATILITY_MULTIPLIER, MARKETS,
    marketOf, session, currentOrNextSession, stepCount, dailyVolatility, tradingDay, stepAt, priceAt, isOpen,
  };
})();

if (typeof module !== 'undefined') module.exports = GameIntraday;

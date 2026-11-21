/* ===== Randata history health checks =====
 *
 * Pure helpers for the Randata console (randata.html): judges whether one
 * symbol's stored bars cover the 10-year window Randata promises. The rule
 * mirrors Randata's own backfill check (app/ingestion.py _has_full_history):
 * the history must start within HISTORY_GRACE_DAYS of max(today - 10 years,
 * inception date), so young listings are not flagged for missing years.
 */

const RandataHealth = (() => {
  const HISTORY_YEARS = 10;
  const HISTORY_GRACE_DAYS = 14;
  // Longer than a weekend plus a public holiday, so equities do not flag on Mondays.
  const STALE_AFTER_DAYS = 5;
  // Same tolerance as the start check: a hole this long means missing bars, not a market closure.
  const LARGEST_NORMAL_GAP_DAYS = HISTORY_GRACE_DAYS;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function dayNumber(dateText) {
    return Math.floor(new Date(String(dateText).slice(0, 10) + 'T00:00:00Z').getTime() / DAY_MS);
  }

  function dateFromDayNumber(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }

  // Earliest date the history should reach: the 10-year window start, or the
  // inception date when the asset started trading later.
  function expectedStart(today, inceptionDate) {
    const windowStart = dayNumber(today) - 365 * HISTORY_YEARS;
    const inception = inceptionDate ? dayNumber(inceptionDate) : null;
    return dateFromDayNumber(inception !== null && inception > windowStart ? inception : windowStart);
  }

  // bars: date-ascending [{ date, ... }]. Returns the coverage facts plus a list
  // of problems; an empty list means the symbol is healthy.
  function coverage(bars, today, inceptionDate) {
    const list = (bars || []).filter((bar) => bar && bar.date);
    const expected = expectedStart(today, inceptionDate);
    if (!list.length) {
      return { rows: 0, firstDate: null, lastDate: null, years: 0, largestGapDays: 0, expectedStart: expected, problems: ['no data'] };
    }
    const firstDate = list[0].date;
    const lastDate = list[list.length - 1].date;
    let largestGapDays = 0;
    for (let index = 1; index < list.length; index++) {
      const gap = dayNumber(list[index].date) - dayNumber(list[index - 1].date);
      if (gap > largestGapDays) largestGapDays = gap;
    }
    const problems = [];
    if (dayNumber(firstDate) > dayNumber(expected) + HISTORY_GRACE_DAYS) problems.push('starts ' + firstDate + ', expected ' + expected);
    if (largestGapDays > LARGEST_NORMAL_GAP_DAYS) problems.push('gap of ' + largestGapDays + ' days');
    if (dayNumber(today) - dayNumber(lastDate) > STALE_AFTER_DAYS) problems.push('stale since ' + lastDate);
    return {
      rows: list.length,
      firstDate: firstDate,
      lastDate: lastDate,
      years: Math.round(((dayNumber(lastDate) - dayNumber(firstDate)) / 365.25) * 10) / 10,
      largestGapDays: largestGapDays,
      expectedStart: expected,
      problems: problems
    };
  }

  return { coverage, expectedStart, HISTORY_YEARS, STALE_AFTER_DAYS };
})();

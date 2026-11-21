// Randata console coverage rule: js/randata-health.js
const { loadScripts, test, assert } = require('./helpers');

const { RandataHealth } = loadScripts(['js/randata-health.js'], ['RandataHealth']);
const today = '2026-11-20';

// Weekday bars from `from` to `to`, skipping weekends like an equity series.
function weekdayBars(from, to) {
  const bars = [];
  for (let day = new Date(from + 'T00:00:00Z'); day <= new Date(to + 'T00:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) bars.push({ date: day.toISOString().slice(0, 10), close: 1 });
  }
  return bars;
}

test('a full 10-year weekday series has no problems', () => {
  const result = RandataHealth.coverage(weekdayBars('2016-11-23', today), today, null);
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.firstDate, '2016-11-23');
  assert.strictEqual(result.largestGapDays, 3);
  assert.strictEqual(result.years, 10);
});

test('history starting years after the window start is flagged as short', () => {
  const result = RandataHealth.coverage(weekdayBars('2021-01-04', today), today, null);
  assert.strictEqual(result.problems.length, 1);
  assert.ok(result.problems[0].startsWith('starts 2021-01-04'), result.problems[0]);
});

test('a young listing is judged from its inception date, not the 10-year window', () => {
  const result = RandataHealth.coverage(weekdayBars('2021-01-04', today), today, '2021-01-04');
  assert.deepStrictEqual(result.problems, []);
  assert.strictEqual(result.expectedStart, '2021-01-04');
});

test('an inception older than the window keeps the window start', () => {
  assert.strictEqual(RandataHealth.expectedStart(today, '1990-01-01'), RandataHealth.expectedStart(today, null));
});

test('a month-long hole and an old last bar are both reported', () => {
  const bars = weekdayBars('2016-11-23', '2020-03-01').concat(weekdayBars('2020-04-15', '2026-11-10'));
  const result = RandataHealth.coverage(bars, today, null);
  // Last bar before the hole is Friday 2020-02-28, the next one Wednesday 2020-04-15.
  assert.deepStrictEqual(result.problems, ['gap of 47 days', 'stale since 2026-11-10']);
});

test('a symbol without bars reports no data', () => {
  const result = RandataHealth.coverage([], today, null);
  assert.deepStrictEqual(result.problems, ['no data']);
  assert.strictEqual(result.rows, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatDay, formatDateTime, formatTime, singaporeDateKey, singaporeDayDiff, addCalendarDays, normalizeDateInput } from "../app/utils/date.js";

test("Singapore midnight and year rollover use the correct calendar date", () => {
  assert.equal(formatDate("2026-10-13T16:00:00Z"), "14 Oct 2026");
  assert.equal(formatDateTime("2026-12-31T16:00:00Z"), "1 Jan 2027, 00:00");
  assert.equal(formatTime("2026-10-14T06:30:00Z"), "14:30");
  assert.equal(singaporeDateKey("2026-10-13T16:00:00Z"), "2026-10-14");
});

test("date-only and unzoned wall times belong to Singapore", () => {
  assert.equal(formatDay("2026-10-14"), "14 Oct 2026");
  assert.equal(formatDateTime("2026-10-14T00:30"), "14 Oct 2026, 00:30");
  assert.equal(formatDateTime("2026-10-14 14:30:00"), "14 Oct 2026, 14:30");
  assert.equal(formatDate("2026-09-01"), "1 Sep 2026");
  assert.equal(formatDate("14 Oct 2026"), "14 Oct 2026");
  assert.equal(formatDate("Oct 14, 2026"), "14 Oct 2026");
});

test("empty or invalid dates use the requested fallback", () => {
  for (const value of [null, undefined, "", "bad date", "2026-02-30", "2026-02-30T00:00:00Z", "31 Feb 2026", new Date(NaN)]) {
    assert.equal(formatDate(value), "—");
    assert.equal(formatDay(value, ""), "");
    assert.equal(formatDateTime(value), "—");
    assert.equal(singaporeDayDiff(value), null);
  }
  assert.equal(formatDate(0), "1 Jan 1970");
});

test("due status counts Singapore days, not elapsed 24-hour periods", () => {
  assert.equal(singaporeDayDiff("2026-10-14T15:59:00Z", "2026-10-13T16:00:00Z"), 0);
  assert.equal(singaporeDayDiff("2026-10-14T16:00:00Z", "2026-10-14T15:59:00Z"), 1);
  assert.equal(singaporeDayDiff("2026-10-13", "2026-10-14T00:00:00+08:00"), -1);
});

test("calendar shortcuts work over year rollover and machine DST", () => {
  assert.equal(singaporeDateKey(addCalendarDays("2026-12-31T16:30:00Z", 1)), "2027-01-02");
  assert.equal(addCalendarDays("2026-03-07T16:30:00Z", 2), "2026-03-09T16:30:00.000Z");
  assert.equal(normalizeDateInput("14 Oct 2026"), "2026-10-14");
  assert.equal(normalizeDateInput("31 Feb 2026"), "31 Feb 2026");
});

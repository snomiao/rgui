import { describe, expect, test } from "bun:test";
import {
  expandRrule,
  parseIcs,
  parseIcsDate,
  parseIcsDuration,
  serializeIcs,
  unfoldLines,
} from "./ics.js";

const DAY = 86400_000;

describe("unfoldLines", () => {
  test("continuation lines rejoin, CRLF or LF", () => {
    expect(unfoldLines("SUMMARY:Hello\r\n  world\r\nUID:x")).toEqual([
      "SUMMARY:Hello world",
      "UID:x",
    ]);
    expect(unfoldLines("A:1\n B:not-a-line")).toEqual(["A:1B:not-a-line"]);
  });
});

describe("parseIcsDate", () => {
  test("UTC, all-day, floating", () => {
    expect(parseIcsDate("20260720T120000Z")).toEqual({
      ms: Date.UTC(2026, 6, 20, 12),
      allDay: false,
    });
    expect(parseIcsDate("20260720", {})).toEqual({
      ms: Date.UTC(2026, 6, 20),
      allDay: true,
    });
    const local = parseIcsDate("20260720T090000", {});
    expect(local?.ms).toBe(new Date(2026, 6, 20, 9).getTime());
  });
  test("TZID converts wall time to the zone's UTC instant", () => {
    // 09:00 in New York on 2026-07-20 (EDT, UTC-4) = 13:00Z
    const d = parseIcsDate("20260720T090000", { TZID: "America/New_York" });
    expect(d?.ms).toBe(Date.UTC(2026, 6, 20, 13));
    // and in winter (EST, UTC-5) = 14:00Z — DST handled
    const w = parseIcsDate("20260120T090000", { TZID: "America/New_York" });
    expect(w?.ms).toBe(Date.UTC(2026, 0, 20, 14));
  });
});

describe("parseIcsDuration", () => {
  test("common shapes", () => {
    expect(parseIcsDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseIcsDuration("P1D")).toBe(DAY);
    expect(parseIcsDuration("P1W")).toBe(7 * DAY);
    expect(parseIcsDuration("bogus")).toBeNull();
  });
});

describe("expandRrule", () => {
  const start = Date.UTC(2026, 6, 1, 10); // Wed Jul 1 2026 10:00Z
  test("DAILY with COUNT", () => {
    const out = expandRrule("FREQ=DAILY;COUNT=3", start, 0, Infinity);
    expect(out).toEqual([start, start + DAY, start + 2 * DAY]);
  });
  test("WEEKLY BYDAY keeps time-of-day and weekday set", () => {
    const out = expandRrule("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", start, 0, Infinity)!;
    expect(out.length).toBe(4);
    for (const ms of out) {
      const d = new Date(ms);
      expect([1, 3]).toContain(d.getUTCDay());
      expect(d.getUTCHours()).toBe(10);
    }
    expect(out[0]).toBe(start); // Jul 1 IS a Wednesday
  });
  test("MONTHLY skips short months for day-31 starts", () => {
    const s31 = Date.UTC(2026, 0, 31, 9);
    const out = expandRrule("FREQ=MONTHLY;COUNT=3", s31, 0, Infinity)!;
    for (const ms of out) expect(new Date(ms).getUTCDate()).toBe(31);
  });
  test("UNTIL bounds and unsupported rules return null", () => {
    const out = expandRrule(`FREQ=DAILY;UNTIL=${"20260703T000000Z"}`, start, 0, Infinity)!;
    expect(out.length).toBe(2); // Jul 1, Jul 2 10:00 — Jul 3 10:00 is past UNTIL
    expect(expandRrule("FREQ=YEARLY", start, 0, Infinity)).toBeNull();
    expect(expandRrule("FREQ=MONTHLY;BYDAY=2MO", start, 0, Infinity)).toBeNull();
  });
});

describe("parseIcs / serializeIcs", () => {
  const SAMPLE = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "X-WR-CALNAME:Work",
    "BEGIN:VEVENT",
    "UID:one@x",
    "DTSTART:20260721T130000Z",
    "DTEND:20260721T140000Z",
    "SUMMARY:Standup\\, weekly",
    "LOCATION:Room 1",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:two@x",
    "DTSTART;VALUE=DATE:20260722",
    "SUMMARY:Offsite",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:rec@x",
    "DTSTART:20260720T090000Z",
    "DTEND:20260720T093000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "EXDATE:20260721T090000Z",
    "SUMMARY:Daily sync",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  test("parses names, escaping, all-day default end, recurrence + EXDATE", () => {
    const cal = parseIcs(SAMPLE, { fromMs: 0, toMs: Date.UTC(2027, 0, 1) });
    expect(cal.name).toBe("Work");
    const standup = cal.events.find((e) => e.uid === "one@x")!;
    expect(standup.summary).toBe("Standup, weekly");
    expect(standup.endMs - standup.startMs).toBe(3600_000);
    const offsite = cal.events.find((e) => e.uid === "two@x")!;
    expect(offsite.allDay).toBe(true);
    expect(offsite.endMs - offsite.startMs).toBe(DAY);
    const syncs = cal.events.filter((e) => e.uid.startsWith("rec@x"));
    expect(syncs.length).toBe(2); // 3 instances minus the EXDATE'd one
    expect(syncs.every((e) => e.endMs - e.startMs === 1800_000)).toBe(true);
  });

  test("roundtrip: serialize → parse preserves events", () => {
    const cal = parseIcs(SAMPLE, { fromMs: 0, toMs: Date.UTC(2027, 0, 1) });
    const text = serializeIcs(cal.events, "Round");
    const back = parseIcs(text, { fromMs: 0, toMs: Date.UTC(2027, 0, 1) });
    expect(back.name).toBe("Round");
    expect(back.events.length).toBe(cal.events.length);
    const a = back.events.find((e) => e.summary === "Standup, weekly")!;
    expect(a.startMs).toBe(Date.UTC(2026, 6, 21, 13));
  });

  test("RECURRENCE-ID overrides replace their instance (Google-style)", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:std@x",
      "DTSTART:20260706T090000Z",
      "DTEND:20260706T093000Z",
      "RRULE:FREQ=DAILY;COUNT=4",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT", // moved + renamed 2nd instance
      "UID:std@x",
      "RECURRENCE-ID:20260707T090000Z",
      "DTSTART:20260707T140000Z",
      "DTEND:20260707T143000Z",
      "SUMMARY:Standup (moved)",
      "END:VEVENT",
      "BEGIN:VEVENT", // cancelled 3rd instance
      "UID:std@x",
      "RECURRENCE-ID:20260708T090000Z",
      "DTSTART:20260708T090000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const cal = parseIcs(text, { fromMs: 0, toMs: Date.UTC(2027, 0, 1) });
    const starts = cal.events.map((e) => new Date(e.startMs).toISOString().slice(0, 13)).sort();
    // 4 instances − 1 cancelled = 3; the moved one sits at 14:00, no 09:00 dupe
    expect(cal.events.length).toBe(3);
    expect(starts).toEqual(["2026-07-06T09", "2026-07-07T14", "2026-07-09T09"]);
    const moved = cal.events.find((e) => e.summary === "Standup (moved)")!;
    expect(moved.endMs - moved.startMs).toBe(1800_000);
    // uid keys stay unique
    expect(new Set(cal.events.map((e) => e.uid)).size).toBe(3);
  });

  test("orphan overrides (master missing) emit standalone", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:orphan@x",
      "RECURRENCE-ID:20260701T100000Z",
      "DTSTART:20260701T110000Z",
      "DTEND:20260701T113000Z",
      "SUMMARY:Rescheduled thing",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const cal = parseIcs(text, { fromMs: 0, toMs: Date.UTC(2027, 0, 1) });
    expect(cal.events.length).toBe(1);
    expect(cal.events[0]!.startMs).toBe(Date.UTC(2026, 6, 1, 11));
  });

  test("long summaries fold at 74 chars and unfold back", () => {
    const long = "x".repeat(200);
    const text = serializeIcs([
      { uid: "l", summary: long, startMs: 0, endMs: 3600_000, allDay: false },
    ]);
    expect(text.split("\r\n").every((l) => l.length <= 74)).toBe(true);
    const back = parseIcs(text, { fromMs: -DAY, toMs: DAY });
    expect(back.events[0]!.summary).toBe(long);
  });
});

/**
 * Minimal iCalendar (RFC 5545) codec for the calendar demo — pure data, no
 * I/O. Parses the common real-world subset honestly and marks what it can't
 * expand rather than inventing dates:
 *
 *   • line unfolding / folding, text escaping
 *   • VEVENT: UID, SUMMARY, LOCATION, DESCRIPTION, DTSTART/DTEND
 *     (date-time, all-day VALUE=DATE, UTC "Z", TZID via Intl best-effort,
 *     floating = local), DURATION fallback
 *   • RRULE: simple FREQ=DAILY/WEEKLY/MONTHLY with INTERVAL/COUNT/UNTIL and
 *     WEEKLY BYDAY, expanded inside a caller-given horizon (cap 500
 *     instances); anything gnarlier keeps the first instance flagged
 *     `recurring` instead of silently-wrong dates
 *   • EXDATE (exact-instant removal)
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** RRULE was present but too complex to expand — first instance only */
  recurring?: boolean;
}

export interface IcsCalendar {
  /** X-WR-CALNAME when present */
  name?: string;
  events: IcsEvent[];
}

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// ── line-level ────────────────────────────────────────────────────────────

/** RFC 5545 §3.1 — a CRLF followed by space/tab continues the line */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length) {
      out.push(raw);
    }
  }
  return out;
}

/** NAME;PARAM=a;OTHER=b:value → { name, params, value } */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  // find the ':' that ends the name+params section (params may contain
  // quoted strings holding ':')
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params, value };
}

const unescapeText = (s: string): string =>
  s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const escapeText = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");

// ── date-times ────────────────────────────────────────────────────────────

/** UTC offset (ms) of an IANA zone at a given instant, via Intl */
export function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** parse an ICS date/date-time value to Unix ms; allDay for VALUE=DATE */
export function parseIcsDate(
  value: string,
  params: Record<string, string> = {},
): { ms: number; allDay: boolean } | null {
  const mDate = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (params["VALUE"] === "DATE" || mDate) {
    const m = mDate ?? /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return null;
    return { ms: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +m[6]!];
  if (m[7] === "Z") return { ms: Date.UTC(y, mo - 1, d, hh, mm, ss), allDay: false };
  const tz = params["TZID"];
  if (tz) {
    try {
      // interpret the wall time in tz: guess UTC, correct by the zone's
      // offset at the guess, refine once for DST boundaries
      const naive = Date.UTC(y, mo - 1, d, hh, mm, ss);
      let ms = naive - zoneOffsetMs(naive, tz);
      ms = naive - zoneOffsetMs(ms, tz);
      return { ms, allDay: false };
    } catch {
      /* unknown zone → fall through to local */
    }
  }
  // floating time → viewer's local zone (documented best-effort)
  return { ms: new Date(y, mo - 1, d, hh, mm, ss).getTime(), allDay: false };
}

/** basic ISO-8601 duration (PnW / PnDTnHnMnS subset) → ms */
export function parseIcsDuration(value: string): number | null {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const ms =
    (+(m[2] ?? 0)) * 7 * DAY_MS +
    (+(m[3] ?? 0)) * DAY_MS +
    (+(m[4] ?? 0)) * HOUR_MS +
    (+(m[5] ?? 0)) * 60_000 +
    (+(m[6] ?? 0)) * 1000;
  return m[1] ? -ms : ms;
}

// ── RRULE (simple subset) ─────────────────────────────────────────────────

const BYDAY_NUM: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Expand a simple RRULE within [fromMs, toMs]. Returns null when the rule is
 * beyond the supported subset (caller keeps the first instance + a flag).
 */
export function expandRrule(
  rule: string,
  startMs: number,
  fromMs: number,
  toMs: number,
  cap = 500,
): number[] | null {
  const parts: Record<string, string> = {};
  for (const kv of rule.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  const freq = parts["FREQ"];
  const interval = Math.max(1, +(parts["INTERVAL"] ?? 1) || 1);
  const count = parts["COUNT"] ? +parts["COUNT"] : Infinity;
  let untilMs = Infinity;
  if (parts["UNTIL"]) {
    const u = parseIcsDate(parts["UNTIL"]);
    if (u) untilMs = u.ms + (u.allDay ? DAY_MS - 1 : 0);
  }
  const unsupported = Object.keys(parts).filter(
    (k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"].includes(k),
  );
  if (unsupported.length) return null;
  if (parts["BYDAY"] && freq !== "WEEKLY") return null; // BYDAY beyond WEEKLY unsupported
  // every branch walks candidate instants in order and stops on the FIRST
  // terminal condition — past UNTIL, past the horizon, count/cap reached —
  // so an open horizon plus an UNTIL (or vice versa) always terminates
  const maxEmit = Math.min(cap, count);
  const out: number[] = [];
  const collect = (candidates: () => Generator<number>): number[] => {
    let emitted = 0;
    for (const ms of candidates()) {
      if (ms > untilMs || ms > toMs || emitted >= maxEmit) break;
      emitted++;
      if (ms >= fromMs) out.push(ms);
    }
    return out;
  };
  if (freq === "DAILY") {
    return collect(function* () {
      for (let i = 0; ; i++) yield startMs + i * interval * DAY_MS;
    });
  }
  if (freq === "WEEKLY") {
    const days = parts["BYDAY"]
      ? parts["BYDAY"].split(",").map((d) => BYDAY_NUM[d])
      : [new Date(startMs).getUTCDay()];
    if (days.some((d) => d === undefined)) return null; // ordinal BYDAY (2MO…)
    const sorted = [...(days as number[])].sort((a, b) => a - b);
    const startDay = new Date(startMs).getUTCDay();
    const weekStart = startMs - startDay * DAY_MS; // Sunday-aligned, keeps time-of-day
    return collect(function* () {
      for (let w = 0; ; w += interval)
        for (const d of sorted) {
          const ms = weekStart + w * 7 * DAY_MS + d * DAY_MS;
          if (ms >= startMs) yield ms;
        }
    });
  }
  if (freq === "MONTHLY") {
    const s = new Date(startMs);
    const dom = s.getUTCDate();
    return collect(function* () {
      for (let i = 0; ; i += interval) {
        const base = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + i, dom, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()));
        if (base.getUTCDate() === dom) yield base.getTime(); // short months skip day-31
      }
    });
  }
  return null;
}

// ── document parse / serialize ────────────────────────────────────────────

type ProtoEvent = Partial<IcsEvent> & {
  rrule?: string;
  durMs?: number;
  exdates?: Set<number>;
  /** RECURRENCE-ID: this VEVENT overrides ONE instance of the same-UID series */
  recurrenceId?: number;
  cancelled?: boolean;
};

export function parseIcs(
  text: string,
  opts: { fromMs?: number; toMs?: number } = {},
): IcsCalendar {
  const fromMs = opts.fromMs ?? Date.now() - 2 * 365 * DAY_MS;
  const toMs = opts.toMs ?? Date.now() + 2 * 365 * DAY_MS;
  const lines = unfoldLines(text);
  const cal: IcsCalendar = { events: [] };

  // pass 1 — collect every VEVENT as a proto record
  const protos: ProtoEvent[] = [];
  let ev: ProtoEvent | null = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "X-WR-CALNAME") cal.name = unescapeText(p.value).trim();
    else if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") ev = {};
    else if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      if (ev && ev.startMs !== undefined) protos.push(ev);
      ev = null;
    } else if (ev) {
      if (p.name === "UID") ev.uid = p.value.trim();
      else if (p.name === "SUMMARY") ev.summary = unescapeText(p.value).trim();
      else if (p.name === "LOCATION") ev.location = unescapeText(p.value).trim();
      else if (p.name === "DESCRIPTION") ev.description = unescapeText(p.value).trim();
      else if (p.name === "STATUS") ev.cancelled = p.value.trim().toUpperCase() === "CANCELLED";
      else if (p.name === "RECURRENCE-ID") {
        const d = parseIcsDate(p.value.trim(), p.params);
        if (d) ev.recurrenceId = d.ms;
      } else if (p.name === "DTSTART") {
        const d = parseIcsDate(p.value.trim(), p.params);
        if (d) {
          ev.startMs = d.ms;
          ev.allDay = d.allDay;
        }
      } else if (p.name === "DTEND") {
        const d = parseIcsDate(p.value.trim(), p.params);
        if (d) ev.endMs = d.ms;
      } else if (p.name === "DURATION") {
        ev.durMs = parseIcsDuration(p.value.trim()) ?? undefined;
      } else if (p.name === "RRULE") ev.rrule = p.value.trim();
      else if (p.name === "EXDATE") {
        for (const v of p.value.split(",")) {
          const d = parseIcsDate(v.trim(), p.params);
          if (d) (ev.exdates ??= new Set()).add(d.ms);
        }
      }
    }
  }

  // pass 2 — emit. Overrides (same UID + RECURRENCE-ID) REPLACE the matching
  // expanded instance of their series (Google exports every edited instance
  // of a recurring event this way); STATUS:CANCELLED overrides delete it;
  // overrides whose master never expanded (outside horizon, unsupported
  // rule, partial export) emit standalone rather than vanishing.
  let uidSeq = 0;
  const finish = (p: ProtoEvent, uid: string): IcsEvent => {
    const allDay = p.allDay ?? false;
    const endMs =
      p.endMs ??
      (p.durMs != null ? p.startMs! + p.durMs : p.startMs! + (allDay ? DAY_MS : HOUR_MS));
    return {
      uid,
      summary: p.summary ?? "(untitled)",
      location: p.location,
      description: p.description,
      startMs: p.startMs!,
      endMs,
      allDay,
    };
  };
  const ovByUid = new Map<string, Map<number, ProtoEvent>>();
  for (const p of protos) {
    if (p.recurrenceId === undefined || !p.uid) continue;
    let m = ovByUid.get(p.uid);
    if (!m) ovByUid.set(p.uid, (m = new Map()));
    m.set(p.recurrenceId, p);
  }
  const consumed = new Set<ProtoEvent>();
  for (const p of protos) {
    if (p.recurrenceId !== undefined) continue; // overrides emit via masters
    const uid = p.uid ?? `ics-${++uidSeq}`;
    const overrides = p.uid ? ovByUid.get(p.uid) : undefined;
    if (p.rrule) {
      const starts = expandRrule(p.rrule, p.startMs!, fromMs, toMs);
      if (starts === null) {
        if (!p.cancelled) cal.events.push({ ...finish(p, uid), recurring: true });
        continue;
      }
      const dur = (p.endMs ?? p.startMs! + (p.durMs ?? (p.allDay ? DAY_MS : HOUR_MS))) - p.startMs!;
      let i = 0;
      for (const s of starts) {
        if (p.exdates?.has(s)) continue;
        const ov = overrides?.get(s);
        if (ov) {
          consumed.add(ov);
          if (!ov.cancelled) cal.events.push(finish(ov, `${uid}#r${s}`));
          continue;
        }
        cal.events.push({ ...finish(p, `${uid}#${i++}`), startMs: s, endMs: s + dur });
      }
      continue;
    }
    if (p.cancelled || p.exdates?.has(p.startMs!)) continue;
    // even a non-recurring master can be overridden (degenerate but legal)
    const ov = overrides?.get(p.startMs!);
    if (ov) {
      consumed.add(ov);
      if (!ov.cancelled) cal.events.push(finish(ov, `${uid}#r${p.startMs}`));
      continue;
    }
    cal.events.push(finish(p, uid));
  }
  for (const p of protos) {
    if (p.recurrenceId === undefined || consumed.has(p) || p.cancelled) continue;
    const uid = p.uid ?? `ics-${++uidSeq}`;
    cal.events.push(finish(p, `${uid}#r${p.recurrenceId}`)); // orphan override
  }
  return cal;
}

const two = (n: number) => String(n).padStart(2, "0");
const icsUtc = (ms: number) => {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}` +
    `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
  );
};
const icsDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
};

/** fold a content line at 74 chars per RFC 5545 §3.1 */
function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const chunks: string[] = [line.slice(0, 74)];
  for (let i = 74; i < line.length; i += 73) chunks.push(" " + line.slice(i, i + 73));
  return chunks.join("\r\n");
}

export function serializeIcs(events: readonly IcsEvent[], name = "rgui calendar"): string {
  const now = icsUtc(Date.now());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//snomiao//rgui-calendar//EN",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${e.uid}`);
    lines.push(`DTSTAMP:${now}`);
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startMs)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(e.endMs)}`);
    } else {
      lines.push(`DTSTART:${icsUtc(e.startMs)}`);
      lines.push(`DTEND:${icsUtc(e.endMs)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

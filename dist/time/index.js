export const LAYERS = ["day", "week", "month", "year"];
export const systemClock = () => new Date();
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;
function zoneOf(config) {
    return config.timezone === "local" ? undefined : config.timezone;
}
/** Wall-clock parts of an instant in the configured zone. */
export function wallClock(instant, config) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zoneOf(config),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(instant);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`,
        seconds: get("second"),
    };
}
/** The atlas day an instant belongs to, applying the day boundary. */
export function dayOf(instant, config) {
    const { date, time } = wallClock(instant, config);
    return time < config.dayBoundary ? previousDay(date) : date;
}
function toUtc(day) {
    const m = DAY_RE.exec(day);
    if (!m)
        throw new Error(`Not a day id: ${day}`);
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function fromUtc(d) {
    return d.toISOString().slice(0, 10);
}
export function addDays(day, n) {
    const d = toUtc(day);
    d.setUTCDate(d.getUTCDate() + n);
    return fromUtc(d);
}
export function previousDay(day) {
    return addDays(day, -1);
}
function isoWeek(day) {
    const d = toUtc(day);
    const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - weekday + 3); // Thursday of this week
    const year = d.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(year, 0, 4));
    firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
    const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
    return { year, week };
}
/** The id of the period at `layer` that contains `day`. */
export function periodOf(layer, day) {
    switch (layer) {
        case "day":
            return day;
        case "week": {
            const { year, week } = isoWeek(day);
            return `${year}-W${String(week).padStart(2, "0")}`;
        }
        case "month":
            return day.slice(0, 7);
        case "year":
            return day.slice(0, 4);
    }
}
export function parsePeriod(id) {
    if (DAY_RE.test(id))
        return { layer: "day", id };
    if (WEEK_RE.test(id))
        return { layer: "week", id };
    if (MONTH_RE.test(id))
        return { layer: "month", id };
    if (YEAR_RE.test(id))
        return { layer: "year", id };
    throw new Error(`Not a period id: "${id}". Use 2026-10-08, 2026-W41, 2026-10 or 2026.`);
}
function mondayOfIsoWeek(year, week) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
    return addDays(fromUtc(jan4), (week - 1) * 7);
}
/** First and last day of a period, inclusive. */
export function rangeOf(id) {
    const { layer } = parsePeriod(id);
    switch (layer) {
        case "day":
            return { first: id, last: id };
        case "week": {
            const m = WEEK_RE.exec(id);
            const first = mondayOfIsoWeek(Number(m[1]), Number(m[2]));
            return { first, last: addDays(first, 6) };
        }
        case "month": {
            const m = MONTH_RE.exec(id);
            const next = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
            return { first: `${id}-01`, last: previousDay(fromUtc(next)) };
        }
        case "year":
            return { first: `${id}-01-01`, last: `${id}-12-31` };
    }
}
export function daysOf(id) {
    const { first, last } = rangeOf(id);
    const days = [];
    for (let d = first; d <= last; d = addDays(d, 1))
        days.push(d);
    return days;
}
/** A period is closed once the atlas day has moved past its last day. */
export function isClosed(id, now, config) {
    return dayOf(now, config) > rangeOf(id).last;
}
/** The period one layer up that a period rolls into, if any. */
export function parentsOf(id) {
    const { layer } = parsePeriod(id);
    const { first } = rangeOf(id);
    switch (layer) {
        case "day":
            return [periodOf("week", id), periodOf("month", id)];
        case "week":
            return [];
        case "month":
            return [periodOf("year", first)];
        case "year":
            return [];
    }
}
/** The previous period at the same layer. */
export function previousPeriod(id) {
    const { layer } = parsePeriod(id);
    return periodOf(layer, previousDay(rangeOf(id).first));
}
export function compareDays(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

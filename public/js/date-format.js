(function (global) {
  "use strict";
  function parseDate(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const raw = String(value).trim();
    // Explicitly accept day-first input without relying on the browser locale.
    const dayFirst = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?)?$/i);
    if (dayFirst) {
      let hour = Number(dayFirst[4] || 0);
      const marker = String(dayFirst[6] || "").toUpperCase();
      if (marker === "PM" && hour < 12) hour += 12;
      if (marker === "AM" && hour === 12) hour = 0;
      const date = new Date(Date.UTC(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1]), hour, Number(dayFirst[5] || 0)) - 6 * 60 * 60 * 1000);
      if (date.getUTCFullYear() !== Number(dayFirst[3]) || date.getUTCMonth() !== Number(dayFirst[2]) - 1 || date.getUTCDate() !== Number(dayFirst[1])) return null;
      return date;
    }
    // PostgreSQL DATE/ISO date-only values must be interpreted as calendar dates,
    // not as UTC instants that shift a day in Asia/Dhaka.
    const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
      const date = new Date(Date.UTC(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3])) - 6 * 60 * 60 * 1000);
      return date.getUTCFullYear() === Number(isoDate[1]) && date.getUTCMonth() === Number(isoDate[2]) - 1 && date.getUTCDate() === Number(isoDate[3]) ? date : null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function formatDate(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "2-digit", year: "numeric" }).format(date) : "—";
  }
  function formatDateTime(value) {
    const date = parseDate(value);
    if (!date) return "—";
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value || "";
    return get("day") + "/" + get("month") + "/" + get("year") + ", " + get("hour") + ":" + get("minute") + " " + get("dayPeriod").toUpperCase();
  }
  global.FazDate = Object.freeze({ parse: parseDate, formatDate: formatDate, formatDateTime: formatDateTime });
  global.formatDateTime = global.formatDateTime || formatDateTime;
  global.formatDate = global.formatDate || formatDate;
})(window);

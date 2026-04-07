// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const ENCODING = "utf-8";

export function decode(value: string): string {
  return Buffer.from(value, "base64").toString(ENCODING);
}

export function encode(value: string | Record<string, unknown>): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(str, ENCODING).toString("base64");
}

// ---------------------------------------------------------------------------
// JWT decode (no signature verification — metadata only)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  const payload = parts[1];
  if (payload === undefined) throw new Error("Invalid JWT: missing payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Date/time helpers
// ---------------------------------------------------------------------------

export function utcnow(): Date {
  return new Date();
}

/**
 * Parse a Litter-Robot API timestamp string or numeric epoch into a Date.
 * Returns null if the value is falsy.
 */
export function toTimestamp(
  timestamp: string | number | null | undefined,
): Date | null {
  if (timestamp == null || timestamp === "" || timestamp === 0) return null;

  if (typeof timestamp === "number") {
    return new Date(timestamp * 1000);
  }

  // Normalise ISO strings
  let ts = timestamp;
  if (ts.endsWith("Z")) {
    ts = ts.slice(0, -1) + "+00:00";
  } else if (!ts.includes("+") && !ts.includes("-", 10)) {
    ts += "+00:00";
  }
  // Pad sub-seconds to 6 digits
  ts = ts.replace(/(\.\d+)/, (m) => m.padEnd(7, "0").slice(0, 7));
  return new Date(ts);
}

export function roundTime(dt?: Date, roundTo = 60): Date {
  const base = dt ?? utcnow();
  const ms = roundTo * 1000;
  return new Date(Math.round(base.getTime() / ms) * ms);
}

/** Return a Date representing today (UTC) at the given hours/minutes. */
export function todayAtTime(hours: number, minutes: number): Date {
  const now = utcnow();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0),
  );
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function urljoin(base: string, subpath?: string | null): string {
  if (!subpath) return base;
  const b = base.endsWith("/") ? base : `${base}/`;
  return new URL(subpath, b).toString();
}

// ---------------------------------------------------------------------------
// Enum helpers
// ---------------------------------------------------------------------------

/**
 * Look up an enum member by value, case-insensitively.
 * Returns undefined if not found.
 */
export function toEnum<T extends Record<string, string | number>>(
  enumObj: T,
  value: unknown,
  logWarning = true,
): T[keyof T] | undefined {
  if (value == null) return undefined;

  const members = Object.values(enumObj) as Array<string | number>;

  // Direct match
  if (members.includes(value as string | number)) {
    return value as T[keyof T];
  }

  // Case-insensitive string match
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    const found = members.find(
      (m) => typeof m === "string" && m.toUpperCase() === upper,
    );
    if (found !== undefined) return found as T[keyof T];
  }

  if (logWarning) {
    console.warn(`Value '${String(value)}' not found in enum`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Litter level calculation (mirrors Python calculate_litter_level)
// ---------------------------------------------------------------------------

export function calculateLitterLevel(
  isCleaning: boolean,
  newLevel: number,
  oldLevel: number,
  expiration: Date | null,
): [number, Date | null, number] {
  const now = utcnow();
  let level = oldLevel;

  if (isCleaning) {
    expiration = new Date(now.getTime() + 60_000);
  } else if (expiration === null || expiration < now || Math.abs(oldLevel - newLevel) < 10) {
    level = newLevel;
  }

  const percent = Math.max(Math.round((100 - (level - 440) / 0.6) / 10) * 10, 0);
  return [level, expiration, percent];
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

export function pluralize(word: string, count: number): string {
  return `${count} ${word}${count !== 1 ? "s" : ""}`;
}

// ---------------------------------------------------------------------------
// Redact sensitive data
// ---------------------------------------------------------------------------

const REDACTED = "**REDACTED**";
const REDACT_FIELDS = new Set([
  "token",
  "access_token",
  "id_token",
  "idToken",
  "refresh_token",
  "refreshToken",
  "userId",
  "userEmail",
  "sessionId",
  "oneSignalPlayerId",
  "deviceId",
  "id",
  "litterRobotId",
  "unitId",
  "litterRobotSerial",
  "serial",
  "s3ImageURL",
]);

export function redact<T>(data: T): T {
  if (data === null || typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map(redact) as unknown as T;
  }

  const result: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const [key, value] of Object.entries(result)) {
    if (value == null) continue;
    if (REDACT_FIELDS.has(key)) {
      result[key] = REDACTED;
    } else if (typeof value === "object") {
      result[key] = redact(value);
    }
  }
  return result as unknown as T;
}

// ---------------------------------------------------------------------------
// dig — safely read nested keys with dot notation
// ---------------------------------------------------------------------------

export function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// firstValue — return first non-null value from a set of keys
// ---------------------------------------------------------------------------

export function firstValue(
  data: Record<string, unknown> | null | undefined,
  keys: Iterable<string>,
  defaultValue: unknown = undefined,
  returnNone = false,
): unknown {
  if (!data) return defaultValue;
  for (const key of keys) {
    if (key in data) {
      const value = data[key];
      if (value !== undefined && (value !== null || returnNone)) {
        return value;
      }
    }
  }
  return defaultValue;
}

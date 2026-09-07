/**
 * What the instance's JSON is allowed to be before this server reads it.
 *
 * Every response used to be read through a TypeScript cast, and a cast is not a
 * check: `feed/1e300` as a stream id, `1e999` as an unread count (which
 * `JSON.parse` hands over as `Infinity`), a number where a title belongs, a
 * `null` where a list belongs. None of those are what FreshRSS writes — but
 * what answers under `FRESHRSS_URL` is whatever sits there, and the output
 * schema every tool declares is enforced by the SDK: one such value made the
 * *whole* listing an "Output validation error", or a `TypeError` out of
 * `value.replace`, with no article in it.
 *
 * The helpers here decide the shape once, at the boundary. The rule for the
 * callers is: skip the element or omit the field, never answer with something
 * the schema refuses.
 */

/** The value as a plain object, or an empty one. Arrays and `null` are not objects here. */
export function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The value as an array, or an empty one. */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The value if it is a string, otherwise `undefined`. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * The value if it is a finite number, otherwise `undefined`.
 *
 * `-0` is normalised: it serialises as `0`, so a result that carried it would
 * say one thing in `structuredContent` and another in the text block.
 */
export function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value + 0
    : undefined;
}

/**
 * The value if it is a safe integer, otherwise `undefined`. What a
 * `z.number().int()` output schema accepts: zod refuses `2 ** 53` and `1e20`
 * as integers, so `Number.isInteger` alone is not the check.
 */
export function safeIntegerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value + 0
    : undefined;
}

/**
 * Unix seconds `Date` can represent: ±8.64e15 milliseconds, so ±8.64e12
 * seconds. `new Date(seconds * 1000).toISOString()` throws a `RangeError`
 * past that — for the whole listing, not the one entry.
 */
const MAX_UNIX_SECONDS = 8_640_000_000_000;

/** The value as unix seconds `toISOString` accepts, otherwise `undefined`. */
export function unixSecondsOf(value: unknown): number | undefined {
  const seconds = safeIntegerOf(value);
  return seconds !== undefined && Math.abs(seconds) <= MAX_UNIX_SECONDS
    ? seconds
    : undefined;
}

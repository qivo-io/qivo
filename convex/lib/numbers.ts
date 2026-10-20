/* Number rules shared by the server's model layer and the app. No imports,
 * so the app can import this file. */

/** Rounds to one decimal, the grain of remaining hours. At magnitudes where
 * scaling overflows, the number already has no fraction. */
export function roundTenths(value: number): number {
  const scaled = value * 10
  return Number.isFinite(scaled) ? Math.round(scaled) / 10 : value
}

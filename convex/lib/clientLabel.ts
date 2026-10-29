/* How API access names a connected app's OAuth client in a row's mono line
 * (src/lib/apiAccess.ts credentialPrefix), so the server's search
 * (apiAccess.ts page) matches the text the row shows as well as the full
 * client id. It has no server-only imports, so the app imports it too. */

/** OAuth client id `id` as a row shows it: "client " and the id, shortened
 * to its first and last four characters around "…" when it is longer than
 * twelve. */
export function clientLabel(id: string): string {
  return `client ${id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id}`
}

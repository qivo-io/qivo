/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '95a307d27959b668e91ffcf1e5c0127b78954b43228194e00f3a94b898217d37'
export const SHA_TOOLS_MODERN = '12f63ccd701604bde3d0377eebd77abc260d062d50f9b9495beadf6f9261d0dc'

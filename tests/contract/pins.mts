/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '582572b2dbaf3ef6aeec2e226da5823f6a991e2e68becef2d74abd8ee48a063c'
export const SHA_TOOLS_MODERN = '578367488a37ba0ed8ba63c31e0b1a8274763d660657db48c4bae4a95aa295c4'

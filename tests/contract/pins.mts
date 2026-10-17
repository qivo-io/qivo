/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '8c79634bc97a64eb44a0c8786e0b8814827e11a37930c863ad7d12ab8115e0e0'
export const SHA_TOOLS_MODERN = '606ab7112493780d4b0d572eeb215e14e7fa80b53ec4de816efbee1781431aaa'

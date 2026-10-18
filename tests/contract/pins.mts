/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'fdf6defb9a3ab87b336ada34afb868aeda6bbd85f3460ab2e7d1a46f5aa164b8'
export const SHA_TOOLS_MODERN = '0e98311021a3a87fdd4f2abe114fdabdf61e47e656b2e773005c567f64524487'

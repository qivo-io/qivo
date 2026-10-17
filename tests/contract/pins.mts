/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '33e21b419806342a3e1155aa8debc6c754dae4c5bd833daa704a1e040c099f6a'
export const SHA_TOOLS_MODERN = 'f546241e5a3804d22248e69114991af16dbb4309991d10f6b87044396a627321'

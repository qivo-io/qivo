/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'e045f1e5211302f543c3e351048512ea7cd39da5e63a74c664ecc2e7f1b97e00'
export const SHA_TOOLS_MODERN = '6d3673152eb89944636c3e2acbe352db09c025e18557016d3a48d00a4e02d3c2'

/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '09c0163bcde71f0741e0cced0fe0989c538d3f28145b92730d6e5153acc15f5d'
export const SHA_TOOLS_MODERN = '1cbcbac8a88abbdba963dac7c9bbf2fbabfb3003c97862d281a93cdb463e6188'

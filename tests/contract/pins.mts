/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '4a07a0ca52f39a77dd2e4c9402c47155b853c96a8d60b7661adcf91bcb5d6f76'
export const SHA_TOOLS_MODERN = '25652d8eb445bd65ea9042fcd3a21080b1a623d5c0afc915cb9eff987dcbdb97'

/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'f10301423295fdb62ddf05196740b409eb6bcc9b72a39c98f784426a768bb358'
export const SHA_TOOLS_MODERN = '4f27c22f0d614a1755265216e898e83515efdd48d9a836b511cebd1eaf8cdc47'

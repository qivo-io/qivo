/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = 'f964dbf43898f176db38e7d17ecb05c71e0c14c3966d5cd667ef3812b8e153a7'
export const SHA_TOOLS_MODERN = 'b2bdeb95453154f032d3453de7249be4c322dcb0efd5eda592aa37b47308be26'

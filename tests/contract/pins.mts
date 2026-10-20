/* Byte pins shared by the contract suites.
 *
 * The two tools/list sha256 hashes are copied VERBATIM from
 * convex/tests/mcp.test.ts (SHA_TOOLS_LEGACY / SHA_TOOLS_MODERN): the hash of
 * the legacy SSE `data:` payload (id 2) and of the whole modern JSON body (id 3).
 * If a tool's wire bytes ever change deliberately, regenerate BOTH pins there
 * first — this file only mirrors them. */

export const SHA_TOOLS_LEGACY = '9fad41ff2ac5e60b552f98af6e912da7ffaaa5b6159209f62c8d346413705a9e'
export const SHA_TOOLS_MODERN = '02e1c77fa0b4d784404c53ef8be09683f6c449d2311903c946484e75d0e44753'

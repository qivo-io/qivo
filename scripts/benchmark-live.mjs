// Read-only Northstar development workspace round trips: the workspace's one
// part (convex/workspace.ts root), read as one HTTP query; never seeds or
// modifies data. No part sends a task, so the report counts none.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { inspectBrowserDemo, loadBrowserDemo } from './browser-demo.mjs'

const demo = loadBrowserDemo('http://localhost:5199')
await inspectBrowserDemo(demo)
// Capture privately: neither the admin key nor the roster is printed.
const { stdout } = await promisify(execFile)(
  'npx',
  ['convex', 'data', 'profiles', '--limit', '100', '--format', 'json'],
  { maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CONVEX_DEPLOY_KEY: demo.target.key } },
)
const profiles = JSON.parse(stdout)
const actor = profiles.find(
  (profile) =>
    profile.email === demo.account('nora').email && profile.active && profile.org_role === 'admin',
)
assert.ok(actor?.auth_user_id, 'Northstar development admin unavailable')
const client = new ConvexHttpClient(demo.target.url, { logger: false })
client.setAdminAuth(demo.target.key, {
  subject: actor.auth_user_id,
  issuer: 'qivo-readonly-benchmark',
})
/* One part's round trip: its milliseconds and the bytes of its answer. */
const timed = async (name, args) => {
  const start = performance.now()
  const answer = await client.query(makeFunctionReference(name), args)
  return { ms: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(answer)), answer }
}
const parts = new Map()
const whole = []
let bytes = 0
for (let sample = 0; sample < 10; sample++) {
  const start = performance.now()
  const { ms, bytes: size, answer } = await timed('workspace:root', {})
  if (sample)
    parts.set('workspace:root', [...(parts.get('workspace:root') ?? []), { ms, bytes: size }])
  const elapsed = performance.now() - start
  assert.equal(answer?.orgs?.find((org) => org.id === actor.org_id)?.slug, 'northstar-labs')
  bytes = size
  if (sample) whole.push(elapsed)
}
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]
console.log(
  JSON.stringify(
    {
      kind: 'Northstar development HTTP workspace part round trips; one warmup, nine samples; includes network/cache',
      bytes,
      wholeReadMedianMs: median(whole),
      parts: Object.fromEntries(
        [...parts].map(([key, samples]) => [
          key,
          {
            medianMs: Math.round(median(samples.map((s) => s.ms))),
            maxMs: Math.round(Math.max(...samples.map((s) => s.ms))),
            bytes: samples.at(-1).bytes,
          },
        ]),
      ),
    },
    null,
    2,
  ),
)

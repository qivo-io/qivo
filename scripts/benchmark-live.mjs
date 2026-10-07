// Read-only Northstar development snapshot round trips; never seeds or modifies data.
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
const timings = []
let tasks = 0
let bytes = 0
for (let sample = 0; sample < 10; sample++) {
  const start = performance.now()
  const snapshot = await client.query(makeFunctionReference('snapshot:forMe'), {})
  const elapsed = performance.now() - start
  assert.equal(snapshot.orgs.find((org) => org.id === actor.org_id)?.slug, 'northstar-labs')
  tasks = snapshot.issues.length
  bytes = Buffer.byteLength(JSON.stringify(snapshot))
  if (sample) timings.push(elapsed)
}
const ordered = [...timings].sort((a, b) => a - b)
console.log(
  JSON.stringify(
    {
      kind: 'Northstar development HTTP snapshot round trips; one warmup, nine samples; includes network/cache',
      tasks,
      bytes,
      medianMs: ordered[4],
      maxMs: ordered[8],
      samplesMs: timings,
    },
    null,
    2,
  ),
)

/* Live OAuth browser drive. Requires the localhost app, a pushed development
 * backend and Northstar credentials. Never seeds; removes its own temporary
 * task and OAuth client/connection rows through guarded cleanup. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { chromium } from 'playwright'
import {
  cleanupDemoArtifacts,
  inspectBrowserDemo,
  loadBrowserDemo,
  signInBrowser,
} from './browser-demo.mjs'

const demo = loadBrowserDemo(process.argv[2] ?? 'http://localhost:5199')
const before = await inspectBrowserDemo(demo)
const apiOrigin = demo.target.url.replace('.convex.cloud', '.convex.site')
const adminClient = new ConvexHttpClient(demo.target.url, { logger: false })
adminClient.setAdminAuth(demo.target.key)
const clientName = `Qivo OAuth smoke ${randomUUID()}`
const taskTitle = `OAuth planning smoke ${randomUUID()}`
const log = (message) => console.log(`[oauth-smoke] ${message}`)
let stage = 'starting'
let clientId
let passed = false
let taskAttempted = false
const callbacks = new Map()
const callbackServer = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname !== '/callback') {
    response.writeHead(404).end()
    return
  }
  callbacks.set(url.searchParams.get('state'), url.searchParams)
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'",
  })
  response.end(
    '<!doctype html><title>OAuth smoke callback</title><p>Returned to the test client.</p>',
  )
})
await new Promise((resolve) => callbackServer.listen(0, '127.0.0.1', resolve))
const redirectUri = `http://127.0.0.1:${callbackServer.address().port}/callback`
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(20_000)

async function jsonResponse(response, expected, label) {
  assert.equal(response.status, expected, `${label}: unexpected HTTP status`)
  return response.json()
}

let metadata
let resource
let requestedScopes
async function tokenRequest(fields, expected = 200) {
  return jsonResponse(
    await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, resource, ...fields }),
    }),
    expected,
    'Token endpoint',
  )
}

async function mcp(token, name, args = {}, modern = true) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  const params = { name, arguments: args }
  if (modern) {
    headers['Mcp-Method'] = 'tools/call'
    headers['Mcp-Name'] = name
    params._meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'qivo-oauth-smoke', version: '1' },
    }
  }
  return fetch(resource, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
}

async function toolData(token, name, args = {}, modern = true) {
  const response = await mcp(token, name, args, modern)
  assert.equal(response.status, 200, `MCP ${name}: unexpected HTTP status`)
  const text = await response.text()
  const prefix = 'event: message\ndata: '
  const body = JSON.parse(text.startsWith(prefix) ? text.slice(prefix.length).trim() : text)
  assert.ok(body.result && !body.result.isError, `MCP ${name} succeeds`)
  return JSON.parse(body.result.content[0].text)
}

async function authorize({ cancel = false, signIn = false, readOnly = true } = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const state = randomUUID()
  const url = new URL(metadata.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    scope: requestedScopes,
    prompt: 'consent',
    resource,
  }).toString()
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })
  if (signIn) await signInBrowser(page, demo.account('nora'))
  await page.getByRole('heading', { name: `Connect ${clientName} to Qivo`, exact: true }).waitFor()
  assert.ok(
    (await page.locator('body').innerText()).includes(demo.orgName),
    'Consent names Northstar',
  )
  const allowChanges = page.getByRole('checkbox', { name: 'Allow changes', exact: true })
  assert.ok(await allowChanges.isChecked(), 'Write access is selected by default')
  if (!cancel && readOnly) await allowChanges.uncheck()
  await page.getByRole('button', { name: cancel ? 'Cancel' : 'Connect', exact: true }).click()
  await page.waitForURL((candidate) => candidate.origin === new URL(redirectUri).origin)
  const callback = callbacks.get(state)
  assert.ok(callback, 'Callback preserves the client state')
  callbacks.delete(state)
  if (cancel) {
    assert.equal(callback.get('error'), 'access_denied', 'Cancellation refuses authorization')
    assert.equal(callback.get('code'), null, 'Cancellation issues no code')
    return null
  }
  assert.equal(callback.get('error'), null, 'Approval has no OAuth error')
  const code = callback.get('code')
  assert.ok(code, 'Approval returns an authorization code')
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  })
  assert.ok(tokens.access_token?.startsWith('qvo_'), 'OAuth access token issued')
  assert.ok(tokens.refresh_token?.startsWith('qvr_'), 'Offline refresh token issued')
  assert.equal(
    tokens.scope.split(' ').includes('qivo:write'),
    !readOnly,
    'Issued write access matches the consent choice',
  )
  return tokens
}

try {
  stage = 'discovery and registration'
  const challenge = await fetch(`${apiOrigin}/mcp`, { method: 'POST' })
  assert.equal(challenge.status, 401, 'MCP advertises authorization on unauthenticated requests')
  const metadataUrl = challenge.headers
    .get('www-authenticate')
    ?.match(/resource_metadata="([^"]+)"/)?.[1]
  assert.ok(metadataUrl, 'Challenge contains protected-resource metadata')
  requestedScopes = challenge.headers.get('www-authenticate')?.match(/\bscope="([^"]+)"/)?.[1]
  assert.deepEqual(
    requestedScopes?.split(' '),
    ['qivo:read', 'qivo:write', 'offline_access'],
    'Default discovery requests reading, writing and automatic renewal',
  )
  assert.equal(new URL(metadataUrl).origin, apiOrigin, 'Discovery stays on the development API')
  const protectedResource = await jsonResponse(await fetch(metadataUrl), 200, 'Protected resource')
  resource = protectedResource.resource
  assert.equal(resource, `${apiOrigin}/mcp`, 'Resource belongs to this development deployment')
  const issuer = new URL(protectedResource.authorization_servers[0])
  assert.equal(issuer.origin, apiOrigin, 'Issuer belongs to this development deployment')
  const issuerMetadata = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, '')}`
  metadata = await jsonResponse(await fetch(issuerMetadata), 200, 'Authorization server metadata')
  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    assert.equal(new URL(metadata[endpoint]).origin, apiOrigin, `${endpoint} stays on the issuer`)
  }
  const registration = await jsonResponse(
    await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: requestedScopes,
      }),
    }),
    200,
    'Client registration',
  )
  clientId = registration.client_id
  assert.equal(typeof clientId, 'string', 'Dynamic client registered')
  log('Protected-resource discovery and public-client registration passed')

  stage = 'password sign-in and cancellation'
  await authorize({ cancel: true, signIn: true })
  log('Browser sign-in preserves the request; Cancel returns access_denied')

  stage = 'default approval and project planning writes'
  const writeConnection = await authorize({ readOnly: false })
  stage = 'listing projects with default write approval'
  const projects = await toolData(writeConnection.access_token, 'list_projects')
  const project = projects.find((candidate) => candidate.type === 'project')
  assert.ok(project, 'Existing Northstar sub-project is available')
  stage = 'creating a temporary planning task'
  taskAttempted = true
  const task = await toolData(writeConnection.access_token, 'create_task', {
    project: project.id,
    title: taskTitle,
    remaining_hours: 4,
    priority: 'medium',
  })
  assert.ok(task.id, 'OAuth creates a planning task')
  stage = 'updating the temporary task plan'
  await toolData(
    writeConnection.access_token,
    'update_task',
    { ref: task.id, remaining_hours: 6, due_date: '2026-09-25', priority: 'high' },
    false,
  )
  stage = 'reading the saved task plan'
  const planned = await toolData(writeConnection.access_token, 'get_task', { ref: task.id })
  assert.equal(planned.title, taskTitle)
  assert.equal(planned.remaining_hours, 6, 'Updated estimate persists')
  assert.equal(planned.due_date, '2026-09-25', 'Updated deadline persists')
  assert.equal(planned.priority, 'high', 'Updated priority persists')
  stage = 'deleting the temporary planning task'
  await toolData(writeConnection.access_token, 'delete_task', { ref: task.id })
  taskAttempted = false
  log('Default approval reads, creates, updates and deletes a temporary planning task')

  stage = 'approval and read-only MCP access'
  const initial = await authorize()
  const read = await mcp(initial.access_token, 'list_projects')
  assert.equal(read.status, 200, 'Approved OAuth token reads projects')
  const readResult = await read.json()
  assert.ok(readResult.result && !readResult.result.isError, 'Project read succeeds')
  for (const modern of [true, false]) {
    const refusal = await mcp(
      initial.access_token,
      'update_user',
      { user_id: 'me', plannable_hours: 37 },
      modern,
    )
    assert.equal(refusal.status, 403, 'Read-only OAuth refuses writes before tool execution')
    assert.ok(
      refusal.headers.get('www-authenticate')?.includes('insufficient_scope'),
      'Scope refusal is explicit',
    )
  }
  const rest = await fetch(`${apiOrigin}/v1/projects`, {
    headers: { Authorization: `Bearer ${initial.access_token}` },
  })
  assert.equal(rest.status, 401, 'OAuth token cannot authenticate REST')
  log('Approval narrows to reading; MCP reads pass and both protocol legs refuse writes')

  stage = 'refresh rotation and replay refusal'
  const renewed = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: initial.refresh_token,
  })
  assert.ok(renewed.refresh_token !== initial.refresh_token, 'Refresh token rotates')
  assert.equal(
    (await mcp(renewed.access_token, 'list_projects')).status,
    200,
    'Renewed token reads',
  )
  const replay = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: initial.refresh_token },
    400,
  )
  assert.equal(replay.error, 'invalid_grant', 'Reused refresh is refused')
  assert.equal(
    (await mcp(renewed.access_token, 'list_projects')).status,
    401,
    'Replay revokes the connection',
  )
  log('Refresh rotation works; replay blocks the newly issued access token')

  stage = 'reconnection and settings deletion'
  const reconnected = await authorize()
  stage = 'opening connected-app settings'
  await page.goto(`${demo.base}/app/${demo.orgSlug}/settings/account`)
  await page
    .getByRole('heading', { name: 'Your account', exact: true })
    .waitFor({ timeout: 30_000 })
  const mcpSection = page.locator('[data-settings-account-section="mcp"]')
  if (await mcpSection.count()) await mcpSection.click()
  stage = 'loading connected apps'
  await page.getByRole('group', { name: 'Connected apps', exact: true }).scrollIntoViewIfNeeded()
  const connections = page.locator('[data-oauth-connection]').filter({ hasText: clientName })
  await connections.first().getByRole('button', { name: 'Delete', exact: true }).waitFor()
  assert.equal(
    await connections.count(),
    3,
    'Both active approvals and the revoked grant can be deleted',
  )
  stage = 'cancelling connection deletion'
  await connections.first().getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await connections.count(), 3, 'Cancelling deletion preserves the connection')
  stage = 'confirming settings deletion'
  // Delete active and revoked grants for this uniquely registered client.
  while (await connections.count()) {
    const connectionId = await connections.first().getAttribute('data-oauth-connection')
    const row = page.locator(`[data-oauth-connection="${connectionId}"]`)
    await row.getByRole('button', { name: 'Delete', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete connection', exact: true })
      .click()
    await row.waitFor({ state: 'detached' })
  }
  stage = 'checking deleted credentials'
  assert.equal(
    (await mcp(reconnected.access_token, 'list_projects')).status,
    401,
    'Settings deletion prevents access',
  )
  const deleted = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: reconnected.refresh_token },
    400,
  )
  assert.equal(deleted.error, 'invalid_grant', 'Settings deletion prevents refresh')
  stage = 'signing out after OAuth checks'
  await page.evaluate(() => window.PLANNER.signOut())
  await page.locator('input[type="email"]').waitFor()
  log(
    'Fresh approval reconnects; deletion removes active and revoked connections and blocks access and refresh',
  )
  passed = true
} catch {
  // Browser navigation errors may contain callback URLs; never log raw errors,
  // request bodies, cookies, passwords, codes or token endpoint responses.
  process.exitCode = 1
  log(`FAILED during ${stage}`)
  await page
    .screenshot({ path: '.local/dependency-upgrade/oauth-smoke-failure.png' })
    .catch(() => {})
} finally {
  await context.close()
  if (taskAttempted) {
    try {
      await cleanupDemoArtifacts(browser, demo, { issueTitle: taskTitle })
    } catch {
      passed = false
      process.exitCode = 1
      log('Cleanup failed for the uniquely named temporary planning task')
    }
  }
  await browser.close()
  await new Promise((resolve) => callbackServer.close(resolve))
  if (clientId) {
    try {
      await adminClient.mutation(makeFunctionReference('internal/oauthSmoke:cleanup'), {
        expected_site_url: demo.target.siteUrl,
        client_id: clientId,
        client_name: clientName,
      })
    } catch {
      passed = false
      process.exitCode = 1
      log("Cleanup failed; inspect this drive's temporary OAuth client before repeating")
    }
  }
  assert.deepEqual(
    await inspectBrowserDemo(demo),
    before,
    'Northstar counts and anchor are preserved',
  )
  if (passed)
    log(
      'PASS — OAuth default read/write planning, read-only consent, refresh, replay and deletion; demo preserved',
    )
}

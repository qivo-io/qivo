/* Shared Northstar setup for local browser drives. Credentials stay in the
 * importer's private deployment-bound file; a smoke never seeds or resets. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { loadCredentials, resolveTarget } from './marketing-demo.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export function loadBrowserDemo(baseURL, { cwd = ROOT, env } = {}) {
  if (!env) {
    const envFile = join(cwd, '.env.local')
    if (existsSync(envFile)) process.loadEnvFile(envFile)
    env = process.env
  }
  const base = new URL(baseURL)
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error('Browser smoke drives require a localhost development server origin.')
  }
  const target = resolveTarget({ target: 'dev' }, env)
  if (env.VITE_CONVEX_URL && env.VITE_CONVEX_URL !== target.url) {
    throw new Error(
      'The local app Convex URL does not match the development credential deployment.',
    )
  }
  const credentials = loadCredentials(cwd, target)
  if (!credentials) {
    throw new Error(
      'Northstar development credentials are missing. Run npm run demo -- seed --dev first.',
    )
  }
  return {
    base: base.origin,
    orgSlug: 'northstar-labs',
    orgName: 'Northstar Labs',
    target,
    credentials,
    account(key) {
      const account = credentials.value.accounts.find((person) => person.key === key)
      if (!account) throw new Error('Requested Northstar account is unavailable.')
      return account
    },
  }
}

function devClient(demo) {
  const client = new ConvexHttpClient(demo.target.url, { logger: false })
  client.setAdminAuth(demo.target.key)
  return client
}

export async function inspectBrowserDemo(demo) {
  let state
  try {
    state = await devClient(demo).query(makeFunctionReference('internal/marketingDemo:inspect'), {
      expected_site_url: demo.target.siteUrl,
    })
  } catch {
    throw new Error(
      'Could not inspect the Northstar development demo. Check the dev deployment and importer permissions.',
    )
  }
  if (state.state !== 'ready')
    throw new Error('Northstar is not ready. Run npm run demo -- seed --dev first.')
  if (state.credential_set_id !== demo.credentials.value.credential_set_id) {
    throw new Error('Northstar credentials do not match the development ownership receipt.')
  }
  return { anchor: state.anchor, counts: state.counts }
}

export async function signInBrowser(page, account) {
  // Playwright can include fill values in errors. Never let a password reach
  // a drive's failure log, even when the form disappears during submission.
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 20000 })
    await page.fill('input[type="email"]', account.email)
    await page.fill('input[type="password"]', account.password)
    await page.click('button[type="submit"]')
  } catch {
    throw new Error('Browser sign-in failed while filling or submitting the form.')
  }
}

export async function signInDemo(page, demo, key = 'nora') {
  await page.goto(`${demo.base}/app/~/board/all`, { waitUntil: 'domcontentloaded' })
  await signInBrowser(page, demo.account(key))
  await page.waitForSelector('[data-all-nav]', { timeout: 30000 })
  const slug = await page.evaluate(() => window.PLANNER.org?.slug)
  if (slug !== demo.orgSlug) throw new Error('Browser did not sign in to Northstar Labs.')
}

export async function cleanupDemoArtifacts(browser, demo, artifacts) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInDemo(page, demo)
    await page.evaluate(
      async ({ issueTitle, agentKeyName, agentName, memberEmail, orgSlug }) => {
        // Use the dev app's authenticated singleton so cleanup awaits backend
        // completion, including after a failed optimistic browser operation.
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await convex.query('snapshot:forMe', {})
        const org = snapshot.orgs.find((candidate) => candidate.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        if (issueTitle) {
          for (const issue of snapshot.issues.filter(
            (it) => it.org_id === org.id && it.title === issueTitle,
          )) {
            await convex.mutation('issues:deleteDeep', { org_id: org.id, id: issue.id })
          }
        }
        // after its tasks: a temporary agent profile, by its run-unique name
        if (agentName) {
          for (const profile of snapshot.profiles.filter(
            (p) => p.org_id === org.id && p.kind === 'agent' && p.name === agentName,
          )) {
            await convex.mutation('profiles:remove', { org_id: org.id, id: profile.id })
          }
        }
        if (agentKeyName) {
          const keys = await window.PLANNER.listAgentKeys()
          if (!keys) throw new Error('Cannot list temporary agent keys for cleanup')
          for (const key of keys.filter((key) => key.name === agentKeyName)) {
            if (
              !(await window.PLANNER.revokeAgentKey(key.id)) ||
              !(await window.PLANNER.deleteAgentKey(key.id))
            ) {
              throw new Error('Could not remove the temporary agent key')
            }
          }
        }
        if (memberEmail) {
          for (const profile of snapshot.profiles.filter(
            (p) => p.org_id === org.id && p.email === memberEmail,
          )) {
            await convex.mutation('profiles:remove', { org_id: org.id, id: profile.id })
          }
        }
      },
      { ...artifacts, orgSlug: demo.orgSlug },
    )
    if (artifacts.memberEmail) {
      try {
        await devClient(demo).mutation(makeFunctionReference('adminAuth:deleteOrphanLogin'), {
          email: artifacts.memberEmail,
        })
      } catch (error) {
        if (error?.data?.code !== 'not_found')
          throw new Error('Could not remove the temporary break-glass login.')
      }
    }
    await page.evaluate(() => window.PLANNER.signOut())
  } finally {
    await context.close()
  }
}

/* Shared Northstar setup for local browser drives. Credentials stay in the
 * importer's private deployment-bound file; a smoke never seeds or resets.
 * Deleting a task moves it to Deleted items for 30 days, so a drive that
 * deletes its temporary tasks also deletes them for good there
 * (purgeDeletedTasks), through a seam the development deployment allows and
 * production refuses. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import {
  DemoCliError,
  fixtureDirectory,
  loadCredentials,
  resolveTarget,
} from './marketing-demo.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/* What a drive against a local backend reads in place of the seed's flags,
 * for marketing-demo.mjs messages, which name the flags. */
const LOCAL_INPUTS =
  "A local drive takes the seed's --deployment from QIVO_LOCAL_DEPLOYMENT, its --url from VITE_CONVEX_URL and its --site-url from the drive's base URL."

/** The command that seeds the Northstar demo a drive's `target` names. */
function seedCommand(target) {
  return target.target === 'local'
    ? `npm run demo -- seed --local --deployment ${target.deployment} --url ${target.url} --site-url ${target.siteUrl}`
    : 'npm run demo -- seed --dev'
}

/** Northstar's drive setup for the dev server at `baseURL`, against the
 * development deployment or, with QIVO_FIXTURE_LOCAL=true, the disposable
 * local backend that QIVO_LOCAL_DEPLOYMENT and VITE_CONVEX_URL name. The
 * local seed binds its credentials to its exact backend and site origins,
 * and the backend checks its SITE_URL and sign-in origins exactly, so a drive
 * there opens the seed's --site-url, with localhost and 127.0.0.1 as
 * different origins. */
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
  const local = env.QIVO_FIXTURE_LOCAL === 'true'
  let target
  try {
    target = local
      ? resolveTarget(
          { target: 'local', deployment: env.QIVO_LOCAL_DEPLOYMENT, siteUrl: base.origin },
          env,
        )
      : resolveTarget({ target: 'dev' }, env)
  } catch (error) {
    if (local && error instanceof DemoCliError)
      throw new DemoCliError(`${error.message} ${LOCAL_INPUTS}`)
    throw error
  }
  // a local target takes its backend from VITE_CONVEX_URL itself
  if (!local && env.VITE_CONVEX_URL && env.VITE_CONVEX_URL !== target.url) {
    throw new Error(
      'The local app Convex URL does not match the development credential deployment.',
    )
  }
  const directory = fixtureDirectory(cwd, env, { local })
  let credentials
  try {
    credentials = loadCredentials(directory, target)
  } catch (error) {
    if (local && error instanceof DemoCliError)
      throw new DemoCliError(
        `${error.message} A local drive reads the credentials that ${seedCommand(target)} stored, with each origin spelled the same way (localhost and 127.0.0.1 differ).`,
      )
    throw error
  }
  if (!credentials) {
    throw new Error(
      local
        ? `Northstar credentials for the local backend are missing. Run ${seedCommand(target)} first.`
        : 'Northstar development credentials are missing. Run npm run demo -- seed --dev first.',
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

const PURGE_AT_ONCE = 25

/** Deletes for good the Deleted items of temporary tasks a drive created and
 * deleted (deletedItems:purgeTasks), by the tasks' uuids, so they do not
 * wait 30 days in Northstar's Deleted items. */
export async function purgeDeletedTasks(demo, taskIds) {
  const ids = [...new Set(taskIds.filter(Boolean))]
  for (let at = 0; at < ids.length; at += PURGE_AT_ONCE) {
    let result
    try {
      result = await devClient(demo).mutation(makeFunctionReference('deletedItems:purgeTasks'), {
        task_ids: ids.slice(at, at + PURGE_AT_ONCE),
      })
    } catch {
      throw new Error('Could not delete the temporary tasks from Deleted items.')
    }
    if (result.waiting > 0) throw new Error('A temporary task is still moving to Deleted items.')
  }
}

export async function inspectBrowserDemo(demo) {
  const { target } = demo
  const local = target.target === 'local'
  let state
  try {
    state = await devClient(demo).query(makeFunctionReference('internal/marketingDemo:inspect'), {
      expected_site_url: target.siteUrl,
    })
  } catch {
    throw new Error(
      local
        ? `Could not inspect Northstar on the local backend at ${target.url}. Check that it runs, that QIVO_LOCAL_ADMIN_KEY is its admin key and that its SITE_URL is ${target.siteUrl}.`
        : 'Could not inspect the Northstar development demo. Check the dev deployment and importer permissions.',
    )
  }
  if (state.state !== 'ready')
    throw new Error(
      `Northstar is not ready${local ? ' on the local backend' : ''}. Run ${seedCommand(target)} first.`,
    )
  if (state.credential_set_id !== demo.credentials.value.credential_set_id) {
    throw new Error(
      `Northstar credentials do not match the ${local ? 'local backend' : 'development'} ownership receipt.`,
    )
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
  // the All projects directory, which reads no task and needs no project
  await page.goto(`${demo.base}/app/~/projects`, { waitUntil: 'domcontentloaded' })
  await signInBrowser(page, demo.account(key))
  await page.waitForSelector('[data-all-nav]', { timeout: 30000 })
  const slug = await page.evaluate(() => window.PLANNER.org?.slug)
  if (slug !== demo.orgSlug) throw new Error('Browser did not sign in to Northstar Labs.')
}

/** Every row of navigation list `query` (projectNav:page, children, search
 * or targets) with `args`, as the person signed in on `page` sees it, read
 * batch by batch on the page's Convex client, waiting out `not_ready` for
 * up to 15 s. The store holds no project list, so the drives read what the
 * app's own lists read. Throws where the list stops or refuses. Needs the
 * Vite dev server, which serves the page's modules. */
export async function navRows(page, query, args = {}) {
  const rows = await page.evaluate(
    async ({ query, args }) => {
      const { convex } = await import('/src/lib/convex.ts')
      const deadline = Date.now() + 15000
      const rows = []
      for (let after; ; ) {
        const batch = await convex.query(query, { ...args, ...(after ? { after } : {}) })
        if (batch.state === 'not_ready' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        if (batch.state !== 'ok') return `answered ${batch.state}`
        rows.push(...batch.rows)
        if (batch.stopped) return 'stopped'
        if (batch.next === null) return rows
        after = batch.next
      }
    },
    { query, args },
  )
  if (typeof rows === 'string') throw new Error(`${query} ${rows}`)
  return rows
}

/** The top-level project named `name` that the person signed in on `page`
 * opens, with its live sub-projects: `{ id, org_id, name, num, children }`,
 * each child `{ id, org_id, name, num, parent_id }`, from projectNav.search
 * and projectNav.children (navRows). Throws where no such project shows. */
export async function navProject(page, name) {
  const top = (await navRows(page, 'projectNav:search', { search: name })).find(
    (row) => row.name === name && row.parent === null,
  )
  if (!top) throw new Error(`Northstar shows no top-level project named ${name}`)
  const children = await navRows(page, 'projectNav:children', { project_id: top.id })
  return { id: top.id, org_id: top.org_id, name: top.name, num: top.num, children }
}

/** Removes what a drive left in Northstar: its tasks titled `issueTitle`, a
 * temporary agent, agent key and member, then deletes for good the Deleted
 * items of those tasks and of `taskIds`, the tasks the drive deleted itself. */
export async function cleanupDemoArtifacts(browser, demo, artifacts) {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInDemo(page, demo)
    const deleted = await page.evaluate(
      async ({ issueTitle, agentKeyName, agentName, memberEmail, orgSlug }) => {
        // Use the dev app's authenticated singleton so cleanup awaits backend
        // completion, including after a failed optimistic browser operation.
        const { convex } = await import('/src/lib/convex.ts')
        const snapshot = await (await import('/convex/lib/workspaceJoin.ts')).readWorkspace(
          (name, args) => convex.query(name, args),
        )
        const org = snapshot.orgs.find((candidate) => candidate.slug === orgSlug)
        if (!org) throw new Error('Cleanup organization is unavailable')
        const deleted = []
        if (issueTitle) {
          for (const issue of snapshot.issues.filter(
            (it) => it.org_id === org.id && it.title === issueTitle,
          )) {
            await convex.mutation('issues:deleteDeep', { org_id: org.id, id: issue.id })
            deleted.push(issue.id)
          }
        }
        // The workspace holds nobody but the signed-in person, so people
        // are found through the mention popup's read (pickers.mentions),
        // every batch of a search, whose rows give an agent no address. A
        // read that fails throws, so the cleanup never reports success
        // after finding nobody.
        const people = async (search) => {
          const rows = []
          for (let cursor = null, batches = 0; ; batches++) {
            const found = await window.PLANNER.mentionChoices(org.id, search, cursor)
            if (found?.state !== 'ready') {
              const why = found?.message ?? found?.state ?? 'the read failed'
              throw new Error(`Cleanup cannot list people: ${why}`)
            }
            rows.push(...found.rows)
            if (found.next === null) return rows
            if (batches >= 200) throw new Error('Cleanup cannot list every person')
            cursor = found.next
          }
        }
        // after its tasks: a temporary agent profile, by its run-unique name
        if (agentName) {
          for (const profile of (await people(agentName)).filter(
            (p) => p.email === null && p.name === agentName,
          )) {
            await convex.mutation('profiles:remove', { org_id: org.id, id: profile.id })
          }
        }
        if (agentKeyName) {
          // the organization's agents' keys, read once (tokens.agentKeys)
          const agents = (await people('')).filter((p) => p.email === null).map((p) => p.id)
          const answer = agents.length
            ? await window.PLANNER.agentKeys(org.id, agents)
            : { agents: [] }
          if (!answer) throw new Error('Cannot list temporary agent keys for cleanup')
          const keys = answer.agents.flatMap((agent) => agent.keys)
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
          const members = (await people(memberEmail)).filter((p) => p.email === memberEmail)
          for (const profile of members) {
            await convex.mutation('profiles:remove', { org_id: org.id, id: profile.id })
          }
        }
        return deleted
      },
      { ...artifacts, orgSlug: demo.orgSlug },
    )
    // the tasks it deleted, and those the drive deleted itself (taskIds)
    await purgeDeletedTasks(demo, [...(artifacts.taskIds ?? []), ...deleted])
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

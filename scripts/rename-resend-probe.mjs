#!/usr/bin/env node
/* Shows which workspace parts a task rename re-sends, on the staging
 * deployment or on a disposable local backend (--local).
 *
 * It signs in one Northstar fixture person over the deployment's own sign-in
 * endpoint, with the password from the fixture credentials file
 * (QIVO_FIXTURE_CREDENTIALS_DIR, as scripts/staging-check.mjs reads it), and
 * subscribes to the workspace parts (convex/workspace.ts) through the app's
 * own registry (src/store/liveParts.ts) until the workspace is complete. It
 * then renames one active task assigned to that person in Northstar, waits
 * until the new title arrives and a few seconds more, renames the task back
 * the same way, and prints, for each of the two changes, every part that
 * sent a new answer and its size. The title is the only change it makes,
 * and it restores the title also after a failure. A rename leaves the
 * task's history row, as any rename in the app does. It exits 0 when each
 * change re-sent only the tasks window that holds the task, 1 when it
 * re-sent anything else or failed, and 2 for arguments it cannot use.
 *
 * The password, the session and the sign-in token stay in this process's
 * memory and are never printed. The deploy key the staging helper provides
 * only proves which deployment this is; the probe never calls Convex with
 * it.
 *
 *   staging, from the application checkout:
 *     "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-staging" \
 *       node scripts/rename-resend-probe.mjs --staging
 *   local, with the fixture seeded by marketing-demo.mjs seed --local:
 *     QIVO_FIXTURE_CREDENTIALS_DIR=… node scripts/rename-resend-probe.mjs --local \
 *       --app-url http://localhost:5252 --convex-url http://127.0.0.1:3252 \
 *       --api-url http://127.0.0.1:3253 --deployment local-name-3252
 *
 * --as names the fixture person (default nora), and --task the number of
 * the task to rename (default the lowest numbered active task assigned to
 * them). */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LIMITS } from './limits.mjs'
import { fixtureDirectory, loadCredentials } from './marketing-demo.mjs'
import { resolveConfig } from './staging-check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ORG_SLUG = 'northstar-labs'
const PEOPLE = ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben']
/** How long the probe keeps listening after a change arrived, for parts
 *  that answer later. */
export const SETTLE_MS = 3000
/** How long one change may take to arrive. */
const CHANGE_MS = 60_000
/** How long the workspace may take to load. */
const LOAD_MS = 180_000

class UsageError extends Error {}

/** Parses the command line. Secrets are never accepted as arguments. */
export function parseArgs(argv) {
  const o = { as: 'nora' }
  const takes = new Set([
    '--app-url',
    '--convex-url',
    '--api-url',
    '--deployment',
    '--as',
    '--task',
  ])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--staging' || arg === '--local') {
      if (o.target) throw new UsageError('Choose either --staging or --local.')
      o.target = arg.slice(2)
    } else if (takes.has(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`)
      o[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
    } else
      throw new UsageError(
        /^--[a-z][a-z-]{0,30}$/.test(arg)
          ? `Unknown argument ${arg}.`
          : 'Unknown argument (not shown, in case it is a secret).',
      )
  }
  if (!o.target) throw new UsageError('Choose --staging or --local.')
  if (!PEOPLE.includes(o.as)) throw new UsageError(`--as takes one of ${PEOPLE.join(', ')}.`)
  if (o.task !== undefined) {
    if (!/^[1-9][0-9]{0,8}$/.test(o.task)) throw new UsageError('--task takes a task number.')
    o.task = Number(o.task)
  }
  return o
}

/** A part's name and window, as the report prints it. */
export const partName = ({ name, args }) =>
  'from' in args ? `${name} [${args.from || '(start)'}, ${args.to ?? '(end)'})` : name

/** The verdict on one change: whether it re-sent only `holder`, the token
 *  of the tasks window that holds the task, and the sentence that says so. */
export function verdict(resent, holder) {
  const others = [...resent.keys()].filter((token) => token !== holder)
  if (!resent.has(holder))
    return { ok: false, line: 'the window that holds the task sent no new answer' }
  if (others.length > 0)
    return {
      ok: false,
      line: `${others.length} part(s) besides the window that holds the task sent a new answer`,
    }
  return { ok: true, line: 'only the window that holds the task sent a new answer' }
}

/* Signs `account` in over the deployment's auth endpoints. Answers the
   way to get a Convex token and the way to sign out. Nothing it holds is
   printed. */
async function signIn(apiOrigin, appOrigin, account) {
  const jar = new Map()
  const keep = (response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
  }
  const headers = () => ({
    Origin: appOrigin,
    Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
  })
  const signedIn = await fetch(`${apiOrigin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
    redirect: 'error',
  })
  await signedIn.body?.cancel()
  if (!signedIn.ok) throw new Error(`Sign-in answered ${signedIn.status}.`)
  keep(signedIn)
  const token = async () => {
    const r = await fetch(`${apiOrigin}/api/auth/convex/token`, {
      headers: headers(),
      redirect: 'error',
    })
    if (!r.ok) throw new Error(`The token request answered ${r.status}.`)
    keep(r)
    const { token } = await r.json()
    if (typeof token !== 'string') throw new Error('The token request answered no token.')
    return token
  }
  const signOut = async () => {
    const r = await fetch(`${apiOrigin}/api/auth/sign-out`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
    })
    await r.body?.cancel()
  }
  return { token, signOut }
}

async function start() {
  let o
  let cfg
  let account
  try {
    o = parseArgs(process.argv.slice(2))
    if (o.target === 'staging' && !process.env.CONVEX_DEPLOY_KEY)
      throw new UsageError(
        'Run --staging through the staging helper, which selects the deployment.',
      )
    cfg = resolveConfig(o, process.env)
    delete cfg.target.key
    delete process.env.CONVEX_DEPLOY_KEY
    const credentials = loadCredentials(
      fixtureDirectory(ROOT, process.env, { local: cfg.target.target === 'local' }),
      cfg.target,
    )
    if (!credentials)
      throw new UsageError('The Northstar fixture credentials for this deployment are missing.')
    account = credentials.value.accounts.find((a) => a.key === o.as)
  } catch (error) {
    // the refusals of the fixture tools never repeat a secret
    console.error(error instanceof Error ? error.message : 'The arguments were refused.')
    process.exitCode = 2
    return
  }
  const secrets = [account.password]
  const say = (line) => {
    let s = String(line)
    for (const secret of secrets) s = s.split(secret).join('[redacted]')
    console.log(s)
  }

  const { ConvexClient } = await import('convex/browser')
  const { makeFunctionReference, getFunctionName } = await import('convex/server')
  const { createLiveQueries, createLiveParts } = await import('./liveParts.mjs')
  const { partRows } = await import('./workspaceJoin.mjs')

  const auth = await signIn(cfg.apiOrigin, cfg.appOrigin, account)
  const client = new ConvexClient(cfg.target.url, { unsavedChangesWarning: false })
  // the title to put back when the probe stops before it did
  let restore = null
  let failed = false
  try {
    client.setAuth(async () => {
      const token = await auth.token()
      secrets.push(token)
      return token
    })
    const base = createLiveQueries(client.client, (ref, args) => client.query(ref, args))
    // what each token names, from the registry's own subscriptions
    const named = new Map()
    const live = {
      ...base,
      watch(ref, args) {
        const watched = base.watch(ref, args)
        named.set(watched.token, { name: getFunctionName(ref), args })
        return watched
      },
    }
    const watching = new Set()
    let onChange = () => {}
    base.onTransition(({ tokens }) => {
      for (const token of tokens) if (named.has(token)) watching.add(token)
      onChange(tokens)
    })
    const began = performance.now()
    let complete
    let parts
    const loaded = new Promise((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('The workspace did not load in time.')),
        LOAD_MS,
      )
      parts = createLiveParts(
        live,
        (news) => {
          if (news.workspace.state === 'failed') {
            clearTimeout(timer)
            fail(new Error('The workspace failed to load.'))
          }
          if (news.workspace.state === 'complete') {
            complete = news.workspace.value
            clearTimeout(timer)
            done()
          }
        },
        () => true,
      )
    })
    await loaded
    const org = complete?.orgs.find((row) => row.slug === ORG_SLUG)
    if (!org) throw new Error(`The person holds no seat in ${ORG_SLUG}.`)
    const mine = new Set(complete.myProfileIds)
    const me = complete.profiles.find((p) => mine.has(p.id) && p.org_id === org.id)
    const tasks = complete.issues
      .filter((t) => t.org_id === org.id && t.archived_at === undefined)
      .sort((a, b) => a.num - b.num)
    const task =
      o.task === undefined
        ? tasks.find((t) => t.assignee_id === me?.id)
        : tasks.find((t) => t.num === o.task)
    if (!task)
      throw new Error(
        o.task === undefined
          ? 'No active task is assigned to this person.'
          : `Task ${o.task} is not an active task this person is shown.`,
      )
    const counts = {}
    for (const { name } of named.values()) counts[name] = (counts[name] ?? 0) + 1
    say(
      `Workspace of ${me?.name ?? o.as} complete in ${((performance.now() - began) / 1000).toFixed(1)} s, ${named.size} parts subscribed: ${Object.entries(
        counts,
      )
        .map(([name, n]) => `${n} ${name.replace('workspace:', '')}`)
        .join(', ')}.`,
    )

    const answerOf = (token) => {
      try {
        return base.read(token)
      } catch {
        return undefined
      }
    }
    /* the tasks window whose answer holds the task, and its title there */
    const holderOf = () => {
      for (const [token, { name }] of named)
        if (name === 'workspace:tasks') {
          const answer = answerOf(token)
          if (answer?.state !== 'ok') continue
          const row = partRows(answer).issues.find((t) => t.id === task.id)
          if (row) return { token, title: row.title }
        }
      return null
    }
    const update = makeFunctionReference('issues:update')
    /* sets the task's title and records every part that sends a new answer
       until it arrived and SETTLE_MS more passed */
    const change = async (title) => {
      const resent = new Map()
      let arrived = null
      let settled
      const done = new Promise((resolveDone) => {
        settled = resolveDone
      })
      onChange = (tokens) => {
        for (const token of tokens) {
          const answer = answerOf(token)
          resent.set(token, Buffer.byteLength(JSON.stringify(answer ?? null)))
        }
        if (arrived === null && holderOf()?.title === title) {
          arrived = performance.now()
          setTimeout(settled, SETTLE_MS)
        }
      }
      const sent = performance.now()
      const timer = setTimeout(settled, CHANGE_MS)
      await client.mutation(update, { org_id: org.id, id: task.id, patch: { title } })
      await done
      clearTimeout(timer)
      onChange = () => {}
      return { resent, ms: arrived === null ? null : arrived - sent }
    }
    const holder = holderOf()
    if (!holder) throw new Error('No tasks window holds the task.')
    const original = task.title
    const suffix = ' (rename probe)'
    const probeTitle = `${original.slice(0, LIMITS.title.max - suffix.length)}${suffix}`
    say(`Task ${task.num} is in ${partName(named.get(holder.token))}.`)
    let ok = true
    for (const [label, title] of [
      ['Rename', probeTitle],
      ['Rename back', original],
    ]) {
      restore ??= { org_id: org.id, id: task.id, patch: { title: original } }
      const { resent, ms } = await change(title)
      if (title === original) restore = null
      const holderNow = holderOf()?.token ?? holder.token
      const result = verdict(resent, holderNow)
      ok &&= result.ok && ms !== null
      say(
        `${label}: ${ms === null ? 'the new title never arrived' : `arrived in ${Math.round(ms)} ms`}; ${resent.size} part(s) sent a new answer:`,
      )
      for (const [token, bytes] of resent)
        say(
          `  ${partName(named.get(token) ?? { name: token, args: {} })}, ${bytes.toLocaleString('en-US')} bytes${token === holderNow ? ' (holds the task)' : ''}`,
        )
      say(`  ${result.ok ? 'PASS' : 'FAIL'}: ${result.line}.`)
    }
    parts.stop()
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    failed = true
    say(`FAIL: ${error instanceof Error ? error.message : 'the probe stopped'}`)
  } finally {
    if (restore !== null)
      try {
        await client.mutation(makeFunctionReference('issues:update'), restore)
        say('The title was put back.')
      } catch {
        say(
          `FAIL: the title of the task could not be put back; set it to "${restore.patch.title}".`,
        )
      }
    await client.close()
    await auth.signOut().catch(() => {})
    if (failed) process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await start()

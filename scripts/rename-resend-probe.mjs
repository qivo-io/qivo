#!/usr/bin/env node
/* Shows which workspace parts a task rename re-sends, on the staging
 * deployment or on a disposable local backend (--local).
 *
 * It signs in one Northstar fixture person over the deployment's own sign-in
 * endpoint, with the password from the fixture credentials file
 * (QIVO_FIXTURE_CREDENTIALS_DIR, as scripts/staging-check.mjs reads it), and
 * subscribes to the workspace parts (convex/workspace.ts) through the app's
 * own registry (src/store/liveParts.ts) until the workspace is complete and
 * every part it watches answered, the pieces of a window cut in two
 * included. It then renames one active task assigned to that person in
 * Northstar, waits until the new title arrives and a few seconds more,
 * renames the task back the same way, and prints, for each of the two
 * changes, every part that sent a new answer and its size. The title is the
 * only field it changes, but each write is a rename like one in the app: it
 * sets the task's update time, adds a history row, sends a task.updated
 * event to each webhook that takes it and sends every other follower of the
 * task an inbox notice of the new title. It puts the title back also after a failure, a timeout or a
 * first Ctrl-C, SIGTERM or SIGHUP, when the backend accepts that write
 * within CHANGE_MS, and otherwise prints the title to set; a second signal
 * exits at once without, and so does a kill. A title that still ends in
 * SUFFIX, left by such a run, stops it before any write. Each write carries
 * the title it replaces as `expected`, as the app's do, so a rename by
 * someone else meanwhile refuses the probe's write and keeps their title.
 * It exits 0 when each change re-sent only the tasks window that holds the
 * task, 1 when it re-sent anything else or failed, and 2 for arguments it
 * cannot use.
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
import { getFunctionName, makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { cutText, LIMITS } from './limits.mjs'
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
/** How long one request to the auth endpoints may take. */
const FETCH_MS = 30_000
/** What the probe adds to the task's title. */
export const SUFFIX = ' (rename probe)'

/** The probe's title for a task titled `original`: SUFFIX after as much of
 *  it as fits the title limit, an emoji kept whole. */
export const probeTitleOf = (original) =>
  `${cutText(original, LIMITS.title.max - SUFFIX.length)}${SUFFIX}`

class UsageError extends Error {}

/** `promise`, or a rejection with `message` when it has not settled within
 *  `ms`, or with the reason of `stop` when that rejects first. */
export function within(promise, ms, message, stop) {
  let timer
  const late = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(message)), ms)
  })
  return Promise.race([promise, late, ...(stop ? [stop] : [])]).finally(() => clearTimeout(timer))
}

/** `base`'s watch as the probe sees it: `named` holds what each token names,
 *  `watched()` lists the tokens watched now, `answered()` says whether each
 *  of them holds an answer, and `live` is the transport that records them
 *  for the registry. A window
 *  cut in two keeps serving while its pieces load, so a complete workspace
 *  may still wait for their first answers. */
export function watching(base) {
  const named = new Map()
  // how many watch each token now
  const active = new Map()
  const live = {
    ...base,
    watch(ref, args) {
      const watched = base.watch(ref, args)
      named.set(watched.token, { name: getFunctionName(ref), args })
      active.set(watched.token, (active.get(watched.token) ?? 0) + 1)
      let stopped = false
      return {
        token: watched.token,
        stop: () => {
          if (stopped) return
          stopped = true
          const left = active.get(watched.token) - 1
          if (left === 0) active.delete(watched.token)
          else active.set(watched.token, left)
          watched.stop()
        },
      }
    },
  }
  const answered = () =>
    [...active.keys()].every((token) => {
      try {
        return base.read(token) !== undefined
      } catch {
        // a failed part holds an answer too, its error
        return true
      }
    })
  return { live, named, watched: () => [...active.keys()], answered }
}

/** The Convex client's token fetcher over `token()`: it records each token
 *  in `secrets`, so nothing prints it, and answers null when the request
 *  fails, after telling `lost`, as the client calls it where a rejection
 *  would stop the process before the title is put back. */
export function authFetcher(token, secrets, lost) {
  return async () => {
    try {
      const value = await token()
      secrets.push(value)
      return value
    } catch (error) {
      lost(error)
      return null
    }
  }
}

/** Renames a task titled `original` to `probeTitle` and back.
 *  `change(title, seen, landed)` writes `title` over `seen`, the title it
 *  replaces, calls `landed()` once the backend accepted the write, and
 *  answers once the parts settled; `report(label, answer)` gets each
 *  change's answer. `left.write` holds the write that puts the title back
 *  while one is needed (`{title, seen}`), also after this throws: from
 *  before the first write is sent, as it may land however its wait ends,
 *  until the rename back landed, or a refusal shows the probe's title is
 *  not stored. `theirs(error)` says whether a refusal kept someone else's
 *  rename. */
export async function renameAndBack({ original, probeTitle, change, report, left, theirs }) {
  left.write = { title: original, seen: probeTitle }
  try {
    report('Rename', await change(probeTitle, original, () => {}))
  } catch (error) {
    if (!(error instanceof ConvexError)) throw error
    // a refused write changed nothing
    left.write = null
    throw new Error(
      theirs(error)
        ? 'someone else renamed the task meanwhile; the probe changed nothing'
        : `the rename was refused (${error.data?.message ?? error.message}); the title was not changed`,
    )
  }
  try {
    report(
      'Rename back',
      await change(original, probeTitle, () => {
        left.write = null
      }),
    )
  } catch (error) {
    // someone else's title is stored, which the put-back must keep
    if (theirs(error)) left.write = null
    throw error
  }
}

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

/* Signs `account` in over the deployment's auth endpoints, each request
   bounded by FETCH_MS. Answers the way to get a Convex token and the way to
   sign out. Nothing it holds is printed. */
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
    signal: AbortSignal.timeout(FETCH_MS),
  })
  await signedIn.body?.cancel()
  if (!signedIn.ok) throw new Error(`Sign-in answered ${signedIn.status}.`)
  keep(signedIn)
  const token = async () => {
    const r = await fetch(`${apiOrigin}/api/auth/convex/token`, {
      headers: headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_MS),
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
      signal: AbortSignal.timeout(FETCH_MS),
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
  // The first signal stops the wait at hand and goes on to put the title
  // back; a second exits at once. A closed terminal must not stop that.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
  let interrupt
  const interrupted = new Promise((_, fail) => {
    interrupt = fail
  })
  interrupted.catch(() => {})
  let signalled = false
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => {
      if (signalled) process.exit(130)
      signalled = true
      interrupt(
        new Error(`stopped by ${signal}; a second signal exits without putting the title back`),
      )
    })
  let failed = false
  // a failure no wait awaits, inside the Convex client for one, stops the
  // wait at hand too, so the title is still put back
  process.on('unhandledRejection', (reason) => {
    failed = true
    interrupt(new Error(`unexpected failure: ${reason instanceof Error ? reason.message : reason}`))
  })

  const { ConvexClient } = await import('convex/browser')
  const { createLiveQueries, createLiveParts, FIELD_CHANGED, printOf, trimmedForm } = await import(
    './liveParts.mjs'
  )
  const { partRows } = await import('./workspaceJoin.mjs')

  const update = makeFunctionReference('issues:update')
  const theirs = (error) => error?.data?.reason === FIELD_CHANGED
  let signing = null
  let auth = null
  let client = null
  let parts = null
  let org = null
  let task = null
  // the write that puts the title back while the probe owes one
  const left = { write: null }
  /* the write that sets the task's title to `title` over `seen`, the
     title it replaces, refused when someone else renamed the task since */
  const rename = (title, seen) => ({
    org_id: org.id,
    id: task.id,
    patch: { title },
    expected: { title: printOf(trimmedForm(seen)) },
  })
  try {
    signing = signIn(cfg.apiOrigin, cfg.appOrigin, account)
    auth = await within(signing, 3 * FETCH_MS, 'The sign-in did not answer in time.', interrupted)
    client = new ConvexClient(cfg.target.url, { unsavedChangesWarning: false })
    client.setAuth(
      authFetcher(auth.token, secrets, (error) =>
        interrupt(new Error(`the sign-in token could not be renewed: ${error.message}`)),
      ),
      (signedIn) => {
        if (!signedIn) interrupt(new Error('the backend no longer accepts the sign-in'))
      },
    )
    const base = createLiveQueries(client.client, (ref, args) => client.query(ref, args))
    // what each token names, from the registry's own subscriptions
    const { live, named, watched, answered } = watching(base)
    let onChange = () => {}
    base.onTransition(({ tokens }) => onChange(tokens))
    const began = performance.now()
    let complete
    const loaded = new Promise((done, fail) => {
      parts = createLiveParts(
        live,
        (news) => {
          if (news.workspace.state === 'failed') fail(new Error('The workspace failed to load.'))
          if (news.workspace.state === 'complete') {
            complete = news.workspace.value
            if (answered()) done()
          }
        },
        () => true,
      )
    })
    await within(loaded, LOAD_MS, 'The workspace did not load in time.', interrupted)
    org = complete?.orgs.find((row) => row.slug === ORG_SLUG)
    if (!org) throw new Error(`The person holds no seat in ${ORG_SLUG}.`)
    const mine = new Set(complete.myProfileIds)
    const me = complete.profiles.find((p) => mine.has(p.id) && p.org_id === org.id)
    const tasks = complete.issues
      .filter((t) => t.org_id === org.id && t.archived_at === undefined)
      .sort((a, b) => a.num - b.num)
    task =
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
    const subscribed = watched()
    for (const token of subscribed) {
      const { name } = named.get(token)
      counts[name] = (counts[name] ?? 0) + 1
    }
    say(
      `Workspace of ${me?.name ?? o.as} complete in ${((performance.now() - began) / 1000).toFixed(1)} s, ${subscribed.length} parts subscribed: ${Object.entries(
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
    /* the tasks window watched now whose answer holds the task, and its
       title there */
    const holderOf = () => {
      for (const token of watched())
        if (named.get(token).name === 'workspace:tasks') {
          const answer = answerOf(token)
          if (answer?.state !== 'ok') continue
          const row = partRows(answer).issues.find((t) => t.id === task.id)
          if (row) return { token, title: row.title }
        }
      return null
    }
    /* sets the task's title over `seen` and records every part that sends a
       new answer until it arrived and SETTLE_MS more passed */
    const change = async (title, seen, landed) => {
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
      try {
        await within(
          client.mutation(update, rename(title, seen)),
          CHANGE_MS,
          'The rename was not confirmed in time.',
          interrupted,
        )
        landed()
        await Promise.race([done, interrupted])
      } finally {
        clearTimeout(timer)
        onChange = () => {}
      }
      return { resent, ms: arrived === null ? null : arrived - sent }
    }
    const holder = holderOf()
    if (!holder) throw new Error('No tasks window holds the task.')
    const original = task.title
    // a run stopped by a second signal or a kill leaves its title
    if (original.endsWith(SUFFIX))
      throw new Error(
        `Task ${task.num} still holds the title a stopped run left; set it to "${original.slice(0, -SUFFIX.length)}" or what it was before, and run again.`,
      )
    const probeTitle = probeTitleOf(original)
    say(`Task ${task.num} is in ${partName(named.get(holder.token))}.`)
    let ok = true
    await renameAndBack({
      original,
      probeTitle,
      change,
      left,
      theirs,
      report: (label, { resent, ms }) => {
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
      },
    })
    process.exitCode = ok ? 0 : 1
  } catch (error) {
    failed = true
    say(
      `FAIL: ${
        theirs(error)
          ? 'someone else renamed the task meanwhile'
          : error instanceof Error
            ? error.message
            : 'the probe stopped'
      }`,
    )
  } finally {
    // not stopped by a signal: the first one led here, and a second exits
    const restore = left.write
    if (restore !== null)
      try {
        await within(
          client.mutation(update, rename(restore.title, restore.seen)),
          CHANGE_MS,
          'timed out',
        )
        say('The title was put back.')
      } catch (error) {
        say(
          theirs(error)
            ? 'FAIL: someone else renamed the task meanwhile, so the probe kept their title.'
            : `FAIL: the title of the task could not be put back; set it to "${restore.title}".`,
        )
      }
    parts?.stop()
    await client?.close()
    // a sign-in a signal cut short may still answer
    const session =
      auth ?? (signing && (await within(signing, FETCH_MS, 'timed out').catch(() => null)))
    await session?.signOut().catch(() => {})
    if (failed) process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await start()

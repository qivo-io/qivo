#!/usr/bin/env node
/* Explicit Northstar fixtures for isolated development and staging backends.
 * Passwords stay outside the checkout. Only password hashes reach Convex. */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashPassword } from 'better-auth/crypto'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SLUG = 'northstar-labs'
const PEOPLE = [
  ['nora', 'Nora Berg'],
  ['leo', 'Leo Martins'],
  ['aisha', 'Aisha Rahman'],
  ['emil', 'Emil Strand'],
  ['daniel', 'Daniel Park'],
  ['sofia', 'Sofia Andersson'],
  ['ben', 'Ben Carter'],
]
const AVATARS = [...PEOPLE.map(([key]) => key), 'atlas']
const COMMANDS = new Set(['plan', 'seed', 'reset', 'wipe'])
// Only exact known refusals are safe to repeat. Other backend errors may
// contain serialized arguments (including password hashes).
const SAFE_REFUSALS = new Set([
  'marketing demo: SITE_URL is unset',
  'marketing demo: deployment SITE_URL does not match the requested target',
  'marketing demo: an unowned organization occupies the demo address or id',
  'marketing demo: roster changed; restore the demo roster before resetting',
  'marketing demo: owned organization missing or its address changed',
  'marketing demo: login ownership changed',
  'marketing demo: a demo email already belongs to an unowned account',
  'marketing demo: credential set belongs to a different provisioning run',
  'marketing demo: work was added after wipe; use reset to replace it',
  'marketing demo: use reset to change dates or dataset version',
])
const references = Object.fromEntries(
  ['inspect', 'provision', 'apply', 'avatarUpload', 'adoptAvatar'].map((name) => [
    name,
    makeFunctionReference(`internal/marketingDemo:${name}`),
  ]),
)

class DemoCliError extends Error {}

export function mondayAnchor(value, now = new Date()) {
  if (value === undefined) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    return date.toISOString().slice(0, 10)
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DemoCliError('--anchor must be a Monday in YYYY-MM-DD format.')
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DemoCliError('--anchor must be an actual calendar date.')
  }
  if (date.getUTCDay() !== 1) throw new DemoCliError('--anchor must be a Monday.')
  return value
}

export function parseArgs(args, now = new Date()) {
  const options = { command: 'plan', dryRun: false, help: false }
  let commandSeen = false
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (COMMANDS.has(arg)) {
      if (commandSeen)
        throw new DemoCliError('Choose exactly one command: plan, seed, reset, wipe.')
      options.command = arg
      commandSeen = true
      continue
    }
    if (
      ![
        '--staging',
        '--dev',
        '--dry-run',
        '--anchor',
        '--confirm',
        '--url',
        '--site-url',
        '--help',
      ].includes(arg)
    ) {
      throw new DemoCliError(
        'Unknown argument. Use --help for supported options; secrets belong in the environment.',
      )
    }
    if (seen.has(arg)) throw new DemoCliError('Each option may be provided only once.')
    seen.add(arg)
    if (arg === '--help') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--staging' || arg === '--dev') {
      if (options.target) throw new DemoCliError('Choose either --staging or --dev, never both.')
      options.target = arg.slice(2)
    } else {
      const value = args[++index]
      if (!value || value.startsWith('--'))
        throw new DemoCliError('An option is missing its value.')
      const key = {
        '--anchor': 'anchor',
        '--confirm': 'confirm',
        '--url': 'url',
        '--site-url': 'siteUrl',
      }[arg]
      options[key] = value
    }
  }
  options.anchor = mondayAnchor(options.anchor, now)
  if (!options.help && options.command !== 'plan' && !options.target) {
    throw new DemoCliError(
      'Explicitly select --dev or --staging before seeding, resetting, or wiping.',
    )
  }
  if (
    !options.help &&
    !options.dryRun &&
    ['reset', 'wipe'].includes(options.command) &&
    options.confirm !== SLUG
  ) {
    throw new DemoCliError(
      'Reset and wipe require --confirm northstar-labs. They remove all work inside the marked demo organization.',
    )
  }
  return options
}

export function resolveTarget(options, env, requireKey = true) {
  const target = options.target ?? 'dev'
  if (!['dev', 'staging'].includes(target))
    throw new DemoCliError('Production fixture commands are disabled.')
  const environment = target === 'dev' ? 'development' : 'staging'
  if (requireKey && (env.QIVO_ENVIRONMENT !== environment || env.APP_MODE === 'demo')) {
    throw new DemoCliError('QIVO_ENVIRONMENT does not match the selected isolated fixture target.')
  }
  const key = env.CONVEX_DEPLOY_KEY
  if (!key && requireKey) {
    throw new DemoCliError(
      'Set the isolated deployment-scoped CONVEX_DEPLOY_KEY in the environment. Never pass it as a command argument.',
    )
  }
  const match = key?.match(/^(prod|dev):([a-z][a-z0-9-]*-[0-9]+)\|[^|\s]+$/)
  if (key !== undefined && !match)
    throw new DemoCliError(
      'CONVEX_DEPLOY_KEY must be a deployment-scoped dev or prod key; project and preview keys are refused.',
    )
  if (match && match[1] !== (target === 'dev' ? 'dev' : 'prod')) {
    throw new DemoCliError(
      'The deploy key does not match --dev/--staging. Refusing to contact a different deployment.',
    )
  }
  const siteUrl =
    options.siteUrl ?? env.SITE_URL ?? (target === 'dev' ? 'http://localhost:5199' : undefined)
  let site
  try {
    site = new URL(siteUrl)
  } catch {
    throw new DemoCliError('Set the exact isolated SITE_URL for fixture commands.')
  }
  if (
    site.origin !== siteUrl ||
    ['qivo.io', 'www.qivo.io', 'demo.qivo.io'].includes(site.hostname)
  ) {
    throw new DemoCliError('Fixture commands require an exact nonproduction site origin.')
  }
  if (target === 'staging' && site.protocol !== 'https:') {
    throw new DemoCliError('Staging fixture commands require HTTPS.')
  }
  if (target === 'dev' && !/^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(siteUrl)) {
    throw new DemoCliError('Development demo writes require a localhost site URL.')
  }
  // An explicit URL must match the key and cannot redirect admin auth.
  const urlValue = options.url ?? (match ? `https://${match[2]}.convex.cloud` : env.VITE_CONVEX_URL)
  let url
  if (urlValue) {
    try {
      url = new URL(urlValue)
    } catch {
      throw new DemoCliError('The deployment URL must be a canonical HTTPS Convex cloud origin.')
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !/^https:\/\/[a-z][a-z0-9-]*-[0-9]+\.convex\.cloud\/$/.test(url.href)
    ) {
      throw new DemoCliError('The deployment URL must be a canonical HTTPS Convex cloud origin.')
    }
    if (match && url.hostname !== `${match[2]}.convex.cloud`) {
      throw new DemoCliError(
        'The deployment URL does not match the deploy key. No credentials were sent.',
      )
    }
  }
  return {
    target,
    deployment: match?.[2] ?? url?.hostname.split('.')[0],
    url: url?.origin,
    siteUrl,
    key,
  }
}

function isOwned(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

function privateDirectory(path, create, requirePrivate) {
  if (!existsSync(path)) {
    if (!create) return false
    mkdirSync(path, { mode: 0o700 })
  }
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !isOwned(stat) ||
    (requirePrivate && stat.mode & 0o077)
  ) {
    throw new DemoCliError(
      'The credentials directory must be owned by this user, private (0700), and free of symlinks.',
    )
  }
  return true
}

export function credentialsPath(directory, target) {
  if (!/^[a-z][a-z0-9-]*-[0-9]+$/.test(target.deployment ?? '')) {
    throw new DemoCliError('Cannot bind credentials to an unknown deployment.')
  }
  return join(directory, target.deployment, 'credentials.json')
}

/** A caller must choose an existing private directory outside the application checkout. */
export function fixtureDirectory(cwd, env) {
  const directory = env.QIVO_FIXTURE_CREDENTIALS_DIR
  if (!directory || !isAbsolute(directory) || !privateDirectory(directory, false, true)) {
    throw new DemoCliError(
      'Set QIVO_FIXTURE_CREDENTIALS_DIR to an existing private absolute directory outside this checkout.',
    )
  }
  const canonical = realpathSync(directory)
  const within = relative(realpathSync(cwd), canonical)
  if (within === '' || (!within.startsWith('..') && !isAbsolute(within))) {
    throw new DemoCliError('Fixture credentials must be stored outside the application checkout.')
  }
  return canonical
}

function verifyCredentials(value, target) {
  if (
    value?.version !== 1 ||
    value.organization !== SLUG ||
    value.deployment !== target.deployment ||
    value.deployment_url !== target.url ||
    value.site_url !== target.siteUrl ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.credential_set_id ?? '',
    ) ||
    !Array.isArray(value.accounts) ||
    value.accounts.length !== PEOPLE.length ||
    !PEOPLE.every(([key, name]) => {
      const accounts = value.accounts.filter((account) => account.key === key)
      return (
        accounts.length === 1 &&
        accounts[0].name === name &&
        accounts[0].email === `${key}@demo.qivo.io` &&
        typeof accounts[0].password === 'string' &&
        accounts[0].password.length >= 32
      )
    })
  ) {
    throw new DemoCliError(
      'The credentials file is invalid or belongs to another deployment. It was not overwritten.',
    )
  }
  return value
}

/** Returns null when absent unless creation was explicitly requested. This
 * never repairs or overwrites a suspicious existing file. */
export function loadCredentials(directory, target, { create = false } = {}) {
  const path = credentialsPath(directory, target)
  const dirs = [directory, dirname(path)]
  for (const dir of dirs) {
    if (!privateDirectory(dir, create, true)) return null
  }
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new DemoCliError(
        'Cannot safely open the credentials file. Check file ownership, permissions, and symlinks.',
      )
    if (!create) return null
  }
  if (fd !== undefined) {
    try {
      const stat = fstatSync(fd)
      if (
        !stat.isFile() ||
        !isOwned(stat) ||
        stat.mode & 0o077 ||
        stat.size > 65536 ||
        stat.nlink !== 1
      ) {
        throw new DemoCliError(
          'The credentials file must be an owned private (0600) regular file without hard links.',
        )
      }
      let value
      try {
        value = JSON.parse(readFileSync(fd, 'utf8'))
      } catch {
        throw new DemoCliError(
          'The credentials file is unreadable or invalid. It was not overwritten.',
        )
      }
      return { path, value: verifyCredentials(value, target) }
    } finally {
      closeSync(fd)
    }
  }
  const value = {
    version: 1,
    organization: SLUG,
    deployment: target.deployment,
    deployment_url: target.url,
    site_url: target.siteUrl,
    credential_set_id: randomUUID(),
    accounts: PEOPLE.map(([key, name]) => ({
      key,
      name,
      email: `${key}@demo.qivo.io`,
      password: randomBytes(32).toString('base64url'),
    })),
  }
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } catch {
    throw new DemoCliError(
      'Could not save credentials privately and exclusively. No accounts have been provisioned; inspect the local credentials file before retrying.',
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return { path, value }
}

function assertCredentialSet(credentials, state) {
  if (credentials && state?.credential_set_id !== credentials.value.credential_set_id) {
    throw new DemoCliError(
      'The local credentials file does not match the demo login receipt. No passwords were replaced. Use the original credentials file for this deployment; a concurrent first seed may have provisioned it from another clone.',
    )
  }
}

function readAvatars(cwd, people) {
  return people.map((person) => {
    if (!AVATARS.includes(person.key))
      throw new DemoCliError(
        'The server returned an unknown demo person. Check that client and backend versions agree.',
      )
    const candidates = ['png', 'jpg', 'jpeg', 'webp'].map((ext) =>
      join(cwd, 'scripts', 'demo', 'assets', `${person.key}.${ext}`),
    )
    const paths = candidates.filter(existsSync)
    if (paths.length !== 1)
      throw new DemoCliError(
        `Exactly one checked-in portrait is required for ${person.key} in scripts/demo/assets (PNG, JPEG, or WebP).`,
      )
    const bytes = readFileSync(paths[0])
    if (!bytes.length || bytes.length > 2 * 1024 * 1024)
      throw new DemoCliError(
        `The ${person.key} portrait must be a nonempty image no larger than 2 MiB.`,
      )
    const ext = paths[0].split('.').at(-1)
    return {
      person: person.key,
      bytes,
      mime: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`,
    }
  })
}

async function remote(stage, operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DemoCliError) throw error
    if (SAFE_REFUSALS.has(error?.data?.message)) {
      throw new DemoCliError(`Request refused during ${stage}: ${error.data.message}.`)
    }
    // Match only the two fixed permission names this importer needs. Never
    // echo an arbitrary server-provided scope or its surrounding error text.
    const deniedPermission = [error?.message, error?.data?.message]
      .filter((message) => typeof message === 'string')
      .map((message) =>
        message.match(
          /You do not have permission to perform this operation \((deployment:functions:runInternal(?:Queries|Mutations))\)\./,
        ),
      )
      .find(Boolean)?.[1]
    if (deniedPermission) {
      throw new DemoCliError(
        `Demo request denied during ${stage}: ${deniedPermission}. Grant this permission to the selected deployment key and rerun the same command. Raw server details are withheld.`,
      )
    }
    const code = error?.data?.code
    const hint = ['not_found', 'forbidden', 'bad_request', 'rule', 'conflict'].includes(code)
      ? ` (${code})`
      : ''
    throw new DemoCliError(
      `Demo request failed during ${stage}${hint}. Check deployment access, deployed functions, and the site's demo ownership guard. Retry with the same private credentials file; raw server errors are withheld to keep secrets out of logs.`,
    )
  }
}

function printPlan(options, target, log) {
  log(`Northstar Labs — ${options.command}${options.dryRun ? ' (dry run)' : ''}`)
  log(
    `Target: ${target.siteUrl}${target.deployment ? ` / ${target.deployment}` : ' / deployment not selected'}`,
  )
  log(`Anchor Monday: ${options.anchor} (UTC calendar dates)`)
  log(
    'Scope: Luma Sensor (5 subprojects), Luma Cloud (4), Pilot & Launch (3); seven humans and Atlas, with portraits.',
  )
  log(
    'Human logins: name@demo.qivo.io; Nora is the sole org admin. Passwords are stored in a private deployment-bound local file.',
  )
  log(
    'Seed creates an absent/empty demo and preserves an unchanged ready demo. Use reset to replace existing work, refresh dates, or update the dataset version.',
  )
  log(
    'Reset and wipe remove work only inside the marked Northstar demo organization. Logins, profile images, and its ownership marker are preserved.',
  )
  log(
    'Reset runs two steps, wipe then seed. The demo is empty between them; if the seed step fails, re-run the same reset.',
  )
  log('No network requests, credentials, or data changes were made.')
}

export async function runMarketingDemo(args, dependencies = {}) {
  const {
    cwd = PROJECT_ROOT,
    env = process.env,
    now = new Date(),
    log = console.log,
    clientFactory = (url) => new ConvexHttpClient(url, { logger: false }),
    hash = hashPassword,
    upload = globalThis.fetch,
  } = dependencies
  const options = parseArgs(args, now)
  if (options.help) {
    log(`Usage: node scripts/marketing-demo.mjs [plan|seed|reset|wipe] [options]

  --staging              Explicitly target the isolated staging backend
  --dev                  Explicitly target the localhost development app
  --anchor YYYY-MM-DD     Monday around which demo dates are arranged (default: current UTC Monday)
  --confirm northstar-labs Required for reset and wipe
  --dry-run              Print the operation without network access or local writes
  --url URL              Canonical Convex URL; must match the deployment key
  --site-url URL         Expected SITE_URL (dev defaults to http://localhost:5199)
  --help                 Show this help

Set QIVO_ENVIRONMENT to development or staging, matching the selected target.
Load only that isolated backend's CONVEX_DEPLOY_KEY. Staging also requires its
exact SITE_URL. Production fixture commands are disabled.
Set QIVO_FIXTURE_CREDENTIALS_DIR to a private directory outside this checkout.
Credentials are stored under <directory>/<deployment>/credentials.json (0600).
No secret command-line flags are supported. plan is fully offline.
Wipe preserves logins and portraits; it removes all demo organization work.
Reset is a wipe followed by a seed; if the seed fails, re-run the same reset.`)
    return { kind: 'help' }
  }
  const readOnly = options.command === 'plan' || options.dryRun
  const target = resolveTarget(options, env, !readOnly)
  if (readOnly) {
    printPlan(options, target, log)
    return { kind: 'plan', command: options.command, anchor: options.anchor }
  }
  const credentialsDirectory = fixtureDirectory(cwd, env)
  const client = clientFactory(target.url)
  client.setAdminAuth(target.key)
  const guard = { expected_site_url: target.siteUrl }
  let state = await remote('inspection', () => client.query(references.inspect, guard))
  if (!['absent', 'empty', 'ready'].includes(state?.state))
    throw new DemoCliError(
      'Unexpected demo state. Check client/backend compatibility before retrying.',
    )
  if (options.command === 'wipe' && state.state === 'absent') {
    log(`No marked Northstar demo exists on ${target.siteUrl}; nothing to wipe.`)
    return { kind: 'complete', state: 'absent', counts: state.counts }
  }
  let credentials = null
  if (options.command !== 'wipe') {
    // Check files before provisioning; a missing portrait must not leave a new
    // organization behind. Existing portraits do not need another upload.
    const missingPeople =
      state.state === 'absent'
        ? AVATARS.map((key) => ({ key }))
        : state.people.filter((person) => !person.avatar_storage_id)
    const avatars = readAvatars(cwd, missingPeople)
    credentials = loadCredentials(credentialsDirectory, target, {
      create: state.state === 'absent',
    })
    if (state.state !== 'absent') assertCredentialSet(credentials, state)
    if (state.state === 'absent') {
      const password_hashes = Object.fromEntries(
        await Promise.all(
          credentials.value.accounts.map(async (account) => [
            account.key,
            await hash(account.password),
          ]),
        ),
      )
      const provisioned = await remote('account provisioning', () =>
        client.mutation(references.provision, {
          ...guard,
          password_hashes,
          credential_set_id: credentials.value.credential_set_id,
        }),
      )
      assertCredentialSet(credentials, provisioned)
      state = await remote('profile inspection', () => client.query(references.inspect, guard))
      assertCredentialSet(credentials, state)
    }
    for (const avatar of avatars) {
      if (state.people.find((person) => person.key === avatar.person)?.avatar_storage_id) continue
      const url = await remote('portrait upload preparation', () =>
        client.mutation(references.avatarUpload, { ...guard, person: avatar.person }),
      )
      const storageId = await remote('portrait upload', async () => {
        const response = await upload(url, {
          method: 'POST',
          headers: { 'Content-Type': avatar.mime },
          body: avatar.bytes,
        })
        if (!response.ok)
          throw new DemoCliError(
            `Portrait upload failed (HTTP ${response.status}). Re-run the same command to resume.`,
          )
        const result = await response.json()
        if (typeof result.storageId !== 'string')
          throw new DemoCliError(
            'Portrait upload returned no storage ID. Re-run the same command to resume.',
          )
        return result.storageId
      })
      await remote('portrait adoption', () =>
        client.mutation(references.adoptAvatar, {
          ...guard,
          person: avatar.person,
          storage_id: storageId,
        }),
      )
    }
  }
  const apply = (mode) =>
    remote(`demo work ${mode}`, () =>
      client.mutation(references.apply, { ...guard, anchor: options.anchor, mode }),
    )
  if (options.command === 'reset') {
    // Two transactions, wipe then seed: as one they come too close to
    // Convex's 1 s mutation limit. Repeating the reset is always safe.
    await apply('wipe')
    await apply('seed').catch((error) => {
      throw new DemoCliError(
        `${error.message} The wipe step completed, so the demo may now be empty. Re-run the same reset command to seed it.`,
      )
    })
  } else {
    await apply(options.command)
  }
  const result = await remote('final verification', () => client.query(references.inspect, guard))
  assertCredentialSet(credentials, result)
  log(`Northstar Labs: ${result.state}. ${target.siteUrl} / ${target.deployment}`)
  log(`Anchor: ${result.anchor ?? 'no work seeded'}. Counts: ${JSON.stringify(result.counts)}.`)
  if (credentials) log(`Private login credentials: ${credentials.path}`)
  else if (options.command !== 'wipe')
    log(
      'Existing logins were preserved. No local credentials file was found; no replacement passwords were generated.',
    )
  if (options.command === 'wipe')
    log(
      'Demo work removed. Existing logins, profile images, and the ownership marker were preserved.',
    )
  log(`Open: ${target.siteUrl}/app/northstar-labs/board`)
  return {
    kind: 'complete',
    state: result.state,
    counts: result.counts,
    credentialsPath: credentials?.path,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const envFile = join(PROJECT_ROOT, '.env.local')
    if (existsSync(envFile)) process.loadEnvFile(envFile)
    await runMarketingDemo(process.argv.slice(2))
  } catch (error) {
    console.error(
      `marketing-demo: ${error instanceof DemoCliError ? error.message : 'The command could not complete. Check local file access and setup; raw errors are withheld to keep secrets out of logs.'}`,
    )
    process.exitCode = 1
  }
}

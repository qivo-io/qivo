import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getFunctionName } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  credentialsPath,
  loadCredentials,
  mondayAnchor,
  parseArgs,
  resolveTarget,
  runMarketingDemo,
} from './marketing-demo.mjs'

const folders = []
const NOW = new Date('2026-09-05T23:59:59Z')
const DEV_ENV = { CONVEX_DEPLOY_KEY: 'dev:tidy-otter-12|test-private-key' }
const PROD_ENV = {
  CONVEX_DEPLOY_KEY: 'prod:happy-wolf-34|other-private-key',
  VITE_CONVEX_URL: 'https://tidy-otter-12.convex.cloud',
}
const DEV_TARGET = resolveTarget({ target: 'dev' }, DEV_ENV)
const PERSON_KEYS = ['nora', 'leo', 'aisha', 'emil', 'daniel', 'sofia', 'ben', 'atlas']

function folder() {
  const path = mkdtempSync(join(tmpdir(), 'qivo-marketing-demo-'))
  folders.push(path)
  return path
}

function writeAvatars(cwd) {
  const assetDir = join(cwd, 'scripts', 'demo', 'assets')
  mkdirSync(assetDir, { recursive: true })
  for (const key of PERSON_KEYS) writeFileSync(join(assetDir, `${key}.png`), 'test image bytes')
}

afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('date and command safety', () => {
  it('uses the current UTC Monday and accepts an explicit Monday without shifting it', () => {
    expect(mondayAnchor(undefined, NOW)).toBe('2026-08-31')
    expect(mondayAnchor(undefined, new Date('2026-09-07T00:00:00Z'))).toBe('2026-09-07')
    expect(mondayAnchor('2027-01-04')).toBe('2027-01-04')
  })

  it('rejects rolled-over dates, timestamps, non-Mondays, and conflicting flags', () => {
    for (const date of ['2026-02-30', '2026-09-05', '2026-09-07T00:00:00Z', '09/07/2026']) {
      expect(() => mondayAnchor(date)).toThrow(/anchor/)
    }
    expect(() => parseArgs(['seed', '--dev', '--prod'], NOW)).toThrow(/either/)
    expect(() => parseArgs(['seed', 'reset', '--dev'], NOW)).toThrow(/exactly one/)
    expect(() => parseArgs(['seed'], NOW)).toThrow(/Explicitly/)
    expect(() => parseArgs(['seed', '--dev', '--password', 'do-not-log'], NOW)).toThrow(
      /Unknown argument/,
    )
  })

  it('requires the exact organization token before destructive operations', () => {
    for (const command of ['reset', 'wipe']) {
      expect(() => parseArgs([command, '--prod'], NOW)).toThrow(/confirm northstar-labs/)
      expect(() => parseArgs([command, '--prod', '--confirm', 'another-org'], NOW)).toThrow(
        /confirm northstar-labs/,
      )
      expect(parseArgs([command, '--prod', '--confirm', 'northstar-labs'], NOW).command).toBe(
        command,
      )
      expect(parseArgs([command, '--prod', '--dry-run'], NOW).dryRun).toBe(true)
    }
  })
})

describe('target selection never redirects a deploy key', () => {
  it('refuses environment/flag and explicit URL/key mismatches before client creation', async () => {
    const factory = vi.fn()
    await expect(
      runMarketingDemo(['seed', '--prod'], { cwd: folder(), env: DEV_ENV, clientFactory: factory }),
    ).rejects.toThrow(/does not match/)
    expect(factory).not.toHaveBeenCalled()
    expect(() =>
      resolveTarget({ target: 'dev', url: 'https://happy-wolf-34.convex.cloud' }, DEV_ENV),
    ).toThrow(/does not match/)
    expect(() => resolveTarget({ target: 'dev' }, PROD_ENV)).toThrow(/does not match/)
  })

  it('uses the key target over a stale development Vite URL', () => {
    const target = resolveTarget({ target: 'prod' }, PROD_ENV)
    expect(target.url).toBe('https://happy-wolf-34.convex.cloud')
    expect(target.siteUrl).toBe('https://qivo.io')
  })

  it('selects the dedicated production key only for explicit --prod when both keys exist', () => {
    const env = {
      ...DEV_ENV,
      CONVEX_DEPLOY_KEY_PRODUCTION: PROD_ENV.CONVEX_DEPLOY_KEY,
      VITE_CONVEX_URL: PROD_ENV.VITE_CONVEX_URL,
    }
    expect(resolveTarget({ target: 'prod' }, env)).toMatchObject({
      target: 'prod',
      deployment: 'happy-wolf-34',
      url: 'https://happy-wolf-34.convex.cloud',
      siteUrl: 'https://qivo.io',
      key: PROD_ENV.CONVEX_DEPLOY_KEY,
    })
    for (const options of [{ target: 'dev' }, {}]) {
      expect(resolveTarget(options, env)).toEqual(DEV_TARGET)
    }
    expect(
      resolveTarget({}, { CONVEX_DEPLOY_KEY_PRODUCTION: PROD_ENV.CONVEX_DEPLOY_KEY }, false),
    ).toMatchObject({ target: 'dev', key: undefined, siteUrl: 'http://localhost:5199' })
  })

  it('refuses an invalid production alias without falling back or creating a client', async () => {
    const factory = vi.fn()
    for (const key of [DEV_ENV.CONVEX_DEPLOY_KEY, 'preview:team:project|secret', 'invalid', '']) {
      for (const fallback of [DEV_ENV, PROD_ENV]) {
        await expect(
          runMarketingDemo(['seed', '--prod'], {
            cwd: folder(),
            env: { ...fallback, CONVEX_DEPLOY_KEY_PRODUCTION: key },
            clientFactory: factory,
          }),
        ).rejects.toThrow(/does not match|deployment-scoped/)
      }
    }
    expect(factory).not.toHaveBeenCalled()
    expect(
      resolveTarget({ target: 'dev' }, { ...DEV_ENV, CONVEX_DEPLOY_KEY_PRODUCTION: 'invalid' }),
    ).toEqual(DEV_TARGET)
  })

  it('rejects non-deployment keys and URLs that could leak admin credentials', () => {
    for (const key of [
      'preview:team:project|secret',
      'project:team:project|secret',
      'dev:tidy-otter-12',
      'dev:tidy-otter-12|',
    ]) {
      expect(() => resolveTarget({ target: 'dev' }, { CONVEX_DEPLOY_KEY: key })).toThrow(
        /deployment-scoped/,
      )
    }
    for (const url of [
      'https://example.com',
      'http://tidy-otter-12.convex.cloud',
      'https://tidy-otter-12.convex.cloud/path',
      'https://user:password@tidy-otter-12.convex.cloud',
      'https://tidy-otter-12.convex.cloud/?token=private',
    ]) {
      expect(() => resolveTarget({ target: 'dev', url }, DEV_ENV)).toThrow(/canonical HTTPS/)
    }
    expect(() => resolveTarget({ target: 'dev', siteUrl: 'https://qivo.io' }, DEV_ENV)).toThrow(
      /localhost/,
    )
    expect(() =>
      resolveTarget({ target: 'prod', siteUrl: 'https://other.qivo.io' }, PROD_ENV),
    ).toThrow(/exact site/)
  })

  it('allows a fully offline plan without a deploy key and writes nothing', async () => {
    const cwd = folder()
    const factory = vi.fn()
    const log = vi.fn()
    for (const args of [[], ['seed', '--prod', '--dry-run'], ['reset', '--dev', '--dry-run']]) {
      await expect(
        runMarketingDemo(args, { cwd, env: {}, now: NOW, clientFactory: factory, log }),
      ).resolves.toMatchObject({ kind: 'plan', anchor: '2026-08-31' })
    }
    expect(factory).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, '.local'))).toBe(false)
    expect(JSON.stringify(log.mock.calls)).toContain('Reset runs two steps, wipe then seed')
  })
})

describe('private, persistent credentials', () => {
  it('persists strong individual passwords once with private permissions', () => {
    const cwd = folder()
    const first = loadCredentials(cwd, DEV_TARGET, { create: true })
    const second = loadCredentials(cwd, DEV_TARGET, { create: true })
    expect(second).toEqual(first)
    expect(first.value.accounts).toHaveLength(7)
    expect(new Set(first.value.accounts.map((account) => account.password)).size).toBe(7)
    expect(
      first.value.accounts.every(
        (account) => account.password.length >= 43 && account.email.endsWith('@demo.qivo.io'),
      ),
    ).toBe(true)
    expect(statSync(first.path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(first.path)).mode & 0o777).toBe(0o700)
  })

  it('never creates substitute passwords for an already provisioned demo', () => {
    const cwd = folder()
    expect(loadCredentials(cwd, DEV_TARGET)).toBeNull()
    expect(existsSync(join(cwd, '.local'))).toBe(false)
  })

  it('refuses a file bound to a different deployment without overwriting it', () => {
    const cwd = folder()
    const credentials = loadCredentials(cwd, DEV_TARGET, { create: true })
    const other = { ...credentials.value, deployment_url: 'https://happy-wolf-34.convex.cloud' }
    writeFileSync(credentials.path, JSON.stringify(other))
    expect(() => loadCredentials(cwd, DEV_TARGET, { create: true })).toThrow(/another deployment/)
    expect(JSON.parse(readFileSync(credentials.path, 'utf8'))).toEqual(other)
  })

  it('refuses unrelated, corrupt, or publicly readable credential files', () => {
    const cwd = folder()
    const credentials = loadCredentials(cwd, DEV_TARGET, { create: true })
    writeFileSync(credentials.path, '{invalid')
    expect(() => loadCredentials(cwd, DEV_TARGET, { create: true })).toThrow(/invalid/)
    expect(readFileSync(credentials.path, 'utf8')).toBe('{invalid')
    writeFileSync(credentials.path, JSON.stringify(credentials.value))
    chmodSync(credentials.path, 0o644)
    expect(() => loadCredentials(cwd, DEV_TARGET, { create: true })).toThrow(/private/)
  })

  it('refuses symlinked directories and files', () => {
    const cwd = folder()
    const destination = folder()
    symlinkSync(destination, join(cwd, '.local'))
    expect(() => loadCredentials(cwd, DEV_TARGET, { create: true })).toThrow(/symlinks/)
    const safe = folder()
    const credentials = loadCredentials(safe, DEV_TARGET, { create: true })
    const outside = join(destination, 'other.json')
    writeFileSync(outside, 'do not overwrite', { mode: 0o600 })
    rmSync(credentials.path)
    symlinkSync(outside, credentials.path)
    expect(() => loadCredentials(safe, DEV_TARGET, { create: true })).toThrow(/symlinks/)
    expect(readFileSync(outside, 'utf8')).toBe('do not overwrite')
  })
})

describe('resumable seed execution', () => {
  it('saves secrets before provision, sends hashes only, uploads portraits, and never logs secrets', async () => {
    const cwd = folder()
    writeAvatars(cwd)
    let state = 'absent'
    let credentialSetId
    const calls = []
    const log = vi.fn()
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => ({
        state,
        people: state === 'absent' ? [] : PERSON_KEYS.map((key) => ({ key })),
        counts: { users: state === 'absent' ? 0 : 8 },
        anchor: '2026-08-31',
        credential_set_id: credentialSetId,
      })),
      mutation: vi.fn(async (reference, args) => {
        const name = getFunctionName(reference).split(':').at(-1)
        calls.push({ name, args })
        if (name === 'provision') {
          expect(existsSync(credentialsPath(cwd, DEV_TARGET))).toBe(true)
          expect(Object.keys(args.password_hashes)).toHaveLength(7)
          expect(
            Object.values(args.password_hashes).every((hash) => hash.startsWith('hash:')),
          ).toBe(true)
          state = 'empty'
          credentialSetId = args.credential_set_id
          return { state, credential_set_id: credentialSetId }
        }
        if (name === 'avatarUpload')
          return 'https://tidy-otter-12.convex.cloud/api/storage/upload/test'
        if (name === 'apply') state = 'ready'
        return null
      }),
    }
    const upload = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: 'test-storage-id' }),
    }))
    await runMarketingDemo(['seed', '--dev'], {
      cwd,
      env: DEV_ENV,
      now: NOW,
      clientFactory: () => client,
      hash: async (password) => `hash:${password.length}`,
      upload,
      log,
    })
    expect(client.setAdminAuth).toHaveBeenCalledWith(DEV_ENV.CONVEX_DEPLOY_KEY)
    expect(upload).toHaveBeenCalledTimes(8)
    expect(calls.at(-1)).toMatchObject({
      name: 'apply',
      args: { mode: 'seed', anchor: '2026-08-31' },
    })
    const secretFile = loadCredentials(cwd, DEV_TARGET)
    const output = JSON.stringify(log.mock.calls)
    const wire = JSON.stringify(calls)
    for (const account of secretFile.value.accounts) {
      expect(output).not.toContain(account.password)
      expect(wire).not.toContain(account.password)
    }
    expect(output).not.toContain(DEV_ENV.CONVEX_DEPLOY_KEY)
  })

  it("refuses to advertise a losing concurrent clone's passwords as the live credentials", async () => {
    const cwd = folder()
    writeAvatars(cwd)
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => ({ state: 'absent', counts: { users: 0 } })),
      mutation: vi.fn(async () => ({
        state: 'empty',
        credential_set_id: 'another-clone-created-these-logins',
      })),
    }
    const log = vi.fn()
    const upload = vi.fn()
    await expect(
      runMarketingDemo(['seed', '--dev'], {
        cwd,
        env: DEV_ENV,
        clientFactory: () => client,
        hash: async () => 'test-hash',
        log,
        upload,
      }),
    ).rejects.toThrow(/does not match the demo login receipt/)
    expect(client.mutation).toHaveBeenCalledTimes(1)
    expect(getFunctionName(client.mutation.mock.calls[0][0])).toBe(
      'internal/marketingDemo:provision',
    )
    expect(upload).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    const credentials = loadCredentials(cwd, DEV_TARGET)
    expect(credentials.value.credential_set_id).toBe(
      client.mutation.mock.calls[0][1].credential_set_id,
    )
    expect(credentials.value.credential_set_id).not.toBe('another-clone-created-these-logins')
  })

  it('checks an existing credential stash against the server receipt before resetting work', async () => {
    const cwd = folder()
    const credentials = loadCredentials(cwd, DEV_TARGET, { create: true })
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => ({
        state: 'ready',
        credential_set_id: 'a-different-credential-set',
        people: PERSON_KEYS.map((key) => ({ key, avatar_storage_id: 'existing-avatar' })),
      })),
      mutation: vi.fn(),
    }
    await expect(
      runMarketingDemo(['reset', '--dev', '--confirm', 'northstar-labs'], {
        cwd,
        env: DEV_ENV,
        clientFactory: () => client,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/does not match the demo login receipt/)
    expect(client.mutation).not.toHaveBeenCalled()
    expect(loadCredentials(cwd, DEV_TARGET)).toEqual(credentials)
  })

  // Each command sends exactly its own apply modes: a seed must not wipe a
  // ready demo's manual edits, a wipe must not reseed, and a reset is two
  // transactions, wipe then seed, for the same anchor.
  it.each([
    ['seed', ['seed'], 'No local credentials file'],
    ['wipe', ['wipe'], 'Demo work removed'],
    ['reset', ['wipe', 'seed'], 'No local credentials file'],
  ])(
    'runs %s on a ready demo as apply %j without new credentials or portraits',
    async (command, modes, message) => {
      const cwd = folder()
      const client = {
        setAdminAuth: vi.fn(),
        query: vi.fn(async () => ({
          state: 'ready',
          people: [{ key: 'nora', avatar_storage_id: 'existing' }],
          counts: { users: 8 },
        })),
        mutation: vi.fn(async () => null),
      }
      const log = vi.fn()
      await runMarketingDemo([command, '--dev', '--confirm', 'northstar-labs'], {
        cwd,
        env: DEV_ENV,
        now: NOW,
        clientFactory: () => client,
        log,
      })
      expect(
        client.mutation.mock.calls.map(([reference, args]) => [
          getFunctionName(reference),
          args.mode,
        ]),
      ).toEqual(modes.map((mode) => ['internal/marketingDemo:apply', mode]))
      expect(client.mutation.mock.calls.every(([, args]) => args.anchor === '2026-08-31')).toBe(
        true,
      )
      expect(existsSync(join(cwd, '.local'))).toBe(false)
      expect(JSON.stringify(log.mock.calls)).toContain(message)
    },
  )

  it('says the demo may be empty and to re-run reset only when the seed fails after the wipe', async () => {
    const run = async (failing) => {
      const client = {
        setAdminAuth: vi.fn(),
        query: vi.fn(async () => ({
          state: 'ready',
          people: PERSON_KEYS.map((key) => ({ key, avatar_storage_id: 'existing-avatar' })),
        })),
        mutation: vi.fn(async (_reference, args) => {
          if (args.mode === failing)
            throw new Error(`Request included ${DEV_ENV.CONVEX_DEPLOY_KEY}`)
          return null
        }),
      }
      const log = vi.fn()
      const error = await runMarketingDemo(['reset', '--dev', '--confirm', 'northstar-labs'], {
        cwd: folder(),
        env: DEV_ENV,
        clientFactory: () => client,
        log,
      }).catch((error) => error)
      expect(log).not.toHaveBeenCalled()
      expect(error.message).not.toContain(DEV_ENV.CONVEX_DEPLOY_KEY)
      return { error, modes: client.mutation.mock.calls.map(([, args]) => args.mode) }
    }
    const seedFailed = await run('seed')
    expect(seedFailed.modes).toEqual(['wipe', 'seed'])
    expect(seedFailed.error.message).toContain('demo work seed')
    expect(seedFailed.error.message).toContain('the demo may now be empty')
    expect(seedFailed.error.message).toContain('Re-run the same reset command')
    // a refused wipe changed nothing: no seed attempt and no empty-demo claim
    const wipeFailed = await run('wipe')
    expect(wipeFailed.modes).toEqual(['wipe'])
    expect(wipeFailed.error.message).toContain('demo work wipe')
    expect(wipeFailed.error.message).not.toContain('empty')
  })

  it('treats wiping an absent demo as a no-op without provisioning anything', async () => {
    const cwd = folder()
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => ({ state: 'absent', counts: { users: 0 } })),
      mutation: vi.fn(),
    }
    await expect(
      runMarketingDemo(['wipe', '--dev', '--confirm', 'northstar-labs'], {
        cwd,
        env: DEV_ENV,
        clientFactory: () => client,
        log: vi.fn(),
      }),
    ).resolves.toMatchObject({ kind: 'complete', state: 'absent' })
    expect(client.mutation).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, '.local'))).toBe(false)
  })

  it('rejects oversized portraits before creating credentials or accounts', async () => {
    const cwd = folder()
    const assetDir = join(cwd, 'scripts', 'demo', 'assets')
    mkdirSync(assetDir, { recursive: true })
    writeFileSync(join(assetDir, 'nora.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => ({ state: 'absent', counts: { users: 0 } })),
      mutation: vi.fn(),
    }
    await expect(
      runMarketingDemo(['seed', '--dev'], {
        cwd,
        env: DEV_ENV,
        clientFactory: () => client,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/2 MiB/)
    expect(client.mutation).not.toHaveBeenCalled()
    expect(existsSync(join(cwd, '.local'))).toBe(false)
  })

  it('repeats an exact known refusal so the date-reset remedy remains actionable', async () => {
    const message = 'marketing demo: use reset to change dates or dataset version'
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => {
        throw { data: { code: 'rule', message } }
      }),
    }
    await expect(
      runMarketingDemo(['seed', '--dev'], {
        cwd: folder(),
        env: DEV_ENV,
        clientFactory: () => client,
        log: vi.fn(),
      }),
    ).rejects.toThrow(message)
  })

  it('withholds raw server errors and writes no credentials before inspection', async () => {
    const cwd = folder()
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => {
        throw new Error(`Request included ${DEV_ENV.CONVEX_DEPLOY_KEY}`)
      }),
    }
    const error = await runMarketingDemo(['seed', '--dev'], {
      cwd,
      env: DEV_ENV,
      clientFactory: () => client,
      log: vi.fn(),
    }).catch((error) => error)
    expect(error.message).toContain('inspection')
    expect(error.message).not.toContain(DEV_ENV.CONVEX_DEPLOY_KEY)
    expect(existsSync(join(cwd, '.local'))).toBe(false)
  })

  it.each([
    ['runInternalQueries', 'inspection', 'query'],
    ['runInternalMutations', 'demo work wipe', 'mutation'],
  ])(
    'reports the missing %s permission without adjacent secrets',
    async (action, stage, method) => {
      const cwd = folder()
      const scope = `deployment:functions:${action}`
      const client = {
        setAdminAuth: vi.fn(),
        query: vi.fn(async () => ({
          state: 'ready',
          people: PERSON_KEYS.map((key) => ({ key, avatar_storage_id: 'existing-avatar' })),
        })),
        mutation: vi.fn(),
      }
      client[method].mockRejectedValue(
        new Error(
          `Request included ${DEV_ENV.CONVEX_DEPLOY_KEY}. You do not have permission to perform this operation (${scope}). This is determined by the permissions granted to CONVEX_DEPLOY_KEY. password=neighboring-secret`,
        ),
      )
      const log = vi.fn()
      const error = await runMarketingDemo(['reset', '--dev', '--confirm', 'northstar-labs'], {
        cwd,
        env: DEV_ENV,
        clientFactory: () => client,
        log,
      }).catch((error) => error)
      expect(error.message).toContain(stage)
      expect(error.message).toContain(scope)
      expect(error.message).toContain('Grant this permission')
      expect(error.message).not.toContain(DEV_ENV.CONVEX_DEPLOY_KEY)
      expect(error.message).not.toContain('neighboring-secret')
      expect(log).not.toHaveBeenCalled()
      expect(existsSync(join(cwd, '.local'))).toBe(false)
    },
  )

  it('withholds unrecognized permission names even when they resemble a known scope', async () => {
    const client = {
      setAdminAuth: vi.fn(),
      query: vi.fn(async () => {
        throw new Error(
          'You do not have permission to perform this operation (deployment:functions:runInternalQueries_privateSecret).',
        )
      }),
    }
    const error = await runMarketingDemo(['seed', '--dev'], {
      cwd: folder(),
      env: DEV_ENV,
      clientFactory: () => client,
      log: vi.fn(),
    }).catch((error) => error)
    expect(error.message).toContain('raw server errors are withheld')
    expect(error.message).not.toContain('deployment:functions:')
    expect(error.message).not.toContain('privateSecret')
  })
})

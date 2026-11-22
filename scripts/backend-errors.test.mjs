import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { errorReport } from './backend-errors.mjs'

const execution = (timestamp, path, type, status, error_message, will_retry = false) =>
  JSON.stringify({
    timestamp,
    topic: 'function_execution',
    function: { path, type, cached: false, request_id: 'e690b44ebff87fe1' },
    execution_time_ms: 11,
    status,
    error_message,
    occ_info: null,
    will_retry,
  })
const consoleLine = (timestamp, path, type, log_level, message) =>
  JSON.stringify({
    timestamp,
    topic: 'console',
    function: { path, type, cached: false, request_id: 'e690b44ebff87fe1' },
    log_level,
    message,
    is_truncated: false,
  })
const STACK = '\n    at handler (../../convex/machine/auth.ts:113:13)\n'

describe('the backend error report', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backend-errors-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const file = (name, lines) => {
    const path = join(dir, name)
    writeFileSync(path, `${lines.join('\n')}\n`)
    return path
  }

  it("prints a function's uncaught error with its function and stack, and no ordinary line or refusal", () => {
    const functionLog = file('function-log.jsonl', [
      execution(1795336557771, 'billingMetering:ingress', 'mutation', 'success', null),
      execution(
        1795336557772,
        'machine/auth:lookupCredential',
        'query',
        'failure',
        `Uncaught Error: forced failure${STACK}`,
      ),
      consoleLine(
        1795336557774,
        'GET /v1/me',
        'http_action',
        'ERROR',
        `[Error: Uncaught Error: forced failure${STACK}]`,
      ),
      execution(
        1795336557820,
        'machine/auth:lookupCredential',
        'query',
        'failure',
        `Uncaught ConvexError: {"code":"not_found","message":"forced refusal"}${STACK}`,
      ),
      execution(
        1795336557830,
        'tasks:update',
        'mutation',
        'failure',
        'Documents read from or written to the "issues" table changed',
        true,
      ),
      consoleLine(1795336557840, 'files:eraseHeldFiles', 'mutation', 'LOG', "'restore check'"),
      consoleLine(1795336557850, 'jobs:sweep', 'mutation', 'WARN', "'sweep resumed'"),
      JSON.stringify({ timestamp: 1795336557860, topic: 'audit_log', audit_log_action: 'push' }),
    ])
    const backendLog = file('backend.log', [
      '\x1b[2m2026-11-22T08:42:45.300000Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mconvex-cloud-http\x1b[0m: "GET /v1/me HTTP/1.1" 500',
      '\x1b[2m2026-11-22T08:42:45.310000Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2misolate::request_scope\x1b[0m: Promise handler added after reject',
      '\x1b[2m2026-11-22T08:42:45.339613Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2msearch_index_workers::retriable_worker\x1b[0m: TextBackfillFlusher died',
      '(conflicts with read of system table _index.by_id)',
      '2026-11-22T08:42:46.000000Z  INFO application: Uploading package',
      'Node executor using tempdir: /tmp/.tmpX4lcNF',
      "thread 'tokio-runtime-worker' (48213) panicked at crates/x/src/y.rs:812:9:",
      'index out of bounds',
      "thread 'main' panicked at crates/z/src/main.rs:5:1:",
    ])
    expect(errorReport({ functionLog, backendLog })).toBe(
      [
        `Function errors, from ${functionLog}:`,
        '  2026-11-22T08:35:57.772Z query machine/auth:lookupCredential failed:',
        '      Uncaught Error: forced failure',
        '          at handler (../../convex/machine/auth.ts:113:13)',
        '  2026-11-22T08:35:57.774Z http_action GET /v1/me console.error:',
        '      [Error: Uncaught Error: forced failure',
        '          at handler (../../convex/machine/auth.ts:113:13)',
        '      ]',
        `Backend errors, from ${backendLog}:`,
        '  2026-11-22T08:42:45.339613Z ERROR search_index_workers::retriable_worker: TextBackfillFlusher died',
        '      (conflicts with read of system table _index.by_id)',
        "  thread 'tokio-runtime-worker' (48213) panicked at crates/x/src/y.rs:812:9:",
        '      index out of bounds',
        "  thread 'main' panicked at crates/z/src/main.rs:5:1:",
      ].join('\n'),
    )
  })

  it('removes keys, tokens, passwords, cookies and signed URLs from an entry, and keeps ids, names and stack lines', () => {
    const instanceSecret = 'c0ffee'.repeat(11).slice(0, 64)
    const adminKey = `qivo-webkit|01${'ab12'.repeat(18)}`
    // built from parts, so that the repository's secret scan finds no
    // secret in this file
    const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const secrets = {
      personalToken: `qvt_${'9f8e7d6c'.repeat(4)}`,
      agentKey: `qva_${'1a2b3c4d'.repeat(4)}`,
      sessionToken: 'Xk3fQ9vL'.repeat(4),
      cookieSignature: 'h7G2kP9x'.repeat(2),
      password: 'Zq-8vN_3'.repeat(6),
      fileToken: 'Zm9vYmFy'.repeat(4),
      uploadToken: '0123abcd'.repeat(5),
      jwt: [base64url({ alg: 'RS256' }), base64url({ sub: 'nora' }), 'c2lnbmF0'].join('.'),
      tokenHash: '1a22'.repeat(16),
    }
    const kept = [
      'k17a9cdkm3bqv5y8w2x0n4r6j1s7t3hd',
      '8f14e45f-ceea-467a-9575-0c1b2d3e4f5a',
      'ArgumentValidationError',
      'INVALID_EMAIL_OR_PASSWORD',
      'at handler (../../convex/tokens.ts:45:3)',
      'machine/auth:lookupCredential',
    ]
    const message = [
      `ArgumentValidationError: Object contains extra field \`secret\` that is not in the validator.`,
      `Object: {hash: "${secrets.tokenHash}", isAgent: false, secret: "${secrets.personalToken}"}`,
      `request headers: {authorization: "Bearer ${secrets.agentKey}", cookie: "better-auth.session_token=${secrets.sessionToken}.${secrets.cookieSignature}; Path=/"}`,
      `fetch http://127.0.0.1:3237/attachment-uploads/${kept[1]}?e=1795336557&m=k17&t=${secrets.fileToken} and /api/storage/upload?token=${secrets.uploadToken}`,
      `login ${secrets.password} with ${secrets.jwt} refused: ${kept[3]}`,
      `personal token ${secrets.personalToken} unknown`,
      `user ${kept[0]} keys ${adminKey} ${instanceSecret}`,
      `    ${kept[4]}`,
    ].join('\n')
    const functionLog = file('function-log.jsonl', [
      execution(1795336557861, 'machine/auth:lookupCredential', 'query', 'failure', message),
    ])
    const backendLog = file('backend.log', [
      `2026-11-22T08:42:45.339613Z ERROR common::errors: admin key ${adminKey} refused for session ${secrets.sessionToken}`,
    ])
    const report = errorReport({
      functionLog,
      backendLog,
      secretFiles: [
        file('instance-secret', [instanceSecret]),
        file('admin-key', [adminKey]),
        join(dir, 'missing-secret'),
      ],
    })
    for (const [name, value] of Object.entries(secrets)) expect(report, name).not.toContain(value)
    expect(report).not.toContain(instanceSecret)
    expect(report).not.toContain(adminKey.split('|')[1])
    for (const value of kept) expect(report).toContain(value)
    expect(report).toContain('qvt_[redacted]')
    expect(report).toContain('ERROR common::errors: admin key [redacted] refused for session')
  })

  it('prints a repeated error once with its count, and cuts a flood at the cap and says how many it left out', () => {
    const repeated = Array.from({ length: 50 }, (_, i) =>
      execution(1795336557000 + i, 'jobs:sweep', 'mutation', 'failure', 'Uncaught Error: same'),
    )
    const long = execution(
      1795336558000,
      'jobs:deep',
      'action',
      'failure',
      `Uncaught Error: deep\n${Array.from({ length: 20 }, (_, i) => `    at f${i} (x.ts:${i}:1)`).join('\n')}`,
    )
    const flood = Array.from({ length: 300 }, (_, i) =>
      execution(1795336559000 + i, 'tasks:update', 'mutation', 'failure', `Uncaught Error: n${i}`),
    )
    const functionLog = file('function-log.jsonl', [...repeated, long, ...flood])
    const report = errorReport(
      { functionLog, backendLog: join(dir, 'backend.log') },
      { entryLines: 5, sectionChars: 2_000 },
    )
    const section = report.slice(0, report.indexOf('\nBackend errors'))
    const lines = section.split('\n')
    expect(lines.filter((line) => line.includes('jobs:sweep failed:'))).toHaveLength(1)
    expect(section).toContain(
      '      Uncaught Error: same\n      (50 times, the last at 2026-11-22T08:35:57.049Z)',
    )
    expect(section).toContain('          at f2 (x.ts:2:1)\n      … the entry is cut here')
    expect(section).not.toContain('at f3 ')
    const shown = lines.filter((line) => line.includes('tasks:update failed:')).length
    const cut = section.match(
      /\n {2}Cut at the cap of 2000 characters\. Not shown: (\d+) more error entries\.$/,
    )
    expect(cut).not.toBeNull()
    expect(shown).toBeGreaterThan(0)
    expect(shown + Number(cut[1])).toBe(300)
    expect(section.length - (lines[0].length + 1) - cut[0].length).toBeLessThanOrEqual(2_000)
  })

  it('says so when a log has no error entry or does not exist, as the workflow runs it', () => {
    const functionLog = join(dir, 'function-log.jsonl')
    const backendLog = file('backend.log', [
      '2026-11-22T08:42:46.000000Z  INFO application: Uploading package',
      '2026-11-22T08:42:46.100000Z  WARN local_backend: Running without a proxy',
    ])
    const run = spawnSync(
      process.execPath,
      ['scripts/backend-errors.mjs', '--function-log', functionLog, '--backend-log', backendLog],
      { encoding: 'utf8' },
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      [
        `Function errors, from ${functionLog}:`,
        '  The file does not exist.',
        `Backend errors, from ${backendLog}:`,
        '  No error entry.',
        '',
      ].join('\n'),
    )
  })
})

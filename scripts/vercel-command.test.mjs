import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// Intercept process boundaries: exercise the real configured shell command
// without ever deploying a backend or inheriting deployment credentials.
function commandsFor(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'qivo-vercel-command-'))
  const log = join(dir, 'commands.jsonl')
  try {
    for (const binary of ['node', 'npx']) {
      writeFileSync(
        join(dir, binary),
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify([${JSON.stringify(binary)}, ...process.argv.slice(2)]) + '\\n')\n`,
        { mode: 0o700 },
      )
    }
    const { buildCommand } = JSON.parse(readFileSync('vercel.json', 'utf8'))
    execFileSync('/bin/sh', ['-c', buildCommand], {
      env: { PATH: dir, COMMAND_LOG: log, ...(mode === undefined ? {} : { VITE_APP_MODE: mode }) },
    })
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the committed Vercel command routes demo builds without the shared seed', () => {
  expect(commandsFor('demo')).toEqual([['node', 'scripts/demo-deploy.mjs']])
})

test.each([undefined, '', 'app'])(
  'the committed Vercel command preserves normal builds with mode %s',
  (mode) => {
    expect(commandsFor(mode)).toEqual([
      [
        'npx',
        'convex',
        'deploy',
        '--cmd',
        'node scripts/vercel-build.mjs',
        '--preview-run',
        'internal/previewSeed:seed',
      ],
    ])
  },
)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeDeploymentReceipt } from './deployment-receipt.mjs'
import { minimumNode, nodeVersionProblem } from './node-engines.mjs'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const engines = JSON.parse(read('package.json')).engines.node

describe('the Node version check', () => {
  it('accepts the minimum and every later release of its major', () => {
    for (const version of ['v24.22.1', 'v24.22.10', 'v24.23.0', 'v24.40.2'])
      expect(nodeVersionProblem(version, '>=24.22.1 <25')).toBeNull()
  })

  it('refuses an older release, another major or a version it cannot read', () => {
    for (const version of ['v24.21.0', 'v24.22.0', 'v24.9.9', 'v22.23.4', 'v25.0.0', 'v24.22'])
      expect(nodeVersionProblem(version, '>=24.22.1 <25')).toBe(
        `Node ${version} does not satisfy package.json engines.node >=24.22.1 <25. Use Node 24.22.1 or a later 24.x release.`,
      )
  })

  it('refuses an engines range that does not name one major with a floor', () => {
    for (const range of ['24.x', '>=24.22.1', '>=24.22.1 <26', '^24.22.1', undefined])
      expect(() => minimumNode(range)).toThrow(/engines\.node must read/)
  })

  /** Runs Node with `args` as if this Node were `version`. */
  const run = (version, ...args) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,Object.defineProperty(process,'version',{value:'${version}'})`,
        ...args,
      ],
      { encoding: 'utf8' },
    )

  it('fails as a command on an older Node and passes on the minimum', () => {
    const minimum = `v${minimumNode(engines).join('.')}`
    const older = run('v24.21.0', 'scripts/node-version.mjs')
    expect(older.status).toBe(1)
    expect(older.stderr).toContain(`Node v24.21.0 does not satisfy package.json engines.node`)
    const current = run(minimum, 'scripts/node-version.mjs')
    expect(current.status).toBe(0)
    expect(current.stdout).toContain(`Node ${minimum} satisfies`)
  })

  it('only warns on an older Node with --warn, as the Vercel build runs it', () => {
    const older = run('v24.21.0', 'scripts/node-version.mjs', '--warn')
    expect(older.status).toBe(0)
    expect(older.stderr).toContain('Warning: Node v24.21.0 does not satisfy')
  })

  // The command has no entry-module test that a symlink, a flag or an
  // import could make false and so skip the check.
  it('checks however the command is loaded', () => {
    const imported = run(
      'v24.21.0',
      '--input-type=module',
      '--eval',
      "await import('./scripts/node-version.mjs')",
    )
    expect(imported.status).toBe(1)
    expect(imported.stderr).toContain('Node v24.21.0 does not satisfy')
  })
})

describe('every place that picks a Node for Qivo', () => {
  // Convex reads convex.json and otherwise runs Node actions on its own
  // default major.
  it('runs the backend Node actions on the major the app builds and tests with', () => {
    expect(read('convex.json')).toContain(`"nodeVersion": "${minimumNode(engines)[0]}"`)
  })

  it('keeps the lockfile root on the same range', () => {
    expect(JSON.parse(read('package-lock.json')).packages[''].engines.node).toBe(engines)
  })

  const workflows = readdirSync(new URL('../.github/workflows', import.meta.url)).map((name) => [
    name,
    read(`.github/workflows/${name}`),
  ])

  /** The jobs of a workflow, each from its key under `jobs:` to the next. */
  const jobsOf = (text) =>
    text
      .slice(text.indexOf('\njobs:\n'))
      .split(/\n(?= {2}[\w-]+:[ \t]*$)/m)
      .slice(1)

  it('sets up the newest Node of the engines range and checks it before any other step', () => {
    let setups = 0
    let nodeJobs = 0
    for (const [name, text] of workflows) {
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        const step = /^(\s*)- uses: actions\/setup-node@/.exec(line)
        if (!step) return
        setups++
        const indent = step[1]
        const end = lines.findIndex((next, at) => at > index && next.startsWith(`${indent}- `))
        const inputs = lines.slice(index + 1, end).map((input) => input.trim())
        const file = inputs.find((input) => input.startsWith('node-version-file: '))
        const directory = /^node-version-file: ((?:\.node-check\/)?)package\.json$/.exec(file)?.[1]
        expect(directory, `${name}: ${file}`).toBeDefined()
        // A workflow that builds a chosen ref takes the check and its range
        // from its own commit, since an older ref has neither.
        if (/ref: \$\{\{ (?:inputs\.ref|needs\.resolve\.outputs\.sha) \}\}/.test(text)) {
          expect(directory, name).toBe('.node-check/')
          expect(text, name).toContain(
            '          path: .node-check\n          sparse-checkout: |\n            /package.json\n            /scripts/node-engines.mjs\n            /scripts/node-version.mjs\n          sparse-checkout-cone-mode: false\n',
          )
        }
        expect(inputs, name).toContain('check-latest: true')
        expect(lines.slice(end, end + 2), name).toEqual([
          `${indent}- name: Check the Node version`,
          `${indent}  run: node ${directory}scripts/node-version.mjs`,
        ])
      })
      // Every job that runs Node sets it up; the runner's own Node is unchecked.
      for (const job of jobsOf(text))
        if (/\b(?:node|npm|npx) \S/.test(job.replaceAll(/^\s*#.*$/gm, ''))) {
          nodeJobs++
          expect(job, `${name} ${job.split('\n')[0]}`).toContain('uses: actions/setup-node@')
        }
      expect(text, name).not.toMatch(/node-version:/)
    }
    expect(setups).toBeGreaterThanOrEqual(5)
    expect(nodeJobs).toBe(setups)
  })

  it('reports the Node of every Vercel build before it builds', () => {
    expect(JSON.parse(read('vercel.json')).buildCommand).toMatch(
      /^node scripts\/node-version\.mjs --warn && /,
    )
  })

  it('names the Node that built a hosted app in its version.json', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qivo-receipt-'))
    try {
      writeFileSync(join(directory, 'version.json'), JSON.stringify({ buildId: 'build' }))
      const commit = '0'.repeat(40)
      writeDeploymentReceipt(
        { VERCEL_GIT_COMMIT_SHA: commit, QIVO_ENVIRONMENT: 'staging' },
        directory,
      )
      expect(JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8'))).toEqual({
        buildId: 'build',
        commit,
        environment: 'staging',
        node: process.version,
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

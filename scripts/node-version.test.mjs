import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { minimumNode, nodeVersionProblem } from './node-version.mjs'

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

  it('fails as a command on an older Node and passes on the minimum', () => {
    const as = (version) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,Object.defineProperty(process,'version',{value:'${version}'})`,
          'scripts/node-version.mjs',
        ],
        { encoding: 'utf8' },
      )
    const minimum = `v${minimumNode(engines).join('.')}`
    const older = as('v24.21.0')
    expect(older.status).toBe(1)
    expect(older.stderr).toContain(`Node v24.21.0 does not satisfy package.json engines.node`)
    const current = as(minimum)
    expect(current.status).toBe(0)
    expect(current.stdout).toContain(`Node ${minimum} satisfies`)
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

  it('sets up the newest Node of the engines range and checks it before any other step', () => {
    let setups = 0
    for (const [name, text] of workflows) {
      const lines = text.split('\n')
      lines.forEach((line, index) => {
        const step = /^(\s*)- uses: actions\/setup-node@/.exec(line)
        if (!step) return
        setups++
        const indent = step[1]
        const end = lines.findIndex((next, at) => at > index && next.startsWith(`${indent}- `))
        const inputs = lines.slice(index + 1, end).map((input) => input.trim())
        expect(inputs, name).toContain('node-version-file: package.json')
        expect(inputs, name).toContain('check-latest: true')
        expect(lines.slice(end, end + 2), name).toEqual([
          `${indent}- name: Check the Node version`,
          `${indent}  run: node scripts/node-version.mjs`,
        ])
      })
      // Every workflow that runs Node sets it up; the runner's own Node is unchecked.
      if (/\b(?:node|npm|npx) \S/.test(text.replaceAll(/^\s*#.*$/gm, '')))
        expect(text, name).toContain('uses: actions/setup-node@')
      expect(text, name).not.toMatch(/node-version:/)
    }
    expect(setups).toBeGreaterThanOrEqual(5)
  })

  it('checks the Node of every Vercel build before it builds', () => {
    expect(JSON.parse(read('vercel.json')).buildCommand).toMatch(
      /^node scripts\/node-version\.mjs && /,
    )
  })
})

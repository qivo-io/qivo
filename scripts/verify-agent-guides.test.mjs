import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyAgentGuides } from './verify-agent-guides.mjs'

describe('agent guides in the deployment output', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qivo-agent-guides-'))
    mkdirSync(join(root, 'public'))
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'vercel.json'), JSON.stringify({ outputDirectory: 'dist' }))
    for (const guide of ['llms.txt', 'skill.md', 'auth.md']) {
      const content = `# Qivo ${guide}\n\nAgent guidance.\n`
      writeFileSync(join(root, 'public', guide), content)
      writeFileSync(join(root, 'dist', guide), content)
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts all three unchanged guides at the deployment root', () => {
    expect(() => verifyAgentGuides(root)).not.toThrow()
  })

  it.each(['llms.txt', 'skill.md', 'auth.md'])('refuses a build missing /%s', (guide) => {
    rmSync(join(root, 'dist', guide))
    expect(() => verifyAgentGuides(root)).toThrow(`/${guide} must exist at the deployment root`)
  })

  it('refuses files copied into a public subdirectory instead of the deployment root', () => {
    mkdirSync(join(root, 'dist', 'public'))
    renameSync(join(root, 'dist', 'auth.md'), join(root, 'dist', 'public', 'auth.md'))
    expect(() => verifyAgentGuides(root)).toThrow('/auth.md must exist at the deployment root')
  })

  it.each(['# Stale guide\n', '<!doctype html><html>Homepage</html>'])(
    'refuses output that differs from the source: %s',
    (content) => {
      writeFileSync(join(root, 'dist', 'skill.md'), content)
      expect(() => verifyAgentGuides(root)).toThrow('dist/skill.md differs from public/skill.md')
    },
  )

  it('refuses an empty source even when the output matches', () => {
    for (const dir of ['public', 'dist']) {
      writeFileSync(join(root, dir, 'llms.txt'), ' \n')
    }
    expect(() => verifyAgentGuides(root)).toThrow('public/llms.txt is empty')
  })

  it('refuses a deleted source even when an old build still has the file', () => {
    rmSync(join(root, 'public', 'auth.md'))
    expect(() => verifyAgentGuides(root)).toThrow(/ENOENT.*auth\.md/)
  })

  it('checks the configured deployment output instead of accepting an old dist directory', () => {
    writeFileSync(join(root, 'vercel.json'), JSON.stringify({ outputDirectory: 'release' }))
    expect(() => verifyAgentGuides(root)).toThrow('Cannot read release/llms.txt')
    renameSync(join(root, 'dist'), join(root, 'release'))
    expect(() => verifyAgentGuides(root)).not.toThrow()
  })

  it('requires an explicit deployment output directory', () => {
    writeFileSync(join(root, 'vercel.json'), '{}')
    expect(() => verifyAgentGuides(root)).toThrow(/must name the outputDirectory/)
  })
})

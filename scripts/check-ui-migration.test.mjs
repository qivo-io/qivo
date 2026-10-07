import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./check-ui-migration.mjs', import.meta.url))

// Exercise the actual parser and CLI exit status: a traversal that misses JSX
// after a TypeScript upgrade must not make the migration guard silently pass.
function runGuard({ files, allowlist = {}, css = '', tsconfig }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-ui-guard-'))
  try {
    const fixture = {
      'src/styles/tokens.css': css,
      'scripts/ui-runtime-style-allowlist.json': JSON.stringify(allowlist),
      ...files,
      ...(tsconfig ? { 'tsconfig.json': JSON.stringify(tsconfig) } : {}),
    }
    for (const [file, source] of Object.entries(fixture)) {
      const target = path.join(cwd, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, source)
    }
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
    })
    if (result.error) throw result.error
    return result
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

describe('UI migration guard with the native TypeScript parser', () => {
  it('allows reviewed dynamic styles and exempts shared UI primitives', () => {
    const result = runGuard({
      files: {
        'src/Feature.tsx':
          'export const view = <Button className="modern" style={{ width: size }} />',
        'src/components/ui/Button.tsx':
          'export const button = <button className="tbtn" style={{ width: 12 }} />',
      },
      allowlist: { 'src/Feature.tsx': { count: 1, reason: 'Measured width' } },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 feature files, 1 reviewed runtime style sites')
  })

  it('rejects native controls, legacy classes and static styles even outside tsconfig', () => {
    const result = runGuard({
      tsconfig: { files: ['src/Included.tsx'] },
      files: {
        'src/Included.tsx': 'export const included = <div />',
        'src/Feature.tsx': [
          'export const view = <>',
          '  <button className="tbtn">Save</button>',
          '  <input className={`iconbtn`} />',
          '  <select className={active ? "mdbtn" : "modern"} />',
          '  <textarea />',
          '  <div style={{ width: 12, color: "red", display: `block` }} />',
          '</>',
        ].join('\n'),
      },
      allowlist: { 'src/Feature.tsx': { count: 1, reason: 'Reviewed site' } },
      css: '.provider-btn:hover { color: red; }',
    })
    expect(result.status).toBe(1)
    for (const [line, tag] of ['button', 'input', 'select', 'textarea'].entries()) {
      expect(result.stderr).toContain(`src/Feature.tsx:${line + 2} uses raw <${tag}>`)
    }
    for (const token of ['tbtn', 'iconbtn', 'mdbtn']) {
      expect(result.stderr).toContain(`uses legacy .${token}`)
    }
    expect(result.stderr.match(/keeps static presentation in style/g)).toHaveLength(3)
    expect(result.stderr).toContain(
      'src/styles/tokens.css still defines or references .provider-btn',
    )
  })

  it('enforces runtime style counts, missing entries and review reasons', () => {
    const result = runGuard({
      files: {
        'src/Feature.tsx': 'export const view = <div style={{ width: size }} style={position} />',
        'src/Other.tsx': 'export const other = <div style={position} />',
      },
      allowlist: {
        'src/Feature.tsx': { count: 1, reason: '' },
        'src/Removed.tsx': { count: 1, reason: 'Previously measured' },
      },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'src/Feature.tsx has 2 runtime style site(s); reviewed allowlist says 1',
    )
    expect(result.stderr).toContain(
      'src/Other.tsx has 1 runtime style site(s) but is not allowlisted',
    )
    expect(result.stderr).toContain('src/Removed.tsx allowlist is stale (1 reviewed, 0 found)')
    expect(result.stderr).toContain('src/Feature.tsx has no runtime-style reason')
  })

  it('refuses malformed TSX instead of trusting an incomplete parse', () => {
    const result = runGuard({ files: { 'src/Feature.tsx': 'export const view = <div' } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/Feature.tsx has syntax errors')
  })

  it('preserves component titles, document metadata and shared tooltip primitives', () => {
    const result = runGuard({
      files: {
        'src/Feature.tsx': [
          'const model = { title: "Task name" }; model.title = "Updated task";',
          'export const view = <>',
          '  <title>Document title</title>',
          '  <ModalShell title="Task details" />',
          '  <EmptyState title="No tasks" />',
          '  <Button title="Create task" />',
          '  <HoverTooltip content="Assignee"><span>Nora</span></HoverTooltip>',
          '</>',
        ].join('\n'),
        'src/components/ui/tooltip.tsx':
          'export const tooltip = <div role="tooltip">Shared content</div>',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 feature files, 0 reviewed runtime style sites')
    expect(result.stdout).toContain('0 imperative renderer checked')
  })

  it('rejects native hover help and custom tooltip roles in feature JSX', () => {
    const result = runGuard({
      files: {
        'src/Feature.tsx': [
          'export const view = <>',
          '  <span title="Full project name">Project</span>',
          '  <div title={helpText} />',
          '  <svg><g><title>Priority</title></g></svg>',
          '  <div role="tooltip">Custom tooltip</div>',
          '  <FloatingPanel role={"tooltip"} />',
          '</>',
        ].join('\n'),
      },
    })
    expect(result.status).toBe(1)
    for (const line of [2, 3])
      expect(result.stderr).toContain(`src/Feature.tsx:${line} uses a native title tooltip`)
    expect(result.stderr).toContain('src/Feature.tsx:4 uses an SVG <title> tooltip')
    for (const line of [5, 6])
      expect(result.stderr).toContain(`src/Feature.tsx:${line} defines a custom tooltip`)
  })

  it('checks imperative tooltip writes on created DOM elements outside tsconfig', () => {
    const result = runGuard({
      tsconfig: { files: ['src/Feature.tsx'] },
      files: {
        'src/Feature.tsx': 'export const view = <div />',
        'src/components/mentionSuggestion.ts': [
          'const row = document.createElement("button");',
          'row.title = "Member email";',
          'row.setAttribute("title", "Member email");',
          'let popup; popup = document.createElement("div");',
          'popup.role = "tooltip";',
          'popup.setAttribute("role", "tooltip");',
        ].join('\n'),
      },
    })
    expect(result.status).toBe(1)
    for (const line of [2, 3, 5, 6])
      expect(result.stderr).toContain(
        `src/components/mentionSuggestion.ts:${line} writes native/custom tooltip markup`,
      )
    expect(result.stderr.match(/writes native\/custom tooltip markup/g)).toHaveLength(4)
  })

  it('allows model titles even when a DOM variable has the same name in another scope', () => {
    const result = runGuard({
      files: {
        'src/Feature.tsx': 'export const view = <div />',
        'src/components/mentionSuggestion.ts': [
          'const row = document.createElement("button");',
          'row.setAttribute("aria-label", "Select member");',
          'row.role = "option";',
          'row.textContent = "Nora";',
          'function updateModel() {',
          '  const row = { title: "Task name" };',
          '  row.title = "Updated task";',
          '  return row;',
          '}',
        ].join('\n'),
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('1 imperative renderer checked')
  })
})

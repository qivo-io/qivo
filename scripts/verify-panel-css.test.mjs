import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyBuiltPanelCss, verifyPanelCss } from './verify-panel-css.mjs'

const selector = 'html[data-appearance]:where(.planner-navigation,.settings-content-frame)'
const material = 'var(--workspace-panel-blur)'
const working = `${selector}{-webkit-backdrop-filter:${material};backdrop-filter:${material}}`

describe('production panel blur', () => {
  it('accepts the standard blur with or without an older WebKit fallback', () => {
    expect(() => verifyPanelCss(working)).not.toThrow()
    expect(() => verifyPanelCss(`${selector}{backdrop-filter:${material}}`)).not.toThrow()
  })

  it('allows Tailwind to emit an explicitly prefixed utility as its own rule', () => {
    expect(() =>
      verifyPanelCss(
        `${working}.\\[-webkit-backdrop-filter\\:blur\\(4px\\)\\]{-webkit-backdrop-filter:blur(4px)}`,
      ),
    ).not.toThrow()
  })

  it('rejects the prefixed-only rule produced by the September 13 build', () => {
    expect(() =>
      verifyPanelCss(
        `${selector}{background:var(--workspace-panel);-webkit-backdrop-filter:${material}}`,
      ),
    ).toThrow('Missing matching standard backdrop-filter')
  })

  it('does not let working sidebar blur hide a broken floating surface or reset', () => {
    for (const value of [material, 'none']) {
      expect(() =>
        verifyPanelCss(`${working}[data-floating-surface]{-webkit-backdrop-filter:${value}}`),
      ).toThrow('Missing matching standard backdrop-filter')
    }
  })

  it('rejects absent or disabled shared panel blur', () => {
    expect(() => verifyPanelCss('.unrelated{backdrop-filter:blur(10px)}')).toThrow('Cannot find')
    expect(() => verifyPanelCss(`${selector}{backdrop-filter:none}`)).toThrow('must retain')
  })

  it('reads every CSS chunk from the configured deployment output', () => {
    const root = mkdtempSync(join(tmpdir(), 'qivo-panel-css-'))
    try {
      mkdirSync(join(root, 'release', 'assets'), { recursive: true })
      writeFileSync(join(root, 'vercel.json'), JSON.stringify({ outputDirectory: 'release' }))
      writeFileSync(join(root, 'release', 'assets', 'shared.css'), working)
      expect(() => verifyBuiltPanelCss(root)).not.toThrow()
      writeFileSync(
        join(root, 'release', 'assets', 'lazy.css'),
        '.mobile-roadmap-section{-webkit-backdrop-filter:var(--workspace-panel-blur)}',
      )
      expect(() => verifyBuiltPanelCss(root)).toThrow('Missing matching standard backdrop-filter')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

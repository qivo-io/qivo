#!/usr/bin/env node
/* Inspect the shipped CSS: development serves declarations that production's
 * optimizer can remove. Prefixed-only backdrop blur is ignored by Chromium. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export function verifyPanelCss(css) {
  let sharedPanelFound = false
  // Generated declaration blocks contain no nested braces. Inspect each one
  // separately so a working declaration elsewhere cannot mask a broken panel.
  for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Tailwind's explicit vendor-property utility is separate from its standard
    // companion class. It is not an authored panel declaration pair.
    if (selector.trim().startsWith('.\\[-webkit-backdrop-filter\\:')) continue
    const standard = declarations.match(/(?:^|;)\s*backdrop-filter\s*:\s*([^;]+)/)?.[1]?.trim()
    const prefixed = declarations
      .match(/(?:^|;)\s*-webkit-backdrop-filter\s*:\s*([^;]+)/)?.[1]
      ?.trim()
    if (prefixed && standard !== prefixed) {
      throw new Error(`Missing matching standard backdrop-filter in ${selector.trim()}`)
    }
    if (selector.includes('.planner-navigation') && selector.includes('.settings-content-frame')) {
      sharedPanelFound = true
      if (standard !== 'var(--workspace-panel-blur)') {
        throw new Error('Sidebar and Settings must retain standard workspace backdrop blur')
      }
    }
  }
  if (!sharedPanelFound) throw new Error('Cannot find the generated Sidebar/Settings panel rule')
}

export function verifyBuiltPanelCss(root = projectRoot) {
  const { outputDirectory } = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) {
    throw new Error('vercel.json must name the outputDirectory to check before deployment')
  }
  const output = resolve(root, outputDirectory)
  const css = readdirSync(output, { recursive: true })
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(output, name), 'utf8'))
    .join('\n')
  verifyPanelCss(css)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyBuiltPanelCss()
    console.log('[panel-css] Verified standard backdrop blur in production styles')
  } catch (error) {
    console.error(`[panel-css] ${error.message}`)
    process.exitCode = 1
  }
}

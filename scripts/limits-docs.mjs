#!/usr/bin/env node
/* Writes the limits tables of the public docs from the one registry,
 * convex/lib/limits.ts: the whole guide page docs/guide/limits.md, and the
 * table between the limits markers in docs/rest-api.md and docs/mcp.md.
 * `node scripts/limits-docs.mjs` rewrites them; scripts/docs-contract.mjs
 * calls limitsDocsErrors and fails while any of them differs from the
 * registry, so a changed limit cannot leave a stale number in the docs. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grouped, LIMIT_GROUPS, LIMITS } from '../convex/lib/limits.ts'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export const START = '<!-- limits:start (written by scripts/limits-docs.mjs) -->'
export const END = '<!-- limits:end -->'

/** A limit's value as the tables print it: "255 characters" or "1 to 168 hours". */
function value(limit) {
  const max = `${grouped(limit.max)} ${limit.unit}`
  return limit.min === undefined ? max : `${grouped(limit.min)} to ${max}`
}

/** `s` as a table cell, pipes escaped. */
const cell = (s) => s.replaceAll('|', '\\|')

/** A limit's refusal as the readers of a table meet it: on the guide page
 * (`surface` null) as the app shows it, capitalized with a final period,
 * when the app meets it; in the REST and MCP docs as those answer it, which
 * can start with a parameter name such as `limit`. */
const shown = (l, surface) =>
  surface === null && l.on.includes('app') ? sentence(l.refusal) : l.refusal
const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.')

/** The `limits` met on `surface` ('app', 'rest' or 'mcp'; null for any of
 * them), one table per group with a heading of `level` hashes. */
export function limitTables(surface, level, limits = LIMITS) {
  const out = []
  for (const [group, heading] of Object.entries(LIMIT_GROUPS)) {
    const rows = Object.values(limits).filter(
      (l) =>
        l.group === group &&
        (surface === null ? l.on.some((s) => s !== 'operator') : l.on.includes(surface)),
    )
    if (rows.length === 0) continue
    out.push(`${'#'.repeat(level)} ${heading}`, '', '| Limit | Value | Past the limit |')
    out.push('| --- | --- | --- |')
    for (const l of rows) out.push(`| ${l.label} | ${value(l)} | ${cell(shown(l, surface))} |`)
    out.push('')
  }
  return out.join('\n').trimEnd()
}

const GUIDE_INTRO = `Every limit in Qivo is the same in the app, the REST API and the MCP server. A refused change keeps nothing and says which limit it passed and what to do. The app keeps what you typed or pasted, shows how many characters a field holds as it nears its limit and turns Save off until the text fits.

A character is one UTF-16 code unit, the count a browser's text field uses. Most letters count as one and most emoji as two. Qivo trims spaces and line breaks from both ends of a text before counting and stores the trimmed text.`

/** The guide page's whole Markdown source. */
export const guidePage = (limits = LIMITS) => `${GUIDE_INTRO}\n\n${limitTables(null, 2, limits)}\n`

/** `doc` with the text between the markers replaced by the `surface` tables. */
function withTables(doc, surface, file, limits) {
  const start = doc.indexOf(START)
  const end = doc.indexOf(END)
  if (start === -1 || end < start) throw new Error(`${file} has no limits markers`)
  return `${doc.slice(0, start + START.length)}\n\n${limitTables(surface, 3, limits)}\n\n${doc.slice(end)}`
}

/** Each generated file with the text it should hold under `limits`. */
function expected(root, limits) {
  const files = [{ file: 'docs/guide/limits.md', text: guidePage(limits) }]
  for (const [file, surface] of [
    ['docs/rest-api.md', 'rest'],
    ['docs/mcp.md', 'mcp'],
  ]) {
    files.push({
      file,
      text: withTables(
        readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n'),
        surface,
        file,
        limits,
      ),
    })
  }
  return files
}

/** One problem per generated file that differs from the registry,
 * `limits` (the real one unless a test passes a changed copy). */
export function limitsDocsErrors(root = projectRoot, limits = LIMITS) {
  const errors = []
  let files
  try {
    files = expected(root, limits)
  } catch (e) {
    return [String(e instanceof Error ? e.message : e)]
  }
  for (const { file, text } of files) {
    let current = ''
    try {
      // a checkout with Windows line endings holds the same text
      current = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')
    } catch {}
    if (current !== text)
      errors.push(
        `${file}: the limits table differs from convex/lib/limits.ts; run node scripts/limits-docs.mjs`,
      )
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { file, text } of expected(projectRoot, LIMITS))
    writeFileSync(join(projectRoot, file), text)
  console.log('[limits] wrote docs/guide/limits.md, docs/rest-api.md and docs/mcp.md')
}

#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs, stripVTControlCharacters } from 'node:util'

const ENTRY_LINES = 40
const ENTRY_CHARS = 4_000
const SECTION_CHARS = 24_000

const REDACTED = '[redacted]'
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+/
const RANDOM_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g

/**
 * Returns a function that removes secrets from a text: each of `values`,
 * and anything shaped like a secret a run of the check makes.
 */
export function redactor(values) {
  const known = values
    .map((value) => value.trim())
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)
  // The report goes to a public CI log, and an error can quote a function's
  // arguments or a request. So besides the backend's keys this removes Qivo
  // credentials, JWTs, signed URL parameters, cookies, values named as
  // secrets and random strings such as session tokens and passwords. A
  // random string mixes upper and lower case, with digits or at 32
  // characters or more, which Convex ids and names in code rarely do.
  return (text) => {
    let out = text
    for (const value of known) out = out.replaceAll(value, REDACTED)
    return out
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(
        /(\b[\w.-]*(?:password|passwd|secret|token|cookie|authorization|api_?key|jwt|session)[\w.-]*["']?\s*(?:=\s*["']?|:\s*["']))[^"'\s,;}&)[\]]+/gi,
        `$1${REDACTED}`,
      )
      .replace(
        /([?&](?:t|token|sig|signature|code|key|X-Amz-[A-Za-z-]+)=)[^&\s"'<>[\]]+/gi,
        `$1${REDACTED}`,
      )
      .replace(/\b(qv[a-z]_)[A-Za-z0-9_-]+/g, `$1${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, REDACTED)
      .replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED)
      .replace(RANDOM_RUN, (run) => {
        const mixed = /[A-Z]/.test(run) && /[a-z]/.test(run)
        return mixed && (run.length >= 32 || /[0-9]/.test(run)) ? REDACTED : run
      })
  }
}

/** The error entries of the function log that --local-log-sink writes. */
function functionEntries(text) {
  const entries = []
  let unreadable = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      unreadable++
      continue
    }
    const fn = event.function ?? {}
    const at = Number.isFinite(event.timestamp) ? new Date(event.timestamp).toISOString() : ''
    if (
      event.topic === 'function_execution' &&
      event.status === 'failure' &&
      // the backend runs the function again
      event.will_retry !== true &&
      // a refusal the caller answers with, such as a 404, which the check
      // causes many times on purpose
      !String(event.error_message).startsWith('Uncaught ConvexError:')
    )
      entries.push({ at, text: `${fn.type} ${fn.path} failed:\n${event.error_message}` })
    else if (event.topic === 'console' && event.log_level === 'ERROR')
      entries.push({ at, text: `${fn.type} ${fn.path} console.error:\n${event.message}` })
  }
  return { entries, unreadable }
}

function backendEntries(text) {
  const entries = []
  let current = null
  for (const line of stripVTControlCharacters(text).split('\n')) {
    const stamp = line.match(STAMP)
    if (stamp) {
      const rest = line.slice(stamp[0].length)
      current = rest.startsWith('ERROR ') ? { at: stamp[1], text: rest } : null
      if (current) entries.push(current)
    } else if (/^thread '.*'(?: \(\d+\))? panicked at /.test(line)) {
      current = { at: '', text: line }
      entries.push(current)
    } else if (current && line.trim() !== '') current.text += `\n${line}`
  }
  return { entries, unreadable: 0 }
}

function cutEntry(text, { entryLines, entryChars }) {
  let lines = text.split('\n')
  let cut = false
  if (lines.length > entryLines) {
    lines = lines.slice(0, entryLines)
    cut = true
  }
  let out = lines.join('\n')
  if (out.length > entryChars) {
    out = out.slice(0, entryChars)
    cut = true
  }
  return cut ? `${out}\n… the entry is cut here` : out
}

function section(title, path, read, redact, caps) {
  const out = [`${title}, from ${path}:`]
  if (!existsSync(path)) return [...out, '  The file does not exist.']
  const { entries, unreadable } = read(readFileSync(path, 'utf8'))
  const distinct = new Map()
  for (const entry of entries) {
    const text = cutEntry(redact(entry.text).trimEnd(), caps)
    const seen = distinct.get(text)
    if (seen) {
      seen.count++
      seen.last = entry.at
    } else distinct.set(text, { first: entry.at, last: entry.at, count: 1 })
  }
  if (distinct.size === 0) out.push('  No error entry.')
  let size = 0
  let shown = 0
  for (const [text, { first, last, count }] of distinct) {
    const [head, ...body] = text.split('\n')
    const lines = [
      `  ${[first, head].filter(Boolean).join(' ')}`,
      ...body.map((line) => (line.trim() === '' ? '' : `      ${line}`)),
    ]
    if (count > 1) lines.push(`      (${count} times, the last at ${last})`)
    const block = lines.join('\n')
    if (size + block.length > caps.sectionChars) break
    out.push(block)
    size += block.length + 1
    shown++
  }
  const left = distinct.size - shown
  if (left > 0)
    out.push(
      `  Cut at the cap of ${caps.sectionChars} characters. Not shown: ${left} more error ${left === 1 ? 'entry' : 'entries'}.`,
    )
  if (unreadable > 0) out.push(`  Skipped ${unreadable} of its lines, which are not JSON.`)
  return out
}

/**
 * The report of the error entries in a local backend's function log and in
 * its own log, with secrets removed, as text to print.
 */
export function errorReport(
  { functionLog, backendLog, secretFiles = [] },
  { entryLines = ENTRY_LINES, entryChars = ENTRY_CHARS, sectionChars = SECTION_CHARS } = {},
) {
  const secrets = secretFiles
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
  const redact = redactor(secrets)
  const caps = { entryLines, entryChars, sectionChars }
  return [
    ...section('Function errors', functionLog, functionEntries, redact, caps),
    ...section('Backend errors', backendLog, backendEntries, redact, caps),
  ].join('\n')
}

if (import.meta.main) {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        'function-log': { type: 'string' },
        'backend-log': { type: 'string' },
        'secret-file': { type: 'string', multiple: true },
      },
    }))
  } catch {}
  if (!values?.['function-log'] || !values['backend-log']) {
    console.error(
      'Usage: node scripts/backend-errors.mjs --function-log FILE --backend-log FILE [--secret-file FILE]...',
    )
    process.exit(2)
  }
  console.log(
    errorReport({
      functionLog: values['function-log'],
      backendLog: values['backend-log'],
      secretFiles: values['secret-file'] ?? [],
    }),
  )
}

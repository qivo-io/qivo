/* The public docs list the app actions that have no REST route or MCP tool
 * under a "Stays in the app" heading, once in each file below. The copies
 * must hold the same bullets, so a change to one copy fails here until the
 * other copies follow. Only the bullets are compared; each file words its
 * own introduction. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const COPIES = ['docs/rest-api.md', 'docs/mcp.md', 'public/skill.md']
const HEADING = /^#{2,3} Stays in the app$/

/** The bullets under the file's one "Stays in the app" heading, up to the
 * next heading, each folded onto one line so rewrapping is no change. Throws
 * unless the file has exactly one such heading. */
function staysInTheApp(text) {
  const lines = text.split('\n')
  const starts = lines.flatMap((line, i) => (HEADING.test(line) ? [i] : []))
  if (starts.length !== 1)
    throw new Error(`expected one Stays in the app heading, found ${starts.length}`)
  const bullets = []
  let inBullet = false
  for (const line of lines.slice(starts[0] + 1)) {
    if (line.startsWith('#')) break
    const continued = inBullet && /^\s+\S/.test(line)
    if (line.startsWith('- ')) bullets.push(line.slice(2).trim())
    else if (continued) bullets[bullets.length - 1] += ` ${line.trim()}`
    inBullet = line.startsWith('- ') || continued
  }
  return bullets
}

const read = (file) => readFileSync(new URL(file, root), 'utf8')

describe('Stays in the app', () => {
  it('holds the same bullets in every copy', () => {
    const [first, ...others] = COPIES.map((file) => staysInTheApp(read(file)))
    expect(first.length).toBeGreaterThan(0)
    for (const list of others) expect(list).toEqual(first)
  })

  it('reads a rewrapped bullet as unchanged and an edited one as a change', () => {
    const text = read('docs/rest-api.md')
    const list = staysInTheApp(text)
    const rewrapped = text.replace(
      '- Adding or removing other people as followers of a task. A credential\n  changes',
      '- Adding or removing other people as followers of a task.\n  A credential changes',
    )
    expect(rewrapped).not.toBe(text)
    expect(staysInTheApp(rewrapped)).toEqual(list)
    const edited = text.replace('- Inviting a guest to a project by email.', '- Inviting a guest.')
    expect(staysInTheApp(edited)).not.toEqual(list)
    expect(staysInTheApp(text.replace(/\n- Billing[^\n]*/, ''))).toHaveLength(list.length - 1)
  })

  it('refuses a file without the heading or with two', () => {
    const text = read('public/skill.md')
    expect(() => staysInTheApp(text.replace('## Stays in the app', '## Browser only'))).toThrow(
      'found 0',
    )
    expect(() => staysInTheApp(`${text}\n## Stays in the app\n`)).toThrow('found 2')
  })
})

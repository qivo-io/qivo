/* The limits registry (lib/limits.ts): every refusal states the number its
 * entry holds, so a changed limit cannot leave a stale number in a sentence,
 * and grouped() prints numbers as the sentences and docs do. */

import { describe, expect, it } from 'vitest'
import {
  attachmentTooLarge,
  grouped,
  LIMITS,
  type Limit,
  linksFull,
  MIB,
  trimMarkdown,
} from '../lib/limits'
import { ARCHIVE_TTL_MS, DEMO_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES } from '../model/orgExports'

describe('the limits registry', () => {
  it.each(Object.entries(LIMITS) as [string, Limit][])(
    '%s states its own numbers',
    (_name, limit) => {
      expect(limit.refusal).toContain(grouped(limit.max))
      if (limit.min !== undefined && limit.min > 0)
        expect(limit.refusal).toContain(grouped(limit.min))
      // a sentence starts lowercase, so the app can capitalize it
      expect(limit.refusal.charAt(0)).toBe(limit.refusal.charAt(0).toLowerCase())
    },
  )

  it("gives the organization export's cap, the demo's cap and its hours their numbers", () => {
    expect(MAX_ARCHIVE_BYTES).toBe(95 * 1024 * 1024)
    expect(DEMO_ARCHIVE_BYTES).toBe(2 * 1024 * 1024)
    expect(ARCHIVE_TTL_MS).toBe(4 * 60 * 60 * 1000)
    expect(MAX_ARCHIVE_BYTES).toBe(LIMITS.exportSize.max * MIB)
    expect(DEMO_ARCHIVE_BYTES).toBe(LIMITS.demoExportSize.max * MIB)
    expect(ARCHIVE_TTL_MS).toBe(LIMITS.exportHours.max * 3_600_000)
  })

  it('builds the sentences that name a value from the same numbers', () => {
    expect(attachmentTooLarge(7)).toContain('7 MiB')
    expect(linksFull('QN-7')).toContain(`QN-7 already has ${LIMITS.links.max} links`)
  })

  it('groups digits without Intl', () => {
    expect([grouped(80), grouped(20_000), grouped(99_999.9), grouped(604_800_000)]).toEqual([
      '80',
      '20,000',
      '99,999.9',
      '604,800,000',
    ])
  })

  it('trims Markdown without turning a paragraph into a heading, list or quote', () => {
    expect(trimMarkdown('\n\n  \nFix the login \n\n')).toBe('Fix the login')
    for (const text of [' # Heading', ' - literal dash', ' > literal quote']) {
      expect(trimMarkdown(`\n${text}\n`), text).toBe(text)
    }
  })
})

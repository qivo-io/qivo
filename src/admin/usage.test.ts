import { describe, expect, it } from 'vitest'
import type { UsageMonth } from './api'
import { pickerMonths, USAGE_COLUMNS, usageCsv } from './usage'

const counts = Object.fromEntries(
  USAGE_COLUMNS.map((c, i) => [c.key, i]),
) as UsageMonth['rows'][number]['counts']

describe('the usage CSV', () => {
  it('writes one line per organization with raw counts, quoting names that need it', () => {
    const csv = usageCsv({
      month: '2026-03',
      current: false,
      person_mail: { mail_verification: 0, mail_password_reset: 0, mail_account_notes: 0 },
      rows: [
        {
          org_id: 'o1',
          name: 'Acme, "North"',
          counts: { ...counts, active_tasks: null, file_bytes: 1_500_000 },
          api_estimated: true,
          computed_at: '2026-04-01T05:15:00.000Z',
        },
      ],
    })
    const [head, line, end] = csv.split('\r\n')
    expect(head.split(',')).toEqual([
      'month',
      'org_id',
      'organization',
      ...USAGE_COLUMNS.map((c) => c.key),
      'api_estimated',
      'computed_at',
    ])
    expect(line.startsWith('2026-03,o1,"Acme, ""North""",0,1,2,3,,5,')).toBe(true)
    expect(line).toContain(',1500000,')
    expect(line.endsWith(',true,2026-04-01T05:15:00.000Z')).toBe(true)
    expect(end).toBe('')
  })
})

describe('the month picker', () => {
  it('offers this month and the 26 before it, across a year boundary', () => {
    const months = pickerMonths(Date.parse('2026-02-10T00:00:00Z'))
    expect(months).toHaveLength(27)
    expect(months.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12'])
    expect(months.at(-1)).toBe('2023-12')
  })
})

import { describe, expect, it } from 'vitest'
import type { UsageMonth } from './api'
import { peopleMonths, pickerMonths, UNATTRIBUTED_COLUMNS, USAGE_COLUMNS, usageCsv } from './usage'

const counts = Object.fromEntries(
  USAGE_COLUMNS.map((c, i) => [c.key, i]),
) as UsageMonth['rows'][number]['counts']

const table = (rows: UsageMonth['rows']): UsageMonth => ({
  month: '2026-03',
  current: false,
  unattributed: {
    mail_verification: 4,
    mail_password_reset: 2,
    mail_account_notes: 1,
    background_bytes: 900,
  },
  rows,
  failed: [],
  status: { partial: true, run: null },
})

const row = (name: string): UsageMonth['rows'][number] => ({
  org_id: 'o1',
  name,
  counts: { ...counts, active_tasks: null, file_bytes: 1_500_000 },
  api_estimated: true,
  computed_at: '2026-04-01T05:15:00.000Z',
})

describe('the usage CSV', () => {
  it('writes one line per organization with raw counts, quoting names that need it', () => {
    const csv = usageCsv(table([row('Acme, "North"')]))
    // a byte order mark, so a spreadsheet reads the names as UTF-8
    expect(csv.startsWith('﻿month,')).toBe(true)
    const [head, line, outside, end] = csv.slice(1).split('\r\n')
    expect(head.split(',')).toEqual([
      'month',
      'org_id',
      'organization',
      ...USAGE_COLUMNS.map((c) => c.key),
      ...UNATTRIBUTED_COLUMNS,
      'api_estimated',
      'computed_at',
      'month_partial',
    ])
    expect(line.startsWith('2026-03,o1,"Acme, ""North""",0,1,2,3,,5,')).toBe(true)
    expect(line).toContain(',1500000,')
    expect(line.endsWith(',,,,,true,2026-04-01T05:15:00.000Z,true')).toBe(true)
    // what belongs to no organization, in its own columns
    expect(outside).toBe(
      `2026-03,,No organization,${','.repeat(USAGE_COLUMNS.length)}900,4,2,1,,,true`,
    )
    expect(end).toBe('')
  })

  it('writes a name a spreadsheet would run as a formula as text', () => {
    const names = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tTab']
    const lines = usageCsv(table(names.map(row)))
      .split('\r\n')
      .slice(1, -2)
    expect(lines.map((line) => line.split(',')[2])).toEqual([
      "'=1+1",
      "'+SUM(A1)",
      "'-2+3",
      "'@cmd",
      "'\tTab",
    ])
    const line = (name: string) => usageCsv(table([row(name)])).split('\r\n')[1]
    // quoted as well when it holds a comma or a quote
    expect(line('=HYPERLINK("x","y")')).toContain(',"\'=HYPERLINK(""x"",""y"")",')
    // a plain name stays as it is
    expect(line('Pine Studio')).toContain(',Pine Studio,')
  })
})

describe('the people breakdown months', () => {
  it('adds a month the organization holds that the picker lacks, newest first', () => {
    expect(peopleMonths(['2026-03', '2026-02'], ['2026-02', '2026-04'])).toEqual([
      '2026-04',
      '2026-03',
      '2026-02',
    ])
  })
})

describe('the month picker', () => {
  it('offers this month back to the oldest month retention keeps, across a year boundary', () => {
    const months = pickerMonths(Date.parse('2026-02-10T00:00:00Z'))
    expect(months.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12'])
    // 800 days before 10 February 2026 is 1 December 2023
    expect(months.at(-1)).toBe('2023-12')
    expect(months).toHaveLength(27)
  })

  it('reaches back 28 months when the 800 days begin early in a month', () => {
    // 800 days before 1 April 2026 is 22 January 2024, and January is kept.
    const months = pickerMonths(Date.parse('2026-04-01T05:15:00Z'))
    expect(months.at(-1)).toBe('2024-01')
    expect(months).toHaveLength(28)
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanTokenExpiry } from '../../convex/lib/access'
import { setDateFormat } from './dates'
import {
  expiryFromDay,
  expiryLabel,
  expiryPhrase,
  isExpired,
  lastDay,
  parseDayInput,
} from './tokenExpiry'

/* Stockholm leaves summer time on 25 Oct 2026 (a 25 hour day) and enters it
   on 28 Mar 2027 (a 23 hour day), so local midnights move against UTC. */
const zone = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Stockholm'
})
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const NOW = new Date(2026, 9, 15, 10, 0)
/* The stored expiry for a last day, as the dialog would create it. */
const ending = (day: string, now = NOW) => {
  const at = expiryFromDay(day, now)
  if (at === null) throw new Error(`${day} is not a valid last day`)
  return at
}

describe('parseDayInput', () => {
  it('reads a date input value as that local date', () => {
    expect(parseDayInput('2027-01-12')).toEqual(new Date(2027, 0, 12))
    expect(parseDayInput('2028-02-29')).toEqual(new Date(2028, 1, 29))
  })

  it('refuses anything but a real calendar date', () => {
    for (const value of [
      '',
      '2027-1-12',
      '12/01/2027',
      '2027-01-12T00:00',
      '2027-02-30',
      '2027-02-29',
      '2027-13-01',
      '2027-00-10',
      '0099-01-01',
    ])
      expect(parseDayInput(value), value).toBeNull()
  })
})

describe('expiryFromDay', () => {
  it('stores the start of the next local day as a UTC instant', () => {
    expect(expiryFromDay('2027-01-12', NOW)).toBe('2027-01-12T23:00:00.000Z')
  })

  it('follows the local midnight across a daylight saving change', () => {
    // the last summer-time day ends at 22:00 UTC, the first winter one at 23:00
    expect(expiryFromDay('2026-10-24', NOW)).toBe('2026-10-24T22:00:00.000Z')
    expect(expiryFromDay('2026-10-25', NOW)).toBe('2026-10-25T23:00:00.000Z')
    expect(expiryFromDay('2027-03-27', NOW)).toBe('2027-03-27T23:00:00.000Z')
    expect(expiryFromDay('2027-03-28', NOW)).toBe('2027-03-28T22:00:00.000Z')
  })

  it('accepts today as the last day', () => {
    expect(expiryFromDay('2026-10-15', new Date(2026, 9, 15, 23, 59))).toBe(
      '2026-10-15T22:00:00.000Z',
    )
  })

  it('writes the form the server accepts unchanged', () => {
    for (const day of ['2026-10-15', '2026-10-25', '2027-03-28', '9999-12-30']) {
      const at = ending(day)
      expect(cleanTokenExpiry(at)).toBe(at)
    }
  })

  it('refuses a past day, a non-date and a year the server cannot store', () => {
    expect(expiryFromDay('2026-10-14', NOW)).toBeNull()
    expect(expiryFromDay('', NOW)).toBeNull()
    expect(expiryFromDay('2027-02-30', NOW)).toBeNull()
    expect(expiryFromDay('9999-12-31', NOW)).toBeNull()
  })
})

describe('lastDay', () => {
  it('reads back the chosen day from the stored instant', () => {
    for (const day of ['2026-10-24', '2026-10-25', '2027-03-28', '2027-01-12']) {
      const last = lastDay(ending(day))
      expect(last?.toDateString()).toBe(parseDayInput(day)?.toDateString())
    }
  })

  it('is null for an unreadable value', () => {
    expect(lastDay('soon')).toBeNull()
  })
})

describe('isExpired', () => {
  it('never expires a token without an expiry', () => {
    expect(isExpired(null, NOW)).toBe(false)
  })

  it('expires a token from its expiry instant on', () => {
    const at = ending('2026-10-15')
    expect(isExpired(at, new Date(Date.parse(at) - 1))).toBe(false)
    expect(isExpired(at, new Date(at))).toBe(true)
    expect(isExpired(at, new Date(Date.parse(at) + 1))).toBe(true)
  })

  it('counts an unreadable expiry as expired, as the server does', () => {
    expect(isExpired('soon', NOW)).toBe(true)
  })
})

describe('expiryLabel', () => {
  afterEach(() => setDateFormat(null))

  it('says Never without an expiry', () => {
    expect(expiryLabel(null, NOW)).toEqual({ text: 'Never', soon: false })
  })

  it('counts down the last week', () => {
    expect(expiryLabel(ending('2026-10-15'), NOW)).toEqual({ text: 'Today', soon: true })
    expect(expiryLabel(ending('2026-10-16'), NOW)).toEqual({ text: 'Tomorrow', soon: true })
    expect(expiryLabel(ending('2026-10-21'), NOW)).toEqual({ text: 'In 6 days', soon: true })
    expect(expiryLabel(ending('2026-10-22'), NOW)).toEqual({ text: 'In 7 days', soon: true })
  })

  it('counts calendar days across a daylight saving change', () => {
    const autumn = new Date(2026, 9, 20, 12)
    expect(expiryLabel(ending('2026-10-27', autumn), autumn).text).toBe('In 7 days')
    const spring = new Date(2027, 2, 25, 12)
    expect(expiryLabel(ending('2027-04-01', spring), spring).text).toBe('In 7 days')
  })

  it('names the day after the last week, with the year when it is another', () => {
    expect(expiryLabel(ending('2026-10-23'), NOW)).toEqual({ text: '23 Oct', soon: false })
    expect(expiryLabel(ending('2027-01-12'), NOW)).toEqual({ text: '12 Jan 2027', soon: false })
    setDateFormat('MMM D, YYYY')
    expect(expiryLabel(ending('2027-01-12'), NOW).text).toBe('Jan 12, 2027')
  })

  it('shows the last day of an expired token without the warning', () => {
    const at = ending('2026-09-30', new Date(2026, 8, 1))
    expect(expiryLabel(at, NOW)).toEqual({ text: '30 Sep', soon: false })
    // at the very instant it ends, it is no longer "Today"
    const today = ending('2026-10-15')
    expect(expiryLabel(today, new Date(today))).toEqual({ text: '15 Oct', soon: false })
  })

  it('shows nothing for an unreadable expiry', () => {
    expect(expiryLabel('soon', NOW)).toEqual({ text: '', soon: false })
  })
})

describe('expiryPhrase', () => {
  it('puts each bucket into a sentence', () => {
    expect(expiryPhrase(null, NOW)).toBe('never expires')
    expect(expiryPhrase(ending('2026-10-15'), NOW)).toBe('expires today')
    expect(expiryPhrase(ending('2026-10-16'), NOW)).toBe('expires tomorrow')
    expect(expiryPhrase(ending('2026-10-21'), NOW)).toBe('expires in 6 days')
    expect(expiryPhrase(ending('2027-01-12'), NOW)).toBe('expires 12 Jan 2027')
    expect(expiryPhrase(ending('2026-09-30', new Date(2026, 8, 1)), NOW)).toBe('expired 30 Sep')
    expect(expiryPhrase('soon', NOW)).toBe('expired')
  })
})

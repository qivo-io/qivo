import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import {
  CURATION_BODY_LIMIT_BYTES,
  CURATION_TOKEN_PREFIX,
  parseCurationReview,
  parseCurationSubmission,
} from '../lib/panoramaCuration'

const ID = 'LBI7cgq3pbM'
const URL = `https://unsplash.com/photos/${ID}`
const valid = { url: URL, date: '12-25' }

function expectBadRequest(run: () => unknown, message?: RegExp) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError)
    const refusal = (error as ConvexError<{ code: string; message: string }>).data
    expect(refusal.code).toBe('bad_request')
    if (message) expect(refusal.message).toMatch(message)
    return
  }
  throw new Error('expected a typed bad_request refusal')
}

describe('external photo references', () => {
  it.each([
    URL,
    `${URL}/`,
    `${URL}?utm_source=agent&utm_medium=referral#preview`,
    `https://www.unsplash.com/photos/${ID}`,
    `https://unsplash.com/photos/a-blue-lake-and-snowy-mountains-${ID}`,
    `  https://www.unsplash.com/photos/a-lake-${ID}?utm_source=curator  `,
  ])('canonicalizes a photo reference without preserving tracking or title slugs: %s', (url) => {
    expect(parseCurationSubmission({ ...valid, url })).toEqual({
      source_url: URL,
      source_id: `unsplash:${ID}`,
      day: '12-25',
    })
  })

  it.each(['AbC12-_xyz9', '-Abcdef123_', '_12345678-a'])(
    'preserves the case and allowed punctuation of photo ID %s',
    (id) => {
      expect(
        parseCurationSubmission({ ...valid, url: `https://unsplash.com/photos/${id}` }).source_id,
      ).toBe(`unsplash:${id}`)
    },
  )

  it.each([
    'http://unsplash.com/photos/LBI7cgq3pbM',
    '//unsplash.com/photos/LBI7cgq3pbM',
    'https://images.unsplash.com/photo-1461988320302-91bde64fc8e4',
    'https://plus.unsplash.com/premium_photo-12345',
    'https://unsplash.com/plus',
    'https://unsplash.com/@photographer',
    'https://unsplash.com/collections/LBI7cgq3pbM',
    'https://unsplash.com/t/nature',
    'https://unsplash.com/photos/LBI7cgq3pbM/download',
    'https://unsplash.com/photos/LBI7cgq3pbM//',
    'https://unsplash.com/en/photos/LBI7cgq3pbM',
    'https://unsplash.com/photos/%4cBI7cgq3pbM',
    'https://unsplash.com/photos/..%2fLBI7cgq3pbM',
    'https://unsplash.com/elsewhere/../photos/LBI7cgq3pbM',
    'https://unsplash.com/photos/../photos/LBI7cgq3pbM',
    'https://unsplash.com\\photos\\LBI7cgq3pbM',
    'https://unsplash.com:443/photos/LBI7cgq3pbM',
    'https://unsplash.com:8080/photos/LBI7cgq3pbM',
    'https://user@unsplash.com/photos/LBI7cgq3pbM',
    'https://user:password@unsplash.com/photos/LBI7cgq3pbM',
    'https://unsplash.com@127.0.0.1/photos/LBI7cgq3pbM',
    'https://unsplash.com.evil.test/photos/LBI7cgq3pbM',
    'https://www.unsplash.com.evil.test/photos/LBI7cgq3pbM',
    'https://unsplash.com./photos/LBI7cgq3pbM',
    'https://unsplash.com/photos/LBI7cgq3pbM\n?utm_source=agent',
    'https://unsplash.com/photos/LBI7cgq3pbM\t',
    'https://unsplash.com/photos/short',
    'https://unsplash.com/photos/abcdefghijkl',
    'https://unsplash.com/photos/-LBI7cgq3pbM',
    'https://unsplash.com/photos/a-slug-LBI7cgq3pb!',
    'https://unsplash.com/photos/a.slug-LBI7cgq3pbM',
    'data:text/plain,LBI7cgq3pbM',
    'javascript:alert(1)',
  ])('refuses unsupported or ambiguous source URL %s', (url) => {
    expectBadRequest(() => parseCurationSubmission({ ...valid, url }))
  })

  it('rejects an oversized URL instead of storing a truncated reference', () => {
    expectBadRequest(
      () => parseCurationSubmission({ ...valid, url: `${URL}?q=${'x'.repeat(2048)}` }),
      /2048/,
    )
  })

  it('returns no database fields or human approval from agent input', () => {
    const parsed = parseCurationSubmission({
      ...valid,
      status: 'approved',
      storage_id: 'someone-elses-file',
      reviewed_by: 'operator',
      __proto__: { source_id: 'overridden' },
    })
    expect(parsed).toEqual({ source_url: URL, source_id: `unsplash:${ID}`, day: '12-25' })
  })
})

describe('recurring date and optional metadata', () => {
  it.each(['W01', 'W09', 'W52', 'W53', '01-01', '02-28', '04-30', '12-31'])(
    'accepts annual day %s',
    (date) => {
      expect(parseCurationSubmission({ ...valid, date }).day).toBe(date)
    },
  )

  it.each([
    '2026-12-25',
    '2028-02-29',
    '12-25T00:00:00Z',
    '1-01',
    '00-01',
    '13-01',
    '04-31',
    '02-30',
    ' 12-25 ',
    '',
    null,
    1225,
  ])('refuses a noncanonical or invalid annual date %j', (date) =>
    expectBadRequest(() => parseCurationSubmission({ ...valid, date })),
  )

  it('rejects a standalone legacy leap-day key', () => {
    expectBadRequest(
      () => parseCurationSubmission({ ...valid, date: '02-29' }),
      /February 29 is not a recurring key/,
    )
  })

  it('trims supplied metadata and omits absent fields rather than writing null', () => {
    expect(
      parseCurationSubmission({
        ...valid,
        title: '  Winter lake  ',
        creator: ' Jane Doe ',
        reason: '\nCalm winter scene for Christmas.\n',
      }),
    ).toEqual({
      source_url: URL,
      source_id: `unsplash:${ID}`,
      day: '12-25',
      title: 'Winter lake',
      creator: 'Jane Doe',
      reason: 'Calm winter scene for Christmas.',
    })
    const absent = parseCurationSubmission({
      ...valid,
      title: undefined,
      creator: undefined,
      reason: undefined,
    })
    expect(Object.keys(absent).sort()).toEqual(['day', 'source_id', 'source_url'])
  })

  it.each(['title', 'creator', 'reason'])('refuses blank, null and non-text %s', (field) => {
    for (const value of ['', '  \n ', null, 123, [], {}])
      expectBadRequest(() => parseCurationSubmission({ ...valid, [field]: value }))
  })

  it.each([
    ['title', 300],
    ['creator', 300],
    ['reason', 2000],
  ] as const)('enforces the %s length bound after trimming', (field, limit) => {
    expect(
      parseCurationSubmission({ ...valid, [field]: ` ${'x'.repeat(limit)} ` })[field],
    ).toHaveLength(limit)
    expectBadRequest(() => parseCurationSubmission({ ...valid, [field]: 'x'.repeat(limit + 1) }))
  })

  it.each([undefined, null, [], 'input', 123, true])(
    'requires an input object, received %j',
    (input) => {
      expectBadRequest(() => parseCurationSubmission(input))
      expectBadRequest(() => parseCurationReview(input))
    },
  )
})

describe('agent precheck decisions', () => {
  it.each(['approved', 'declined'] as const)(
    'keeps an agent %s decision separate from human status',
    (decision) => {
      expect(
        parseCurationReview({ decision, reason: ' Good composition. ', status: 'approved' }),
      ).toEqual({ decision, reason: 'Good composition.' })
      expect(parseCurationReview({ decision, reason: 'Seasonal fit.', day: '12-25' })).toEqual({
        decision,
        reason: 'Seasonal fit.',
        day: '12-25',
      })
    },
  )

  it.each([undefined, null, 'approve', 'reject', 'pending', 'APPROVED', 1])(
    'refuses unsupported decision %j',
    (decision) => {
      expectBadRequest(() => parseCurationReview({ decision, reason: 'Reviewed.' }), /decision/)
    },
  )

  it.each([undefined, null, '', '   ', 123, 'x'.repeat(2001)])(
    'requires a nonempty bounded reason %j',
    (reason) => {
      expectBadRequest(() => parseCurationReview({ decision: 'approved', reason }), /reason/)
    },
  )

  it('validates optional recurring dates and omits an absent day', () => {
    expect(
      parseCurationReview({ decision: 'declined', reason: 'Unsuitable.', day: undefined }),
    ).toEqual({ decision: 'declined', reason: 'Unsuitable.' })
    for (const day of [null, '02-29', '2026-12-25', '13-01'])
      expectBadRequest(() =>
        parseCurationReview({ decision: 'approved', reason: 'Reviewed.', day }),
      )
  })

  it('publishes explicit ingress size and token namespace constants', () => {
    expect(CURATION_BODY_LIMIT_BYTES).toBe(16 * 1024)
    expect(CURATION_TOKEN_PREFIX).toBe('qvc_')
  })
})

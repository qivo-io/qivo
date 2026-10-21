/* The one rule for a stored email address (lib/email.ts): the mail
 * sender's address rule within LIMITS.email, lowercased, with a Unicode
 * domain written as punycode. */

import { domainToASCII } from 'node:url'
import { describe, expect, it } from 'vitest'
import { asciiEmail, cleanEmail } from '../lib/email'
import { LIMITS } from '../lib/limits'

/** An address of exactly `length` characters at example.com. */
const ofLength = (length: number) => `${'a'.repeat(length - '@example.com'.length)}@example.com`

describe('cleanEmail', () => {
  it('trims and lowercases an address it can mail', () => {
    expect(cleanEmail('  Anna.Berg@Example.COM ')).toBe('anna.berg@example.com')
    expect(cleanEmail('jørn@example.no')).toBe('jørn@example.no')
  })

  it('writes a Unicode domain as punycode, label by label', () => {
    expect(cleanEmail('anna@bücher.de')).toBe('anna@xn--bcher-kva.de')
    expect(cleanEmail('Anna@BÜCHER.de')).toBe('anna@xn--bcher-kva.de')
    expect(cleanEmail('ivan@правительство.рф')).toBe('ivan@xn--80aealotwbjpid2k.xn--p1ai')
    expect(cleanEmail('a@例え.テスト')).toBe('a@xn--r8jz45g.xn--zckzah')
    // an ideographic full stop separates labels too
    expect(cleanEmail('a@日本語。jp')).toBe('a@xn--wgv71a119e.jp')
    // a domain already in punycode stays as it is
    expect(cleanEmail('anna@xn--bcher-kva.de')).toBe('anna@xn--bcher-kva.de')
  })

  it('maps the domain as url.domainToASCII does, full-width and compatibility forms included', () => {
    for (const domain of [
      'ｅｘａｍｐｌｅ.com',
      'ＥＸＡＭＰＬＥ.com',
      'ﬁ.com',
      'Ⅻ.com',
      'ℌ.com',
      'bücher.de',
      'straße.de',
      '例え.テスト',
      '🍕.ws',
      'правительство.рф',
    ]) {
      expect(asciiEmail(`taro@${domain}`), domain).toBe(`taro@${domainToASCII(domain)}`)
    }
    // NFC alone wrote full-width example.com as a punycode domain that cannot exist
    expect(cleanEmail('taro@ｅｘａｍｐｌｅ.com')).toBe('taro@example.com')
  })

  it('takes an apostrophe in the local part, which Better Auth and Google accept', () => {
    expect(cleanEmail("Sean.O'Brien@Company.com")).toBe("sean.o'brien@company.com")
  })

  it('takes an address of 254 characters and refuses one of 255', () => {
    expect(LIMITS.email.max).toBe(254)
    expect(cleanEmail(ofLength(254))).toBe(ofLength(254))
    expect(cleanEmail(ofLength(255))).toBeNull()
    // the limit holds for the stored form, after the domain is converted
    expect(asciiEmail(`${'a'.repeat(240)}@bücher.de`)).toHaveLength(257)
    expect(cleanEmail(`${'a'.repeat(240)}@bücher.de`)).toBeNull()
  })

  it('refuses what is not one address the mail sender takes', () => {
    for (const raw of [
      '',
      'anna',
      'anna@',
      '@example.com',
      'anna@example',
      'anna@b.c d',
      'anna berg@example.com',
      'anna@example.com, ben@example.com',
      'Anna <anna@example.com>',
      '"anna"@example.com',
      'anna@exa_mple.com',
      'anna@-example.com',
      'anna@@example.com',
    ]) {
      expect(cleanEmail(raw), raw).toBeNull()
    }
  })

  it('leaves text far over the limit unconverted, and refuses it', () => {
    const long = `a@${'ü'.repeat(10_000)}.de`
    expect(asciiEmail(long)).toBe(long)
    expect(cleanEmail(long)).toBeNull()
  })
})

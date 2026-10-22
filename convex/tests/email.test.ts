/* The one rule for a stored email address (lib/email.ts): the mail
 * sender's address rule within LIMITS.email, lowercased, with a Unicode
 * domain written as punycode, that a password login can also use. */

import { domainToASCII, domainToUnicode } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import {
  asciiEmail,
  cleanEmail,
  emailRefusal,
  NO_PASSWORD_LOGIN,
  PASSWORD_ADDR,
  unicodeEmail,
} from '../lib/email'
import { LIMITS } from '../lib/limits'

/** An address of exactly `length` characters at example.com. */
const ofLength = (length: number) => `${'a'.repeat(length - '@example.com'.length)}@example.com`

describe('cleanEmail', () => {
  it('trims and lowercases an address it can mail', () => {
    expect(cleanEmail('  Anna.Berg@Example.COM ')).toBe('anna.berg@example.com')
  })

  it('writes a Unicode domain as punycode, label by label', () => {
    expect(cleanEmail('anna@bücher.de')).toBe('anna@xn--bcher-kva.de')
    expect(cleanEmail('Anna@BÜCHER.de')).toBe('anna@xn--bcher-kva.de')
    expect(asciiEmail('ivan@правительство.рф')).toBe('ivan@xn--80aealotwbjpid2k.xn--p1ai')
    expect(asciiEmail('a@例え.テスト')).toBe('a@xn--r8jz45g.xn--zckzah')
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

  it('drops the characters a domain ignores and refuses the ones it cannot hold', () => {
    // a soft hyphen and a zero-width space are mapped to nothing
    for (const domain of ['exa\u00admple.com', 'exa\u200bmple.com']) {
      expect(asciiEmail(`taro@${domain}`), domain).toBe(`taro@${domainToASCII(domain)}`)
    }
    // url.domainToASCII refuses these, and so does the address rule
    for (const domain of ['\u0301abc.com', 'a\u200db.com', 'a b.com']) {
      expect(domainToASCII(domain), domain).toBe('')
      expect(cleanEmail(`taro@${domain}`), domain).toBeNull()
    }
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

describe('password logins', () => {
  /* Better Auth refuses any address outside zod's z.email() pattern on
   * password sign-up, sign-in and reset (authMail.test.ts drives the real
   * endpoints). */
  it('copies the pattern Better Auth checks addresses with', () => {
    // the formatter drops the backslash before a hyphen that ends a class,
    // which means the same there
    const plain = (pattern: RegExp) => pattern.source.replaceAll('\\-', '-')
    expect(plain(PASSWORD_ADDR)).toBe(plain(z.regexes.email))
    expect(PASSWORD_ADDR.flags).toBe(z.regexes.email.flags)
  })

  it('takes every address Better Auth takes, a Unicode second-level domain included', () => {
    for (const raw of [
      'anna@example.com',
      'anna@bücher.de',
      "sean.o'brien@company.com",
      'first+tag@example.co.uk',
      'a_b-c@sub.example.io',
    ]) {
      const email = cleanEmail(raw)
      expect(email, raw).not.toBeNull()
      expect(z.email().safeParse(email).success, raw).toBe(true)
      expect(emailRefusal(raw), raw).toBeNull()
    }
  })

  it('refuses an address the mail sender takes but a password login does not, and says why', () => {
    for (const raw of [
      // a Unicode top-level domain, typed in Unicode or in punycode
      'ivan@правительство.рф',
      'ivan@xn--80aealotwbjpid2k.xn--p1ai',
      'a@例え.テスト',
      'jørn@example.no',
      'anna!berg@example.com',
      'anna..berg@example.com',
      'anna@example.c',
    ]) {
      expect(cleanEmail(raw), raw).toBeNull()
      expect(z.email().safeParse(asciiEmail(raw)).success, raw).toBe(false)
      expect(emailRefusal(raw), raw).toBe(NO_PASSWORD_LOGIN)
    }
    // the length and the address shape keep their own refusals
    expect(emailRefusal(`${'a'.repeat(250)}@example.com`)).toBe(LIMITS.email.refusal)
    expect(emailRefusal('anna@')).toBeNull()
  })
})

describe('unicodeEmail', () => {
  it('writes each punycode label of the domain back in Unicode, as url.domainToUnicode does', () => {
    for (const domain of [
      'bücher.de',
      'straße.de',
      'правительство.рф',
      '例え.テスト',
      '🍕.ws',
      'ελληνικά.gr',
      'a-ü-b.de',
      'example.com',
    ]) {
      const ascii = asciiEmail(`taro@${domain}`)
      expect(unicodeEmail(ascii), domain).toBe(`taro@${domainToUnicode(domainToASCII(domain))}`)
    }
  })

  it('leaves a label that is not valid punycode as it is', () => {
    for (const email of [
      'a@xn--.de',
      'a@xn--abc-.de',
      'a@xn--!!.de',
      'a@xn--99999999999999999999.de',
      'anna',
    ])
      expect(unicodeEmail(email), email).toBe(email)
  })
})

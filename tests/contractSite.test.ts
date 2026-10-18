import { describe, expect, it } from 'vitest'
import { contractSiteUrl } from './contract/site.mts'

const KEY = 'dev:fine-goose-986|test-key'
const SITE = 'https://fine-goose-986.eu-west-1.convex.site'
const envLocal = (site: string) => `CONVEX_DEPLOYMENT=dev:other\nVITE_CONVEX_SITE_URL=${site}\n`

describe('contract pass site', () => {
  it("uses the exported site of the key's deployment before .env.local", () => {
    const other = envLocal('https://admired-wildcat-470.convex.site')
    expect(contractSiteUrl({ CONVEX_DEPLOY_KEY: KEY, VITE_CONVEX_SITE_URL: SITE }, other)).toBe(
      SITE,
    )
    expect(contractSiteUrl({ CONVEX_DEPLOY_KEY: KEY }, envLocal(`${SITE}/`))).toBe(SITE)
    expect(
      contractSiteUrl({ CONVEX_DEPLOY_KEY: KEY, CONTRACT_BASE_URL: SITE }, envLocal('x')),
    ).toBe(SITE)
  })

  it('checks a CONTRACT_BASE_URL override like any other site', () => {
    const env = { CONVEX_DEPLOY_KEY: KEY, VITE_CONVEX_SITE_URL: SITE }
    expect(() =>
      contractSiteUrl(
        { ...env, CONTRACT_BASE_URL: 'https://admired-wildcat-470.convex.site' },
        undefined,
      ),
    ).toThrow(/not the convex.site of fine-goose-986/)
  })

  it('refuses a missing or non-development key without repeating it', () => {
    for (const key of [undefined, '', 'prod:fine-goose-986|test-key', 'preview:x|y']) {
      expect(() => contractSiteUrl({ CONVEX_DEPLOY_KEY: key }, envLocal(SITE))).toThrow(/with-dev/)
    }
    expect(() =>
      contractSiteUrl({ CONVEX_DEPLOY_KEY: 'prod:fine-goose-986|test-key' }, undefined),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('test-key') }))
  })

  it("refuses a site that is not the key's deployment", () => {
    for (const site of [
      'https://admired-wildcat-470.convex.site',
      'http://127.0.0.1:3211',
      'http://fine-goose-986.eu-west-1.convex.site',
      'https://fine-goose-986.eu-west-1.convex.cloud',
      'https://fine-goose-986.convex.site.example.com',
      `${SITE}/path`,
      'not-a-url',
    ])
      expect(() => contractSiteUrl({ CONVEX_DEPLOY_KEY: KEY }, envLocal(site))).toThrow(
        /not the convex.site of fine-goose-986/,
      )
    expect(() => contractSiteUrl({ CONVEX_DEPLOY_KEY: KEY }, undefined)).toThrow(/neither/)
  })
})

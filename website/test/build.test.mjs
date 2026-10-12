import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSETS, buildSite, ROOT, verifyOutput } from '../scripts/build.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const guide = join(repository, 'docs/guide')
/** What `vite build` leaves in dist/ before the website build runs. */
const APP_FILES = [
  'app.html',
  'admin.html',
  'favicon.svg',
  'llms.txt',
  'skill.md',
  'auth.md',
  'version.json',
  'assets/app-abc123.js',
]

describe('website build', () => {
  const directories = []
  const scratch = () => {
    const directory = mkdtempSync(join(tmpdir(), 'qivo-website-build-test-'))
    directories.push(directory)
    return directory
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  /** A dist/ directory holding the application build. */
  function appOutput(extra = []) {
    const outDir = scratch()
    for (const file of [...APP_FILES, ...extra]) {
      mkdirSync(dirname(join(outDir, file)), { recursive: true })
      writeFileSync(join(outDir, file), 'application')
    }
    return outDir
  }

  it('publishes the website next to the application without touching its files', () => {
    const outDir = appOutput()
    const files = buildSite({ outDir, env: { QIVO_ENVIRONMENT: 'production' } })
    const pages = JSON.parse(readFileSync(join(guide, 'pages.json'), 'utf8')).pages
    expect([...files.keys()].sort()).toEqual(
      [
        'index.html',
        'sitemap.xml',
        'docs/index.html',
        'pricing/index.html',
        ...pages.map((page) => `docs/${page.slug}/index.html`),
        ...Object.keys(ASSETS),
      ].sort(),
    )
    for (const file of files.keys()) expect(existsSync(join(outDir, file)), file).toBe(true)
    for (const file of APP_FILES)
      expect(readFileSync(join(outDir, file), 'utf8')).toBe('application')
    for (const file of ['index.html', 'pricing/index.html', 'docs/index.html']) {
      expect(readFileSync(join(outDir, file), 'utf8')).toContain(
        '<a href="mailto:support@qivo.io">Contact support</a>',
      )
    }
    for (const license of ['manrope-OFL.txt', 'rubik-OFL.txt']) {
      expect(readFileSync(join(outDir, 'marketing/fonts', license), 'utf8')).toContain(
        'SIL OPEN FONT LICENSE',
      )
    }
    expect(readFileSync(join(outDir, 'marketing/README.md'), 'utf8')).toContain('Pexels')
    expect(readFileSync(join(outDir, 'sitemap.xml'), 'utf8')).toContain('https://qivo.io/pricing/')
  })

  it('refuses to replace an application file and then writes nothing', () => {
    for (const taken of ['index.html', 'robots.txt', 'pricing/index.html']) {
      const outDir = appOutput([taken])
      expect(() => buildSite({ outDir, env: {} }), taken).toThrow(
        `${taken}: would replace an application file`,
      )
      expect(existsSync(join(outDir, 'sitemap.xml')), taken).toBe(false)
      expect(readFileSync(join(outDir, taken), 'utf8')).toBe('application')
    }
  })

  // vercel.json lets browsers keep these files for a year, so a font whose
  // bytes change must never be published under a name already in use.
  it('publishes each font under a name that contains its own content hash', () => {
    const files = buildSite({ outDir: appOutput(), env: {} })
    const fonts = [...files.keys()].filter((name) => name.endsWith('.woff2'))
    expect(
      fonts.map((name) => name.replace(/^marketing\/fonts\/|\.[0-9a-f]{8}\.woff2$/g, '')),
    ).toEqual(['manrope-normal-latin'])
    for (const name of fonts) {
      const hash = createHash('sha256').update(files.get(name)).digest('hex')
      expect(name.endsWith(`.${hash.slice(0, 8)}.woff2`), name).toBe(true)
    }
  })

  // Chrome holds the first paint only for font preloads parsed before <body>.
  it('preloads the fonts of its stylesheet at the top of every page head', () => {
    const files = buildSite({ outDir: appOutput(), env: {} })
    const pages = [...files.keys()].filter((name) => name.endsWith('.html'))
    expect(pages).toEqual(
      expect.arrayContaining(['index.html', 'pricing/index.html', 'docs/index.html']),
    )
    for (const name of pages) {
      const html = files.get(name)
      const head = html.slice(0, html.indexOf('</head>'))
      const tags = [...head.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)].map(([tag]) => tag)
      const preloads = tags.map(
        (tag) =>
          /^<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin \/>$/.exec(
            tag,
          )?.[1],
      )
      const faces = [...html.matchAll(/@font-face\s*\{[^}]*\burl\("([^"]+)"\)/g)]
        .map(([, url]) => url)
        .filter((url) => !url.startsWith('data:'))
      expect(faces, name).toHaveLength(1)
      expect([...preloads].sort(), name).toEqual([...faces].sort())
      const last = head.indexOf(tags.at(-1))
      expect(last, name).toBeLessThan(head.indexOf('<style'))
      expect(last, name).toBeLessThan(head.search(/<script\b|<title\b/))
    }
  })

  it('emits the Microsoft publisher-domain association', () => {
    const outDir = appOutput()
    buildSite({ outDir, env: {} })
    expect(
      JSON.parse(
        readFileSync(join(outDir, '.well-known/microsoft-identity-association.json'), 'utf8'),
      ),
    ).toEqual({
      associatedApplications: [{ applicationId: '65decab1-4111-4a47-b321-2368c4e8262b' }],
    })
  })

  it('emits referenced guide images and fails when one is missing', () => {
    const contentDir = scratch()
    cpSync(guide, contentDir, { recursive: true })
    const page = JSON.parse(readFileSync(join(contentDir, 'pages.json'), 'utf8')).pages[0]
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(contentDir, 'shot.png'), png)
    writeFileSync(
      join(contentDir, page.file),
      `${readFileSync(join(contentDir, page.file), 'utf8')}\n![A board](./shot.png)\n`,
    )
    const outDir = appOutput()
    buildSite({ contentDir, outDir, env: {} })
    expect(readFileSync(join(outDir, 'docs/assets/shot.png'))).toEqual(png)
    expect(readFileSync(join(outDir, `docs/${page.slug}/index.html`), 'utf8')).toContain(
      'src="/docs/assets/shot.png"',
    )
    rmSync(join(contentDir, 'shot.png'))
    expect(() => buildSite({ contentDir, outDir: appOutput(), env: {} })).toThrow(
      /Missing or invalid local image/,
    )
  })

  it.each([
    ['assets/app.js', 'export {}', /application/],
    ['docs/index.html', '<p>CONVEX_DEPLOY_KEY</p>', /credential/],
    ['notes.txt', 'preview:team:project|abcdefghijklmnopqrstuvwxyz', /credential/],
    ['index.html', '<script src="https://cdn.example/x.js"></script>', /third-party script/],
    [
      'index.html',
      '<style>@font-face{src:url(https://fonts.example/x.woff2)}</style>',
      /third-party/,
    ],
    [
      'index.html',
      '<link rel="stylesheet" href="https://cdn.example/x.css">',
      /third-party resource/,
    ],
    [
      'index.html',
      '<link rel="preload" as="font" href="//fonts.example/x.woff2">',
      /third-party resource/,
    ],
    ['docs/index.html', '<img src="https://images.example/x.png" alt="">', /third-party resource/],
    ['marketing/home.js', "import x from 'https://cdn.example/x.js'", /third-party module/],
    ['marketing/home.js', "await import('//cdn.example/x.js')", /third-party module/],
  ])('rejects output %s with unsafe content', (file, body, message) => {
    const files = buildSite({ outDir: appOutput(), env: {} })
    // The real pages pass, including absolute canonical links and outbound <a> links.
    expect(() => verifyOutput(files)).not.toThrow()
    expect(() =>
      verifyOutput(
        new Map([
          [
            'a.html',
            '<link rel="canonical" href="https://qivo.io/"><a href="https://demo.qivo.io">Demo</a>',
          ],
        ]),
      ),
    ).not.toThrow()
    expect(() => verifyOutput(new Map([...files, [file, body]]))).toThrow(message)
  })

  it('lets search engines index production only', () => {
    const production = buildSite({ outDir: appOutput(), env: { QIVO_ENVIRONMENT: 'production' } })
    expect(production.get('robots.txt')).toEqual(readFileSync(join(ROOT, 'public/robots.txt')))
    expect(production.get('index.html')).not.toContain('name="robots"')
    for (const environment of [undefined, 'preview']) {
      const env = { QIVO_ENVIRONMENT: environment, SITE_ORIGIN: 'https://qivo-git-x.vercel.app' }
      const files = buildSite({ outDir: appOutput(), env })
      expect(files.get('robots.txt'), environment).toBe('User-agent: *\nDisallow: /\n')
      for (const path of ['index.html', 'pricing/index.html', 'docs/index.html'])
        expect(files.get(path), path).toContain('name="robots" content="noindex, nofollow"')
    }
  })

  it('builds each stable environment for its own origin', async () => {
    expect(() => buildSite({ outDir: appOutput(), env: { QIVO_ENVIRONMENT: 'staging' } })).toThrow(
      /SITE_ORIGIN must be https:\/\/preview\.qivo\.io/,
    )
    expect(() => buildSite({ outDir: appOutput(), env: { QIVO_ENVIRONMENT: 'preview' } })).toThrow(
      /SITE_ORIGIN must name the branch preview/,
    )
    // The theme reads SITE_ORIGIN once, when it is first imported.
    vi.resetModules()
    vi.stubEnv('SITE_ORIGIN', 'https://preview.qivo.io')
    try {
      const staging = await import('../scripts/build.mjs')
      expect(() =>
        staging.buildSite({ outDir: appOutput(), env: { QIVO_ENVIRONMENT: 'production' } }),
      ).toThrow(/SITE_ORIGIN must be https:\/\/qivo\.io/)
      const files = staging.buildSite({ outDir: appOutput(), env: { QIVO_ENVIRONMENT: 'staging' } })
      for (const path of ['index.html', 'pricing/index.html', 'docs/index.html'])
        expect(files.get(path)).toContain('rel="canonical" href="https://preview.qivo.io/')
      expect(files.get('sitemap.xml')).toContain('https://preview.qivo.io/pricing/')
      const automation = files.get('docs/automation-ai-the-rest-api-and-the-mcp-server/index.html')
      expect(automation).toContain('href="/skill.md"')
      expect(automation).not.toContain('href="https://qivo.io/skill.md"')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('skips the demo, which serves only the application', () => {
    const output = execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, VITE_APP_MODE: 'demo' },
    })
    expect(output).toContain('Skipped')
  })
})

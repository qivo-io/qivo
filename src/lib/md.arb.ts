/* Shared fast-check generators for the markdown dialect's AST — used by the
   serializer and editor-adapter test suites (never imported by app code). */
import * as fc from 'fast-check'
import type { MdBlock, MdInline } from './md'

export const UUID = '123e4567-e89b-12d3-a456-426614174000'

// no ':' in generated text — a bare "https://…" in a text node autolinks on
// reparse (same normalization Linear/Jira apply); URL-bearing text is
// covered by the idempotence property instead
const TEXT_CHARS = [...'ab c*_~+`\\[]()!@#>-.\n\t"3…é']
const textArb = fc
  .string({ unit: fc.constantFrom(...TEXT_CHARS), minLength: 1, maxLength: 14 })
  .map((text): MdInline => ({ t: 'text', text }))
const codeArb = fc
  .string({ unit: fc.constantFrom(...[...'ab` *\n\\~']), maxLength: 10 })
  .map((text): MdInline => ({ t: 'code', text }))
const HREFS = [
  'https://a.io/x',
  'http://b.c/d e',
  'x(y)z',
  '',
  'mailto:a@b.c',
  '  https://pad.io  ',
  'a\\)b',
  'trail\\',
  `user:${UUID}`,
]
const SRCS = [`att:${UUID}`, 'uploading:ab12cd34', 'https://img.io/a b.png', '']
const ALTS = ['shot', 'a[b]c\\', 'Uploading image…', '', 'x*y_z', 'a\nb']
const imageArb = fc
  .record({ alt: fc.constantFrom(...ALTS), src: fc.constantFrom(...SRCS) })
  .map(({ alt, src }): MdInline => ({ t: 'image', alt, src }))
// mention ids are always parser-shaped uuids in the canonical pipeline (the
// parser only produces them, descDoc degrades anything else to text)
const MENTION_NAMES = ['Maya Lindqvist', 'a[b]c\\', '', 'x*y z', 'a\nb', '@nested']
const mentionArb = fc
  .constantFrom(...MENTION_NAMES)
  .map((name): MdInline => ({ t: 'mention', id: UUID, name }))

const { inline } = fc.letrec<{ inline: MdInline }>((tie) => ({
  inline: fc.oneof(
    { maxDepth: 3 },
    textArb,
    textArb,
    textArb,
    fc.constant<MdInline>({ t: 'br' }),
    codeArb,
    imageArb,
    mentionArb,
    fc
      .record({
        t: fc.constantFrom('bold', 'italic', 'strike', 'underline'),
        children: fc.array(tie('inline'), { maxLength: 3 }),
      })
      .map((r) => r as MdInline),
    fc
      .record({
        href: fc.constantFrom(...HREFS),
        children: fc.array(tie('inline'), { maxLength: 3 }),
      })
      .map(({ href, children }): MdInline => ({ t: 'link', href, children })),
  ),
}))

const inlinesArb = fc.array(inline, { maxLength: 6 })
export const blockArb = fc.oneof(
  inlinesArb.map((children): MdBlock => ({ t: 'p', children })),
  fc
    .record({ level: fc.constantFrom(1 as const, 2 as const, 3 as const), children: inlinesArb })
    .map(({ level, children }): MdBlock => ({ t: 'h', level, children })),
  inlinesArb.map((children): MdBlock => ({ t: 'quote', children })),
  fc.array(inlinesArb, { maxLength: 4 }).map((items): MdBlock => ({ t: 'ul', items })),
  fc
    .record({
      start: fc.integer({ min: -5, max: 1200 }),
      items: fc.array(inlinesArb, { maxLength: 4 }),
    })
    .map(({ start, items }): MdBlock => ({ t: 'ol', start, items })),
  fc
    .string({ unit: fc.constantFrom(...[...'ab`\n *#>-']), maxLength: 20 })
    .map((text): MdBlock => ({ t: 'codeblock', text })),
)
export const docArb = fc.array(blockArb, { maxLength: 5 })

export const hostileString = fc.oneof(
  fc.string({ unit: fc.constantFrom(...[...'*~+`\\[]()!#>-. _\nab3:/hts"']), maxLength: 40 }),
  fc.string({ maxLength: 40 }),
)

// FC_RUNS=50000 npx vitest run for a deep fuzz
export const RUNS =
  Number(
    (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.FC_RUNS,
  ) || 300

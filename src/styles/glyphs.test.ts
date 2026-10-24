import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The style rules of `css`, each with the media query it sits in. */
function rules(css: string) {
  const found: { media: string; selectors: string[]; body: string }[] = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = /(@media[^{]*)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}|([^{}@]+)\{([^{}]*)\}/g
  for (const match of text.matchAll(pattern)) {
    const [, media, inner, selector, body] = match
    if (media) for (const rule of rules(inner)) found.push({ ...rule, media: media.trim() })
    else found.push({ media: '', selectors: selector.split(',').map((one) => one.trim()), body })
  }
  return found
}

/** A simple selector's specificity as one number: ids, then classes,
    attributes and pseudo-classes, then elements and pseudo-elements. */
function specificity(selector: string) {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0
  const classes = selector.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/g)?.length ?? 0
  const elements = selector.match(/::[\w-]+|(?:^|[\s>+~])[a-z][\w-]*/g)?.length ?? 0
  return ids * 10_000 + classes * 100 + elements
}

/** The rules of `css` that color a glyph's background outside forced
    colors and win over the forced-colors rule meant for the same element,
    which would keep their color in Windows High Contrast. */
function forcedColorLeaks(css: string) {
  const all = rules(css)
  const colors = (body: string) => /(^|;|\s)background(-color|-image)?\s*:/.test(body)
  const element = (selector: string) => selector.replace(/\[[^\]]*\]/g, '')
  return all
    .filter((rule) => rule.media.includes('forced-colors') && colors(rule.body))
    .flatMap((forced) =>
      forced.selectors.flatMap((mine) =>
        all
          .filter((rule) => !rule.media && colors(rule.body))
          .flatMap((rule) => rule.selectors)
          .filter((other) => element(other) === element(mine))
          .filter((other) => specificity(other) > specificity(mine)),
      ),
    )
}

describe('glyphs.css', () => {
  it('draws every glyph in the text color in forced colors, whatever rule colored it', () => {
    const css = readFileSync(new URL('./glyphs.css', import.meta.url), 'utf8')
    expect(rules(css).some((rule) => rule.media.includes('forced-colors'))).toBe(true)
    expect(forcedColorLeaks(css)).toEqual([])
  })

  it('finds a rule whose color outranks the forced-colors one', () => {
    const css = `
      .banner::after { background: red; }
      .banner[data-delay="behind"]::after { background-color: yellow; }
      @media (forced-colors: active) {
        .banner::after { background: CanvasText; }
      }`
    expect(forcedColorLeaks(css)).toEqual(['.banner[data-delay="behind"]::after'])
    expect(
      forcedColorLeaks(
        css.replace(
          '  .banner::after { background: CanvasText',
          '  .banner[data-delay]::after { background: CanvasText',
        ),
      ),
    ).toEqual([])
  })
})

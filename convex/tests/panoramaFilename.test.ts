import { describe, expect, it } from 'vitest'
import { panoramaFilename } from '../lib/panoramaFilename'

describe('saved image filenames', () => {
  it('uses the title and creator from the supplied mountain photo', () => {
    expect(panoramaFilename('Misty mountain peaks', 'Sam Lim', 'image/jpeg')).toBe(
      'misty-mountain-peaks_sam-lim.jpg',
    )
  })

  it('trims and truncates each field independently before replacing spaces', () => {
    expect(
      panoramaFilename(
        '  12345678901234567890 EXTRA ',
        ' First Last With More Words ',
        'image/png',
      ),
    ).toBe('12345678901234567890_first-last-with-more.png')
  })

  it('keeps Unicode names and removes filename paths and unsafe punctuation', () => {
    expect(panoramaFilename('  雾 山 / 湖:*?  ', 'Åse\\Berg\n', 'image/webp')).toBe(
      '雾-山-湖_åse-berg.webp',
    )
    expect(panoramaFilename('../', '"<>|', 'image/jpeg')).toBe('image_creator.jpg')
    expect(panoramaFilename('Cafe\u0301', 'SAM LIM', 'image/jpeg')).toBe('café_sam-lim.jpg')
  })

  it('chooses a canonical extension from the validated image type', () => {
    expect(panoramaFilename('Photo', 'Creator', 'image/jpeg')).toBe('photo_creator.jpg')
    expect(panoramaFilename('Photo', 'Creator', 'image/png')).toBe('photo_creator.png')
    expect(panoramaFilename('Photo', 'Creator', 'image/webp')).toBe('photo_creator.webp')
    expect(() => panoramaFilename('Photo', 'Creator', 'text/html')).toThrow(/JPEG, PNG or WebP/)
  })
})

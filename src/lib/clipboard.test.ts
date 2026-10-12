import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals())

  const withClipboard = (writeText?: (text: string) => Promise<void>) =>
    vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })

  it('resolves true once the browser confirms the write', async () => {
    const writeText = vi.fn(async () => {})
    withClipboard(writeText)
    expect(await copyText('QN-12')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('QN-12')
  })

  it('resolves false when the browser refuses the write', async () => {
    withClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    expect(await copyText('QN-12')).toBe(false)
  })

  it('resolves false without a clipboard API', async () => {
    withClipboard()
    expect(await copyText('QN-12')).toBe(false)
  })

  it('resolves false when the call throws before returning a promise', async () => {
    withClipboard(() => {
      throw new TypeError('not allowed here')
    })
    expect(await copyText('QN-12')).toBe(false)
  })
})

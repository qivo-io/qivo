import { describe, expect, it, vi } from 'vitest'
import {
  createNavigationGuard,
  createWindowOpenHandler,
  isAppURL,
  isOAuthProviderURL,
} from './navigation'

const APP = 'https://qivo.io'

/** Runs the guard on one main-frame or subframe navigation. */
function navigate(url: string, isMainFrame = true) {
  const openExternal = vi.fn()
  const event = { url, isMainFrame, preventDefault: vi.fn() }
  createNavigationGuard(APP, openExternal)(event)
  return { blocked: event.preventDefault.mock.calls.length > 0, opened: openExternal.mock.calls }
}

describe('desktop navigation', () => {
  it('keeps only the app origin in the window', () => {
    expect(isAppURL(`${APP}/app/board?x=1`, APP)).toBe(true)
    expect(isAppURL('http://localhost:5199/app', 'http://localhost:5199')).toBe(true)
    for (const url of [
      'https://qivo.io.evil.example/app',
      'https://staging.qivo.io/app',
      'http://qivo.io/app',
      'blob:https://qivo.io/0f8c1c1e-2c3b-4f6a-9d1e-5a7b8c9d0e1f',
      'https://accounts.google.com/',
      'not a url',
    ])
      expect(isAppURL(url, APP), url).toBe(false)
  })

  it('opens sign-in providers in the system browser, not the window', () => {
    // Before this guard a sign-in provider's page loaded in the window, and
    // its redirects onward went unchecked.
    expect(navigate('https://accounts.google.com/o/oauth2/v2/auth')).toEqual({
      blocked: true,
      opened: [['https://accounts.google.com/o/oauth2/v2/auth']],
    })
    expect(isOAuthProviderURL('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true)
    expect(isOAuthProviderURL('https://login.microsoftonline.com/common/oauth2')).toBe(true)
    expect(isOAuthProviderURL('http://accounts.google.com/')).toBe(false)
    expect(isOAuthProviderURL('https://accounts.google.com.evil.example/')).toBe(false)
    expect(isOAuthProviderURL(`${APP}/app`)).toBe(false)
  })

  it('refuses a server redirect away from the app origin', () => {
    expect(navigate(`${APP}/app/settings`)).toEqual({ blocked: false, opened: [] })
    expect(navigate('https://evil.example/landing')).toEqual({
      blocked: true,
      opened: [['https://evil.example/landing']],
    })
    // other schemes never reach the system
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'qivo://x'])
      expect(navigate(url), url).toEqual({ blocked: true, opened: [] })
    expect(navigate('mailto:support@qivo.io')).toEqual({
      blocked: true,
      opened: [['mailto:support@qivo.io']],
    })
    // subframes carry no privileges and are left to the page
    expect(navigate('https://evil.example/frame', false)).toEqual({ blocked: false, opened: [] })
  })

  it('opens no new window and hands only safe links to the system', () => {
    const openExternal = vi.fn()
    const open = createWindowOpenHandler(APP, openExternal)
    for (const url of [
      'https://example.com/doc',
      'mailto:a@b.c',
      'tel:+4612345',
      `${APP}/app/task/1`,
      'file:///etc/passwd',
      'javascript:alert(1)',
    ])
      expect(open({ url }), url).toEqual({ action: 'deny' })
    expect(openExternal.mock.calls).toEqual([
      ['https://example.com/doc'],
      ['mailto:a@b.c'],
      ['tel:+4612345'],
    ])
  })
})

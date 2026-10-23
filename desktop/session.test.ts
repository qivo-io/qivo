import { describe, expect, it, vi } from 'vitest'
import { secureSession } from './session.js'

type Session = Parameters<typeof secureSession>[0]
type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>

/** A stand-in session that keeps the permission request handler it gets. */
function fakeSession(spellcheck: () => void = () => {}) {
  const state: { request?: RequestHandler } = {}
  const session: Session = {
    setPermissionRequestHandler: (handler) => {
      state.request = handler ?? undefined
    },
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setSpellCheckerDictionaryDownloadURL: spellcheck,
    setSpellCheckerLanguages: vi.fn(),
  }
  /** What the session answers when `url`'s top-level page asks for the camera. */
  const camera = (url: string) => {
    let answer: boolean | undefined
    state.request?.(
      {} as Electron.WebContents,
      'media',
      (granted) => {
        answer = granted
      },
      { requestingUrl: url, isMainFrame: true, mediaTypes: ['video'] },
    )
    return answer
  }
  return { session, camera, state }
}

describe('desktop sessions', () => {
  it('restricts permissions and keeps spellcheck offline', () => {
    const { session, camera } = fakeSession()
    secureSession(session, 'https://qivo.io', 'linux')
    expect(camera('https://qivo.io/app')).toBe(false)
    expect(session.setSpellCheckerLanguages).toHaveBeenCalledWith([])
  })

  it('restricts permissions even when the spellcheck setup throws', () => {
    // a session left without a handler would grant every request
    const { session, camera, state } = fakeSession(() => {
      throw new Error('spellcheck failed')
    })
    expect(() => secureSession(session, 'https://qivo.io', 'win32')).toThrow('spellcheck failed')
    expect(state.request).toBeDefined()
    expect(camera('https://evil.example/')).toBe(false)
  })
})

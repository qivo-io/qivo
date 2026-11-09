import { describe, expect, it } from 'vitest'
import { windowOptions } from './windowOptions.js'

describe('the main window options', () => {
  it('reports a window started hidden as hidden until it is first shown', () => {
    expect(windowOptions(true, '/preload.cjs')).toMatchObject({
      show: false,
      paintWhenInitiallyHidden: false,
    })
  })

  it('paints and shows a window started for the person at once', () => {
    expect(windowOptions(false, '/preload.cjs')).toMatchObject({
      show: true,
      paintWhenInitiallyHidden: true,
    })
  })

  it('keeps the renderer isolated and sandboxed with the given preload either way', () => {
    for (const startHidden of [true, false]) {
      const options = windowOptions(startHidden, '/preload.cjs')
      expect(options.webPreferences).toEqual({
        preload: '/preload.cjs',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      })
      expect(options).toMatchObject({ width: 1440, height: 900, minWidth: 960, minHeight: 640 })
      // backgroundThrottling stays Electron's default, which makes a hidden
      // window report hidden
      expect(options.webPreferences).not.toHaveProperty('backgroundThrottling')
    }
  })
})

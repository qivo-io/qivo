import type { BrowserWindowConstructorOptions } from 'electron'

/** The main window's options. `startHidden` is a window created hidden at
    login (`--start-minimized` with a tray), whose page must report itself
    hidden until it is first shown, so its view reads stay paused
    (src/lib/viewVisibility.ts). Electron paints a window created with
    `show: false` anyway unless `paintWhenInitiallyHidden` is false, and
    the page then reports visible while nobody can see it; a Linux check
    under X11 and Wayland showed exactly that. `preload` is the preload
    script's path. `backgroundThrottling` keeps Electron's default, since it
    is what makes a hidden window report hidden. */
export function windowOptions(
  startHidden: boolean,
  preload: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111113',
    show: !startHidden,
    paintWhenInitiallyHidden: !startHidden,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
}

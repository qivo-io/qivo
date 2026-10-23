/**
 * Chromium switches a packaged build refuses to start with. Each one can
 * change which page the window shows with the desktop bridge, which server
 * answers for qivo.io or the update feed, or which code runs in Qivo's
 * processes:
 *
 * - `ignore-certificate-errors` and its SPKI list accept a certificate the
 *   system does not trust, so another server can pose as qivo.io or the feed.
 * - `host-rules` and `host-resolver-rules` send qivo.io and the feed to
 *   another address.
 * - `remote-debugging-port` and `remote-debugging-pipe` let another program
 *   drive the page, and with it the desktop bridge.
 * - `renderer-cmd-prefix`, `utility-cmd-prefix`, `gpu-launcher` and
 *   `browser-subprocess-path` start Qivo's child processes through another
 *   program.
 * - `load-extension` loads an extension into the session. Electron is not
 *   known to honour it, and Qivo refuses it either way.
 *
 * Fuses already turn off `--inspect` and `NODE_OPTIONS`. A run from source
 * accepts every switch, for development.
 */
export const refusedSwitches = [
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'host-rules',
  'host-resolver-rules',
  'remote-debugging-port',
  'remote-debugging-pipe',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'gpu-launcher',
  'browser-subprocess-path',
  'load-extension',
]

/**
 * Returns the refused switches on a packaged build's command line, as
 * `--name`. Chromium's own parser decides what counts as a switch, so the
 * `-name` and Windows `/name` spellings are caught too.
 */
export function refusedSwitchesIn(
  packaged: boolean,
  commandLine: Pick<Electron.CommandLine, 'hasSwitch'>,
): string[] {
  if (!packaged) return []
  return refusedSwitches.filter((name) => commandLine.hasSwitch(name)).map((name) => `--${name}`)
}

import { describe, expect, it } from 'vitest'
import { refusedSwitches, refusedSwitchesIn } from './switches'

function commandLine(...switches: string[]) {
  return { hasSwitch: (name: string) => switches.includes(name) }
}

describe('desktop command-line switches', () => {
  it('names every refused switch a packaged build was started with', () => {
    expect(
      refusedSwitchesIn(
        true,
        commandLine('ignore-certificate-errors', 'host-resolver-rules', 'start-minimized'),
      ),
    ).toEqual(['--ignore-certificate-errors', '--host-resolver-rules'])
    expect(
      refusedSwitchesIn(true, commandLine('remote-debugging-port', 'renderer-cmd-prefix')),
    ).toEqual(['--remote-debugging-port', '--renderer-cmd-prefix'])
  })

  it('starts a packaged build with the switches Qivo and troubleshooting use', () => {
    expect(
      refusedSwitchesIn(
        true,
        commandLine('start-minimized', 'no-sandbox', 'ozone-platform-hint', 'proxy-server'),
      ),
    ).toEqual([])
  })

  it('accepts every switch in a run from source', () => {
    expect(refusedSwitchesIn(false, commandLine(...refusedSwitches))).toEqual([])
  })
})

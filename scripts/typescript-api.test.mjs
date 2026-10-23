import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from 'typescript/unstable/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTypeScriptAPI } from './typescript-api.mjs'

let directory = ''
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

// On Windows closeTypeScriptAPI only runs the API's close(), which ends the server at once.
describe.skipIf(process.platform === 'win32')('closeTypeScriptAPI', () => {
  it('releases the snapshots and lets the server exit on its own', async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qivo-typescript-api-')))
    const file = path.join(directory, 'main.ts')
    fs.writeFileSync(file, 'export const value = 1\n')
    const api = new API()
    const snapshot = api.updateSnapshot({ openFiles: [file] })
    expect(snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file)).toBeDefined()
    // A SIGTERM is what makes the server print "context canceled" now and then.
    const server = api.client.channel.child
    await closeTypeScriptAPI(api)
    expect(server.killed).toBe(false)
    expect({ code: server.exitCode, signal: server.signalCode }).toEqual({ code: 0, signal: null })
    expect(snapshot.isDisposed()).toBe(true)
  })

  it('closes the API and throws when TypeScript moves its server', async () => {
    const api = { close: vi.fn() }
    await expect(closeTypeScriptAPI(api)).rejects.toThrow('Update scripts/typescript-api.mjs')
    expect(api.close).toHaveBeenCalledOnce()
  })

  it("throws when the API's close() stops the server some other way", async () => {
    const api = new API()
    api.updateSnapshot({ openFiles: [] })
    const server = api.client.channel.child
    api.client.close = () => server.kill()
    await expect(closeTypeScriptAPI(api)).rejects.toThrow('stopped its server with a signal')
    await once(server, 'exit')
  })

  it('kills a server that does not exit after its stdin closes or on SIGTERM, and throws', async () => {
    const server = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    )
    await once(server.stdout, 'data')
    const api = { client: { channel: { child: server, close: () => server.kill() } }, close() {} }
    await expect(closeTypeScriptAPI(api, 200, 200)).rejects.toThrow('did not exit within 200 ms')
    expect(server.signalCode).toBe('SIGKILL')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API } from 'typescript/unstable/sync'
import { afterEach, describe, expect, it } from 'vitest'
import { closeTypeScriptAPI } from './typescript-api.mjs'

let directory = ''
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

describe('closeTypeScriptAPI', () => {
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
    expect({ code: server.exitCode, signal: server.signalCode }).toEqual({ code: 0, signal: null })
    expect(snapshot.isDisposed()).toBe(true)
  })
})

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const artifact = 'electron-v44.4.3-linux-x64.zip'
const contents = 'Synthetic Electron download for proxy compatibility checks.'
const checksum = createHash('sha256').update(contents).digest('hex')

// Proxy bootstrap changes Node's global HTTP agents. Exercise the downloader
// resolved by app-builder-lib in a child so other tests retain their own agents.
const download = `
  const { createRequire } = require('node:module')
  const { readFile } = require('node:fs/promises')
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const { downloadArtifact } = builderRequire('@electron/get')
  const [url, directory, artifact, checksum] = process.argv.slice(1)
  downloadArtifact({
    version: '44.4.3', artifactName: 'electron', platform: 'linux', arch: 'x64',
    cacheRoot: directory + '/cache', tempDirectory: directory,
    checksums: { [artifact]: checksum },
    mirrorOptions: { resolveAssetURL: () => url },
    downloadOptions: { quiet: true, retry: { limit: 0 } },
  }).then(async (path) => {
    process.stdout.write(await readFile(path))
  }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
`

describe('Electron packaging downloader proxy compatibility', () => {
  it.each([
    { name: 'downloads through the configured proxy', bypass: false, corrupt: false },
    { name: 'honors NO_PROXY for a direct download', bypass: true, corrupt: false },
    { name: 'rejects a corrupt download through the proxy', bypass: false, corrupt: true },
  ])(
    '$name',
    async ({ bypass, corrupt }) => {
      const parent = resolve('dev-temp/electron-download-tests')
      await mkdir(parent, { recursive: true })
      const directory = await mkdtemp(`${parent}/download-`)
      const proxyRequests = []
      const directRequests = []
      const proxy = createServer((request, response) => {
        proxyRequests.push(request.url)
        response.end(corrupt ? 'corrupt artifact' : contents)
      })
      const origin = createServer((request, response) => {
        directRequests.push(request.url)
        response.end(contents)
      })
      try {
        proxy.listen(0, '127.0.0.1')
        await once(proxy, 'listening')
        origin.listen(0, '127.0.0.1')
        await once(origin, 'listening')
        const url = bypass
          ? `http://127.0.0.1:${origin.address().port}/${artifact}`
          : `http://electron-mirror.invalid/${artifact}`
        const result = run(process.execPath, ['-e', download, url, directory, artifact, checksum], {
          timeout: 10_000,
          env: {
            // Avoid inheriting a developer's mirror or proxy configuration.
            ELECTRON_GET_USE_PROXY: '1',
            ROARR_LOG: 'true',
            GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
            GLOBAL_AGENT_NO_PROXY: bypass ? '127.0.0.1' : '',
          },
        })
        if (corrupt) {
          await expect(result).rejects.toMatchObject({
            stderr: expect.stringContaining('did not match expected checksum'),
          })
        } else {
          const output = (await result).stdout
          expect(output.split('\n').at(-1)).toBe(contents)
          expect(output).toContain('"package":"global-agent"')
        }
        expect(proxyRequests).toEqual(bypass ? [] : [url])
        expect(directRequests).toEqual(bypass ? [`/${artifact}`] : [])
      } finally {
        for (const server of [proxy, origin]) {
          server.closeAllConnections()
          await new Promise((done) => server.close(done))
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )
})

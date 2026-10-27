import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { testCertificate, testKey } from '../tests/fixtures/local-tls.mjs'

const run = promisify(execFile)
// @electron/get starts a 30-second progress-bar timer even when quiet, and
// clears it only after a download succeeds. Without this, a failed download
// keeps the child alive until the `timeout` below kills it.
const noProgress = { ELECTRON_GET_NO_PROGRESS: '1' }
// How a child that reported its error and exited on its own fails.
const failed = (error) => ({ code: 1, killed: false, stderr: expect.stringContaining(error) })
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
    console.error(error.code, error.message)
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
            ...noProgress,
            ELECTRON_GET_USE_PROXY: '1',
            ROARR_LOG: 'true',
            GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
            GLOBAL_AGENT_NO_PROXY: bypass ? '127.0.0.1' : '',
          },
        })
        if (corrupt) {
          await expect(result).rejects.toMatchObject(failed('did not match expected checksum'))
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

  it.each([
    {
      name: 'validates a trusted HTTPS mirror',
      trust: true,
      host: 'receiver.example',
      error: null,
    },
    {
      name: 'rejects an untrusted HTTPS certificate',
      trust: false,
      host: 'receiver.example',
      error: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    },
    {
      name: 'rejects an HTTPS certificate for another hostname',
      trust: true,
      host: 'wrong-receiver.example',
      error: 'ERR_TLS_CERT_ALTNAME_INVALID',
    },
  ])(
    '$name through a proxy',
    async ({ trust, host, error }) => {
      const parent = resolve('dev-temp/electron-download-tests')
      await mkdir(parent, { recursive: true })
      const directory = await mkdtemp(`${parent}/https-`)
      const certificatePath = resolve(directory, 'test-ca.pem')
      const tunnels = []
      const requests = []
      const sockets = new Set()
      const origin = createHttpsServer(
        { key: testKey, cert: testCertificate },
        (request, response) => {
          requests.push(request.url)
          response.end(contents)
        },
      )
      const proxy = createServer()
      for (const server of [proxy, origin]) {
        server.on('connection', (socket) => sockets.add(socket))
      }
      try {
        await writeFile(certificatePath, testCertificate)
        origin.listen(0, '127.0.0.1')
        await once(origin, 'listening')
        // Resolve only this synthetic mirror to the local TLS receiver. The
        // downloader still validates the real TLS handshake and requested name.
        proxy.on('connect', (request, client, head) => {
          tunnels.push(request.url)
          const upstream = connect(origin.address().port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            client.pipe(upstream).pipe(client)
          })
          sockets.add(upstream)
          upstream.on('error', () => client.destroy())
          client.on('error', () => upstream.destroy())
        })
        proxy.listen(0, '127.0.0.1')
        await once(proxy, 'listening')
        const result = run(
          process.execPath,
          ['-e', download, `https://${host}/${artifact}`, directory, artifact, checksum],
          {
            timeout: 10_000,
            env: {
              ...noProgress,
              ELECTRON_GET_USE_PROXY: '1',
              GLOBAL_AGENT_HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
              ...(trust ? { NODE_EXTRA_CA_CERTS: certificatePath } : {}),
            },
          },
        )
        if (error) {
          await expect(result).rejects.toMatchObject(failed(error))
        } else {
          expect((await result).stdout).toBe(contents)
        }
        expect(tunnels).toEqual([`${host}:443`])
        expect(requests).toEqual(error ? [] : [`/${artifact}`])
      } finally {
        for (const socket of sockets) socket.destroy()
        for (const server of [proxy, origin]) {
          await new Promise((done) => server.close(done))
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )
})

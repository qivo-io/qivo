// The benchmark page: the real production UI and store on the synthetic
// transport, built from a checkout and served without a backend. Used by
// scripts/benchmark-browser.mjs and scripts/board-large-smoke.mjs.
import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { gitIn } from '../git.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, 'entry.tsx')
const transport = join(here, 'transport.mjs')

/** Builds the benchmark page from the checkout at `source` into `outDir`,
    with `temporary` as the build root. The page always uses this
    checkout's entry and transport. */
export async function buildPage(source, outDir, temporary) {
  await writeFile(
    join(temporary, 'index.html'),
    `<html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
  )
  await build({
    configFile: false,
    root: temporary,
    logLevel: 'warn',
    define: {
      __QIVO_BUILD_ID__: '"benchmark"',
      'import.meta.env.VITE_CONVEX_URL': '"https://benchmark.invalid"',
      'import.meta.env.VITE_CONVEX_SITE_URL': '"https://benchmark.invalid"',
    },
    plugins: [
      {
        name: 'benchmark-transport',
        enforce: 'pre',
        resolveId(id, importer) {
          if (!importer) return
          const path = id.startsWith('@perf/')
            ? resolve(source, 'src', id.slice(6))
            : id.startsWith('@/')
              ? resolve(source, 'src', id.slice(2))
              : id.startsWith('.')
                ? resolve(dirname(importer), id)
                : id
          if (
            [join(source, 'src/lib/convex'), join(source, 'src/lib/auth')].includes(
              path.replace(/\.ts$/, ''),
            )
          )
            return transport
        },
        transform(code, id) {
          if (id === join(source, 'src/styles/app.css'))
            return `${code}\n@source ${JSON.stringify(join(source, 'src'))};\n`
          if (id === join(source, 'src/App.tsx'))
            return code.replace('function App() {', 'function App() { window.__perf.appRenders++;')
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { '@perf': join(source, 'src'), '@': join(source, 'src') } },
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  })
}

/** The source of `commit` in `root`'s repository, in a folder of its own
    under `temporary`, with `root`'s dependencies. */
export async function checkoutOf(root, commit, temporary) {
  const folder = join(temporary, `baseline-${commit.slice(0, 12)}`)
  await mkdir(folder)
  const archive = join(temporary, 'baseline.tar')
  await gitIn(root, ['archive', '-o', archive, commit, 'src', 'convex', 'scripts'])
  await promisify(execFile)('tar', ['-xf', archive, '-C', folder])
  await symlink(join(root, 'node_modules'), join(folder, 'node_modules'))
  return folder
}

/** Serves the page built into `outDir` on `host` at a free port. Resolves
    its origin and a function that stops the server. */
export async function serve(outDir, host = '127.0.0.1') {
  const server = createServer(async (request, response) => {
    // another device can send any request line once --host is set
    if (!URL.canParse(request.url, 'http://localhost')) {
      response.writeHead(400).end()
      return
    }
    const pathname = new URL(request.url, 'http://localhost').pathname
    const file = pathname.startsWith('/assets/')
      ? join(outDir, pathname)
      : join(outDir, 'index.html')
    try {
      const content = await readFile(file)
      response.setHeader(
        'Content-Type',
        { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[
          extname(file)
        ] || 'application/octet-stream',
      )
      response.end(content)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const name = host.includes(':') ? `[${host}]` : host
  return {
    origin: `http://${name}:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

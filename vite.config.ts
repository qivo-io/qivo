import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, loadEnv } from 'vite'
import { demoProxy } from './scripts/demo-proxy.mjs'

/* Match the app and operator console rewrites in vercel.json. The website at
   `/` is built by website/scripts/build.mjs after `vite build`, so the dev
   server, which has no website, sends `/` to the app. `vite preview` passes
   its output directory as `website`, serves the built website from it and,
   like Vercel, serves a directory's index.html for a path without a trailing
   slash. */
const appRewrite =
  (demo = false, website?: string): Connect.NextHandleFunction =>
  (req, res, next) => {
    const [path, query] = (req.url || '').split(/\?(.*)/s)
    const search = query === undefined ? '' : `?${query}`
    if (path === '/' && !website) {
      res.statusCode = 307
      res.setHeader('Location', `/app${search}`)
      res.end()
      return
    }
    if (path === '/app' || path.indexOf('/app/') === 0) req.url = '/app.html'
    else if (path === '/admin' || path === '/admin/') req.url = demo ? '/app.html' : '/admin.html'
    else if (
      website &&
      !path.endsWith('/') &&
      !extname(path) &&
      existsSync(join(website, path, 'index.html'))
    )
      req.url = `${path}/index.html${search}`
    next()
  }

// A fresh identity for every artifact, including rebuilds of the same commit
// and rollbacks. The bundle and uncached manifest must describe the same build.
const buildId = crypto.randomUUID()

// Add an exact development hostname through Vite's
// __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS environment variable when needed.

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, '.', '')
  const demo = env.VITE_APP_MODE === 'demo'
  return {
    // The regular app and isolated demo run together. Their different config
    // hashes must not invalidate each other's optimized browser dependencies.
    cacheDir: demo ? 'node_modules/.vite-demo' : 'node_modules/.vite',
    // No single-page fallback: unknown paths return 404, as on Vercel, instead
    // of the website's homepage.
    appType: 'mpa',
    define: { __QIVO_BUILD_ID__: JSON.stringify(buildId) },
    server: {
      allowedHosts: [],
      proxy: demoProxy(env, command),
    },
    preview: { allowedHosts: [] },
    plugins: [
      {
        name: 'qivo-app-version',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ buildId }),
          })
        },
      },
      react(),
      tailwindcss(),
      {
        name: 'qivo-app-rewrite',
        configureServer(server) {
          server.middlewares.use(appRewrite(demo))
        },
        configurePreviewServer(server) {
          const output = resolve(server.config.root, server.config.build.outDir)
          server.middlewares.use(appRewrite(demo, demo ? undefined : output))
        },
      },
    ],
    resolve: {
      alias: {
        '@': new URL('./src', import.meta.url).pathname,
      },
    },
    build: {
      // Keep Vite 6's browser transform targets through the bundler upgrade.
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
      rolldownOptions: {
        // The app and operator console are the only Vite HTML entries. The
        // website's pages are written afterwards by website/scripts/build.mjs.
        input: {
          app: 'app.html',
          admin: 'admin.html',
        },
      },
    },
  }
})

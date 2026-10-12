import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, loadEnv } from 'vite'
import { demoProxy } from './scripts/demo-proxy.mjs'

/* Match the app and operator console rewrites in vercel.json. The website at
   `/` is built by website/scripts/build.mjs after `vite build`, so the dev
   server, which has no website, sends `/` to the app. `vite preview` serves
   the built website there instead. */
const appRewrite =
  (demo = false, website = false): Connect.NextHandleFunction =>
  (req, res, next) => {
    const [path, query] = (req.url || '').split(/\?(.*)/s)
    if (path === '/' && !website) {
      res.statusCode = 307
      res.setHeader('Location', query === undefined ? '/app' : `/app?${query}`)
      res.end()
      return
    }
    if (path === '/app' || path.indexOf('/app/') === 0) req.url = '/app.html'
    else if (path === '/admin' || path === '/admin/') req.url = demo ? '/app.html' : '/admin.html'
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
          server.middlewares.use(appRewrite(demo, !demo))
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

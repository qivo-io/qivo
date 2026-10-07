// Development only: a forwarded browser needs just the Vite port, including
// Convex's WebSocket, anonymous sign-in and private file gateways.
export function loopbackOrigin(value) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function demoProxy(env, command) {
  if (
    command !== 'serve' ||
    env.VITE_APP_MODE !== 'demo' ||
    !loopbackOrigin(env.VITE_CONVEX_URL) ||
    !loopbackOrigin(env.VITE_CONVEX_SITE_URL)
  )
    return undefined
  if (!loopbackOrigin(env.SITE_URL))
    throw new Error(
      'Local demo preview requires SITE_URL matching the backend’s localhost app origin.',
    )

  const route = (prefix, target, ws = false) => ({
    target,
    ws,
    changeOrigin: true,
    rewrite: (path) => path.slice(prefix.length) || '/',
    configure(proxy) {
      proxy.on('proxyReq', (request, incoming) => {
        // Port forwarding changes the browser's localhost port. Translate
        // only local origins; never grant an unrelated website a trusted one.
        if (loopbackOrigin(incoming.headers.origin))
          request.setHeader('Origin', new URL(env.SITE_URL).origin)
      })
    },
  })
  return {
    '^/__qivo_convex(?:/|$)': route('/__qivo_convex', env.VITE_CONVEX_URL, true),
    '^/__qivo_http(?:/|$)': route('/__qivo_http', env.VITE_CONVEX_SITE_URL),
  }
}

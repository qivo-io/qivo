// The desktop alerts of a replayed session (scripts/benchmark-load.mjs):
// the app's own alert client and leader, wired as a tab wires them, so a
// replayed leader calls and subscribes what a leading tab does. Kept here
// so a test drives the wiring with a stand-in Convex client.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFunctionReference } from 'convex/server'

/**
 * The app's alert client and leader (src/lib/notificationFeed.ts
 * createNotificationFeed and src/lib/notificationLeader.ts
 * startNotificationLeader) from the checkout at `root`, loaded through Vite
 * as scripts/benchmark-planner.mjs loads its src modules.
 */
export async function loadAppAlerts(root) {
  const { createServer } = await import('vite')
  const cacheDir = await mkdtemp(join(tmpdir(), 'qivo-load-alerts-'))
  const server = await createServer({
    root,
    cacheDir,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
  })
  try {
    const { createNotificationFeed } = await server.ssrLoadModule('/src/lib/notificationFeed.ts')
    const { startNotificationLeader } = await server.ssrLoadModule('/src/lib/notificationLeader.ts')
    return { createNotificationFeed, startNotificationLeader }
  } finally {
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}

/**
 * One browser profile's alerts on `convex` (a ConvexClient), with `app`'s
 * alert client and leader (loadAppAlerts'), wired as src/store/planner.ts
 * startAlerts wires them in a page that can always notify and leads alone,
 * with no Web Locks or channel and so no election. The feed is watched
 * outside any view, each answer handed over with `connection()`, the
 * socket's connection count, so a reconnect runs the feed's resume order,
 * and the delivery mode is watched live. `onAlert` hears each alert the app
 * would show. Answers the stop.
 */
export function leadAlerts({ convex, connection, app, name, onAlert = () => {} }) {
  let stopFeed = null
  const feed = app.createNotificationFeed({
    convex,
    watch: (after) => {
      stopFeed?.()
      stopFeed = convex.onUpdate(
        makeFunctionReference('inbox:feed'),
        { after },
        (value) => feed.receive({ value }, connection()),
        (error) => feed.receive({ error }, connection()),
      )
    },
    unwatch: () => {
      stopFeed?.()
      stopFeed = null
    },
    notify: onAlert,
    openInbox: () => {},
  })
  const leader = app.startNotificationLeader({
    convex,
    feed,
    canNotify: () => true,
    watchCapability: () => () => {},
    watchSettings: (take) =>
      convex.onUpdate(
        makeFunctionReference('notifications:settings'),
        {},
        (value) => take(value?.delivery ?? null),
        () => take(null),
      ),
    watchSignIn: () => () => {},
    name,
    locks: null,
    openChannel: null,
  })
  return () => {
    leader.stop()
    feed.stop()
  }
}

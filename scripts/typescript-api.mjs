/* Helpers for the scripts that read code through TypeScript's native API. */
import { once } from 'node:events'

/**
 * Closes a TypeScript API and lets its server exit on its own. The API's
 * close() releases its snapshots and then stops the server with SIGTERM, and
 * a server stopped that way now and then prints "context canceled", which
 * reaches the caller's stderr because the server shares it. This runs
 * close() without the stop, closes the server's stdin, waits until the
 * server exits and then releases the channel. On Windows the stop ends the
 * server at once, with no chance to print, so the API's close() is enough.
 *
 * The server is a private field of the API. When TypeScript moves it, when
 * close() stops the server some other way, or when the server has not exited
 * `timeout` milliseconds after its stdin closed, this stops the server and
 * throws, so the caller fails instead of printing that line now and then
 * again. A server that ignores SIGTERM gets SIGKILL `grace` milliseconds later.
 */
export async function closeTypeScriptAPI(api, timeout = 10_000, grace = 2_000) {
  if (process.platform === 'win32') return api.close()
  const channel = api.client?.channel
  const server = channel?.child
  if (typeof channel?.close !== 'function' || typeof server?.once !== 'function' || !server.stdin) {
    api.close()
    throw new Error(
      "closeTypeScriptAPI could not find the TypeScript API's server and its stdin in api.client.channel. Update scripts/typescript-api.mjs for the installed typescript.",
    )
  }
  // A server that has stopped already has nothing left to print.
  if (server.exitCode !== null || server.signalCode !== null) {
    api.close()
    return
  }
  const closeChannel = channel.close
  channel.close = () => {}
  try {
    api.close()
  } catch (error) {
    closeChannel.call(channel)
    throw error
  } finally {
    channel.close = closeChannel
  }
  if (server.killed) {
    channel.close()
    throw new Error(
      "The TypeScript API's close() stopped its server with a signal. Update scripts/typescript-api.mjs for the installed typescript.",
    )
  }
  // The API unrefs the server, which would let the process end before the wait does.
  server.ref()
  const exited = once(server, 'exit')
  let killed = false
  let force
  const timer = setTimeout(() => {
    killed = true
    server.kill()
    force = setTimeout(() => server.kill('SIGKILL'), grace)
  }, timeout)
  server.stdin.destroy()
  await exited
  clearTimeout(timer)
  clearTimeout(force)
  channel.close()
  if (killed)
    throw new Error(
      `The TypeScript API's server did not exit within ${timeout} ms after its stdin closed, so closeTypeScriptAPI stopped it.`,
    )
}

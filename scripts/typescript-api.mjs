/* Helpers for the scripts that read code through TypeScript's native API. */
import { once } from 'node:events'

/**
 * Closes a TypeScript API and lets its server exit on its own. The API's
 * close() releases its snapshots and then stops the server with SIGTERM, and
 * a server stopped that way now and then prints "context canceled", which
 * reaches the caller's stderr because the server shares it. This runs
 * close() without the stop, closes the server's input, waits until the
 * server exits, for at most `timeout` milliseconds, and then releases the
 * channel. The server belongs to the API's private fields, so when
 * TypeScript moves them this only calls close().
 */
export async function closeTypeScriptAPI(api, timeout = 10_000) {
  const channel = api.client?.channel
  const server = channel?.child
  if (
    typeof channel?.close !== 'function' ||
    !server?.stdin ||
    server.exitCode !== null ||
    server.signalCode !== null
  ) {
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
  // The API unrefs the server, which would let the process end before the wait does.
  server.ref()
  const exited = once(server, 'exit')
  const timer = setTimeout(() => server.kill(), timeout)
  server.stdin.destroy()
  await exited
  clearTimeout(timer)
  channel.close()
}

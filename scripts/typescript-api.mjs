/* Helpers for the scripts that read code through TypeScript's native API. */
import { once } from 'node:events'
import { closeSync } from 'node:fs'

/**
 * Closes a TypeScript API and lets its server exit on its own. The API's
 * close() releases its snapshots and then stops the server with SIGTERM, and
 * a server stopped that way now and then prints "context canceled", which
 * reaches the caller's stderr because the server shares it. This runs
 * close() without the stop, closes the server's input (its stdin, or on
 * Windows the named pipe the API opened), waits until the server exits and
 * then releases the channel.
 *
 * The server and its input are private fields of the API. When TypeScript
 * moves them, or the server has not exited `timeout` milliseconds after its
 * input closed, this stops it the old way and throws, so the caller fails
 * instead of printing that line now and then again.
 */
export async function closeTypeScriptAPI(api, timeout = 10_000) {
  const channel = api.client?.channel
  const server = channel?.child
  const windows = process.platform === 'win32'
  const input = windows ? channel?.pipeFd : server?.stdin
  if (typeof channel?.close !== 'function' || typeof server?.once !== 'function' || input == null) {
    api.close()
    throw new Error(
      "closeTypeScriptAPI could not find the TypeScript API's server and its input in api.client.channel. Update scripts/typescript-api.mjs for the installed typescript.",
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
  // The API unrefs the server, which would let the process end before the wait does.
  server.ref()
  const exited = once(server, 'exit')
  let killed = false
  const timer = setTimeout(() => {
    killed = true
    server.kill()
  }, timeout)
  if (windows) {
    closeSync(input)
    channel.pipeFd = undefined
  } else input.destroy()
  await exited
  clearTimeout(timer)
  channel.close()
  if (killed)
    throw new Error(
      `The TypeScript API's server did not exit within ${timeout} ms after its input closed, so closeTypeScriptAPI stopped it.`,
    )
}

/* A WebSocket double for a real ConvexClient in tests, which answers as
   the server would (lib/convexOrdering.test.ts,
   panels/settings/useProjectSettings.test.tsx). */

/** A message the client sent, as the socket parsed it. */
export type Sent = { type: string; requestId?: number; newVersion?: number; [key: string]: unknown }

/** A WebSocket double that opens on the next task, records what the client
    sends and lets the test answer as the server. */
export class ScriptedSocket {
  static last: ScriptedSocket | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readyState = 0
  sent: Sent[] = []
  constructor(readonly url: string) {
    ScriptedSocket.last = this
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0)
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

/** A server timestamp as the protocol carries it: a little-endian u64 in base64. */
export function u64(n: number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(n), true)
  return btoa(String.fromCharCode(...bytes))
}

/** Waits one task, as the socket opens and the client sends on one. */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

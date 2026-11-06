// @vitest-environment jsdom
import { ConvexClient } from 'convex/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveQueries, type LiveQueries } from '../../lib/liveQueries'
import { ScriptedSocket, tick, u64 } from '../../lib/scriptedSocket.setup'
import { type ProjectSettingsRead, useProjectSettings } from './useProjectSettings'

/* The read of a project's settings over the app's own live transport and a
   real ConvexClient, with a scripted socket in the server's place, so two
   calls for the same project share one Convex subscription as they do
   when the New sub-project dialog opens over that project's page. */

const transport = vi.hoisted(() => ({ live: null as LiveQueries | null }))
vi.mock('../../lib/convex', () => ({
  live: {
    watch: (...args: Parameters<LiveQueries['watch']>) => transport.live!.watch(...args),
    read: (token: string) => transport.live!.read(token),
    onTransition: (...args: Parameters<LiveQueries['onTransition']>) =>
      transport.live!.onTransition(...args),
  },
}))

type Caller = 'page' | 'dialog'
const reads = new Map<Caller, ProjectSettingsRead>()

/** Reads project plan's settings as `as`, noting what it reads. */
function Reader({ as }: { as: Caller }) {
  reads.set(as, useProjectSettings('plan'))
  return null
}

let client: ConvexClient | null = null
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  reads.clear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  await client?.close()
  client = null
  transport.live = null
  vi.unstubAllGlobals()
})

describe("the read of a project's settings", () => {
  it("asks the server again for every call of the project on one call's Try again", async () => {
    client = new ConvexClient('https://happy-otter-123.convex.cloud', {
      webSocketConstructor: ScriptedSocket as unknown as typeof WebSocket,
      unsavedChangesWarning: false,
    })
    const convex = client
    transport.live = createLiveQueries(convex.client, (ref, args) => convex.query(ref, args))
    await act(async () =>
      root.render(
        <>
          <Reader as="page" />
          <Reader as="dialog" />
        </>,
      ),
    )
    await act(tick)
    await act(tick)
    const socket = ScriptedSocket.last!
    // what the client asked of the server's query set, in order
    const asked = () =>
      socket.sent
        .filter((m) => m.type === 'ModifyQuerySet')
        .flatMap((m) => m.modifications as { type: string; queryId: number }[])
    let version = 0
    let ts = 0
    const transition = (modifications: object[]) =>
      act(async () => {
        const from = version
        version = Math.max(
          ...socket.sent.filter((m) => m.type === 'ModifyQuerySet').map((m) => m.newVersion!),
        )
        socket.receive({
          type: 'Transition',
          startVersion: { querySet: from, ts: u64(ts), identity: 0 },
          endVersion: { querySet: version, ts: u64(++ts), identity: 0 },
          modifications,
        })
      })
    const states = () => [reads.get('page')?.state, reads.get('dialog')?.state]
    // the two calls share one subscription
    expect(asked()).toEqual([
      expect.objectContaining({ type: 'Add', queryId: 0, udfPath: 'projectSettings:get' }),
    ])
    await transition([
      {
        type: 'QueryFailed',
        queryId: 0,
        errorMessage: 'Server Error',
        logLines: [],
        journal: null,
      },
    ])
    expect(states()).toEqual(['failed', 'failed'])

    const before = asked().length
    await act(async () => reads.get('dialog')?.retry())
    // the subscription stops and starts again under a new query id, so the
    // server runs the read once more for both
    expect(asked().slice(before)).toEqual([
      { type: 'Remove', queryId: 0 },
      expect.objectContaining({ type: 'Add', queryId: 1, udfPath: 'projectSettings:get' }),
    ])
    // neither holds the failure of the run that ended
    expect(states()).toEqual(['loading', 'loading'])
    await transition([{ type: 'QueryRemoved', queryId: 0 }])
    expect(states()).toEqual(['loading', 'loading'])
    const answer = { state: 'ok', project: { id: 'plan', name: 'Plan', org_id: 'org' } }
    await transition([
      { type: 'QueryUpdated', queryId: 1, value: answer, logLines: [], journal: null },
    ])
    expect(states()).toEqual(['ok', 'ok'])
    expect(reads.get('page')).toMatchObject({ answer, afterFailure: false })
    expect(reads.get('dialog')).toMatchObject({ answer, afterFailure: false })
  })
})

/* Whether a pending seat's invitation email went out. The app's invitations
   are sent after the change that caused them commits (convex/invites.ts), so
   the person who added someone learns the outcome here, live, from the
   server's record of the send, for the seats a page shows. */
import type { FunctionReturnType } from 'convex/server'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import { fmtTime } from './dates'
import { DEMO_MODE } from './demoMode'
import { useLiveView } from './liveView'

export type InviteDeliveryRow = FunctionReturnType<typeof api.invites.deliveries>[number]
export type InviteDelivery = InviteDeliveryRow['state']

/* The age at which an unsettled send is uncertain, as STALE_SEND_MS in
   convex/invites.ts. The query says so on a fresh load; this covers a page
   left open, because a query does not run again as time passes. */
const STALE_SEND_MS = 5 * 60_000

const staleAt = (row: InviteDeliveryRow) => Date.parse(row.since) + STALE_SEND_MS

/** Each pending seat among `seats` and its newest invitation email in
    `orgId`, keyed by profile id. Org admins see every pending seat, others
    the sends they caused. The read names the seats (invites.deliveries
    with profile_ids), keyed by them sorted, so a page reads only the rows
    it shows; without seats it reads nothing, so no page reads the whole
    organization. It is a live read (lib/liveView.ts) that stops while the
    tab or the desktop window is hidden and reads again on return. A send
    unsettled for five minutes reads as uncertain, also while the page
    stays open. Null while loading, after a refusal, while hidden, without
    seats and in the demo. */
export function useInviteDeliveries(
  orgId: string | undefined,
  seats: readonly string[] = [],
): ReadonlyMap<string, InviteDeliveryRow> | null {
  const sorted = [...new Set(seats)].sort()
  const key =
    DEMO_MODE || !orgId || sorted.length === 0
      ? null
      : JSON.stringify({ org_id: orgId, profile_ids: sorted })
  const view = useLiveView<readonly InviteDeliveryRow[]>(api.invites.deliveries, key)
  const rows = key !== null && view.key === key && view.value !== undefined ? view.value : null
  const [now, setNow] = useState(() => Date.now())
  // the clock the stale check reads, set again with each answer
  useEffect(() => setNow(Date.now()), [rows])
  // wake at the next send that turns stale
  useEffect(() => {
    const next = Math.min(
      ...(rows ?? []).filter((row) => row.state === 'sending' && staleAt(row) > now).map(staleAt),
    )
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now())
    return () => clearTimeout(timer)
  }, [rows, now])
  return useMemo(
    () =>
      rows &&
      new Map(
        rows.map((row) => [
          row.profile_id,
          row.state === 'sending' && staleAt(row) <= now ? { ...row, state: 'uncertain' } : row,
        ]),
      ),
    [rows, now],
  )
}

/** The invitation rows of the pending seats a page shows, which the page
    reads once with useInviteDeliveries and InviteLabel takes from here, so
    each row does not open a read of its own. Null outside such a page. */
export const InviteRows = createContext<ReadonlyMap<string, InviteDeliveryRow> | null>(null)

/** The invitation rows the page above provides (InviteRows). */
export const useInviteRows = () => useContext(InviteRows)

const JOIN_ANYWAY = 'They can still join by creating an account with this address.'

/** What a pending seat says about its invitation email: a short label, the
    sentence behind it, and whether the email failed. A send held back by
    the hourly cap says when it can go again, at `freeAt` (null or past:
    now, and undefined: not known here). A caller that stays on screen
    renders again at that time (useRenderAt). */
export function inviteLabel(
  state: InviteDelivery | undefined,
  freeAt?: string | null,
): {
  text: string
  detail?: string
  failed: boolean
} {
  switch (state) {
    case 'sending':
      return { text: 'sending invitation', failed: false }
    case 'unsent':
      return {
        text: 'invitation not sent',
        detail:
          'The invitation email could not be sent. Check the address. They can join later by creating an account with it, once Qivo can email them.',
        failed: true,
      }
    case 'held':
      return {
        text: 'invitation not sent',
        // the hour is still full only while freeAt lies ahead
        detail: `Invitation not sent. ${
          freeAt && Date.parse(freeAt) > Date.now()
            ? `This organization sent ${LIMITS.invitesPerHour.max} invitation emails in the last hour. Send it again after ${fmtTime(new Date(freeAt))}. `
            : `It was held back by the limit of ${LIMITS.invitesPerHour.max} invitation emails an hour. ${
                freeAt === undefined ? '' : 'Send it again now. '
              }`
        }${JOIN_ANYWAY}`,
        failed: true,
      }
    case 'uncertain':
      return {
        text: 'invitation may not have arrived',
        detail: `The mail service did not confirm the invitation email. If it does not arrive, ${JOIN_ANYWAY.charAt(0).toLowerCase()}${JOIN_ANYWAY.slice(1)}`,
        failed: true,
      }
    default:
      return { text: 'invited', failed: false }
  }
}

/** Renders the caller again at `at` (ms), when it lies ahead, such as the
    time a held invitation can go again, so what it says follows the clock. */
export function useRenderAt(at: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // a time already passed, such as one an answer brought late, counts now
    if (at <= Date.now()) {
      setNow(Date.now())
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), at - Date.now() + 500)
    return () => clearTimeout(timer)
  }, [at])
  return now
}

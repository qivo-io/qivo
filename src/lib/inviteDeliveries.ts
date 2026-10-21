/* Whether a pending seat's invitation email went out. The app's invitations
   are sent after the change that caused them commits (convex/invites.ts), so
   the person who added someone learns the outcome here, live, from the
   server's record of the send. */
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { convex } from './convex'
import { DEMO_MODE } from './demoMode'

export type InviteDelivery = FunctionReturnType<typeof api.invites.deliveries>[number]['state']

const NONE: ReadonlyMap<string, InviteDelivery> = new Map()

/** Each visible pending seat's newest invitation email state in `orgId`,
    keyed by profile id. Org admins see every pending seat, others the sends
    they caused. Empty while loading, on a refusal and in the demo. */
export function useInviteDeliveries(
  orgId: string | undefined,
): ReadonlyMap<string, InviteDelivery> {
  const [states, setStates] = useState(NONE)
  useEffect(() => {
    setStates(NONE)
    if (DEMO_MODE || !orgId) return
    return convex.onUpdate(
      api.invites.deliveries,
      { org_id: orgId },
      (rows) => setStates(new Map(rows.map((row) => [row.profile_id, row.state]))),
      () => setStates(NONE),
    )
  }, [orgId])
  return states
}

const JOIN_ANYWAY = 'They can still join by creating an account with this address.'

/** What a pending seat says about its invitation email: a short label, the
    sentence behind it, and whether the email failed. */
export function inviteLabel(state: InviteDelivery | undefined): {
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
        detail: `The invitation email could not be sent. ${JOIN_ANYWAY}`,
        failed: true,
      }
    case 'held':
      return {
        text: 'invitation not sent',
        detail: `This organization sent too many invitations in the last hour, so this one was not emailed. ${JOIN_ANYWAY}`,
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

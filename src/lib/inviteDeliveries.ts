/* Whether a pending seat's invitation email went out. The app's invitations
   are sent after the change that caused them commits (convex/invites.ts), so
   the person who added someone learns the outcome here, live, from the
   server's record of the send. */
import type { FunctionReturnType } from 'convex/server'
import { useEffect, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { convex } from './convex'
import { DEMO_MODE } from './demoMode'

type Row = FunctionReturnType<typeof api.invites.deliveries>[number]
export type InviteDelivery = Row['state']

/** Each visible pending seat's newest invitation email in `orgId`, keyed by
    profile id. Org admins see every pending seat, others the sends they
    caused. Null while loading, after a refusal and in the demo. */
export function useInviteDeliveries(orgId: string | undefined): ReadonlyMap<string, Row> | null {
  const [rows, setRows] = useState<ReadonlyMap<string, Row> | null>(null)
  useEffect(() => {
    setRows(null)
    if (DEMO_MODE || !orgId) return
    return convex.onUpdate(
      api.invites.deliveries,
      { org_id: orgId },
      (next) => setRows(new Map(next.map((row) => [row.profile_id, row]))),
      () => setRows(null),
    )
  }, [orgId])
  return rows
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
        detail:
          'The invitation email could not be sent. Check the address. They can join later by creating an account with it, once Qivo can email them.',
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

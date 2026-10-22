import { DEMO_FILE_BYTES, MIB } from '../../convex/lib/limits'

// A presentation flag only. Convex independently verifies its deployment mode
// and the caller's owned, unexpired demo before granting any access.
export const DEMO_MODE = import.meta.env.VITE_APP_MODE === 'demo'
export const WORKSPACE_SIGNUP_URL = 'https://qivo.io/app#signup'
export const DEMO_ENDED_EVENT = 'qivo:demo-ended'

export function notifyDemoEnded(phase: 'expired' | 'lost' = 'expired') {
  if (DEMO_MODE) window.dispatchEvent(new CustomEvent(DEMO_ENDED_EVENT, { detail: phase }))
}

/** The size limit the demo app shows for a file, in MiB, or undefined
 * outside the demo. */
export const DEMO_FILE_MIB = DEMO_MODE ? DEMO_FILE_BYTES / MIB : undefined

/** Refuses a file over the demo's per-file limit before it is uploaded, with
 * the sentence the demo backend answers (convex/http.ts readBackgroundBody),
 * so a large pick never ends in a failed upload. */
export function assertDemoFileSize(size: number, demo = DEMO_MODE): void {
  if (demo && size > DEMO_FILE_BYTES)
    throw new Error(`Choose a file no larger than ${DEMO_FILE_BYTES / MIB} MiB.`)
}

/** The sentence for a file over `limit`, the attachment cap the app applies
 * (store/planner.ts projectAttachmentLimit). It names the demo's limit when
 * that is the one that refused the file, else the organization's. */
export function attachmentTooLarge(name: string, limit: number, demo = DEMO_MODE): string {
  const which = demo && limit === DEMO_FILE_BYTES ? 'demo' : 'organization'
  return `"${name}" is larger than the ${Math.round(limit / MIB)} MiB ${which} limit`
}

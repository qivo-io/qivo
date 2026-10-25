/* The sentences a demo deployment refuses a visitor's demo with, under the
 * reason demo_unavailable (lib/demo.ts demoRefusal). The demo app shows one
 * of these on its refusal screen as it is, and no other text a server
 * error carries (src/lib/demoSession.ts demoEnding). This module imports
 * nothing, so the app can import it. */
export const DEMO_UNAVAILABLE = {
  loginRequired: 'A temporary demo login is required.',
  updated: 'Qivo was updated while your demo was being prepared. Start a new demo.',
  off: 'Demo access is unavailable.',
  mainDeployment: 'Demo access is unavailable on the main deployment.',
  unconfigured: 'Demo deployment is not configured.',
  closed: 'New demos are temporarily unavailable.',
} as const

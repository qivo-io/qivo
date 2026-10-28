/* Cron schedule (phase 9) — the three pg_cron jobs, times unchanged. Convex
 * cron args are hourUTC/minuteUTC BY DEFINITION — UTC by construction, which
 * is exactly what pg_cron ran, so do not "fix" 02:30 to local time. The whole
 * pg_net/Vault/cron-secret/Monday-sentinel apparatus is cut: failures appear
 * in the Convex dashboard logs, and each run writes one platform_audit_log
 * row (jobs.ts; files.reapOrphans writes its own).
 *
 * A branch preview registers none of them (see the export below). */

import { cronJobs, makeFunctionReference } from 'convex/server'
import { internal } from './_generated/api'
import { ERASE_EVERY_MS } from './model/fileHolds'

const crons = cronJobs()

// Starts the reconciliations, usage deliveries and free-period reminders
// that are due; a minute with none writes nothing (billingSync.ts).
crons.interval(
  'billing reconciliation',
  { minutes: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('billingSync:sweep'),
)

// was '30 2 * * *' (0070:265)
// The empty arguments start a run, which schedules one chain per organization
// with flagged tasks and one per organization with a due Done task in a live
// project (jobs.ts).
crons.daily(
  'archive-done-issues',
  { hourUTC: 2, minuteUTC: 30 },
  internal.jobs.archiveDoneIssues,
  {},
)

// was '15 3 * * *' (0110:124) — just after the archive sweep
// The empty arguments start a run, which schedules one chain per page of
// profiles whose sweep is due and one for the overdue snoozes (jobs.ts).
crons.daily(
  'sweep-read-messages',
  { hourUTC: 3, minuteUTC: 15 },
  internal.jobs.sweepReadMessages,
  {},
)

// After the other nightly jobs. Purges Deleted items whose 30 days are over;
// the empty arguments start a run and each run schedules the next
// (deletedItems.ts).
crons.daily('expire-deleted-items', { hourUTC: 3, minuteUTC: 45 }, internal.deletedItems.expire, {})

// was '0 3 * * 0' (0033:85)
// The empty arguments start a run; each leg schedules the next, and the last
// leg writes the reap_orphans row (files.ts).
crons.weekly(
  'reap-orphan-files',
  { dayOfWeek: 'sunday', hourUTC: 3, minuteUTC: 0 },
  internal.files.reapOrphans,
  {},
)

// Erases deleted files whose hold has ended and whose scheduled erase did
// not, and checks for a restore. The hold is two intervals shorter than 7
// days, so a file is erased within 7 days of its deletion even when its
// scheduled erase fails (model/fileHolds.ts). The empty arguments start a
// run; each leg schedules the next (files.ts).
crons.interval(
  'erase-held-files',
  { minutes: ERASE_EVERY_MS / 60_000 },
  internal.files.eraseHeldFiles,
  {},
)

// These handlers are no-ops outside the dedicated demo deployment. Admission
// may be closed while recovery continues deleting already-created demos.
crons.interval(
  'demo cleanup recovery',
  { minutes: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('internal/demoCleanup:recover'),
)
crons.interval(
  'demo upload recovery',
  { minutes: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('demoUploads:sweep'),
)
crons.interval(
  'demo analytics storage sample',
  { hours: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('internal/demoMetrics:sample'),
)
crons.interval(
  'demo metrics reporting',
  { minutes: 15 },
  makeFunctionReference<'action', Record<string, never>, null>('demoReporting:publish'),
)

// Restarts profile removal cleanup whose step stopped (profileRemovals.ts).
crons.interval('profile removal recovery', { minutes: 1 }, internal.profileRemovals.recover)

// Restarts label deletion cleanup whose step stopped (labelRemovals.ts).
crons.interval('label removal recovery', { minutes: 10 }, internal.labelRemovals.recover)

// Restarts the steps that bring a rename's name key copies in line, where
// one stopped (nameCopies.ts).
crons.interval('name key copy recovery', { minutes: 10 }, internal.nameCopies.recover)

// Starts and stops the read-only period before deletion, enforces the
// checkout deadline and begins deletions whose date has passed. The empty
// arguments start a run; each leg schedules the next (orgRemovals.ts).
crons.interval('organization retention', { hours: 1 }, internal.orgRemovals.sweep, {})

// Restarts organization deletions whose step stopped (orgRemovals.ts).
crons.interval('organization removal recovery', { minutes: 10 }, internal.orgRemovals.recover)

// Restarts Deleted items steps that stopped, at half the budget (deletedItems.ts).
crons.interval('deleted item recovery', { minutes: 1 }, internal.deletedItems.recover)

// Restarts the comment counts still under way, such as a restore's whose
// step failed (commentLimits.ts).
crons.interval('comment count recovery', { minutes: 10 }, internal.commentLimits.recover)

// Deletes the comment post logs whose posts no longer count
// (commentLimits.ts).
crons.interval('comment rate cleanup', { hours: 1 }, internal.commentLimits.sweep)

crons.interval(
  'webhook event recovery',
  { minutes: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('webhookQueue:expand'),
)

crons.interval(
  'webhook delivery recovery',
  { minutes: 1 },
  makeFunctionReference<'mutation', Record<string, never>, null>('webhookQueue:dispatch'),
)

// Deletes OAuth clients that nobody approved within three days of
// registration. The empty arguments start a run; each leg schedules the next
// (oauthRegistrations.ts).
crons.daily(
  'oauth client cleanup',
  { hourUTC: 4, minuteUTC: 15 },
  internal.oauthRegistrations.sweepClients,
  {},
)

// Deletes per-source OAuth registration counters from earlier hours.
crons.interval(
  'oauth registration counter cleanup',
  { hours: 1 },
  internal.oauthRegistrations.sweepCounters,
  {},
)

crons.interval(
  'webhook retention',
  { minutes: 15 },
  makeFunctionReference<'mutation', Record<string, never>, null>('webhooks:sweep'),
)

// Deletes platform_audit_log rows older than 90 days, after the nightly jobs
// have written theirs. The empty arguments start a run; each step schedules
// the next, and the last writes an expire_audit_log row when it deleted any
// (auditRetention.ts).
crons.daily('expire-audit-log', { hourUTC: 4, minuteUTC: 45 }, internal.auditRetention.expire, {})

// Deletes the sign-in sessions that have expired, each through the
// cleanup's session delete trigger. The empty arguments start a run; each
// step schedules the next, and the last writes an expire_sessions row when
// it deleted any (authRetention.ts).
crons.daily(
  'expire-sessions',
  { hourUTC: 4, minuteUTC: 55 },
  internal.authRetention.expireSessions,
  {},
)

// Deletes the OAuth access and refresh tokens that protect nothing any more,
// and the hashes of used refresh tokens that could no longer be accepted,
// the same way, with an expire_oauth_tokens row (authRetention.ts).
crons.daily(
  'expire-oauth-tokens',
  { hourUTC: 5, minuteUTC: 5 },
  internal.authRetention.expireTokens,
  {},
)

// Stores each organization's usage for the month that just ended, after the
// nightly jobs. On the 1st the empty arguments start the run; each step
// schedules the next and the last writes a usage_month row. On the other
// days it resumes a run whose step stopped, and otherwise reads one row
// (usage.ts closeMonth).
crons.daily('usage-month', { hourUTC: 5, minuteUTC: 15 }, internal.usage.closeMonth, {})

// Deletes usage rows older than 800 days. Each step schedules the next while
// it found a full page (usage.ts).
crons.monthly('expire-usage', { day: 1, hourUTC: 5, minuteUTC: 0 }, internal.usage.expire, {})

/* Convex reads this module, with the deployment's environment variables, when
 * functions are pushed, and only then. The preview builds set
 * QIVO_ENVIRONMENT=preview before their first push (scripts/vercel-build.mjs,
 * scripts/demo-build.mjs), so a branch preview runs no cron job. Every
 * other value keeps every job. A missing or unknown value keeps them too,
 * though http.ts already refuses that push and the jobs of the last push stay.
 * A stable backend holding `preview` by mistake would lose every job, so the
 * stable builds of both scripts refuse to push to a backend whose
 * QIVO_ENVIRONMENT differs from the build's. */
export default process.env.QIVO_ENVIRONMENT === 'preview' ? cronJobs() : crons

/* Cron schedule (phase 9) — the three pg_cron jobs, times unchanged. Convex
 * cron args are hourUTC/minuteUTC BY DEFINITION — UTC by construction, which
 * is exactly what pg_cron ran, so do not "fix" 02:30 to local time. The whole
 * pg_net/Vault/cron-secret/Monday-sentinel apparatus is cut: failures appear
 * in the Convex dashboard logs, and each run writes one platform_audit_log
 * row (jobs.ts; files.reapOrphans writes its own). */

import { cronJobs, makeFunctionReference } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'billing reconciliation',
  { minutes: 1 },
  makeFunctionReference<'action', Record<string, never>, null>('billingSync:sweep'),
)
crons.interval(
  'billing usage delivery',
  { minutes: 1 },
  makeFunctionReference<'action', Record<string, never>, null>('billingSync:pump'),
)

// was '30 2 * * *' (0070:265)
// The empty arguments start a run, which schedules one chain per organization (jobs.ts).
crons.daily(
  'archive-done-issues',
  { hourUTC: 2, minuteUTC: 30 },
  internal.jobs.archiveDoneIssues,
  {},
)

// was '15 3 * * *' (0110:124) — just after the archive sweep
// The empty arguments start a run, which schedules one chain per page of profiles (jobs.ts).
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

// Starts and stops the read-only period before deletion, enforces the
// checkout deadline and begins deletions whose date has passed. The empty
// arguments start a run; each leg schedules the next (orgRemovals.ts).
crons.interval('organization retention', { hours: 1 }, internal.orgRemovals.sweep, {})

// Restarts organization deletions whose step stopped (orgRemovals.ts).
crons.interval('organization removal recovery', { minutes: 10 }, internal.orgRemovals.recover)

// Restarts Deleted items steps that stopped, at half the budget (deletedItems.ts).
crons.interval('deleted item recovery', { minutes: 1 }, internal.deletedItems.recover)

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

export default crons

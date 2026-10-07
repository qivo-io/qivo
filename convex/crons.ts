/* Cron schedule (phase 9) — the three pg_cron jobs, times unchanged. Convex
 * cron args are hourUTC/minuteUTC BY DEFINITION — UTC by construction, which
 * is exactly what pg_cron ran, so do not "fix" 02:30 to local time. The whole
 * pg_net/Vault/cron-secret/Monday-sentinel apparatus is cut: failures appear
 * in the Convex dashboard logs, and each job's final act is one
 * platform_audit_log row written in the same transaction (jobs.ts;
 * files.reapOrphans writes its own). */

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
crons.daily('archive-done-issues', { hourUTC: 2, minuteUTC: 30 }, internal.jobs.archiveDoneIssues)

// was '15 3 * * *' (0110:124) — just after the archive sweep
crons.daily('sweep-read-messages', { hourUTC: 3, minuteUTC: 15 }, internal.jobs.sweepReadMessages)

// was '0 3 * * 0' (0033:85) — self-audits (files.ts writes the reap_orphans row)
crons.weekly(
  'reap-orphan-files',
  { dayOfWeek: 'sunday', hourUTC: 3, minuteUTC: 0 },
  internal.files.reapOrphans,
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

crons.interval(
  'webhook retention',
  { minutes: 15 },
  makeFunctionReference<'mutation', Record<string, never>, null>('webhooks:sweep'),
)

export default crons

import { describe, expect, it } from 'vitest'
import { AUDIT_ACTION_LABELS, auditActionLabel } from '../lib/auditActions'

/* Every platform_audit_log action has a label in Qivo Admin's Audit view.
 * model/admin.ts audit takes only a labeled action, so the typecheck refuses
 * a new one without a label; these scans keep every write on that path and
 * catch a label lost behind a cast. */

const sources = import.meta.glob(['../**/*.ts', '!../_generated/**', '!../tests/**'], {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const path = (key: string) => key.replace(/^\.\.\//, '')

describe('platform audit actions', () => {
  it('are written by model/admin.ts audit alone', () => {
    const writers = Object.entries(sources)
      .filter(([, src]) => /\binsert(?:Unique)?\(\s*(?:\w+,\s*)?'platform_audit_log'/.test(src))
      .map(([key]) => path(key))
    expect(writers).toEqual(['model/admin.ts'])
  })

  it('each have a label, as every action the code names', () => {
    const named = Object.entries(sources)
      .filter(([key, src]) => path(key) !== 'lib/auditActions.ts' && /\/model\/admin'/.test(src))
      .flatMap(([key, src]) =>
        [...src.matchAll(/\baction: '([^']+)'/g)].map(([, action]) => `${path(key)} ${action}`),
      )
    // the scan finds an operator's rows and a nightly job's
    expect(named).toContain('adminOrgs.ts create_org')
    expect(named).toContain('jobs.ts archive_done_issues')
    const unlabeled = named.filter(
      (entry) => !Object.hasOwn(AUDIT_ACTION_LABELS, entry.split(' ')[1]),
    )
    expect(unlabeled).toEqual([])
  })

  it('show a label, a former action its old one, and an unknown one as written', () => {
    expect(auditActionLabel('org.deletion_requested')).toBe('Requested organization deletion')
    expect(auditActionLabel('panorama_refill_started')).toBe('Started image import')
    expect(auditActionLabel('toString')).toBe('toString')
    expect(auditActionLabel('made_up')).toBe('made_up')
  })
})

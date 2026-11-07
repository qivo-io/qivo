/* A person's weekly capacity as Team utilization and the planning panel
   read it from P.person, which knows it only once the store holds the
   person's stored hours (store/viewModels.ts PersonView). */

import { plannableHoursOf } from '../lib/workload'
import type { PersonView } from '../store/planner'

/** What Team utilization and the planning panel say of a person whose
    weekly hours the store could not read, whose cells then show hours
    without a percentage. */
export const CAPACITY_UNKNOWN = 'Capacity unknown'

/** Person `p`'s weekly capacity: their stored hours (the default for none,
    unbounded for an agent), or null while the store does not know their
    hours, as for a person known only by name or not loaded yet. */
export function capacityOf(p: PersonView): number | null {
  if (p.state !== 'ok' || p.plannableHours === undefined) return null
  return plannableHoursOf({ plannableHours: p.plannableHours, kind: p.kind })
}

/** Whether a read on its way may still bring person `p`'s weekly hours,
    as while they are `loading` or known by a picker's name alone before
    their read answers. Once that read failed or left them out, their
    capacity stays unknown and the planning panel says auto-fit is off. */
export function hoursLoading(p: PersonView | null): boolean {
  return p?.state === 'loading' || (p?.state === 'ok' && p.reading)
}

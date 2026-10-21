import { type LoadFigure, loadFigure } from '@/lib/teamSync'
import { plannableHoursOf } from '@/lib/workload'
import { P, type UserVM } from '@/store/planner'

/** A person's week as the Team strip reads it: org-wide hours (P.weekLoadOf)
    over plannable hours, in the strip's colour rule. */
export function weekFigure(u: UserVM): LoadFigure {
  return loadFigure(P.weekLoadOf(u.id, P.TODAY_WEEK), plannableHoursOf(u))
}

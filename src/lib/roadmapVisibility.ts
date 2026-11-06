/* The Roadmap's visibility rule, which lives in
   convex/lib/roadmapVisibility.ts so the server's Roadmap read (tasks.roadmap)
   shows the tasks the app's timeline shows. */
export { isRoadmapTaskVisible } from '../../convex/lib/roadmapVisibility'

/** Whether task `it`, one without subtasks, has nothing to plan on the
    Roadmap, as it is Done without both dates, which the Roadmap's status
    rule never shows, planned or not (isRoadmapTaskVisible). */
export const doneWithoutDates = (it: {
  status?: string
  start?: number | null
  end?: number | null
}): boolean => it.status === 'done' && (it.start == null || it.end == null)

/** Why Plan on roadmap cannot plan such a task (doneWithoutDates), as its
    button's title and the Roadmap's note say. */
export const DONE_WITHOUT_DATES = 'A Done task without dates has nothing to plan on the Roadmap.'

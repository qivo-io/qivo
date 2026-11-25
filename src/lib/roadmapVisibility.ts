/* The Roadmap's visibility rule, which lives in
   convex/lib/roadmapVisibility.ts so the server's Roadmap read (tasks.roadmap)
   shows the tasks the app's timeline shows, and the person's Hide Done in
   Roadmap on top of it, which only the app applies, so the server's answer
   and its counts are the same either way. */
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

/** Whether the Roadmap gives Done tasks no row for the account whose
    appearance is `preferences` (Hide Done in Roadmap): on unless the
    account turned it off, also while its appearance has not loaded. */
export const hidesDone = (preferences: { roadmap_hide_done?: boolean } | null | undefined) =>
  preferences?.roadmap_hide_done !== false

/** Hide Done in Roadmap as the Roadmap applies it, for the appearance the
    app's provider holds (lib/appearanceContext.ts): hidesDone once its
    read answered, and also once it failed, and null while it loads. */
export const hideDoneSetting = (appearance: {
  preferences: { roadmap_hide_done?: boolean } | null
  preferencesState: 'loading' | 'ok' | 'failed' | 'retrying'
}): boolean | null =>
  appearance.preferences === null && appearance.preferencesState === 'loading'
    ? null
    : hidesDone(appearance.preferences)

/** The tasks of `tasks` the Roadmap gives a row, in their order, and the
    ones Hide Done in Roadmap hides, while `hide` is on: those `isDone`
    calls Done, as P.isDone does for the bars, so a task with subtasks
    counts once all its subtask work is Done. While it is off every task
    shows, as the same list. */
export function withoutDone<T>(
  tasks: readonly T[],
  hide: boolean,
  isDone: (task: T) => boolean,
): { shown: readonly T[]; hidden: readonly T[] } {
  if (!hide) return { shown: tasks, hidden: [] }
  const shown: T[] = []
  const hidden: T[] = []
  for (const task of tasks) (isDone(task) ? hidden : shown).push(task)
  return { shown, hidden }
}

/** How the Roadmap says to show Done tasks again, as a clause. */
export const TURN_OFF_HIDE_DONE =
  'turn off Hide Done in Roadmap in Settings → Your preferences → Appearance'

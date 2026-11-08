/* The text filter by the server's words (convex/lib/search.ts
   taskSearchText), for the parity tests that compare the store's rows with
   the Board's and the Roadmap's answers. The store's filter row takes no
   text, as the views take the answer's text verdict, and the store holds
   nobody but the signed-in person and no label, so these name the assignee
   and the labels from the server's data the test published
   (store/guard/liveDouble.setup.ts Whole). It imports no store, so a test
   can load it before the store it boots. */

import { isIssueGroup } from '../lib/issueGroups'
import { matchesAllWords, taskSearchText } from '../lib/search'
import type { Whole } from './guard/liveDouble.setup'
import type { IssueVM } from './viewModels'

/** The names a task's search text holds, people's and labels' by id. */
export type TextNames = { people: Map<string, string>; labels: Map<string, string> }

/** The names of the server's data `whole`, for matchesText. */
export function textNames(whole: Pick<Whole, 'profiles' | 'labels'>): TextNames {
  return {
    people: new Map(whole.profiles.map((p) => [p.id, p.name])),
    labels: new Map(whole.labels.map((l) => [l.id, l.name])),
  }
}

/** Whether task `it` holds every word of `search` in its search text, as
    the server's reads match it, with its assignee and labels named from
    `names`. */
export function matchesText(names: TextNames, it: IssueVM, search: string): boolean {
  if (search.trim() === '') return true
  return matchesAllWords(
    taskSearchText({
      key: it.key,
      title: it.title,
      description: it.description,
      status: it.status,
      group: isIssueGroup(it),
      priority: it.priority,
      assigneeName: it.assignee ? names.people.get(it.assignee) : null,
      labelNames: it.labels.map((id) => names.labels.get(id)),
    }),
    search,
  )
}

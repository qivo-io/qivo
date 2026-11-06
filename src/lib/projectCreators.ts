/* The pure rules behind the "Who can create new projects?" setting in
   Organization settings: how the line under it words the server's answer
   (orgs.projectCreators, convex/model/peopleSettings.ts projectCreatorsOf)
   and which Users rows offer the per-user checkbox. Both follow the shared
   rule in convex/lib/projectCreators.ts, the one projects.create enforces,
   which counts a Standard user agent like a standard user who is a person.
   Nothing here imports the store at runtime. */
import type { CreatorRow, ProjectCreatorsAnswer } from '../../convex/model/peopleSettings'
import type { OrgVM, UserVM } from '../store/planner'

type Setting = OrgVM['projectCreators']

/** The creators line of one answer: the creators it names and how many
    others it counted, up to 100, with `more` past them and `agents` among
    the counted others. */
export type CreatorCount = Omit<
  Extract<ProjectCreatorsAnswer, { state: 'ok' }>,
  'state' | 'setting'
>

/** How the summary names a creator: an agent's name says it is one, such as
 * "Atlas (agent)", because the roster shows agents as standard users. */
export function creatorName(creator: Pick<CreatorRow, 'name' | 'agent'>): string {
  return creator.agent ? `${creator.name} (agent)` : creator.name
}

/** One part of a name list: a name, or the words that join the names. */
export type NamePart = { text: string; name: boolean }

/** The summary's creators on one line. With no others counted, the
 * creators in full ("A", "A and B", "A, B and C"); otherwise the first two
 * and a count that says how many of the others are agents ("A, B and 37
 * more", "A, B and 37 more, including 2 agents," or "A, B and 2 agents"),
 * so an agent is never hidden in the count, and past 100 "A, B and more
 * than 100 others", with ", including at least 3 agents," when the read
 * saw some, since it stopped counting there. Names and joining words are
 * separate parts so the caller can ink them apart; the caller adds " can
 * create projects." */
export function creatorPhrase(count: CreatorCount): NamePart[] {
  const name = (text: string): NamePart => ({ text, name: true })
  const words = (text: string): NamePart => ({ text, name: false })
  const names = count.creators.map(creatorName)
  const agentWord = (n: number) => `${n} agent${n === 1 ? '' : 's'}`
  if (count.others > 0 || count.more) {
    const { others, agents } = count
    const tail = count.more
      ? agents === 0
        ? ` and more than ${others} others`
        : ` and more than ${others} others, including at least ${agentWord(agents)},`
      : agents === 0
        ? ` and ${others} more`
        : agents === others
          ? ` and ${agentWord(agents)}`
          : ` and ${others} more, including ${agentWord(agents)},`
    return [name(names[0]), words(', '), name(names[1]), words(tail)]
  }
  return names.flatMap((text, i) => {
    if (i === 0) return [name(text)]
    return [words(i === names.length - 1 ? ' and ' : ', '), name(text)]
  })
}

/** The "Can create projects" checkbox a Users row shows, which happens only
 * under Selected users: 'editable' for an active standard user, person or
 * agent, the one role the right counts for, and 'locked' (ticked,
 * unchangeable) for an active org admin, who can always create projects.
 * Anyone else gets none. */
export function projectRightBox(
  user: Pick<UserVM, 'active' | 'orgRole'>,
  setting: Setting,
): 'editable' | 'locked' | null {
  if (setting !== 'selected' || !user.active) return null
  if (user.orgRole === 'admin') return 'locked'
  return user.orgRole === 'user' ? 'editable' : null
}

import { compileSearchScore } from './search'

type Project = { id: string; name: string; type: string; parent?: string | null }
type Task = { id: string; key: string; title: string; project: string }

/** A snapshot-scoped index. Visibility is resolved before retaining searchable text. */
export function createPaletteSearch<P extends Project, T extends Task>(
  projects: readonly P[],
  tasks: readonly T[],
  canSee: (projectId: string) => boolean,
) {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const visible = projects.filter((project) => {
    const meta = project.type === 'meta' ? project : byId.get(project.parent ?? '')
    return !!meta && canSee(meta.id)
  })
  const visibleIds = new Set(visible.map((project) => project.id))
  const projectIndex = visible.map((project) => ({
    project,
    label: project.name,
    sub: project.type === 'meta' ? undefined : byId.get(project.parent ?? '')?.name,
    normalized: project.name.toLowerCase(),
  }))
  const taskIndex = tasks
    .filter((task) => visibleIds.has(task.project))
    .map((issue) => ({ issue, normalized: `${issue.key} ${issue.title}`.toLowerCase() }))

  return (query: string) => {
    if (!query.trim()) return { projects: [], issues: [] }
    const score = compileSearchScore(query)
    const rankedProjects = projectIndex
      .map((item) => ({ ...item, score: score(item.normalized) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    const issues: { issue: T; score: number }[] = []
    // Keep the first nine highest scores. Strict comparison preserves source-order ties.
    for (const item of taskIndex) {
      const value = score(item.normalized)
      if (!value || (issues.length === 9 && value <= issues[8].score)) continue
      let at = issues.findIndex((ranked) => value > ranked.score)
      if (at < 0) at = issues.length
      issues.splice(at, 0, { issue: item.issue, score: value })
      if (issues.length > 9) issues.pop()
    }
    return { projects: rankedProjects, issues }
  }
}

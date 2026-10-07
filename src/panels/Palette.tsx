/* An empty search has no suggestions; results contain visible tasks and projects. */
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { IssueKey, StatusDot } from '../components/qivo'
import { restoreFocus } from '../lib/focusVisibility'
import { createPaletteSearch } from '../lib/paletteSearch'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import { P } from '../store/planner'

type SearchPaletteProps = {
  ctx: { setScope: (scopeId: string) => void; openIssue: (issueId: string) => void }
  onClose: () => void
}

function SearchPalette({ ctx, onClose }: SearchPaletteProps) {
  const mobile = useMobile()
  const [query, setQuery] = useState('')
  const pendingActionRef = useRef<(() => void) | null>(null)
  const closeLayer = useMobileBackLayer(true, () => {
    onClose()
    pendingActionRef.current?.()
  })
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  const run = (action: () => void) => {
    // Consume the phone search layer before opening a result, so Back from
    // that result returns to the page where the search began.
    pendingActionRef.current = action
    closeLayer()
  }

  // Workspace rebuilds replace these arrays, including after access changes.
  const search = useMemo(
    () => createPaletteSearch(P.projects, P.issues, (id) => P.canSee(id)),
    [P.projects, P.issues],
  )
  const { projects, issues } = search(query)
  const hasResults = projects.length > 0 || issues.length > 0

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) closeLayer()
      }}
      shouldFilter={false}
      showCloseButton={false}
      onOpenAutoFocus={() => {
        if (document.activeElement instanceof HTMLElement)
          returnFocusRef.current = document.activeElement
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        restoreFocus(returnFocusRef.current)
      }}
      title="Search tasks and projects"
      description="Search visible Qivo tasks and projects"
      overlayClassName="bg-[var(--scrim)] backdrop-blur-[6px]"
      className="top-[13vh] w-[580px] max-w-[93vw] translate-y-0 gap-0 overflow-hidden rounded-xl border-border bg-popover p-0 shadow-pop"
    >
      <CommandInput
        aria-label="Search tasks and projects"
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Search tasks and projects…"
        className="h-control text-base"
        endAdornment={
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            data-palette-close
            aria-label="Close search"
            title={mobile ? undefined : 'Close search (Esc)'}
            onClick={closeLayer}
          >
            {mobile ? 'Close' : 'esc'}
          </Button>
        }
      />
      <CommandList className="max-h-[388px] p-2">
        {!hasResults && query.trim() && (
          <CommandEmpty className="py-6 text-center text-base text-text-3">
            No results for “{query}”
          </CommandEmpty>
        )}
        {issues.length > 0 && (
          <CommandGroup
            heading="Tasks"
            className="[&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-text-1 [&_[cmdk-group-heading]]:tracking-normal"
          >
            {issues.map(({ issue }) => (
              <CommandItem
                key={issue.id}
                value={`issue-${issue.id}`}
                className="gap-2 p-2 data-[selected=true]:bg-primary-soft"
                onSelect={() => run(() => ctx.openIssue(issue.id))}
              >
                <IssueKey id={issue.key} />
                <span className="min-w-0 flex-1 truncate text-base text-text-1">{issue.title}</span>
                {!P.isGroup(issue) && <StatusDot status={issue.status} />}
                <span className="max-w-[120px] truncate text-xs text-text-3">
                  {P.project(issue.project)?.name}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {projects.length > 0 && (
          <CommandGroup
            heading="Projects"
            className="[&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:text-text-1 [&_[cmdk-group-heading]]:tracking-normal"
          >
            {projects.map(({ project, label, sub }) => (
              <CommandItem
                key={project.id}
                value={`project-${project.id}`}
                className="gap-2 p-2 data-[selected=true]:bg-primary-soft"
                onSelect={() => run(() => ctx.setScope(project.id))}
              >
                <span className="min-w-0 flex-1 truncate text-base text-text-1">{label}</span>
                {sub && <span className="text-xs text-text-3">{sub}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

export { SearchPalette }

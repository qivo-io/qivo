import { Button } from '@/components/ui/button'
import { P } from '../store/planner'
import { Icon } from './qivo'

/* `ground` follows ViewFilters (deviation #232): inside the roadmap
   toolbar's well the button is quiet, with the well's tighter radius; on the
   phone agenda, where it stands on the page, it keeps its border. */
export function RoadmapUndo({
  onUndo,
  ground = 'page',
}: {
  onUndo: () => void
  ground?: 'well' | 'page'
}) {
  const { count, busy, disabled } = P.roadmapUndo
  const unavailable = disabled || busy || count === 0
  const reason = disabled
    ? 'History cleared. Leave Roadmap and return to start a new undo history.'
    : busy
      ? 'Waiting for changes to save'
      : count === 0
        ? 'No roadmap changes to undo this visit'
        : undefined
  return (
    <Button
      type="button"
      variant={ground === 'well' ? 'quiet' : 'default'}
      className={ground === 'well' ? 'rounded-sm' : undefined}
      data-roadmap-undo
      disabled={unavailable}
      title={reason ?? 'Undo the last roadmap change'}
      onClick={onUndo}
    >
      <Icon name="rotateCcw" size={16} />
      Undo{count > 0 ? ` (${count})` : ''}
    </Button>
  )
}

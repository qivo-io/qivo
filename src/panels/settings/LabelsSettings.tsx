/* Organization label names, persisted colors and deletion controls. */
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Icon, Popover } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsGroup, SettingsSection } from '../../components/settingsPage'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { LabelVM } from '../../store/planner'
import { P } from '../../store/planner'

// Hex on purpose, not tokens — the same list, and the same reason, as the one
// in planner.ts: this is DATA. A swatch picked here is written to labels.color
// and read back by every client, so a var() would be stored as a string no
// other client could resolve. Do not "migrate" these to tokens.
const LABEL_COLORS = [
  { color: '#6D7BF2', name: 'Indigo' },
  { color: '#F0555D', name: 'Red' },
  { color: '#2FBE7A', name: 'Green' },
  { color: '#F2994A', name: 'Orange' },
  { color: '#A78BFA', name: 'Purple' },
  { color: '#4C9AFF', name: 'Blue' },
  { color: '#E3C55A', name: 'Yellow' },
  { color: '#0891B2', name: 'Teal' },
  { color: '#BE123C', name: 'Rose' },
  { color: '#8A8F98', name: 'Gray' },
]

function LabelRow({
  label,
  canEdit,
  armed,
  onArm,
  onDisarm,
}: {
  label: LabelVM
  canEdit: boolean
  armed: boolean
  onArm: () => void
  onDisarm: () => void
}) {
  const [name, setName] = useStateS(label.name)
  useUpdateBlocker(canEdit && name !== label.name)
  useEffectS(() => {
    setName(label.name)
  }, [label.name])
  const used = P.issues.filter((i) => (i.labels || []).includes(label.id)).length
  const commit = () => {
    const v = name.trim()
    if (v && v !== label.name) P.updateLabel(label.id, { name: v })
    else setName(label.name)
  }
  return (
    <div className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]">
      <Popover
        width={208}
        wrapStyle={{ display: 'flex', flexShrink: 0 }}
        button={(toggle) => (
          <Button
            type="button"
            disabled={!canEdit}
            onClick={toggle}
            data-field-trigger
            aria-label={`Change color for ${label.name}`}
            title={canEdit ? 'Change label color' : undefined}
            className="size-8 disabled:cursor-default"
            variant="ghost"
            size="icon"
          >
            <span
              style={{ background: label.color }}
              className="size-4 rounded-full [box-shadow:0_0_0_2px_var(--surface-1),_0_0_0_3px_var(--border-strong)]"
            />
          </Button>
        )}
      >
        {(close) => (
          <fieldset aria-label="Label colors" className="grid grid-cols-5 gap-1 p-2">
            {LABEL_COLORS.map(({ color, name: colorName }) => (
              <Button
                key={color}
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={!canEdit}
                aria-label={colorName}
                aria-pressed={label.color.toLowerCase() === color.toLowerCase()}
                onClick={() => {
                  if (color.toLowerCase() !== label.color.toLowerCase())
                    P.updateLabel(label.id, { color })
                  close()
                }}
              >
                <span
                  style={{ background: color }}
                  className={cn(
                    'size-5 rounded-full',
                    label.color.toLowerCase() === color.toLowerCase() &&
                      'ring-2 ring-foreground ring-offset-2 ring-offset-popover',
                  )}
                />
              </Button>
            ))}
          </fieldset>
        )}
      </Popover>
      {canEdit ? (
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-control-sm flex-1 border-transparent bg-transparent px-[7px] py-0 font-sans text-base font-medium text-text-1 hover:border-border focus:bg-hover"
        />
      ) : (
        <span className="[flex:1] [font-size:var(--fs-base)] [font-weight:500]">{label.name}</span>
      )}
      <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono">
        {used} task{used === 1 ? '' : 's'}
      </span>
      {canEdit && (
        <Button
          type="button"
          data-delete-label={label.id}
          variant="ghost"
          size={armed ? 'sm' : 'icon-sm'}
          style={{ color: armed ? 'var(--danger)' : undefined }}
          aria-label={
            armed
              ? used
                ? `Click again — removes it from ${used} task${used === 1 ? '' : 's'}`
                : 'Click again to confirm'
              : 'Delete label'
          }
          title={
            armed
              ? used
                ? `Click again — removes it from ${used} task${used === 1 ? '' : 's'}`
                : 'Click again to confirm'
              : 'Delete label'
          }
          onClick={() => {
            if (!armed) {
              onArm()
              return
            }
            P.removeLabel(label.id)
            onDisarm()
            window.showToast?.(`Label “${label.name}” deleted`)
          }}
        >
          <Icon name="trash" size={16} />
          {armed && 'Delete?'}
        </Button>
      )}
    </div>
  )
}

/* Labels survive task moves within the organization. Vocabulary edits follow
   canWriteOrgLabels; picking existing labels follows task access. */
export function OrgLabelsPage() {
  const labels = P.orgLabels()
  const canEdit = P.canWriteOrgLabels()
  const [newLabel, setNewLabel] = useStateS('')
  useUpdateBlocker(!!newLabel)
  const [confirm, setConfirm] = useStateS<string | null>(null)
  const dup = labels.some((l) => l.name.toLowerCase() === newLabel.trim().toLowerCase())
  const addLabel = () => {
    const v = newLabel.trim()
    if (!v || dup) return
    P.addLabel({ name: v })
    window.showToast?.(`Label “${v}” created`)
    setNewLabel('')
  }
  return (
    <>
      <PageTitle>Labels</PageTitle>
      <SettingsSection title="Labels" description="Deleting a label removes it from all tasks.">
        <div data-org-labels className="[display:flex] [flex-direction:column] [gap:6px]">
          {labels.map((l) => (
            <LabelRow
              key={l.id}
              label={l}
              canEdit={canEdit}
              armed={confirm === `l:${l.id}`}
              onArm={() => setConfirm(`l:${l.id}`)}
              onDisarm={() => setConfirm(null)}
            />
          ))}
          {labels.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
              No labels yet.
            </div>
          )}
        </div>
        {canEdit && (
          <SettingsGroup legend="New label">
            <div className="[display:flex] [gap:8px]">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="New label name"
                maxLength={40}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addLabel()
                }}
                className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
              />
              <Button
                type="button"
                disabled={!newLabel.trim() || dup}
                title={dup ? 'A label with that name already exists' : 'Add label'}
                onClick={addLabel}
              >
                <Icon name="plus" size={16} />
                Add label
              </Button>
            </div>
          </SettingsGroup>
        )}
        {!canEdit && (
          <FieldHint>Organization admins and project editors can manage labels.</FieldHint>
        )}
      </SettingsSection>
    </>
  )
}

/* Organization label names, persisted colors and deletion controls. */
import { useEffect as useEffectS, useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Icon, Popover } from '../../components/qivo'
import { FieldHint, PageTitle, SettingsGroup, SettingsSection } from '../../components/settingsPage'
import { LABEL_COLORS } from '../../lib/labelColors'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { useConfirmArm } from '../../lib/useConfirmArm'
import type { LabelVM } from '../../store/planner'
import { P } from '../../store/planner'

function LabelRow({
  label,
  canEdit,
  armed,
  onPress,
}: {
  label: LabelVM
  canEdit: boolean
  armed: boolean
  // the page's useConfirmArm press for this row, which arms it or runs `action`
  onPress: (action: () => void) => void
}) {
  const [name, setName] = useStateS(label.name)
  useUpdateBlocker(canEdit && name !== label.name)
  useEffectS(() => {
    setName(label.name)
  }, [label.name])
  const used = P.issues.filter((i) => (i.labels || []).includes(label.id)).length
  // an empty, unchanged or refused name puts the stored one back
  const commit = () => {
    const v = name.trim()
    if (!v || v === label.name) setName(label.name)
    // a paused rename keeps the typed name
    else if (!P.refusePausedEdit() && !P.updateLabel(label.id, { name: v })) setName(label.name)
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
          maxLength={40}
          aria-label={`Name of label ${label.name}`}
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
          onClick={() =>
            onPress(() => {
              if (P.refusePausedEdit()) return
              P.removeLabel(label.id)
              window.showToast?.(`Label “${label.name}” deleted`)
            })
          }
        >
          <Icon name="trash" size={16} />
          {armed && 'Delete?'}
        </Button>
      )}
    </div>
  )
}

/* Labels survive task moves within the organization. Settings opens this page
   for organization admins only, the same people the server lets rename,
   recolor and delete labels. Picking existing labels follows task access. */
export function OrgLabelsPage() {
  const labels = P.orgLabels()
  const canEdit = P.isAdmin()
  const [newLabel, setNewLabel] = useStateS('')
  useUpdateBlocker(!!newLabel)
  const confirm = useConfirmArm<string>()
  const dup = labels.some((l) => l.name.toLowerCase() === newLabel.trim().toLowerCase())
  const addLabel = () => {
    const v = newLabel.trim()
    if (!v || dup) return
    // a paused create keeps the typed name
    if (P.refusePausedEdit()) return
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
              armed={confirm.armed === `l:${l.id}`}
              onPress={(action) => confirm.press(`l:${l.id}`, action)}
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
                className="h-control w-full bg-surface-1 px-2.5 text-base font-sans [flex:1]"
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
        {!canEdit && <FieldHint>Only organization admins can manage labels.</FieldHint>}
      </SettingsSection>
    </>
  )
}

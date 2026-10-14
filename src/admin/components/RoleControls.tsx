/* The role field shared by the invitation dialogs and the organization's
   People table. Labels and order match the in-app Add a person form
   (src/panels/settings/UsersSettings.tsx). */
import { Lock } from 'lucide-react'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { InviteRole } from '../api'

const ROLE_LABEL: Record<InviteRole, string> = {
  admin: 'Org admin',
  user: 'Standard user',
  viewer: 'Viewer',
}
const ROLE_ORDER: InviteRole[] = ['user', 'viewer', 'admin']

/* `agent` leaves Org admin out, because an agent cannot be one. */
export function RoleSelect({
  value,
  onChange,
  agent = false,
  disabled,
  className,
  'aria-label': ariaLabel = 'Role',
}: {
  value: InviteRole
  onChange: (role: InviteRole) => void
  agent?: boolean
  disabled?: boolean
  className?: string
  'aria-label'?: string
}) {
  return (
    <NativeSelect
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const role = ROLE_ORDER.find((r) => r === event.target.value)
        if (role) onChange(role)
      }}
      className={cn('w-full bg-surface-1 text-sm', className)}
    >
      {ROLE_ORDER.filter((role) => !agent || role !== 'admin').map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role]}
        </option>
      ))}
    </NativeSelect>
  )
}

/* The role field when only Org admin is allowed. It has the face of a select,
   with a lock where the chevron would be. */
export function LockedRole({ title, className }: { title?: string; className?: string }) {
  return (
    <HoverTooltip content={title}>
      <div
        data-locked-role=""
        className={cn(
          'flex h-control w-full items-center justify-between gap-2 rounded-md border border-input px-2.5 text-sm text-text-1',
          className,
        )}
      >
        <span>
          Org admin<span className="sr-only">, locked</span>
        </span>
        <Lock className="size-3.5 text-text-2" aria-hidden="true" />
      </div>
    </HoverTooltip>
  )
}

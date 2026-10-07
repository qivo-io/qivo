import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, type AvatarSize, Icon, MenuItem, Popover } from '../../components/qivo'
import { SettingsField } from '../../components/settingsPage'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { P, type UserVM } from '../../store/planner'

// Account owners and organization admins share the same avatar controls.
function useAvatarUpload(user: UserVM) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const toast = (m: string) => window.showToast?.(m)
  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Clear first so choosing the same file triggers another change.
    e.target.value = ''
    if (!file || busy) return
    setBusy(true)
    const err = await P.setAvatar(user.id, file)
    setBusy(false)
    toast(err || 'Picture updated')
  }
  const clear = async () => {
    if (busy) return
    setBusy(true)
    const err = await P.clearAvatar(user.id)
    setBusy(false)
    toast(err || 'Picture removed')
  }
  const input = (
    <Input
      ref={ref}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      onChange={onChange}
      className="[display:none]"
    />
  )
  return { input, busy, clear, pick: () => ref.current?.click() }
}

function avatarSource(user: UserVM) {
  if (user.sampleAvatar) return 'sample'
  if (user.avatarPath) return 'uploaded'
  if (user.isAgent) return 'agent'
  return P.org.gravatarAvatars ? 'gravatar' : 'off'
}
function sourceLine(user: UserVM) {
  if (user.sampleAvatar) return 'Sample portrait'
  return avatarSource(user) === 'gravatar' ? `Gravatar, ${user.email}` : null
}

// Keep the file input outside the closing menu and invoke pick() synchronously
// before close(): opening a file dialog requires the original user activation.
export function AvatarPicker({ user, size = 28 }: { user: UserVM; size?: AvatarSize }) {
  const canEdit = P.canSetAvatar(user.id)
  const { input, busy, clear, pick } = useAvatarUpload(user)
  const source = sourceLine(user)
  if (!canEdit) return <Avatar id={user.id} size={size} />
  return (
    <>
      {input}
      <Popover
        width={244}
        wrapStyle={{ display: 'flex', flexShrink: 0 }}
        button={(toggle, open: boolean) => (
          <Button
            type="button"
            className="avatarpick"
            data-avatar-pick={user.id}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy}
            title={busy ? 'Uploading…' : `Change ${user.name}’s picture`}
            aria-label={busy ? 'Uploading…' : `Change ${user.name}’s picture`}
            onClick={toggle}
            variant="unstyled"
          >
            <Avatar id={user.id} size={size} />
            <span className="avatarveil">
              <Icon name="camera" size={Math.max(11, Math.round(size * 0.46))} />
            </span>
          </Button>
        )}
      >
        {(close) => (
          <>
            <div className="[padding:4px_8px_8px] [border-bottom:1px_solid_var(--border)] [margin-bottom:4px]">
              <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                {user.name}
              </div>
              {source && (
                <div className="[font-size:var(--fs-xs)] [color:var(--text-2)] [line-height:1.45] [margin-top:3px]">
                  {source}
                </div>
              )}
            </div>
            <MenuItem
              onClick={() => {
                pick()
                close()
              }}
            >
              <Icon name="camera" size={14} />
              {user.avatarPath ? 'Change picture…' : 'Upload a picture…'}
            </MenuItem>
            {/* Only private uploads can be removed; other sources are fallbacks. */}
            {user.avatarPath && !user.sampleAvatar && (
              <MenuItem
                danger
                data-avatar-clear={user.id}
                onClick={() => {
                  close()
                  void clear()
                }}
              >
                <Icon name="trash" size={14} />
                Remove picture
              </MenuItem>
            )}
          </>
        )}
      </Popover>
    </>
  )
}

export function AvatarField({ user }: { user: UserVM }) {
  return (
    <SettingsField label="Picture" width={430}>
      <AvatarPicker user={user} size={40} />
    </SettingsField>
  )
}

// An explicit save reports refusals inline and updates the name across seats.
export function NameField({ me }: { me: Pick<UserVM, 'name'> }) {
  const [v, setV] = useState(me.name)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setV(me.name)
    setErr('')
  }, [me.name])
  const dirty = v.trim() !== me.name
  useUpdateBlocker(dirty || busy)
  const save = async () => {
    if (busy || !dirty) return
    setBusy(true)
    const e = await P.setDisplayName(v)
    setBusy(false)
    setErr(e || '')
    if (!e) window.showToast?.(`You are now “${v.trim().replace(/\s+/g, ' ')}”`)
  }
  return (
    <SettingsField label="Your name" width={470}>
      <div className="flex min-h-10 items-center gap-2">
        <Input
          value={v}
          data-account-name
          maxLength={P.NAME_MAX}
          placeholder="Your name"
          autoComplete="name"
          onChange={(e) => {
            setV(e.target.value)
            setErr('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
            if (e.key === 'Escape') {
              setV(me.name)
              setErr('')
            }
          }}
          className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
        />
        <Button
          type="button"
          data-account-name-save
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {err && (
        <div
          data-account-name-error
          className="[font-size:var(--fs-sm)] [color:var(--danger)] [margin-top:8px] [line-height:1.5]"
        >
          {err}
        </div>
      )}
    </SettingsField>
  )
}

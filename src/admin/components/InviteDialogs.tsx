/* The operator's invitation dialogs. New organization creates an organization
   with its address, billing and first people. Invite people adds people to an
   existing organization, and Edit invite corrects a pending person's name or
   address. The dialogs check addresses while the operator types and once more
   before sending, and show the server's refusal if one still comes back. The
   rules themselves are in ../invites.ts. */
import { Plus, X } from 'lucide-react'
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { billingDate, billingMoney } from '@/lib/billingDisplay'
import { restoreFocus } from '@/lib/focusVisibility'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { cn } from '@/lib/utils'
import {
  type BillingPlans,
  checkAddress,
  checkPeople,
  createOrganization,
  editInvite,
  invitePeople,
  listPlans,
  type OrgMember,
  type PeopleCheck,
  suggestAddress,
} from '../api'
import {
  ADDRESS_MAX,
  addressMessage,
  cleanAddress,
  cleanEmail,
  cleanName,
  conflictMessage,
  createLabel,
  EMAIL_SHAPE,
  FREE_MONTHS,
  freeUntil,
  isBlankRow,
  isCompleteRow,
  MAX_PEOPLE,
  NAME_MAX,
  type PeopleReview,
  type PersonDraft,
  reviewPeople,
  sendLabel,
} from '../invites'
import { LockedRole, RoleSelect } from './RoleControls'

/* A field name over its control, as FieldLabel draws it on settings pages. */
const LABEL = 'mb-2 block text-sm leading-5 text-text-1'
const HINT = 'text-sm text-text-2'
const ERROR = 'text-sm text-danger'
/* Name, email, role and remove in one row. Below 640px the name and email
   take a line each, and the role shares the last line with remove. */
const ROW =
  'grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_10rem_2rem]'

/* Email fields are plain text with the email keyboard. The browser's own
   email check refuses addresses the server accepts, such as one with ø
   before the @, and turns a Unicode domain into punycode. EMAIL_SHAPE in
   ../invites.ts is the only rule. */
const EMAIL_INPUT = {
  type: 'text',
  inputMode: 'email',
  autoComplete: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const

type Plan = BillingPlans['plans'][number]

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const planLabel = (plan: Plan) =>
  `${plan.name}, ${billingMoney(plan.seat_price_cents, plan.currency)} per user per month, ${plan.minimum_seats}-user minimum`

/* `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

const byEmail = (list: PeopleCheck[]): ReadonlyMap<string, PeopleCheck> =>
  new Map(list.map((check) => [check.email, check]))

/* The ids a field's aria-describedby lists for its FieldNote. */
const noteIds = (id: string) => `${id}-error ${id}-hint`

/* The line under a field. An error takes the hint's place. Errors often come
   from a check that finishes after typing stops, so the error slot is a live
   region that is always present, and a screen reader hears each one. */
function FieldNote({
  id,
  error,
  hint,
  className,
}: {
  id: string
  error: string
  hint?: string
  className?: string
}) {
  return (
    <>
      <div id={`${id}-error`} aria-live="polite">
        {error && <p className={cn(ERROR, className)}>{error}</p>}
      </div>
      {!error && hint && (
        <p id={`${id}-hint`} className={cn(HINT, className)}>
          {hint}
        </p>
      )}
    </>
  )
}

/* ------------------------------------------------------------- person rows */

/* The rows of a people dialog, their review and the live address checks.
   `adminFirst` locks row 1 to Org admin. Omit orgId for an organization that
   does not exist yet. */
function usePeopleRows({ adminFirst, orgId }: { adminFirst: boolean; orgId?: string }) {
  const nextId = useRef(1)
  const [rows, setRows] = useState<PersonDraft[]>(() => [
    { id: 0, name: '', email: '', role: adminFirst ? 'admin' : 'user' },
  ])
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set())
  const [addedId, setAddedId] = useState<number | null>(null)
  const [checks, setChecks] = useState<ReadonlyMap<string, PeopleCheck>>(() => new Map())

  const emails = [
    ...new Set(rows.map((row) => cleanEmail(row.email)).filter((e) => EMAIL_SHAPE.test(e))),
  ].sort()
  const settled = useSettled(emails.join('\n'), 300)
  useEffect(() => {
    if (settled === '') {
      setChecks(new Map())
      return
    }
    let active = true
    checkPeople(settled.split('\n'), orgId)
      .then((list) => {
        if (active) setChecks(byEmail(list))
      })
      // The check before sending repeats this and reports its own failure.
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [settled, orgId])

  const review = reviewPeople(rows, { adminFirst, checks })
  return {
    rows,
    review,
    touched,
    addedId,
    dirty: rows.length > 1 || rows.some((row) => !isBlankRow(row)),
    update(id: number, patch: Partial<Omit<PersonDraft, 'id'>>) {
      setRows((all) => all.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    },
    add() {
      const id = nextId.current++
      setRows((all) => [...all, { id, name: '', email: '', role: 'user' }])
      setAddedId(id)
    },
    remove(id: number) {
      setRows((all) => all.filter((row) => row.id !== id))
    },
    /* The operator left the row or pressed Enter in it, so an incomplete
       row may say what it is missing. */
    leave(id: number) {
      setTouched((all) => (all.has(id) ? all : new Set(all).add(id)))
    },
    /* Checks the addresses again right before sending, so a conflict that
       arose since the live check reads the same way under its row. */
    async recheck(): Promise<PeopleReview> {
      if (emails.length === 0) return review
      const fresh = byEmail(await checkPeople(emails, orgId))
      setChecks(fresh)
      return reviewPeople(rows, { adminFirst, checks: fresh })
    },
  }
}

type PeopleRowsState = ReturnType<typeof usePeopleRows>

function PeopleRows({
  people,
  lockFirst,
  disabled,
}: {
  people: PeopleRowsState
  lockFirst: boolean
  disabled: boolean
}) {
  const ids = useId()
  const { rows, review } = people
  const firstReady = isCompleteRow(rows[0])
  const firstHint = [
    lockFirst ? 'The first person must be an org admin.' : '',
    firstReady ? '' : 'Fill in this row to add more people.',
  ]
    .filter(Boolean)
    .join(' ')
  const fieldId = (field: 'name' | 'email', id: number) => `${ids}-${field}-${id}`

  /* Removing a row takes its focused button away, so focus moves to the row
     above, or to the row that takes the first row's place. */
  const remove = (index: number) => {
    const above = rows[index - 1]
    const below = rows[index + 1]
    const next = above ? fieldId('email', above.id) : below ? fieldId('name', below.id) : null
    if (next) document.getElementById(next)?.focus()
    people.remove(rows[index].id)
  }

  return (
    <div>
      <div aria-hidden="true" className={cn(ROW, 'mb-2 hidden text-sm text-text-1 sm:grid')}>
        <span>Name</span>
        <span>Email address</span>
        <span>Role</span>
        <span />
      </div>
      {/* A row's note sits closer to it than the next row does. On a phone a
          row spans three lines, so a hairline separates the rows. */}
      <div className="space-y-3">
        {rows.map((row, i) => {
          const issue = review.issues[i]
          const shown = issue && (!issue.incomplete || people.touched.has(row.id)) ? issue : null
          const noteId = `${ids}-note-${row.id}`
          const locked = lockFirst && i === 0
          const person = `person ${i + 1}`
          return (
            <div
              key={row.id}
              data-person-row=""
              className="border-border max-sm:not-first:border-t max-sm:not-first:pt-3"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) people.leave(row.id)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
                  people.leave(row.id)
              }}
            >
              <div className={ROW}>
                <Input
                  id={fieldId('name', row.id)}
                  value={row.name}
                  onChange={(event) => people.update(row.id, { name: event.target.value })}
                  placeholder="Full name"
                  aria-label={`Name, ${person}`}
                  aria-invalid={shown?.field === 'name' ? true : undefined}
                  aria-describedby={noteIds(noteId)}
                  maxLength={NAME_MAX}
                  autoFocus={row.id === people.addedId}
                  disabled={disabled}
                  className="col-span-2 bg-surface-1 sm:col-span-1"
                />
                <Input
                  {...EMAIL_INPUT}
                  id={fieldId('email', row.id)}
                  value={row.email}
                  onChange={(event) => people.update(row.id, { email: event.target.value })}
                  placeholder="Email address"
                  aria-label={`Email address, ${person}`}
                  aria-invalid={shown?.field === 'email' ? true : undefined}
                  aria-describedby={noteIds(noteId)}
                  disabled={disabled}
                  className="col-span-2 bg-surface-1 sm:col-span-1"
                />
                {locked ? (
                  <LockedRole />
                ) : (
                  <RoleSelect
                    aria-label={`Role, ${person}`}
                    value={row.role}
                    disabled={disabled}
                    onChange={(role) => people.update(row.id, { role })}
                  />
                )}
                {locked || rows.length === 1 ? (
                  <span />
                ) : (
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon"
                    aria-label={`Remove ${person}`}
                    disabled={disabled}
                    onClick={() => remove(i)}
                  >
                    <X />
                  </Button>
                )}
              </div>
              <FieldNote
                id={noteId}
                error={shown?.message ?? ''}
                hint={i === 0 ? firstHint : undefined}
                className="mt-1.5"
              />
            </div>
          )
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-2 -ml-2.5"
        disabled={disabled || !firstReady || rows.length >= MAX_PEOPLE}
        onClick={people.add}
      >
        <Plus />
        Add person
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------ dialog frame */

/* Escape and the close button leave unless a write is running, and the close
   button is hidden while one runs. A click outside leaves only an untouched
   dialog, so a stray click keeps the rows. The callers open the dialog
   without a trigger, so it returns focus to whatever had it before. */
function InviteDialog({
  title,
  narrow = false,
  busy,
  dirty,
  onClose,
  children,
}: {
  title: string
  narrow?: boolean
  busy: boolean
  dirty: boolean
  onClose: () => void
  children: ReactNode
}) {
  const opener = useRef<HTMLElement | null>(null)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        aria-busy={busy}
        showCloseButton={!busy}
        onOpenAutoFocus={() => {
          if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // After New organization the opener is gone and the new page takes focus.
          if (opener.current?.isConnected) restoreFocus(opener.current)
        }}
        onInteractOutside={(event) => {
          if (dirty || busy) event.preventDefault()
        }}
        className={cn(
          'max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] gap-5 overflow-y-auto p-6',
          narrow ? 'max-w-[480px]' : 'max-w-[760px]',
        )}
      >
        <DialogHeader className="min-w-0 pr-7 [overflow-wrap:anywhere]">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function SendFooter({
  label,
  busy,
  canSubmit,
  onCancel,
}: {
  label: string
  busy: boolean
  canSubmit: boolean
  onCancel: () => void
}) {
  return (
    <DialogFooter className="border-t border-border pt-5 sm:items-center">
      <p className="text-sm text-text-2 sm:mr-auto">Invites are emailed from no-reply@qivo.io.</p>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" variant="primary" disabled={!canSubmit}>
        {label}
      </Button>
    </DialogFooter>
  )
}

/* -------------------------------------------------------- new organization */

/* The address field's state. It shows the server's suggestion for the name
   until the operator types an address. Emptied again, it sends nothing and
   the server derives the address from the name, which the placeholder
   shows. A typed address is checked once typing pauses. */
function useAddress(name: string) {
  const [typed, setTyped] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState('')
  const [refusal, setRefusal] = useState<{ slug: string; message: string } | null>(null)
  const following = !typed
  const settledName = useSettled(name.trim(), 250)
  useEffect(() => {
    if (!following) return
    if (settledName === '') {
      setSuggestion('')
      return
    }
    let active = true
    suggestAddress(settledName)
      .then((slug) => {
        if (active) setSuggestion(slug)
      })
      // Only the preview is lost. The server derives the address on create.
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [settledName, following])

  const settledTyped = useSettled(typed ?? '', 300)
  useEffect(() => {
    if (settledTyped === '') return
    let active = true
    checkAddress(settledTyped)
      .then((result) => {
        if (!active) return
        setRefusal(
          'reason' in result
            ? { slug: settledTyped, message: addressMessage(result.reason) }
            : null,
        )
      })
      // Create checks the address again and reports a failure there.
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [settledTyped])

  return {
    value: typed ?? suggestion,
    placeholder: suggestion,
    /* The address to send, or '' to let the server derive it. */
    slug: typed ?? '',
    edited: typed !== null,
    issue: typed && refusal?.slug === typed ? refusal.message : '',
    /* Takes the field's change. The field is lowercased in place, so the
       caret stays where the operator is typing. */
    type(event: ChangeEvent<HTMLInputElement>) {
      const input = event.currentTarget
      const clean = cleanAddress(input.value)
      if (clean !== input.value) {
        const { selectionStart, selectionEnd } = input
        input.value = clean
        input.setSelectionRange(selectionStart, selectionEnd)
      }
      setTyped(clean)
    },
    refuse: (slug: string, reason: string) => setRefusal({ slug, message: addressMessage(reason) }),
  }
}

/* Enter in a field of New organization does nothing. The console cannot
   delete an organization, so only the button creates one. */
function holdEnter(event: KeyboardEvent<HTMLFormElement>) {
  if (
    event.key === 'Enter' &&
    !event.nativeEvent.isComposing &&
    event.target instanceof HTMLInputElement
  )
    event.preventDefault()
}

export function NewOrganizationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  /* Resolves once the new organization's page is ready to open. */
  onCreated: (orgId: string) => Promise<void>
}) {
  const ids = useId()
  const [name, setName] = useState('')
  const address = useAddress(name)
  const [plans, setPlans] = useState<Plan[]>([])
  const [planId, setPlanId] = useState('')
  const [free, setFree] = useState(false)
  const people = usePeopleRows({ adminFirst: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = name.trim() !== '' || address.edited || free || people.dirty
  useUpdateBlocker(dirty || busy)

  useEffect(() => {
    let active = true
    listPlans()
      .then((result) => {
        if (!active) return
        const open = result.plans.filter((plan) => !plan.archived)
        setPlans(open)
        setPlanId(open.find((plan) => plan.id === result.default_plan_id)?.id ?? open[0]?.id ?? '')
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause))
      })
    return () => {
      active = false
    }
  }, [])
  useEffect(() => setError(''), [name, address.value, people.rows])

  const plan = plans.find((p) => p.id === planId)
  const count = people.review.people.length
  const canSubmit = !busy && name.trim() !== '' && !address.issue && people.review.ready

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    try {
      const slug = address.slug
      if (slug !== '') {
        const result = await checkAddress(slug)
        if ('reason' in result) {
          address.refuse(slug, result.reason)
          return
        }
      }
      const review = await people.recheck()
      if (!review.ready) return
      const created = await createOrganization({
        name: name.trim(),
        ...(slug !== '' ? { slug } : {}),
        ...(plan ? { plan_id: plan.id } : {}),
        ...(plan && free ? { complimentary_months: FREE_MONTHS } : {}),
        people: review.people,
      })
      await onCreated(created.org_id)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
      release()
    }
  }

  return (
    <InviteDialog title="New organization" busy={busy} dirty={dirty} onClose={onClose}>
      <form className="contents" onSubmit={submit} onKeyDown={holdEnter} data-new-org-form="">
        <div className="space-y-4">
          <div className="min-w-0">
            <label htmlFor={`${ids}-name`} className={LABEL}>
              Organization name
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={`${ids}-name-hint`}
              disabled={busy}
              className="bg-surface-1"
            />
            <p id={`${ids}-name-hint`} className={cn(HINT, 'mt-2')}>
              The starter team gets the same name.
            </p>
          </div>
          <div className="min-w-0">
            <label htmlFor={`${ids}-address`} className={LABEL}>
              Address
            </label>
            <div
              className={cn(
                'flex h-control w-full min-w-0 overflow-hidden rounded-md border bg-surface-1 shadow-xs',
                address.issue ? 'border-danger' : 'border-input has-[input:focus]:border-primary',
              )}
            >
              <span className="flex shrink-0 items-center border-r border-input px-2.5 font-mono text-base text-text-2 select-none">
                {`${location.host}/app/`}
              </span>
              <Input
                id={`${ids}-address`}
                value={address.value}
                placeholder={address.placeholder}
                onChange={address.type}
                maxLength={ADDRESS_MAX}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-invalid={address.issue ? true : undefined}
                aria-describedby={noteIds(`${ids}-address`)}
                disabled={busy}
                className="h-full rounded-none border-0 bg-transparent !font-mono shadow-none"
              />
            </div>
            <FieldNote id={`${ids}-address`} error={address.issue} className="mt-2" />
          </div>
        </div>
        {plans.length > 0 && (
          <div className="space-y-3 border-t border-border pt-5">
            <div className="min-w-0">
              <label htmlFor={`${ids}-plan`} className={LABEL}>
                Billing plan
              </label>
              <NativeSelect
                id={`${ids}-plan`}
                value={planId}
                onChange={(event) => setPlanId(event.target.value)}
                disabled={busy}
                className="w-full bg-surface-1"
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {planLabel(p)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="min-w-0">
              <div className="flex h-control items-center gap-2">
                <Checkbox
                  id={`${ids}-free`}
                  checked={free}
                  onCheckedChange={(checked) => setFree(checked === true)}
                  aria-describedby={free && plan ? `${ids}-free-hint` : undefined}
                  disabled={busy}
                />
                <label htmlFor={`${ids}-free`} className="text-base text-text-1">
                  Grant six months free
                </label>
              </div>
              {free && plan && (
                <p id={`${ids}-free-hint`} className={cn(HINT, 'pl-6')}>
                  Free until {billingDate(freeUntil(new Date()))}, then {plan.name}.
                </p>
              )}
            </div>
          </div>
        )}
        <div className="border-t border-border pt-5">
          <PeopleRows people={people} lockFirst disabled={busy} />
        </div>
        {error && (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        )}
        <SendFooter
          label={busy ? 'Creating…' : createLabel(count)}
          busy={busy}
          canSubmit={canSubmit}
          onCancel={onClose}
        />
      </form>
    </InviteDialog>
  )
}

/* ----------------------------------------------------------- invite people */

/* `adminFirst` when the organization has no active org admin. Row 1 is then
   locked to Org admin, as the server requires. */
export function InvitePeopleDialog({
  orgId,
  orgName,
  adminFirst,
  onClose,
  onInvited,
}: {
  orgId: string
  orgName: string
  adminFirst: boolean
  onClose: () => void
  /* Resolves once the organization page shows the new people. */
  onInvited: () => Promise<void>
}) {
  const people = usePeopleRows({ adminFirst, orgId })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useUpdateBlocker(people.dirty || busy)
  useEffect(() => setError(''), [people.rows])

  const count = people.review.people.length
  const canSubmit = !busy && people.review.ready && count > 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    try {
      const review = await people.recheck()
      if (!review.ready) return
      await invitePeople(orgId, review.people)
      await onInvited()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
      release()
    }
  }

  return (
    <InviteDialog
      title={`Invite people to ${orgName}`}
      busy={busy}
      dirty={people.dirty}
      onClose={onClose}
    >
      <form className="contents" onSubmit={submit} data-invite-form="">
        <PeopleRows people={people} lockFirst={adminFirst} disabled={busy} />
        {error && (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        )}
        <SendFooter
          label={busy ? 'Sending…' : sendLabel(count)}
          busy={busy}
          canSubmit={canSubmit}
          onCancel={onClose}
        />
      </form>
    </InviteDialog>
  )
}

/* ------------------------------------------------------------- edit invite */

/* Corrects a pending person's name or address. A new address is checked like
   a row in Invite people, and the server emails it at once. */
export function EditInviteDialog({
  orgId,
  member,
  onClose,
  onSaved,
}: {
  orgId: string
  member: OrgMember
  onClose: () => void
  /* Resolves once the organization page shows the change. */
  onSaved: () => Promise<void>
}) {
  const ids = useId()
  const [name, setName] = useState(member.name)
  const [email, setEmail] = useState(member.email ?? '')
  const [emailLeft, setEmailLeft] = useState(false)
  const [check, setCheck] = useState<PeopleCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cleanedName = cleanName(name)
  const cleanedEmail = cleanEmail(email)
  const emailChanged = cleanedEmail !== (member.email ?? '')
  const changed = cleanedName !== member.name || emailChanged
  const nameIssue = cleanedName === '' ? 'Add a name.' : ''
  const shapeIssue =
    cleanedEmail === ''
      ? 'Add an email address.'
      : EMAIL_SHAPE.test(cleanedEmail)
        ? ''
        : 'Enter a full email address.'
  /* A changed, well-formed address, checked once typing pauses. */
  const checkable = emailChanged && shapeIssue === '' ? cleanedEmail : ''
  const settled = useSettled(checkable, 300)
  useEffect(() => {
    if (settled === '') return
    let active = true
    checkPeople([settled], orgId)
      .then(([result]) => {
        if (active && result) setCheck(result)
      })
      // Save checks again and reports a failure there.
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [settled, orgId])
  const conflict = checkable !== '' && check?.email === checkable ? conflictMessage(check) : ''
  const emailIssue = conflict || (emailLeft ? shapeIssue : '')
  useUpdateBlocker(changed || busy)
  useEffect(() => setError(''), [name, email])
  const canSave = !busy && changed && !nameIssue && !shapeIssue && !conflict

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    try {
      if (emailChanged) {
        const [result] = await checkPeople([cleanedEmail], orgId)
        if (result) setCheck(result)
        if (conflictMessage(result)) return
      }
      await editInvite(member.profile_id, cleanedName, cleanedEmail)
      await onSaved()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
      release()
    }
  }

  return (
    <InviteDialog title="Edit invite" narrow busy={busy} dirty={changed} onClose={onClose}>
      <form className="contents" onSubmit={submit} data-edit-invite-form="">
        <div className="space-y-4">
          <div className="min-w-0">
            <label htmlFor={`${ids}-name`} className={LABEL}>
              Name
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={NAME_MAX}
              aria-invalid={nameIssue ? true : undefined}
              aria-describedby={noteIds(`${ids}-name`)}
              disabled={busy}
              className="bg-surface-1"
            />
            <FieldNote id={`${ids}-name`} error={nameIssue} className="mt-2" />
          </div>
          <div className="min-w-0">
            <label htmlFor={`${ids}-email`} className={LABEL}>
              Email address
            </label>
            <Input
              {...EMAIL_INPUT}
              id={`${ids}-email`}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={() => setEmailLeft(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setEmailLeft(true)
              }}
              aria-invalid={emailIssue ? true : undefined}
              aria-describedby={noteIds(`${ids}-email`)}
              disabled={busy}
              className="bg-surface-1"
            />
            <FieldNote
              id={`${ids}-email`}
              error={emailIssue}
              hint="A new address gets a new invite."
              className="mt-2"
            />
          </div>
        </div>
        {error && (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        )}
        <DialogFooter className="border-t border-border pt-5 sm:items-center">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </InviteDialog>
  )
}

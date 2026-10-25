import { useCallback, useEffect, useRef, useState } from 'react'
import { LimitedInput } from '@/components/LimitedField'
import { PageTitle, SettingsField, SettingsGroup, SettingsSection } from '@/components/settingsPage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { billingError, billingMoney } from '@/lib/billingDisplay'
import { useClosingWords } from '@/lib/closingWords'
import { convex } from '@/lib/convex'
import { overLimit } from '@/lib/fieldLimits'
import { restoreFocus } from '@/lib/focusVisibility'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../../convex/_generated/api'
import type { BillingPlan } from '../../../convex/lib/billingTypes'
import { LIMITS, PLAN_CURRENCIES } from '../../../convex/lib/limits'
import { runAction, sendMutation } from '../convex'

const initial = {
  name: '',
  currency: 'usd',
  seatPrice: '1',
  minimumSeats: '5',
  storagePerSeat: '1',
  minimumStorage: '5',
  callsPerSeat: '25000',
  storageBlockPrice: '1',
  apiBlockPrice: '1',
  apiBlockSize: '25000',
  polarProduct: '',
  apiMeter: '',
  storageMeter: '',
}

export function BillingPlans() {
  const [plans, setPlans] = useState<BillingPlan[] | null>(null)
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [form, setForm] = useState(initial)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const activeWrite = useRef(false)
  const dirty = Object.keys(initial).some((key) => form[key] !== initial[key])
  useUpdateBlocker(dirty || busy)

  const reload = useCallback(async () => {
    const result = await convex.query(api.adminBilling.listPlans, {})
    setPlans(result.plans)
    setDefaultId(result.default_plan_id)
  }, [])
  useEffect(() => {
    void reload().catch((cause: unknown) => setError(billingError(cause)))
  }, [reload])

  /** Runs one change, then reloads the catalogue. Answers whether it
   * landed. Its refusal goes to `refuse`, the page's alert unless a dialog
   * shows it. */
  async function write(work: () => Promise<void>, refuse: (refusal: string) => void = setError) {
    if (activeWrite.current) return false
    activeWrite.current = true
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
      await reload()
      return true
    } catch (cause) {
      refuse(billingError(cause))
      return false
    } finally {
      activeWrite.current = false
      setBusy(false)
      release()
    }
  }

  function create(event: React.FormEvent) {
    event.preventDefault()
    void write(async () => {
      await runAction(api.billingActions.createPlan, {
        plan: {
          name: form.name.trim(),
          currency: form.currency,
          seat_price_cents: Math.round(Number(form.seatPrice) * 100),
          minimum_seats: Number(form.minimumSeats),
          storage_gb_per_seat: Number(form.storagePerSeat),
          minimum_storage_gb: Number(form.minimumStorage),
          api_calls_per_seat: Number(form.callsPerSeat),
          storage_block_price_cents: Math.round(Number(form.storageBlockPrice) * 100),
          api_block_price_cents: Math.round(Number(form.apiBlockPrice) * 100),
          api_block_size: Number(form.apiBlockSize),
          ...(form.polarProduct.trim() ? { polar_product_id: form.polarProduct.trim() } : {}),
          ...(form.apiMeter.trim() ? { api_meter_id: form.apiMeter.trim() } : {}),
          ...(form.storageMeter.trim() ? { storage_meter_id: form.storageMeter.trim() } : {}),
        },
      })
      setForm(initial)
      setMessage(
        'Plan created. Connect its Polar product before making it the default for new customers.',
      )
    })
  }

  const field = (
    key: keyof typeof initial,
    label: string,
    options: { number?: boolean; min?: number; step?: string; hint?: string } = {},
  ) => (
    <SettingsField key={key} label={label} hint={options.hint} width={400}>
      <Input
        aria-label={label}
        type={options.number ? 'number' : 'text'}
        min={options.min}
        step={options.step ?? (options.number ? '1' : undefined)}
        required={!['polarProduct', 'apiMeter', 'storageMeter'].includes(key)}
        value={form[key]}
        disabled={busy}
        onChange={(event) => setForm((value) => ({ ...value, [key]: event.target.value }))}
        className="w-full bg-surface-1"
      />
    </SettingsField>
  )

  return (
    <div data-billing-plans>
      <PageTitle
        sub="Create a new plan version when pricing changes. Existing organizations retain their assigned terms."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError('')
              void reload().catch((cause: unknown) => setError(billingError(cause)))
            }}
          >
            Refresh
          </Button>
        }
      >
        Billing plans
      </PageTitle>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 text-sm text-text-2">
          {message}
        </p>
      )}
      <SettingsSection
        title="Plan versions"
        description={
          plans
            ? `${plans.length.toLocaleString()} immutable plan version${plans.length === 1 ? '' : 's'} in the catalogue.`
            : undefined
        }
      >
        {plans === null && !error && (
          <p role="status" className="text-sm text-text-2">
            Loading plans…
          </p>
        )}
        {plans?.length === 0 && (
          <div className="border border-dashed border-border p-6 text-sm text-text-2">
            <p className="font-semibold text-text-1">No billing plans yet.</p>
            <p className="mt-1">
              Create the first immutable plan below, then connect its payment product before
              assigning it.
            </p>
          </div>
        )}
        {plans?.map((plan) => (
          <SettingsGroup key={plan.id} legend={plan.name} data-billing-plan={plan.id}>
            <p className="text-sm">
              {billingMoney(plan.seat_price_cents, plan.currency)} per user per month ·{' '}
              {plan.minimum_seats}-user minimum
            </p>
            <p className="mt-2 text-sm text-text-2">
              {plan.storage_gb_per_seat} GB and {plan.api_calls_per_seat.toLocaleString()} calls per
              user; at least {plan.minimum_storage_gb} GB storage. Extra storage:{' '}
              {billingMoney(plan.storage_block_price_cents, plan.currency)} per started GB. Extra
              calls: {billingMoney(plan.api_block_price_cents, plan.currency)} per started{' '}
              {plan.api_block_size.toLocaleString()} calls.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <MakeDefault
                plan={plan}
                isDefault={defaultId === plan.id}
                busy={busy}
                onConfirm={(refuse) =>
                  write(async () => {
                    await sendMutation(api.adminBilling.setDefaultPlan, { plan_id: plan.id })
                    setMessage(
                      `${plan.name} is the default for new customers. Existing organizations keep their plans.`,
                    )
                  }, refuse)
                }
              />
              {!plan.polar_product_id && (
                <p className="text-sm text-text-2">Payment product is not configured.</p>
              )}
            </div>
            {!plan.polar_product_id && (
              <ConnectPlan
                busy={busy}
                onConnect={(ids) =>
                  write(async () => {
                    await runAction(api.billingActions.connectPlan, {
                      plan_id: plan.id,
                      ...ids,
                    })
                    setMessage(`${plan.name} is connected to Polar.`)
                  })
                }
              />
            )}
          </SettingsGroup>
        ))}
      </SettingsSection>
      <SettingsSection
        title="Create immutable plan"
        description="All amounts are before tax. Plan terms cannot be edited after creation. Without Polar IDs, the plan is a draft that you can connect later."
      >
        <form onSubmit={create}>
          <SettingsField label="Plan name" hint="Use a versioned name, such as Team 2026.">
            <LimitedInput
              aria-label="Plan name"
              limit={LIMITS.planName}
              required
              value={form.name}
              disabled={busy}
              onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
              className="w-full bg-surface-1"
            />
          </SettingsField>
          <SettingsField label="Currency">
            <NativeSelect
              aria-label="Currency"
              value={form.currency}
              disabled={busy}
              onChange={(event) => setForm((value) => ({ ...value, currency: event.target.value }))}
            >
              {PLAN_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code.toUpperCase()}
                </option>
              ))}
            </NativeSelect>
          </SettingsField>
          <SettingsGroup legend="Monthly users">
            {field('seatPrice', 'Price per user', { number: true, min: 0.01, step: '0.01' })}
            {field('minimumSeats', 'Minimum billed users', { number: true, min: 1 })}
          </SettingsGroup>
          <SettingsGroup legend="Shared usage allowances">
            {field('storagePerSeat', 'Included GB per user', { number: true, min: 0 })}
            {field('minimumStorage', 'Minimum included GB', { number: true, min: 0 })}
            {field('callsPerSeat', 'Included API calls per user', { number: true, min: 1 })}
            {field('storageBlockPrice', 'Price per extra started GB', {
              number: true,
              min: 0.01,
              step: '0.01',
            })}
            {field('apiBlockPrice', 'Price per extra started API block', {
              number: true,
              min: 0.01,
              step: '0.01',
            })}
            {field('apiBlockSize', 'API calls per extra block', { number: true, min: 1 })}
          </SettingsGroup>
          <SettingsGroup
            legend="Existing Polar configuration"
            description="Optional IDs for an existing product and its usage meters."
          >
            {field('polarProduct', 'Polar product ID')}
            {field('apiMeter', 'API usage meter ID')}
            {field('storageMeter', 'Storage usage meter ID')}
          </SettingsGroup>
          <div className="mt-6">
            <Button
              type="submit"
              data-create-billing-plan
              disabled={busy || !form.name.trim() || overLimit(LIMITS.planName, form.name)}
            >
              {busy ? 'Saving…' : 'Create plan'}
            </Button>
          </div>
        </form>
      </SettingsSection>
    </div>
  )
}

/** A plan's default line, or the question that makes a connected plan the
 * default for new customers. The question waits for the change and shows
 * its refusal, then closes once the catalogue has reloaded. It stays
 * mounted as its button gives way to the default line, so it fades, and
 * focus then goes to that line. */
function MakeDefault({
  plan,
  isDefault,
  busy,
  onConfirm,
}: {
  plan: BillingPlan
  isDefault: boolean
  busy: boolean
  /** makes the plan the default, giving a refusal to `refuse`, and answers
      whether it landed */
  onConfirm: (refuse: (refusal: string) => void) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const opener = useRef<HTMLButtonElement>(null)
  const status = useRef<HTMLParagraphElement>(null)
  // a reload while it waits for nothing that shows the plan as the default,
  // or archived, ends the question
  if (open && !saving && (isDefault || plan.archived)) setOpen(false)
  // Cancel clears the refusal, and the change clears saving, as the dialog
  // closes. It shows them until it has faded.
  const shown = useClosingWords(open, { error, saving })
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return
        setOpen(next)
        setError('')
      }}
    >
      {isDefault ? (
        <p ref={status} tabIndex={-1} className="text-sm font-semibold">
          Default for new customers
        </p>
      ) : plan.archived ? (
        <p ref={status} tabIndex={-1} className="text-sm text-text-2">
          Archived
        </p>
      ) : (
        <AlertDialogTrigger asChild>
          <Button
            ref={opener}
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !plan.polar_product_id}
          >
            Use for new customers
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent
        size="sm"
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) return
          event.preventDefault()
          restoreFocus(status.current)
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Make {plan.name} the default?</AlertDialogTitle>
          <AlertDialogDescription>
            New organizations will use this connected plan. Existing organizations keep their
            current terms.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {shown.error && (
          <p role="alert" className="text-sm text-danger">
            {shown.error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={shown.saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-make-default
            disabled={shown.saving}
            onClick={(event) => {
              event.preventDefault()
              setSaving(true)
              setError('')
              void onConfirm(setError).then((landed) => {
                setSaving(false)
                if (landed) setOpen(false)
              })
            }}
          >
            {shown.saving ? 'Saving…' : 'Make default'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ConnectPlan({
  busy,
  onConnect,
}: {
  busy: boolean
  onConnect: (ids: {
    polar_product_id: string
    api_meter_id: string
    storage_meter_id: string
  }) => Promise<unknown>
}) {
  const [product, setProduct] = useState('')
  const [apiMeter, setApiMeter] = useState('')
  const [storageMeter, setStorageMeter] = useState('')
  useUpdateBlocker(!!product || !!apiMeter || !!storageMeter)
  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault()
        void onConnect({
          polar_product_id: product.trim(),
          api_meter_id: apiMeter.trim(),
          storage_meter_id: storageMeter.trim(),
        })
      }}
    >
      <SettingsField
        label="Polar product ID"
        hint="Use a dedicated monthly product with seat and usage prices matching this plan."
      >
        <Input
          aria-label="Connect Polar product ID"
          value={product}
          onChange={(event) => setProduct(event.target.value)}
          disabled={busy}
          required
          className="w-full bg-surface-1"
        />
      </SettingsField>
      <SettingsField label="API usage meter ID">
        <Input
          aria-label="Connect API usage meter ID"
          value={apiMeter}
          onChange={(event) => setApiMeter(event.target.value)}
          disabled={busy}
          required
          className="w-full bg-surface-1"
        />
      </SettingsField>
      <SettingsField label="Storage usage meter ID">
        <Input
          aria-label="Connect storage usage meter ID"
          value={storageMeter}
          onChange={(event) => setStorageMeter(event.target.value)}
          disabled={busy}
          required
          className="w-full bg-surface-1"
        />
      </SettingsField>
      <Button
        type="submit"
        variant="outline"
        disabled={busy || !product.trim() || !apiMeter.trim() || !storageMeter.trim()}
      >
        Connect product
      </Button>
    </form>
  )
}

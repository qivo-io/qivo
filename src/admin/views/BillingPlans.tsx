import { useCallback, useEffect, useRef, useState } from 'react'
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
import { billingError, billingMoney } from '@/lib/billingDisplay'
import { convex } from '@/lib/convex'
import { beginUpdateBlock, useUpdateBlocker } from '@/lib/updateSafety'
import { api } from '../../../convex/_generated/api'
import type { BillingPlan } from '../../../convex/lib/billingTypes'

const initial = {
  name: '',
  currency: 'USD',
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

  async function write(work: () => Promise<void>) {
    if (activeWrite.current) return
    activeWrite.current = true
    const release = beginUpdateBlock()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
      await reload()
    } catch (cause) {
      setError(billingError(cause))
    } finally {
      activeWrite.current = false
      setBusy(false)
      release()
    }
  }

  function create(event: React.FormEvent) {
    event.preventDefault()
    void write(async () => {
      await convex.action(api.billingActions.createPlan, {
        plan: {
          name: form.name.trim(),
          currency: form.currency.toLowerCase(),
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
        maxLength={key === 'currency' ? 3 : key === 'name' ? 80 : undefined}
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
              {defaultId === plan.id ? (
                <p className="text-sm font-semibold">Default for new customers</p>
              ) : plan.archived ? (
                <p className="text-sm text-text-2">Archived</p>
              ) : (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !plan.polar_product_id}
                    >
                      Use for new customers
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Make {plan.name} the default?</AlertDialogTitle>
                      <AlertDialogDescription>
                        New organizations will use this connected plan. Existing organizations keep
                        their current terms.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          void write(async () => {
                            await convex.mutation(api.adminBilling.setDefaultPlan, {
                              plan_id: plan.id,
                            })
                            setMessage(
                              `${plan.name} is the default for new customers. Existing organizations keep their plans.`,
                            )
                          })
                        }
                      >
                        Make default
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              {!plan.polar_product_id && (
                <p className="text-sm text-text-2">Payment product is not configured.</p>
              )}
            </div>
            {!plan.polar_product_id && (
              <ConnectPlan
                busy={busy}
                onConnect={(ids) =>
                  write(async () => {
                    await convex.action(api.billingActions.connectPlan, {
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
          {field('name', 'Plan name', { hint: 'Use a versioned name, such as Team 2026.' })}
          {field('currency', 'Currency', {
            hint: 'USD, EUR, GBP, NOK, SEK, DKK, CAD, AUD, CHF or NZD.',
          })}
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
            <Button type="submit" data-create-billing-plan disabled={busy || !form.name.trim()}>
              {busy ? 'Saving…' : 'Create plan'}
            </Button>
          </div>
        </form>
      </SettingsSection>
    </div>
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
  }) => Promise<void>
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

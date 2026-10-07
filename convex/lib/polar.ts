/** Polar's pinned wire contract. No SDK, provider tokens, or raw provider errors
 * cross the public Convex boundary. Sources: polar.sh/docs/api-reference/2026-04
 * and polar.sh/docs/integrate/webhooks/delivery (including the Sep 8 key change). */
import { ConvexError } from 'convex/values'

export const POLAR_API_VERSION = '2026-04'
export const POLAR_MAX_BODY_BYTES = 1024 * 1024
const HTTP_TIMEOUT_MS = 15_000
const MAX_PAGES = 10
const MAX_SEATS = 1_000

declare class TextEncoder {
  encode(input: string): Uint8Array
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(input: Uint8Array): string
}
declare class AbortController {
  readonly signal: unknown
  abort(): void
}
declare function setTimeout(callback: () => void, delay: number): number
declare function clearTimeout(timer: number): void
declare const fetch: (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: unknown
    redirect: 'error'
  },
) => Promise<{
  status: number
  headers: Headers
  body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
  } | null
}>
declare const crypto: {
  subtle: {
    importKey(
      format: string,
      keyData: Uint8Array,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      usages: string[],
    ): Promise<unknown>
    verify(
      algorithm: string,
      key: unknown,
      signature: Uint8Array,
      data: Uint8Array,
    ): Promise<boolean>
  }
}

export class PolarError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'invalid_response'
      | 'invalid_product'
      | 'invalid_webhook'
      | 'invalid_configuration',
    readonly status?: number,
  ) {
    super(
      code === 'invalid_configuration'
        ? 'In Polar, disable multiple subscriptions and customer seat, plan, unit and pause changes; set subscription proration to next period.'
        : code === 'invalid_product'
          ? 'The Polar product does not match this billing plan.'
          : code === 'invalid_webhook'
            ? 'Invalid Polar webhook.'
            : 'Polar billing is temporarily unavailable.',
    )
    this.name = 'PolarError'
  }
}

function configured() {
  const token = process.env.POLAR_ACCESS_TOKEN?.trim()
  const server = process.env.POLAR_SERVER
  if (!token || (server !== 'sandbox' && server !== 'production'))
    throw new ConvexError({
      code: 'rule',
      message: 'Billing is not configured. Contact the Qivo operator.',
    })
  // Both environments use polar_oat_ tokens; the documented prefix does not
  // identify the environment. Polar rejects tokens from the other environment.
  if (!/^polar_oat_[A-Za-z0-9_-]+$/.test(token))
    throw new ConvexError({
      code: 'rule',
      message: 'Billing configuration is invalid. Contact the Qivo operator.',
    })
  return {
    token,
    origin: server === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh',
    server,
  }
}

export function polarConfigured(): boolean {
  try {
    configured()
    return true
  } catch {
    return false
  }
}

const invalid = (): never => {
  throw new PolarError('invalid_response')
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function string(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.length || value.length > max) return invalid()
  return value
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalid()
  return value
}
function bool(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid()
}
function date(value: unknown): number {
  const text = string(value, 64)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text)) return invalid()
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : invalid()
}
function uuid(value: unknown): string {
  const result = string(value, 36)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)
    ? result
    : invalid()
}
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : parse(value)
}
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const config = configured()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.origin}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Polar-Version': POLAR_API_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: 'error',
    })
    if (response.status < 200 || response.status >= 300)
      throw new PolarError('unavailable', response.status)
    const responseVersion = response.headers.get('Polar-Version')
    if (responseVersion && responseVersion !== POLAR_API_VERSION) return invalid()
    const length = Number(response.headers.get('Content-Length'))
    if (length > POLAR_MAX_BODY_BYTES || !response.body) return invalid()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (!part.value) return invalid()
        size += part.value.byteLength
        if (size > POLAR_MAX_BODY_BYTES) return invalid()
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel()
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    } catch {
      return invalid()
    }
  } catch (error) {
    if (error instanceof PolarError) throw error
    // Never include the response, request URL, token, or fetch error in logs/UI.
    throw new PolarError('unavailable')
  } finally {
    clearTimeout(timer)
  }
}

export const POLAR_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const
export type PolarSubscriptionStatus = (typeof POLAR_SUBSCRIPTION_STATUSES)[number]
export type PolarSubscription = {
  id: string
  customerId: string
  externalCustomerId?: string
  productId: string
  status: PolarSubscriptionStatus
  seats?: number
  pendingSeats?: number
  pendingProductId?: string
  pendingAppliesAt?: number
  currentPeriodStart: number
  currentPeriodEnd: number
  trialEnd?: number
  modifiedAt?: number
  startedAt?: number
  endedAt?: number
  cancelAtPeriodEnd: boolean
}

export function parsePolarSubscription(input: unknown): PolarSubscription {
  const value = object(input)
  const status = string(value.status)
  if (!(POLAR_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)) return invalid()
  const customer = object(value.customer)
  const customerId = uuid(value.customer_id)
  if (uuid(customer.id) !== customerId) return invalid()
  const pending = value.pending_update == null ? undefined : object(value.pending_update)
  const start = date(value.current_period_start)
  const end = date(value.current_period_end)
  if (end <= start) return invalid()
  return withoutUndefined({
    id: uuid(value.id),
    customerId,
    externalCustomerId: optional(customer.external_id, string),
    productId: uuid(value.product_id),
    status: status as PolarSubscriptionStatus,
    seats: optional(value.seats, (v) => integer(v, 1)),
    pendingSeats: optional(pending?.seats, (v) => integer(v, 1)),
    pendingProductId: optional(pending?.product_id, uuid),
    pendingAppliesAt: optional(pending?.applies_at, date),
    currentPeriodStart: start,
    currentPeriodEnd: end,
    trialEnd: optional(value.trial_end, date),
    modifiedAt: optional(value.modified_at, date),
    startedAt: optional(value.started_at, date),
    endedAt: optional(value.ended_at, date),
    cancelAtPeriodEnd: bool(value.cancel_at_period_end),
  })
}

export async function getPolarSubscription(id: string): Promise<PolarSubscription> {
  const subscription = parsePolarSubscription(await request(`/subscriptions/${uuid(id)}`))
  if (subscription.id !== id) return invalid()
  return subscription
}

export async function listPolarSubscriptions(
  externalCustomerId: string,
): Promise<PolarSubscription[]> {
  string(externalCustomerId)
  const result: PolarSubscription[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = object(
      await request(
        `/subscriptions/?external_customer_id=${encodeURIComponent(externalCustomerId)}&limit=100&page=${page}`,
      ),
    )
    if (!Array.isArray(response.items)) return invalid()
    for (const item of response.items) {
      const subscription = parsePolarSubscription(item)
      if (subscription.externalCustomerId !== externalCustomerId) return invalid()
      result.push(subscription)
    }
    const pages = integer(object(response.pagination).max_page, 0)
    if (page >= pages) return result
  }
  throw new PolarError('unavailable')
}

export async function updatePolarSeats(id: string, seats: number): Promise<PolarSubscription> {
  const subscription = parsePolarSubscription(
    await request(`/subscriptions/${uuid(id)}`, 'PATCH', {
      seats: integer(seats, 1, MAX_SEATS),
      proration_behavior: 'next_period',
    }),
  )
  if (subscription.id !== id) return invalid()
  return subscription
}

function hostedUrl(value: unknown): string {
  const url = string(value, 4096)
  const expected = configured().server === 'sandbox' ? 'sandbox.polar.sh' : 'polar.sh'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalid()
  }
  if (parsed.origin !== `https://${expected}`) return invalid()
  return url
}

export async function createPolarCheckout(input: {
  externalCustomerId: string
  customerEmail?: string
  customerName?: string
  productId: string
  seats: number
  successUrl: string
  returnUrl: string
}): Promise<PolarCheckout> {
  const seats = integer(input.seats, 1, MAX_SEATS)
  const result = object(
    await request(
      '/checkouts/',
      'POST',
      withoutUndefined({
        external_customer_id: string(input.externalCustomerId),
        customer_email: input.customerEmail,
        customer_name: input.customerName,
        products: [uuid(input.productId)],
        seats,
        min_seats: seats,
        max_seats: seats,
        success_url: string(input.successUrl, 2083),
        return_url: string(input.returnUrl, 2083),
        allow_trial: false,
        allow_discount_codes: false,
      }),
    ),
  )
  const checkout = parseCheckout(result)
  if (
    checkout.productId !== input.productId ||
    checkout.externalCustomerId !== input.externalCustomerId ||
    checkout.seats !== seats
  )
    return invalid()
  return checkout
}

export type PolarCheckout = {
  id: string
  url: string
  expiresAt: number
  status: 'open' | 'expired' | 'confirmed' | 'succeeded' | 'failed'
  productId: string
  externalCustomerId: string
  seats: number
}
function parseCheckout(input: unknown): PolarCheckout {
  const checkout = object(input)
  const status = string(checkout.status)
  if (!['open', 'expired', 'confirmed', 'succeeded', 'failed'].includes(status)) return invalid()
  const seats = integer(checkout.seats, 1, MAX_SEATS)
  if (checkout.min_seats !== seats || checkout.max_seats !== seats) return invalid()
  return {
    id: uuid(checkout.id),
    url: hostedUrl(checkout.url),
    expiresAt: date(checkout.expires_at),
    status: status as PolarCheckout['status'],
    productId: uuid(checkout.product_id),
    externalCustomerId: string(checkout.external_customer_id),
    seats,
  }
}
export async function getPolarCheckout(id: string): Promise<PolarCheckout> {
  const checkout = parseCheckout(await request(`/checkouts/${uuid(id)}`))
  if (checkout.id !== id) return invalid()
  return checkout
}

export async function createPolarPortal(input: {
  externalCustomerId: string
  returnUrl: string
}): Promise<{ url: string }> {
  const result = object(
    await request('/customer-sessions/', 'POST', {
      external_customer_id: string(input.externalCustomerId),
      return_url: string(input.returnUrl, 2083),
    }),
  )
  return { url: hostedUrl(result.customer_portal_url) }
}

export type PolarPrice = {
  id: string
  amountType: string
  currency: string
  isArchived: boolean
  taxBehavior?: string
  minimumSeats?: number
  maximumSeats?: number
  seatTiers?: { minSeats: number; maxSeats?: number; pricePerSeat: number }[]
  meterId?: string
  unitAmount?: number
  capAmount?: number
  meter?: Record<string, unknown>
}
export type PolarProduct = {
  id: string
  organizationId: string
  name: string
  isArchived: boolean
  isRecurring: boolean
  recurringInterval?: string
  recurringIntervalCount?: number
  trialInterval?: string
  trialIntervalCount?: number
  prices: PolarPrice[]
}

export function parsePolarProduct(input: unknown): PolarProduct {
  const product = object(input)
  const id = uuid(product.id)
  if (!Array.isArray(product.prices)) return invalid()
  const prices = product.prices.map((inputPrice): PolarPrice => {
    const price = object(inputPrice)
    if (uuid(price.product_id) !== id) return invalid()
    const result: PolarPrice = withoutUndefined({
      id: uuid(price.id),
      amountType: string(price.amount_type),
      currency: string(price.price_currency),
      isArchived: bool(price.is_archived),
      taxBehavior: optional(price.tax_behavior, string),
    })
    if (result.amountType === 'seat_based') {
      const seatTiers = object(price.seat_tiers)
      if (!Array.isArray(seatTiers.tiers)) return invalid()
      result.minimumSeats = integer(seatTiers.minimum_seats, 1)
      if (seatTiers.maximum_seats != null) result.maximumSeats = integer(seatTiers.maximum_seats, 1)
      result.seatTiers = seatTiers.tiers.map((inputTier) => {
        const tier = object(inputTier)
        return withoutUndefined({
          minSeats: integer(tier.min_seats, 1),
          maxSeats: optional(tier.max_seats, (v) => integer(v, 1)),
          pricePerSeat: integer(tier.price_per_seat),
        })
      })
    } else if (result.amountType === 'metered_unit') {
      const amount = string(price.unit_amount)
      if (
        !/^\d+(?:\.\d+)?$/.test(amount) ||
        !Number.isFinite(Number(amount)) ||
        Number(amount) > Number.MAX_SAFE_INTEGER
      )
        return invalid()
      result.unitAmount = Number(amount)
      result.meterId = uuid(price.meter_id)
      result.meter = object(price.meter)
      if (price.cap_amount != null) result.capAmount = integer(price.cap_amount)
    }
    return result
  })
  return withoutUndefined({
    id,
    organizationId: uuid(product.organization_id),
    name: string(product.name),
    isArchived: bool(product.is_archived),
    isRecurring: bool(product.is_recurring),
    recurringInterval: optional(product.recurring_interval, string),
    recurringIntervalCount: optional(product.recurring_interval_count, (v) => integer(v, 1)),
    trialInterval: optional(product.trial_interval, string),
    trialIntervalCount: optional(product.trial_interval_count, (v) => integer(v, 1)),
    prices,
  })
}

export async function getPolarProduct(id: string): Promise<PolarProduct> {
  const product = parsePolarProduct(await request(`/products/${uuid(id)}`))
  if (product.id !== id) return invalid()
  return product
}

export type PolarMeter = {
  id: string
  archivedAt?: number
  filter: Record<string, unknown>
  aggregation: Record<string, unknown>
}

export async function getPolarMeter(id: string): Promise<PolarMeter> {
  const meter = object(await request(`/meters/${uuid(id)}`))
  if (uuid(meter.id) !== id) return invalid()
  return withoutUndefined({
    id,
    archivedAt: optional(meter.archived_at, date),
    filter: object(meter.filter),
    aggregation: object(meter.aggregation),
  })
}

async function validateOrganizationSettings(id: string): Promise<void> {
  const organization = object(await request(`/organizations/${uuid(id)}`))
  if (uuid(organization.id) !== id) return invalid()
  const subscription = object(organization.subscription_settings)
  const portal = object(object(organization.customer_portal_settings).subscription)
  if (
    subscription.allow_multiple_subscriptions !== false ||
    subscription.allow_customer_updates !== false ||
    subscription.proration_behavior !== 'next_period' ||
    portal.update_seats !== false ||
    portal.update_plan !== false ||
    (portal.update_units !== undefined && portal.update_units !== false) ||
    (portal.pause !== undefined && portal.pause !== false)
  )
    throw new PolarError('invalid_configuration')
}

/** Plan values are app-owned immutable cents. Reject unknown extra prices so a
 * changed provider catalog cannot silently add charges at checkout. */
export async function validatePolarProduct(
  id: string,
  expected: {
    unitAmount: number
    currency: string
    minimumSeats: number
    allowArchived?: boolean
    meters?: { id: string; unitAmount: number; eventName?: string }[]
  },
): Promise<PolarProduct> {
  const product = await getPolarProduct(id)
  await validateOrganizationSettings(product.organizationId)
  const prices = product.prices.filter((price) => !price.isArchived)
  const seatPrices = prices.filter((price) => price.amountType === 'seat_based')
  const seat = seatPrices[0]
  const tiers = seat?.seatTiers
  const meters = expected.meters ?? []
  if (
    (product.isArchived && !expected.allowArchived) ||
    !product.isRecurring ||
    product.recurringInterval !== 'month' ||
    product.recurringIntervalCount !== 1 ||
    product.trialInterval !== undefined ||
    product.trialIntervalCount !== undefined ||
    seatPrices.length !== 1 ||
    prices.length !== meters.length + 1 ||
    !tiers ||
    tiers.length !== 1 ||
    seat.minimumSeats !== expected.minimumSeats ||
    seat.maximumSeats !== undefined ||
    tiers[0].minSeats !== expected.minimumSeats ||
    tiers[0].maxSeats !== undefined ||
    tiers[0].pricePerSeat !== expected.unitAmount ||
    prices.some(
      (price) => price.currency !== expected.currency || price.taxBehavior !== 'exclusive',
    )
  )
    throw new PolarError('invalid_product')
  for (const meter of meters) {
    const matches = prices.filter(
      (price) => price.amountType === 'metered_unit' && price.meterId === meter.id,
    )
    if (
      matches.length !== 1 ||
      matches[0].unitAmount !== meter.unitAmount ||
      matches[0].capAmount !== undefined
    )
      throw new PolarError('invalid_product')
    if (meter.eventName !== undefined) {
      const providerMeter = await getPolarMeter(meter.id)
      const clauses = providerMeter.filter.clauses
      if (
        providerMeter.archivedAt !== undefined ||
        providerMeter.aggregation.func !== 'sum' ||
        providerMeter.aggregation.property !== 'units' ||
        !['and', 'or'].includes(String(providerMeter.filter.conjunction)) ||
        !Array.isArray(clauses) ||
        clauses.length !== 1
      )
        throw new PolarError('invalid_product')
      const clause = object(clauses[0])
      if (
        clause.property !== 'name' ||
        clause.operator !== 'eq' ||
        clause.value !== meter.eventName
      )
        throw new PolarError('invalid_product')
    }
  }
  return product
}

export type PolarUsageEvent = {
  name: string
  externalCustomerId: string
  timestamp: number
  metadata: Record<string, string | number | boolean> & { units: number }
  idempotencyKey: string
}

/** Polar bills by RECEIPT time, not event timestamp. Persist/retry the same
 * external_id; late events enter the current cycle, never a closed invoice. */
export async function ingestPolarEvents(
  events: PolarUsageEvent[],
): Promise<{ inserted: number; duplicates: number }> {
  if (!events.length || events.length > 100) return invalid()
  const payload = events.map((event) => {
    integer(event.timestamp)
    integer(event.metadata.units)
    const entries = Object.entries(event.metadata)
    if (entries.length > 50) return invalid()
    for (const [key, value] of entries) {
      string(key, 40)
      if (typeof value === 'string') string(value, 500)
      else if (typeof value === 'number' && !Number.isFinite(value)) return invalid()
      else if (typeof value !== 'number' && typeof value !== 'boolean') return invalid()
    }
    return {
      name: string(event.name, 128),
      external_customer_id: string(event.externalCustomerId),
      timestamp: new Date(event.timestamp).toISOString(),
      external_id: string(event.idempotencyKey),
      metadata: event.metadata,
    }
  })
  const result = object(await request('/events/ingest', 'POST', { events: payload }))
  const inserted = integer(result.inserted, 0, events.length)
  const duplicates =
    result.duplicates === undefined ? 0 : integer(result.duplicates, 0, events.length)
  if (inserted + duplicates !== events.length) return invalid()
  return { inserted, duplicates }
}

export type PolarWebhook = {
  id: string
  timestamp: number
  type: string
  data: Record<string, unknown>
}
const webhookInvalid = (): never => {
  throw new PolarError('invalid_webhook')
}
function base64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) return webhookInvalid()
  try {
    return Uint8Array.from(atob(input), (c) => c.charCodeAt(0))
  } catch {
    return webhookInvalid()
  }
}

/** WebCrypto verifies HMAC without application-level timing comparisons.
 * Timestamp bounds limit replay; the caller must also deduplicate webhook ID.
 * Validate bytes before decoding JSON. Accept both documented Polar secret
 * schemes to permit existing endpoints and their redeliveries to keep working. */
export async function verifyPolarWebhook(
  raw: Uint8Array,
  headers: Headers,
  options: { secret?: string; now?: number } = {},
): Promise<PolarWebhook> {
  const secret = options.secret ?? process.env.POLAR_WEBHOOK_SECRET
  if (!secret?.startsWith('whsec_') || secret.length > 512) return webhookInvalid()
  if (!raw.byteLength || raw.byteLength > POLAR_MAX_BODY_BYTES) return webhookInvalid()
  const id = headers.get('webhook-id')
  const timestamp = headers.get('webhook-timestamp')
  const signatures = headers.get('webhook-signature')
  if (
    !id ||
    id.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(id) ||
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !signatures ||
    signatures.length > 2048
  )
    return webhookInvalid()
  if (Math.abs((options.now ?? Date.now()) / 1000 - Number(timestamp)) > 300)
    return webhookInvalid()
  const version = headers.get('webhook-api-version')
  if (version && version !== POLAR_API_VERSION) return webhookInvalid()
  const encoder = new TextEncoder()
  const prefix = encoder.encode(`${id}.${timestamp}.`)
  const message = new Uint8Array(prefix.byteLength + raw.byteLength)
  message.set(prefix)
  message.set(raw, prefix.byteLength)
  const keys = [encoder.encode(secret)]
  // Older Polar keys need not be valid Base64. A malformed new key still has
  // to authenticate using the complete legacy secret; it never skips HMAC.
  try {
    keys.unshift(base64(secret.slice(6)))
  } catch {
    /* legacy key */
  }
  const candidates = signatures
    .split(/\s+/)
    .filter((signature) => signature.startsWith('v1,'))
    .map((signature) => {
      try {
        return base64(signature.slice(3))
      } catch {
        return new Uint8Array()
      }
    })
    .filter((signature) => signature.byteLength === 32)
  if (!candidates.length) return webhookInvalid()
  let verified = false
  for (const material of keys) {
    if (!material.byteLength) continue
    const key = await crypto.subtle.importKey(
      'raw',
      material,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    for (const signature of candidates)
      verified = (await crypto.subtle.verify('HMAC', key, signature, message)) || verified
  }
  if (!verified) return webhookInvalid()
  try {
    const event = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)))
    if (event.api_version !== undefined && event.api_version !== POLAR_API_VERSION)
      return webhookInvalid()
    return {
      id,
      timestamp: Number(timestamp) * 1000,
      type: string(event.type, 128),
      data: object(event.data),
    }
  } catch {
    return webhookInvalid()
  }
}

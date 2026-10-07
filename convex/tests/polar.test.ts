import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPolarCheckout,
  createPolarPortal,
  getPolarCheckout,
  getPolarProduct,
  ingestPolarEvents,
  listPolarSubscriptions,
  POLAR_API_VERSION,
  parsePolarSubscription,
  polarConfigured,
  updatePolarSeats,
  validatePolarProduct,
  verifyPolarWebhook,
} from '../lib/polar'
import { expectRefusal } from './helpers.setup'

declare class TextEncoder {
  encode(input: string): Uint8Array
}

const subscriptionId = '11111111-1111-4111-8111-111111111111'
const customerId = '22222222-2222-4222-8222-222222222222'
const productId = '33333333-3333-4333-8333-333333333333'
const priceId = '44444444-4444-4444-8444-444444444444'
const meterId = '55555555-5555-4555-8555-555555555555'
const checkoutId = '66666666-6666-4666-8666-666666666666'
const organizationId = '77777777-7777-4777-8777-777777777777'
const externalCustomerId = 'org-one'
const token = 'polar_oat_hermetic_no_real_token'

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: subscriptionId,
    customer_id: customerId,
    product_id: productId,
    customer: { id: customerId, external_id: externalCustomerId },
    status: 'active',
    seats: 5,
    current_period_start: '2026-09-01T00:00:00Z',
    current_period_end: '2026-10-01T00:00:00Z',
    cancel_at_period_end: false,
    modified_at: null,
    trial_end: null,
    pending_update: null,
    ...overrides,
  }
}
function product() {
  return {
    id: productId,
    organization_id: organizationId,
    name: 'Qivo Founding',
    is_recurring: true,
    is_archived: false,
    recurring_interval: 'month',
    recurring_interval_count: 1,
    prices: [
      {
        id: priceId,
        product_id: productId,
        amount_type: 'seat_based',
        price_currency: 'usd',
        is_archived: false,
        tax_behavior: 'exclusive',
        seat_tiers: {
          minimum_seats: 5,
          maximum_seats: null,
          seat_tier_type: 'volume',
          tiers: [{ min_seats: 5, max_seats: null, price_per_seat: 100 }],
        },
      },
    ],
  }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Polar-Version': POLAR_API_VERSION },
  })
}
const transport = vi.fn()
function organization() {
  return {
    id: organizationId,
    subscription_settings: {
      allow_multiple_subscriptions: false,
      allow_customer_updates: false,
      proration_behavior: 'next_period',
    },
    customer_portal_settings: {
      subscription: { update_seats: false, update_plan: false, update_units: false, pause: false },
    },
  }
}
function mockProduct(value: unknown) {
  transport.mockResolvedValueOnce(json(value))
  transport.mockResolvedValueOnce(json(organization()))
}
beforeEach(() => {
  vi.stubEnv('POLAR_ACCESS_TOKEN', token)
  vi.stubEnv('POLAR_SERVER', 'sandbox')
  vi.stubGlobal('fetch', transport)
  transport.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('Polar outbound billing boundary', () => {
  it('pins version, environment and org identity; fixes checkout seats and disables incidental trial/discounts', async () => {
    const checkout = {
      id: checkoutId,
      url: 'https://sandbox.polar.sh/checkout/session',
      expires_at: '2026-09-20T13:30:00Z',
      status: 'open',
      product_id: productId,
      external_customer_id: externalCustomerId,
      seats: 7,
      min_seats: 7,
      max_seats: 7,
    }
    transport.mockResolvedValue(json(checkout))
    await expect(
      createPolarCheckout({
        externalCustomerId,
        productId,
        seats: 7,
        successUrl: 'https://qivo.test/settings/billing',
        returnUrl: 'https://qivo.test/settings/billing',
      }),
    ).resolves.toMatchObject({
      id: checkoutId,
      url: 'https://sandbox.polar.sh/checkout/session',
      expiresAt: Date.parse(checkout.expires_at),
      status: 'open',
    })
    const [url, init] = transport.mock.calls[0]
    expect(url).toBe('https://sandbox-api.polar.sh/v1/checkouts/')
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      'Polar-Version': '2026-04',
    })
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body)).toEqual({
      external_customer_id: externalCustomerId,
      products: [productId],
      seats: 7,
      min_seats: 7,
      max_seats: 7,
      success_url: 'https://qivo.test/settings/billing',
      return_url: 'https://qivo.test/settings/billing',
      allow_trial: false,
      allow_discount_codes: false,
    })
  })

  it('reads provider checkout status and refuses editable seat bounds', async () => {
    const checkout = {
      id: checkoutId,
      url: 'https://sandbox.polar.sh/checkout/session',
      expires_at: '2026-09-20T13:30:00Z',
      status: 'succeeded',
      product_id: productId,
      external_customer_id: externalCustomerId,
      seats: 7,
      min_seats: 7,
      max_seats: 7,
    }
    transport.mockResolvedValueOnce(json(checkout))
    await expect(getPolarCheckout(checkoutId)).resolves.toMatchObject({
      status: 'succeeded',
      seats: 7,
    })
    transport.mockResolvedValueOnce(json({ ...checkout, min_seats: 1 }))
    await expect(getPolarCheckout(checkoutId)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('requires explicit environment and token without contacting a live service', async () => {
    vi.stubEnv('POLAR_SERVER', '')
    expect(polarConfigured()).toBe(false)
    await expectRefusal(getPolarProduct(productId), 'rule', /not configured/)
    vi.stubEnv('POLAR_SERVER', 'production')
    vi.stubEnv('POLAR_ACCESS_TOKEN', '')
    await expectRefusal(getPolarProduct(productId), 'rule', /not configured/)
    expect(transport).not.toHaveBeenCalled()
  })

  it('keeps provider bodies/secrets out of errors and rejects foreign redirect destinations', async () => {
    transport.mockResolvedValueOnce(json({ detail: `secret ${token}` }, 401))
    await expect(getPolarProduct(productId)).rejects.toMatchObject({
      code: 'unavailable',
      status: 401,
      message: 'Polar billing is temporarily unavailable.',
    })
    transport.mockResolvedValueOnce(
      json({ customer_portal_url: 'https://polar.sh.attacker.test/steal' }),
    )
    await expect(
      createPolarPortal({ externalCustomerId, returnUrl: 'https://qivo.test' }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('bounds response bodies and aborts stalled transport without automatic payment retries', async () => {
    transport.mockResolvedValueOnce(
      new Response('{}', { headers: { 'Content-Length': '1048577' } }),
    )
    await expect(getPolarProduct(productId)).rejects.toMatchObject({ code: 'invalid_response' })
    vi.useFakeTimers()
    transport.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const call = getPolarProduct(productId)
    const assertion = expect(call).rejects.toMatchObject({ code: 'unavailable' })
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('schedules quantity at renewal and retains provider pending quantity distinctly', async () => {
    transport.mockResolvedValue(
      json(
        subscription({
          pending_update: {
            seats: 9,
            product_id: null,
            applies_at: '2026-10-01T00:00:00Z',
          },
        }),
      ),
    )
    const result = await updatePolarSeats(subscriptionId, 9)
    expect(result.seats).toBe(5)
    expect(result.pendingSeats).toBe(9)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      seats: 9,
      proration_behavior: 'next_period',
    })
    expect(result).not.toHaveProperty('modifiedAt')
    expect(result).not.toHaveProperty('trialEnd')
  })

  it('lists all pages for the exact external customer and rejects cross-org results', async () => {
    transport.mockResolvedValueOnce(json({ items: [subscription()], pagination: { max_page: 2 } }))
    transport.mockResolvedValueOnce(json({ items: [], pagination: { max_page: 2 } }))
    expect(await listPolarSubscriptions(externalCustomerId)).toHaveLength(1)
    expect(transport.mock.calls.map((call) => call[0])).toEqual([
      'https://sandbox-api.polar.sh/v1/subscriptions/?external_customer_id=org-one&limit=100&page=1',
      'https://sandbox-api.polar.sh/v1/subscriptions/?external_customer_id=org-one&limit=100&page=2',
    ])
    transport.mockResolvedValueOnce(
      json({
        items: [subscription({ customer: { id: customerId, external_id: 'other-org' } })],
        pagination: { max_page: 1 },
      }),
    )
    await expect(listPolarSubscriptions(externalCustomerId)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('refuses malformed and newly unknown entitlement states', () => {
    for (const value of [
      subscription({ status: 'some_future_status' }),
      subscription({ seats: -1 }),
      subscription({ current_period_end: 'yesterday' }),
      subscription({ current_period_end: '2026-08-01T00:00:00Z' }),
      subscription({ customer: { id: productId, external_id: externalCustomerId } }),
    ]) {
      expect(() => parsePolarSubscription(value)).toThrow()
    }
  })

  it('checks the entire price composition before an immutable plan is activated', async () => {
    const expected = { unitAmount: 100, currency: 'usd', minimumSeats: 5 }
    mockProduct(product())
    await expect(validatePolarProduct(productId, expected)).resolves.toMatchObject({
      id: productId,
    })
    const extra = product()
    extra.prices.push({ ...extra.prices[0], id: checkoutId })
    mockProduct(extra)
    await expect(validatePolarProduct(productId, expected)).rejects.toMatchObject({
      code: 'invalid_product',
    })
    mockProduct({ ...product(), is_archived: true })
    await expect(validatePolarProduct(productId, expected)).rejects.toMatchObject({
      code: 'invalid_product',
    })
    mockProduct({ ...product(), is_archived: true })
    await expect(
      validatePolarProduct(productId, { ...expected, allowArchived: true }),
    ).resolves.toMatchObject({ isArchived: true })
    const tax = product()
    tax.prices[0].tax_behavior = 'inclusive'
    mockProduct(tax)
    await expect(validatePolarProduct(productId, expected)).rejects.toMatchObject({
      code: 'invalid_product',
    })
    mockProduct(product())
    await expect(
      validatePolarProduct(productId, { ...expected, unitAmount: 200 }),
    ).rejects.toMatchObject({ code: 'invalid_product' })
    mockProduct({ ...product(), trial_interval: 'month', trial_interval_count: 6 })
    await expect(validatePolarProduct(productId, expected)).rejects.toMatchObject({
      code: 'invalid_product',
    })
  })

  it('validates configured metered prices without rounding decimal cents', async () => {
    const raw = product()
    const meterPrice = {
      id: checkoutId,
      product_id: productId,
      amount_type: 'metered_unit',
      price_currency: 'usd',
      is_archived: false,
      tax_behavior: 'exclusive',
      meter_id: meterId,
      unit_amount: '100.00',
      cap_amount: null,
      meter: { id: meterId, name: 'API blocks', unit: 'scalar' },
    }
    const configuredProduct = { ...raw, prices: [...raw.prices, meterPrice] }
    const configuredMeter = {
      id: meterId,
      archived_at: null,
      aggregation: { func: 'sum', property: 'units' },
      filter: {
        conjunction: 'and',
        clauses: [{ property: 'name', operator: 'eq', value: 'qivo_api_overage' }],
      },
    }
    mockProduct(configuredProduct)
    transport.mockResolvedValueOnce(json(configuredMeter))
    const expected = {
      unitAmount: 100,
      currency: 'usd',
      minimumSeats: 5,
      meters: [{ id: meterId, unitAmount: 100, eventName: 'qivo_api_overage' }],
    }
    await expect(validatePolarProduct(productId, expected)).resolves.toMatchObject({
      id: productId,
    })
    expect(transport.mock.calls[2][0]).toBe(`https://sandbox-api.polar.sh/v1/meters/${meterId}`)
    for (const wrongMeter of [
      { ...configuredMeter, aggregation: { func: 'count' } },
      { ...configuredMeter, aggregation: { func: 'sum', property: 'metadata.units' } },
      {
        ...configuredMeter,
        filter: {
          conjunction: 'or',
          clauses: [
            ...configuredMeter.filter.clauses,
            { property: 'name', operator: 'eq', value: 'another_product' },
          ],
        },
      },
      {
        ...configuredMeter,
        filter: {
          conjunction: 'and',
          clauses: [{ property: 'name', operator: 'eq', value: 'qivo_storage_overage' }],
        },
      },
    ]) {
      mockProduct(configuredProduct)
      transport.mockResolvedValueOnce(json(wrongMeter))
      await expect(validatePolarProduct(productId, expected)).rejects.toMatchObject({
        code: 'invalid_product',
      })
    }
  })

  it('refuses seller settings that permit a second subscription or customer-managed pricing', async () => {
    for (const key of ['update_seats', 'update_plan', 'update_units', 'pause'] as const) {
      const settings = organization()
      settings.customer_portal_settings.subscription[key] = true
      transport.mockResolvedValueOnce(json(product()))
      transport.mockResolvedValueOnce(json(settings))
      await expect(
        validatePolarProduct(productId, { unitAmount: 100, currency: 'usd', minimumSeats: 5 }),
      ).rejects.toMatchObject({ code: 'invalid_configuration' })
    }
    const settings = organization()
    settings.subscription_settings.allow_multiple_subscriptions = true
    transport.mockResolvedValueOnce(json(product()))
    transport.mockResolvedValueOnce(json(settings))
    await expect(
      validatePolarProduct(productId, { unitAmount: 100, currency: 'usd', minimumSeats: 5 }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' })
  })

  it('sends retry-stable external event IDs and refuses incomplete ingestion acknowledgements', async () => {
    const events = [
      {
        name: 'qivo_api_blocks',
        externalCustomerId,
        timestamp: Date.parse('2026-09-20T00:00:00Z'),
        metadata: { units: 2 },
        idempotencyKey: 'org-one:2026-09:api:2',
      },
    ]
    transport.mockResolvedValueOnce(json({ inserted: 0, duplicates: 1 }))
    await expect(ingestPolarEvents(events)).resolves.toEqual({ inserted: 0, duplicates: 1 })
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      events: [
        {
          name: 'qivo_api_blocks',
          external_customer_id: externalCustomerId,
          timestamp: '2026-09-20T00:00:00.000Z',
          metadata: { units: 2 },
          external_id: 'org-one:2026-09:api:2',
        },
      ],
    })
    transport.mockResolvedValueOnce(json({ inserted: 0, duplicates: 0 }))
    await expect(ingestPolarEvents(events)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('Polar webhook authentication', () => {
  // Independently minted with Python hmac/sha256, not the verifier under test.
  const secret = 'whsec_cWl2by1wb2xhci1oZXJtZXRpYy1zaWduaW5nLWtleS0zMg=='
  const body = '{"type":"subscription.updated","api_version":"2026-04","data":{"name":"Nørthstar"}}'
  const now = 1789905600000
  const standardSignature = 'RpGVXzzTogNejDJbj58klZnhEDQlZNnkVYynDR+Bk1g='
  const legacySignature = 'O7wgTQpy7l17vVvMWDUYVwX8S5J4QEsV5mzoMzppiyM='
  const bytes = new TextEncoder().encode(body)
  function headers(signature = standardSignature) {
    return new Headers({
      'webhook-id': 'evt_qivo',
      'webhook-timestamp': '1789905600',
      'webhook-signature': `v1,${signature}`,
      'webhook-api-version': '2026-04',
    })
  }

  it('accepts exact raw UTF-8 bytes with current and pre-September-8 signing keys', async () => {
    for (const signature of [standardSignature, legacySignature]) {
      await expect(verifyPolarWebhook(bytes, headers(signature), { secret, now })).resolves.toEqual(
        {
          id: 'evt_qivo',
          timestamp: now,
          type: 'subscription.updated',
          data: { name: 'Nørthstar' },
        },
      )
    }
  })

  it('rejects body/header tampering, old/future deliveries, and incompatible payload versions', async () => {
    const changedId = headers()
    changedId.set('webhook-id', 'evt_other')
    const changedVersion = headers()
    changedVersion.set('webhook-api-version', '2026-10')
    const wrongScheme = headers()
    wrongScheme.set('webhook-signature', `v2,${standardSignature}`)
    for (const [raw, requestHeaders, time] of [
      [new TextEncoder().encode(`${body} `), headers(), now],
      [bytes, changedId, now],
      [bytes, changedVersion, now],
      [bytes, wrongScheme, now],
      [bytes, headers(), now + 301_000],
      [bytes, headers(), now - 301_000],
    ] as const) {
      await expect(
        verifyPolarWebhook(raw, requestHeaders, { secret, now: time }),
      ).rejects.toMatchObject({ code: 'invalid_webhook' })
    }
  })

  it('supports Standard Webhooks key rotation signatures without accepting malformed signatures', async () => {
    const rotated = headers()
    rotated.set('webhook-signature', `v1,not-base64 v1,${standardSignature}`)
    await expect(verifyPolarWebhook(bytes, rotated, { secret, now })).resolves.toMatchObject({
      id: 'evt_qivo',
    })
    rotated.set('webhook-signature', 'v1,not-base64')
    await expect(verifyPolarWebhook(bytes, rotated, { secret, now })).rejects.toMatchObject({
      code: 'invalid_webhook',
    })
  })
})

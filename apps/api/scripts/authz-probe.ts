/**
 * What an ordinary customer can reach that is not theirs.
 *
 * `qa-drive` asks whether the happy path works. This asks the opposite question
 * about the same running system: given one signed-in customer with no grants,
 * which boundary can they cross? Every check names a lower-trust principal, an
 * action, the control that is supposed to stop it, and the thing that would be
 * lost — because a check that cannot name what is lost is a style preference,
 * not a security test.
 *
 * Two customers are created per run, so "somebody else's" means a real second
 * account rather than a guessed identifier. Nothing here probes a deployed
 * host: it refuses any base that is not loopback.
 *
 *     SMS_LOG=/tmp/alo-noon-sms.log \
 *       pnpm --filter @alo-noon/api exec tsx scripts/authz-probe.ts
 */
import { readFileSync } from 'node:fs'

const BASE = process.env['QA_API_BASE'] ?? 'http://127.0.0.1:3001'
const SMS_LOG = process.env['SMS_LOG'] ?? '/tmp/alo-noon-sms.log'

let failures = 0

function assertLoopback(): void {
  const host = new URL(BASE).hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to probe a non-loopback host: ${host}`)
  }
}

/** A refusal is the pass. The evidence is the status and the body's code. */
function refused(label: string, response: Probe, allowed: readonly number[]): void {
  const ok = allowed.includes(response.status)
  if (!ok) failures += 1
  process.stdout.write(
    `[${ok ? 'PASS' : 'FAIL'}] ${label} :: ${JSON.stringify({
      status: response.status,
      code: at(response.body, 'error', 'code') ?? null,
    })}\n`,
  )
}

interface Probe {
  status: number
  body: unknown
  cookie: string | null
}

function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string | number, unknown>)[key]
  }
  return current
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function call(
  method: string,
  path: string,
  options: { cookie?: string | undefined; body?: unknown; idempotencyKey?: string } = {},
): Promise<Probe> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: 'manual',
  })
  const raw = await response.text()
  let body: unknown = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = raw
  }
  return { status: response.status, body, cookie: response.headers.get('set-cookie') }
}

function smsLines(): readonly string[] {
  try {
    return readFileSync(SMS_LOG, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function signIn(mobileE164: string): Promise<string> {
  const before = smsLines().length
  const requested = await call('POST', '/api/v1/auth/otp/request', {
    body: { mobileE164 },
    idempotencyKey: `probe-otp-${mobileE164.replace(/[^0-9]/g, '')}-${Date.now()}`,
  })
  const challengeId = text(at(requested.body, 'data', 'challengeId'))
  const after = smsLines()
  const code = after.length > before ? /(\d{6})/.exec(after.at(-1) ?? '')?.[1] : undefined
  if (!code || !challengeId) throw new Error(`no code for ${mobileE164}`)
  const verified = await call('POST', '/api/v1/auth/otp/verify', { body: { challengeId, code } })
  const cookie = verified.cookie?.split(';')[0]
  if (!cookie) throw new Error(`no session for ${mobileE164}`)
  return cookie
}

/**
 * Gives the victim something real to steal. Returns null rather than throwing:
 * a probe whose *setup* fails should say so and carry on with the checks that
 * do not depend on it, not abort and look like a pass.
 */
async function placeOrder(
  cookie: string,
  addressId: string,
  cityId: string,
  suffix: string,
): Promise<string | null> {
  const zones = await call('POST', '/api/v1/serviceability/check', {
    body: { cityId, latitude: 36.5387, longitude: 52.6765 },
  })
  const operationalZoneId = text(at(zones.body, 'data', 'operationalZoneId'))
  const shelf = await call(
    'GET',
    `/api/v1/catalog/products?cityId=${cityId}&operationalZoneId=${String(operationalZoneId)}&page=1&pageSize=20`,
  )
  const offeringId = text(at(shelf.body, 'data', 0, 'offeringId'))
  if (!offeringId || !operationalZoneId) {
    process.stdout.write(
      `[SETUP] no order placed (offering=${String(offeringId)}, zone=${String(operationalZoneId)})\n`,
    )
    return null
  }
  const cart = await call('PUT', `/api/v1/cart/items/${offeringId}`, {
    cookie,
    body: { cityId, operationalZoneId, quantity: 1 },
    idempotencyKey: `probe-cart-${suffix}`,
  })
  const quote = await call('POST', '/api/v1/cart/quote', {
    cookie,
    body: {
      deliveryAddressId: addressId,
      expectedCartVersion: at(cart.body, 'data', 'version'),
      idempotencyKey: `probe-quote-${suffix}`,
    },
  })
  const quoteId = text(at(quote.body, 'data', 'id'))
  if (!quoteId) {
    process.stdout.write(`[SETUP] no quote: ${JSON.stringify(at(quote.body, 'error'))}\n`)
    return null
  }
  const placed = await call('POST', '/api/v1/orders', {
    cookie,
    body: { quoteId, idempotencyKey: `probe-order-${suffix}` },
  })
  return text(at(placed.body, 'data', 'id'))
}

async function main(): Promise<void> {
  assertLoopback()
  process.stdout.write(`=== Authorization probe against ${BASE} ===\n\n`)

  const suffix = String(Date.now()).slice(-6)
  const victim = await signIn(`+989121${suffix}`)
  const attacker = await signIn(`+989122${suffix}`)

  // The victim leaves something worth taking: a saved address, and an order.
  const cities = await call('GET', '/api/v1/serviceability/cities')
  const cityId = text(at(cities.body, 'data', 0, 'id'))
  if (!cityId) throw new Error('no serviceable city')

  const address = await call('POST', '/api/v1/addresses', {
    cookie: victim,
    body: {
      cityId,
      label: 'خانه',
      recipientName: 'قربانی',
      recipientPhone: `+989121${suffix}`,
      addressLine: 'بابل، خیابان مدرس، کوچهٔ نان، پلاک ۱۲',
      latitude: 36.5387,
      longitude: 52.6765,
      deliveryInstructions: 'طبقهٔ دوم، زنگ نزنید',
      idempotencyKey: `probe-address-${suffix}`,
    },
  })
  const addressId = text(at(address.body, 'data', 'id'))
  if (!addressId) {
    throw new Error(`victim address not created: ${JSON.stringify(address.body)}`)
  }

  process.stdout.write('--- Another customer’s things ---\n')
  // A saved address is a home address with a note about a sleeping child in it.
  // Reading one belonging to somebody else is a physical-safety leak, not a
  // privacy nicety.
  const theirList = await call('GET', '/api/v1/addresses', { cookie: attacker })
  const leaked = JSON.stringify(theirList.body).includes(addressId)
  if (leaked) failures += 1
  process.stdout.write(
    `[${leaked ? 'FAIL' : 'PASS'}] another customer’s address is not in this customer’s list :: ${JSON.stringify(
      { status: theirList.status, leaked },
    )}\n`,
  )
  // There is no update or delete route for an address, so checking that one is
  // refused would be checking nothing. What does exist, and is worth far more,
  // is reading somebody's order by its identifier: it carries their name, their
  // phone, their door, and the note they wrote about how to find it.
  const victimOrder = await placeOrder(victim, addressId, cityId, suffix)
  if (victimOrder) {
    const stolen = await call('GET', `/api/v1/orders/${victimOrder}`, { cookie: attacker })
    refused('a customer cannot read another customer’s order by its id', stolen, [401, 403, 404])
    refused(
      'a customer cannot rate another customer’s order',
      await call('POST', `/api/v1/orders/${victimOrder}/rating`, {
        cookie: attacker,
        // `breadScore`, the real field. Sending `score` got a 400 that read as
        // a refusal and was only the schema rejecting an unknown key — the
        // failure mode this whole probe is written to avoid.
        body: { breadScore: 1, comment: 'نان بد بود' },
      }),
      [401, 403, 404, 409, 422],
    )
    refused(
      'a customer cannot reorder from another customer’s order',
      await call('POST', `/api/v1/orders/${victimOrder}/reorder`, {
        cookie: attacker,
        body: { idempotencyKey: `probe-reorder-${suffix}` },
      }),
      [400, 401, 403, 404],
    )
    refused(
      'a customer cannot cancel another customer’s order through the operator route',
      await call('POST', `/api/v1/admin/orders/${victimOrder}/cancel`, {
        cookie: attacker,
        body: { reason: 'لغو' },
      }),
      [401, 403],
    )
  }

  process.stdout.write('\n--- The operator panel ---\n')
  // No grant was ever issued to these accounts. Each of these routes moves money
  // or changes what the shop sells.
  // Every path here is one the server really registers — checked against the
  // route table, because a 404 for a misspelled path proves nothing about
  // authorization and is the easiest way to write a probe that always passes.
  for (const [label, path] of [
    ['list every order', '/api/v1/admin/orders'],
    ['read what the shop owes its partners', '/api/v1/admin/settlement/outstanding'],
    ['see the courier roster', '/api/v1/admin/couriers'],
    ['read payment gateway configuration', '/api/v1/admin/payment-providers/configurations'],
    ['read delivery tariffs', '/api/v1/admin/delivery/tariffs'],
    ['read the staff list', '/api/v1/admin/access/staff'],
    ['read which roles exist', '/api/v1/admin/access/roles'],
    ['read the financial report', '/api/v1/admin/reports/financial'],
    ['read pending withdrawals', '/api/v1/admin/withdrawals'],
    ['read the delivery board', '/api/v1/admin/deliveries'],
    ['read the catalogue behind the shelf', '/api/v1/admin/catalog/offerings'],
  ] as const) {
    refused(`a customer cannot ${label}`, await call('GET', path, { cookie: attacker }), [401, 403])
  }
  // The two writes that hand somebody else the keys.
  refused(
    'a customer cannot grant themselves a role',
    await call('POST', '/api/v1/admin/access/grants', {
      cookie: attacker,
      body: { mobileE164: `+989122${suffix}`, role: 'OWNER', reason: 'probe' },
    }),
    [401, 403],
  )
  refused(
    'a customer cannot register a payment gateway credential',
    await call('POST', '/api/v1/admin/payment-providers/credentials', {
      cookie: attacker,
      body: {
        providerCode: 'ZARINPAL',
        reference: 'local-encrypted://PROBE',
        keyVersion: 'v1',
        idempotencyKey: `probe-credential-${suffix}`,
      },
    }),
    [401, 403],
  )

  process.stdout.write('\n--- The bakery and courier surfaces ---\n')
  for (const [label, path] of [
    ['read a bakery’s order queue', '/api/v1/branch/orders'],
    ['read a bakery’s earnings', '/api/v1/branch/earnings'],
    ['read a courier’s delivery list', '/api/v1/courier/deliveries'],
  ] as const) {
    refused(`a customer cannot ${label}`, await call('GET', path, { cookie: attacker }), [401, 403])
  }

  process.stdout.write('\n--- Money ---\n')
  const wallet = await call('GET', '/api/v1/wallet', { cookie: attacker })
  const balance = at(wallet.body, 'data', 'balance', 'amount')
  // Stated, because every check below is "can somebody with nothing take
  // something", and it is only that question if the balance really is nothing.
  if (balance !== '0') failures += 1
  process.stdout.write(
    `[${balance === '0' ? 'PASS' : 'FAIL'}] the probing account really has nothing :: ${JSON.stringify({ balance })}\n`,
  )
  // The field really is `amount`, and the schema is `.strict()`. An earlier
  // version of this probe sent `amountRial`, got a 400, and recorded it as the
  // business rule holding — when all that had happened was an unknown key being
  // rejected. Every body below is the shape the route actually accepts, so what
  // refuses it is the rule and not the parser.
  refused(
    'a customer cannot transfer above the per-transfer ceiling',
    await call('POST', '/api/v1/wallet/transfers', {
      cookie: attacker,
      body: {
        recipientMobile: `+989121${suffix}`,
        amount: '100000000',
        idempotencyKey: `probe-over-transfer-${suffix}`,
      },
    }),
    [400, 402, 409, 422],
  )
  // Deliberately under the ceiling, because the check above proves only that a
  // ceiling exists. This is the question that matters: from a balance of zero,
  // is an empty-handed transfer turned away *before* an SMS is sent? If the
  // transfer opens and the code goes out, anyone with an account can make this
  // shop send SMS at its own cost, one message per request.
  const before = smsLines().length
  refused(
    'an empty wallet cannot open a transfer at all',
    await call('POST', '/api/v1/wallet/transfers', {
      cookie: attacker,
      body: {
        recipientMobile: `+989121${suffix}`,
        amount: '50000',
        idempotencyKey: `probe-broke-transfer-${suffix}`,
      },
    }),
    [400, 402, 409, 422],
  )
  const sentAnyway = smsLines().length > before
  if (sentAnyway) failures += 1
  process.stdout.write(
    `[${sentAnyway ? 'FAIL' : 'PASS'}] a refused transfer does not spend the shop’s SMS credit :: ${JSON.stringify(
      { messagesSent: smsLines().length - before },
    )}\n`,
  )
  // Zero and negative are refused by the contract's own pattern rather than by
  // a later check, which is the right place for it — but only if it is true.
  for (const [label, amount] of [
    ['a negative amount', '-500000'],
    ['zero', '0'],
  ] as const) {
    refused(
      `a customer cannot transfer ${label}`,
      await call('POST', '/api/v1/wallet/transfers', {
        cookie: attacker,
        body: {
          recipientMobile: `+989121${suffix}`,
          amount,
          idempotencyKey: `probe-bad-amount-${amount}-${suffix}`,
        },
      }),
      [400, 422],
    )
  }

  // A top-up is allowed to be *requested* — it opens a gateway payment. What
  // must not happen is the balance moving because somebody asked.
  await call('POST', '/api/v1/wallet/top-ups', {
    cookie: attacker,
    body: { amount: '5000000', idempotencyKey: `probe-topup-${suffix}` },
  })
  const afterTopUp = await call('GET', '/api/v1/wallet', { cookie: attacker })
  const stillNothing = at(afterTopUp.body, 'data', 'balance', 'amount') === '0'
  if (!stillNothing) failures += 1
  process.stdout.write(
    `[${stillNothing ? 'PASS' : 'FAIL'}] asking for a top-up does not credit the wallet :: ${JSON.stringify(
      { balance: at(afterTopUp.body, 'data', 'balance', 'amount') },
    )}\n`,
  )

  // A withdrawal from an empty wallet is the same question from the other side:
  // it is how a shop is drained by somebody who never paid in.
  refused(
    'a customer cannot withdraw from an empty wallet',
    await call('POST', '/api/v1/wallet/withdrawals', {
      cookie: attacker,
      body: {
        amount: '1000000',
        iban: 'IR062960000000100324200001',
        accountHolder: 'حساب آزمایشی',
        idempotencyKey: `probe-withdraw-${suffix}`,
      },
    }),
    [400, 402, 409, 422],
  )

  process.stdout.write('\n--- Without any session at all ---\n')
  for (const [label, path] of [
    ['the order list', '/api/v1/orders'],
    ['a wallet', '/api/v1/wallet'],
    ['saved addresses', '/api/v1/addresses'],
    ['the operator panel', '/api/v1/admin/orders'],
  ] as const) {
    refused(`an anonymous request cannot read ${label}`, await call('GET', path), [401, 403, 404])
  }

  process.stdout.write(
    failures === 0 ? '\nNO BOUNDARY CROSSED\n' : `\n${failures} BOUNDARY CHECK(S) NEED ATTENTION\n`,
  )
  if (failures > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  process.stdout.write(`\nPROBE ABORTED: ${String(error)}\n`)
  process.exitCode = 1
})

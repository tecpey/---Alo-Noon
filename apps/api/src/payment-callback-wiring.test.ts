import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The composition root, read rather than built, because that is where the hole
 * was.
 *
 * `buildApp` is covered thoroughly: `payment-callback.test.ts` hands it a
 * `paymentCallback` dependency and checks the route from every angle. `server.ts`
 * is what decides whether that dependency is ever passed, and nothing exercised
 * it — so a launch tenant could have `PAYMENT_CALLBACK_BASE_URL` set, register
 * every gateway adapter, hand Zarinpal a callback address, take a customer's
 * money, and return them to a 404. No receipt recorded, nothing for the sweep to
 * settle, an order left PENDING_CONFIRMATION with the card already debited.
 *
 * That is what an end-to-end drive against a sandbox gateway found, and the
 * reason it was invisible is that the two variables are independent: one makes
 * the address, the other makes the route at it.
 *
 * Reading the file is the honest way to check this. Importing `server.ts` starts
 * a server, opens a database and binds a port; the property here is a wiring
 * decision made at module scope, and it is legible in the source.
 */
const SERVER = readFileSync(join(import.meta.dirname, 'server.ts'), 'utf8')

describe('online payment is wired all the way through, or not at all', () => {
  it('registers no gateway adapter unless the callback route will exist', () => {
    // Both names, in one condition. If somebody later gates the adapters on
    // `PAYMENT_CALLBACK_BASE_URL` alone again, this is what says so.
    const gate = SERVER.match(
      /const paymentCallbackBase\s*=\s*([\s\S]{0,240}?)\n\s*(?:const|\/\/)/,
    )?.[1]
    expect(gate, 'paymentCallbackBase must exist and gate adapter registration').toBeDefined()
    expect(gate).toContain('PAYMENT_CALLBACK_BASE_URL')
    expect(gate).toContain('PAYMENT_RESULT_REDIRECT_URL')
  })

  it('builds every adapter’s callback URL from that same gate', () => {
    // Not from the raw variable. `callbackUrlFor` is what each adapter is given,
    // so a gate that the URL builder ignores is not a gate.
    const builder = SERVER.match(/const callbackUrlFor[\s\S]{0,320}?\n\s*: undefined/)?.[0]
    expect(builder).toBeDefined()
    expect(builder).toContain('paymentCallbackBase')
    expect(builder).not.toContain('env.PAYMENT_CALLBACK_BASE_URL')
  })

  it('says so in the log when only half the pair is configured', () => {
    // The safe behaviour is also the silent one: the shop runs and every attempt
    // to pay answers 503, which reads as a gateway outage rather than a missing
    // line in the environment.
    expect(SERVER).toMatch(/Boolean\(env\.PAYMENT_CALLBACK_BASE_URL\)\s*!==/)
    expect(SERVER).toContain('must both be set')
  })
})

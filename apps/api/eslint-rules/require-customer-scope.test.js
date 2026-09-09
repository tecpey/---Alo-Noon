import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import plugin from './require-customer-scope.js'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('require-customer-scope', plugin.rules['require-customer-scope'], {
  valid: [
    {
      code: `async function f(t) {
        return t.order.findFirst({ where: { id, tenantId, customerId } })
      }`,
    },
    {
      code: `async function f(t) {
        return t.address.findMany({ where: { tenantId, customerId, archivedAt: null } })
      }`,
    },
    {
      // Explicitly documented as safe.
      code: `async function f(t) {
        // ownership-established: caller resolved this id under a customerId filter.
        return t.cart.findUnique({ where: { id: cartId } })
      }`,
    },
    {
      // Not a customer-owned model.
      code: `async function f(t) {
        return t.bakeryProductOffering.findFirst({ where: { id, tenantId } })
      }`,
    },
    {
      // No where clause to scope (e.g. a create).
      code: `async function f(t) {
        return t.order.findMany({ include: { items: true } })
      }`,
    },
  ],
  invalid: [
    {
      // The classic IDOR: an id straight from the request, tenant-scoped only.
      code: `async function f(t, request) {
        return t.order.findUnique({ where: { id: request.params.id, tenantId } })
      }`,
      errors: [{ messageId: 'missing' }],
    },
    {
      code: `async function f(t) {
        return t.payment.findFirst({ where: { id: paymentId, tenantId } })
      }`,
      errors: [{ messageId: 'missing' }],
    },
    {
      code: `async function f(t) {
        return t.quote.updateMany({ where: { cartId }, data: { status: 'SUPERSEDED' } })
      }`,
      errors: [{ messageId: 'missing' }],
    },
    {
      // An unrelated comment must not act as an escape hatch.
      code: `async function f(t) {
        // load the order
        return t.order.findUnique({ where: { id: orderId } })
      }`,
      errors: [{ messageId: 'missing' }],
    },
  ],
})

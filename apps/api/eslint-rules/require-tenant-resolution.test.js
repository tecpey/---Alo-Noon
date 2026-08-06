import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import plugin from './require-tenant-resolution.js'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('require-tenant-resolution', plugin.rules['require-tenant-resolution'], {
  valid: [
    {
      code: `
        function register(app) {
          app.get('/x', async (request, reply) => {
            const tenantId = await resolveTenantId(request, deps)
          })
        }
      `,
    },
    {
      code: `
        function register(app) {
          app.post('/x', async (request, reply) => {
            const customer = await authenticatedCustomer(request, deps)
          })
        }
      `,
    },
    {
      code: `
        function register(app) {
          app.get('/x', async (request, reply) => {
            const session = await authenticateRequest(request, deps)
          })
        }
      `,
    },
    {
      code: `
        function register(app) {
          app.post(
            '/x',
            { config: { rateLimit: {} } },
            async (request, reply) => {
              await resolveTenantId(request, deps)
            },
          )
        }
      `,
    },
    {
      // Not a route call on the Fastify \`app\` instance — out of scope for this rule.
      code: `
        function register(other) {
          other.get('/x', async (request, reply) => {
            return reply.send({ ok: true })
          })
        }
      `,
    },
  ],
  invalid: [
    {
      code: `
        function register(app) {
          app.get('/x', async (request, reply) => {
            return reply.send({ ok: true })
          })
        }
      `,
      errors: [{ messageId: 'missing' }],
    },
    {
      code: `
        function register(app) {
          app.post(
            '/x',
            { config: { rateLimit: {} } },
            async (request, reply) => {
              return reply.send({ ok: true })
            },
          )
        }
      `,
      errors: [{ messageId: 'missing' }],
    },
  ],
})

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch'])
const REQUIRED_CALL_PATTERN = /\b(?:resolveTenantId|authenticatedCustomer|authenticateRequest)\s*\(/

/**
 * Every route registered on the Fastify `app` instance in apps/api/src/modules
 * must derive tenant identity from resolveTenantId (host-based),
 * authenticateRequest (session-based, any account type), or
 * authenticatedCustomer (session-based, customer-only) inside its own handler
 * body — tenant enforcement here is by convention, not a shared runtime hook,
 * so a route that forgets this call has no other guard before it touches
 * tenant-owned data. This is a plain source-text check on the handler body
 * rather than a full call-graph analysis, matching how every existing route
 * already calls one of these functions directly rather than through an
 * intermediate wrapper.
 */
const requireTenantResolution = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every Fastify route handler to call resolveTenantId or authenticatedCustomer',
    },
    schema: [],
    messages: {
      missing:
        'This app.{{method}}(...) handler does not call resolveTenantId(...), authenticateRequest(...), or authenticatedCustomer(...). Every tenant-owned route must derive tenant identity from host/session here, never from client input.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'app' ||
          callee.property.type !== 'Identifier' ||
          !ROUTE_METHODS.has(callee.property.name)
        ) {
          return
        }
        const handler = node.arguments[node.arguments.length - 1]
        if (
          !handler ||
          (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression')
        ) {
          return
        }
        const sourceCode = context.sourceCode ?? context.getSourceCode()
        const handlerText = sourceCode.getText(handler)
        if (!REQUIRED_CALL_PATTERN.test(handlerText)) {
          context.report({
            node: handler,
            messageId: 'missing',
            data: { method: callee.property.name },
          })
        }
      },
    }
  },
}

export default {
  rules: {
    'require-tenant-resolution': requireTenantResolution,
  },
}

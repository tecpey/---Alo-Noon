// Models whose rows belong to one customer inside a tenant. Tenant RLS does not
// separate these — two customers of the same tenant are both inside the same
// forced-RLS policy — so customer isolation exists only where application code
// puts it.
const CUSTOMER_OWNED_MODELS = new Set(['order', 'cart', 'quote', 'address', 'payment'])
const QUERY_METHODS = new Set([
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
])
const OWNERSHIP_ESCAPE = 'ownership-established:'

/**
 * Requires every Prisma query against a customer-owned model to scope by
 * customerId.
 *
 * The API has no GET-by-id read routes yet, which is the only reason a classic
 * IDOR (`/invoice/1045` -> `/invoice/1047`) is not reachable today. Order
 * history and order detail are needed for launch, and that is exactly where the
 * hole would appear. Tenant scoping alone does not help: every customer of the
 * pilot operator shares one tenant.
 *
 * Queries whose ownership was already established upstream (internal helpers
 * handed an id that was itself looked up under a customerId filter) opt out with
 * a leading comment containing `ownership-established:` and a reason, so the
 * exemption is visible in review rather than silent.
 */
const requireCustomerScope = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require Prisma queries on customer-owned models to filter by customerId',
    },
    schema: [],
    messages: {
      missing:
        'This {{model}}.{{method}}(...) does not filter by customerId. Customer-owned rows are not separated by tenant RLS, so an id taken from the request would expose another customer\'s data. Add customerId to the where clause, or document why ownership is already established with a leading "{{escape}} <reason>" comment.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    const hasOwnershipEscape = (node) => {
      let statement = node
      while (statement.parent && !/Statement|Declaration/.test(statement.parent.type)) {
        statement = statement.parent
      }
      const target = statement.parent ?? statement
      return sourceCode
        .getCommentsBefore(target)
        .some((comment) => comment.value.includes(OWNERSHIP_ESCAPE))
    }

    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          !QUERY_METHODS.has(callee.property.name) ||
          callee.object.type !== 'MemberExpression' ||
          callee.object.property.type !== 'Identifier' ||
          !CUSTOMER_OWNED_MODELS.has(callee.object.property.name)
        ) {
          return
        }

        const argument = node.arguments[0]
        if (!argument || argument.type !== 'ObjectExpression') return
        const where = argument.properties.find(
          (property) =>
            property.type === 'Property' &&
            property.key.type === 'Identifier' &&
            property.key.name === 'where',
        )
        if (!where) return
        if (sourceCode.getText(where).includes('customerId')) return
        if (hasOwnershipEscape(node)) return

        context.report({
          node,
          messageId: 'missing',
          data: {
            model: callee.object.property.name,
            method: callee.property.name,
            escape: OWNERSHIP_ESCAPE,
          },
        })
      },
    }
  },
}

export default {
  rules: {
    'require-customer-scope': requireCustomerScope,
  },
}

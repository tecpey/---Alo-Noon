import library from '@alo-noon/eslint-config/library'

import requireCustomerScope from './eslint-rules/require-customer-scope.js'
import requireTenantResolution from './eslint-rules/require-tenant-resolution.js'

export default [
  ...library,
  { ignores: ['eslint-rules/**'] },
  {
    files: ['src/modules/*.ts'],
    ignores: ['src/modules/*.test.ts', 'src/modules/*.integration.test.ts'],
    plugins: {
      local: {
        rules: { ...requireTenantResolution.rules, ...requireCustomerScope.rules },
      },
    },
    rules: {
      'local/require-tenant-resolution': 'error',
      'local/require-customer-scope': 'error',
    },
  },
]

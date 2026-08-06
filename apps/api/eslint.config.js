import library from '@alo-noon/eslint-config/library'

import requireTenantResolution from './eslint-rules/require-tenant-resolution.js'

export default [
  ...library,
  { ignores: ['eslint-rules/**'] },
  {
    files: ['src/modules/*.ts'],
    ignores: ['src/modules/*.test.ts', 'src/modules/*.integration.test.ts'],
    plugins: { local: requireTenantResolution },
    rules: {
      'local/require-tenant-resolution': 'error',
    },
  },
]

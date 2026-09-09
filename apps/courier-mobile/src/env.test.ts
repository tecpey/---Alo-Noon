import { describe, expect, it } from 'vitest'

import app from '../App.tsx?raw'

/**
 * A source-level test, which is unusual, for a bug that is invisible every
 * other way.
 *
 * Expo replaces `process.env.EXPO_PUBLIC_*` with a literal at bundle time, and
 * only where it is written as a property access. Written with brackets the
 * substitution silently does not happen: the lookup ships intact, resolves to
 * undefined on the device, and the app tells every user it has not been
 * configured no matter what the build set. It passes typecheck, it passes lint,
 * it works in development where a dev server injects the value, and it fails
 * only in the built app — which is where it was found, after being shipped.
 *
 * So the guard is on the source text, because the failure is in the source text.
 */
describe('the public API base URL', () => {
  it('is read as a property, so Expo inlines it into the bundle', () => {
    expect(app).toContain('process.env.EXPO_PUBLIC_API_BASE_URL')
  })

  it('is never read with brackets', () => {
    expect(app).not.toMatch(/process\.env\[/)
  })
})

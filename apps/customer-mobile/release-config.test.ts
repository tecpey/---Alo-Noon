import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The configuration a build reads, and nobody looks at until a build fails.
 *
 * None of this is exercised by running the app. A wrong package name, a missing
 * notification icon or a channel that does not match the one the code creates
 * are all invisible in development and only surface on a device, after a build
 * that takes twenty minutes and a queue.
 *
 * Deliberately at the app root rather than under `src/`. It reads files, which
 * means `node:fs`, and `src/env.d.ts` exists precisely to keep Node's types out
 * of this app: telling TypeScript that `fs` and `Buffer` are available is how
 * somebody ends up shipping code that crashes on a phone rather than failing to
 * compile. The app's tsconfig covers `App.tsx` and `src/**`, so a file here is
 * run by vitest and left out of that promise — which is the right trade for a
 * test that reads build configuration and never ships.
 */
const APP_ROOT = new URL('./', import.meta.url)
const app = JSON.parse(readFileSync(new URL('app.json', APP_ROOT), 'utf8')).expo
const eas = JSON.parse(readFileSync(new URL('eas.json', APP_ROOT), 'utf8'))
const push = readFileSync(new URL('src/push.ts', APP_ROOT), 'utf8')

describe('what a store needs before it will take the app', () => {
  it('has a package name that cannot change later', () => {
    // The one field that is permanent. Once an app is published under it, a
    // change is a different app: new listing, no reviews, no updates for
    // anybody who installed the old one.
    expect(app.android.package).toBe('ir.alonoon.customer')
    expect(app.ios.bundleIdentifier).toBe('ir.alonoon.customer')
  })

  it('is not still on a placeholder version', () => {
    // `0.0.1` is what `expo init` leaves behind, and a store listing showing it
    // says the app was published by accident.
    expect(app.version).not.toMatch(/^0\.0\./)
    expect(app.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('leaves the build number to EAS rather than to somebody remembering', () => {
    expect(eas.cli.appVersionSource).toBe('remote')
    expect(eas.build.production.autoIncrement).toBe(true)
  })

  it('builds an APK to hand round and a bundle for a store', () => {
    // Play needs an app bundle. Everywhere the APK actually gets installed —
    // by hand, or through Cafe Bazaar and Myket, which is how an Iranian
    // customer will get this — needs an APK.
    expect(eas.build.preview.android.buildType).toBe('apk')
    expect(eas.build.production.android.buildType).toBe('app-bundle')
  })

  it('does not commit a guessed production URL', () => {
    // A domain that is not decided yet, written into a build profile, is an app
    // that silently talks to nothing. It belongs in the Expo dashboard until
    // there is a real one.
    expect(eas.build.production.env?.EXPO_PUBLIC_API_BASE_URL).toBeUndefined()
    // Development is different: the emulator's address for its host is a
    // constant, not a guess.
    expect(eas.build.development.env.EXPO_PUBLIC_API_BASE_URL).toBe('http://10.0.2.2:3001')
  })
})

describe('notifications', () => {
  const plugin = (app.plugins as unknown[]).find(
    (entry): entry is [string, Record<string, unknown>] =>
      Array.isArray(entry) && entry[0] === 'expo-notifications',
  )

  it('is configured at all, or Android draws a grey square', () => {
    expect(plugin).toBeDefined()
  })

  it('points at an icon that exists', () => {
    const icon = plugin![1]!['icon'] as string
    expect(() => statSync(new URL(icon, APP_ROOT))).not.toThrow()
  })

  /**
   * Android reads only the alpha channel of a notification icon and paints
   * every opaque pixel in its own colour. A coloured icon therefore arrives as
   * a solid block — the single most common way a notification ends up looking
   * broken, and one nobody sees until a real push lands on a real phone.
   */
  it('uses a white silhouette on transparency, which is all Android will draw', () => {
    const icon = plugin![1]!['icon'] as string
    const bytes = readFileSync(new URL(icon, APP_ROOT))
    // PNG colour type lives at byte 25: 6 is truecolour with alpha, 4 is
    // greyscale with alpha. Anything else has no alpha and cannot be a
    // silhouette.
    expect([4, 6]).toContain(bytes[25])
  })

  it('names the same channel the code creates', () => {
    // `push.ts` calls `setNotificationChannelAsync('orders', …)`. If these two
    // drift, Android delivers to a channel with default settings — no sound,
    // wrong importance — and nothing anywhere reports it.
    expect(plugin![1]!['defaultChannel']).toBe('orders')
    expect(push).toContain("setNotificationChannelAsync('orders'")
  })

  it('is tinted in the brand colour, matching the icon behind it', () => {
    expect(plugin![1]!['color']).toBe(app.android.adaptiveIcon.backgroundColor)
  })
})

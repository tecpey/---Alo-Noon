import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { colors, cssVariables } from '@alo-noon/design-tokens'

import './styles.css'
import { siteUrl } from '../lib/site-url'
import { ProgressiveApp } from './components/progressive-app'
import { AppTabs } from './components/app-tabs'
import { loadServerBasket } from '../lib/storefront-data'

export const metadata: Metadata = {
  /**
   * The origin every relative metadata URL resolves against — an Open Graph
   * image, a canonical link. Without it Next.js warns at build and a shared
   * link previews with a broken image, which is the first thing anybody sees of
   * a shop they have not visited.
   */
  metadataBase: siteUrl(),
  title: 'الو نون | نان تازه، درب منزل',
  description:
    'سفارش نان تازه از نانوایی‌های محله؛ پخت‌های ویژه و نان روزمرهٔ بسته‌بندی‌شده، با تحویل در زمانی که خودتان انتخاب می‌کنید.',
  applicationName: 'الو نون',
  /**
   * iOS installs from a different set of tags than the manifest, and ignores
   * most of it. Without these, adding الو نون to a Safari home screen gives a
   * shortcut that opens in a browser chrome with the page's own title under it.
   */
  appleWebApp: {
    capable: true,
    title: 'الو نون',
    // The bar is drawn in the page's own paper rather than left translucent,
    // which on iOS means content sliding under the clock.
    statusBarStyle: 'default',
  },
}

export const viewport: Viewport = {
  themeColor: colors.paper,
  colorScheme: 'light',
  /**
   * The switch that makes every `env(safe-area-inset-*)` in the stylesheets
   * mean something.
   *
   * Safari's default is `auto`, which insets the whole page inside the safe
   * area and reports all four values as `0px`. So the header's inset, the
   * footer's clearance over the home indicator and the basket's checkout
   * button — all written against a notched iPhone, all commented as such —
   * computed to zero on exactly the device they were written for, and the
   * stylesheet looked correct while doing nothing. `cover` hands the page the
   * full screen and the real inset values, which is what that CSS expects.
   *
   * It is only safe to set because every edge-pinned surface already carries
   * its own inset; `main` gains one below for the content between them.
   */
  viewportFit: 'cover',
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  /**
   * The basket badge for pages that have no catalogue in context.
   *
   * The shop and a bread's own page carry a live basket and the bar prefers it.
   * Everywhere else — order history, the account — a customer cannot change the
   * basket from the page they are on, so what the server read is what is true.
   *
   * A refusal is a zero rather than an error: the tab bar is navigation, and a
   * missing badge is a smaller failure than no way to reach the shop.
   */
  const basket = await loadServerBasket().catch(() => null)
  const serverCount = (basket?.lines ?? []).reduce((total, [, quantity]) => total + quantity, 0)

  return (
    <html lang="fa" dir="rtl">
      <head>
        {/*
          The one font, fetched as early as the browser will allow.

          Every character on every screen of this product comes out of this
          file. Discovered the normal way it is a third-level request — HTML,
          then stylesheet, then font — and on a phone on a slow connection in
          Iran that is a shop rendered in Tahoma for the first second, then
          reflowed. `crossOrigin` is required even for a same-origin font:
          fonts are fetched in anonymous CORS mode, and a preload without it is
          a second download rather than a warm cache.
        */}
        <link
          rel="preload"
          href="/fonts/vazirmatn-variable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        {/*
          Deprecated, and still load-bearing on the one platform it names.

          `appleWebApp.capable` above no longer emits this: Next.js switched to
          the standard `mobile-web-app-capable` to silence a Chrome warning, and
          iOS does not read that name. Standalone display survives the change
          because Safari takes it from the manifest instead — but two things do
          not. iOS paints a launch image only when this tag is present, and this
          tag is also what Safari falls back to when the manifest fails to load,
          which on a slow Iranian connection is not a hypothetical.

          Written by hand because the framework will not write it.
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/*
          The palette is emitted from the token package rather than written into
          a stylesheet, so the web and the two mobile apps cannot drift apart:
          all three read the same constants, and this is the only bridge. The
          string is built from those constants; no input reaches it.
        */}
        <style dangerouslySetInnerHTML={{ __html: cssVariables() }} />
      </head>
      <body>
        {children}
        {/*
          After the page, not before it: this registers the service worker and
          holds the install offer, and neither is worth a millisecond of the
          first paint. It renders nothing at all until a browser says the shop
          is installable.
        */}
        <ProgressiveApp />
        {/*
          Last in the body, fixed to the bottom of the viewport. On a phone with
          the shop installed there is no browser chrome, so this is the only
          navigation within reach of the thumb holding it.
        */}
        <AppTabs serverCount={serverCount} />
      </body>
    </html>
  )
}

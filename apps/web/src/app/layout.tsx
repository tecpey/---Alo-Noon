import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { colors, cssVariables } from '@alo-noon/design-tokens'

import './styles.css'
import { siteUrl } from '../lib/site-url'
import { ProgressiveApp } from './components/progressive-app'

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
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
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
      </body>
    </html>
  )
}

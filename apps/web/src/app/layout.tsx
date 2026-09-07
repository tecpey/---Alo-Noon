import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { colors, cssVariables } from '@alo-noon/design-tokens'

import './styles.css'
import { siteUrl } from '../lib/site-url'

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
          The palette is emitted from the token package rather than written into
          a stylesheet, so the web and the two mobile apps cannot drift apart:
          all three read the same constants, and this is the only bridge. The
          string is built from those constants; no input reaches it.
        */}
        <style dangerouslySetInnerHTML={{ __html: cssVariables() }} />
      </head>
      <body>{children}</body>
    </html>
  )
}

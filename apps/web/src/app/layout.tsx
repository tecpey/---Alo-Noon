import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import { colors, cssVariables } from '@alo-noon/design-tokens'

import './styles.css'

export const metadata: Metadata = {
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

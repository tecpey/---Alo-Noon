'use client'

import { colors, cssVariables } from '@alo-noon/design-tokens'

import './styles.css'

/**
 * The last page before Next.js's own.
 *
 * `error.tsx` handles a page that threw, and cannot handle the root layout
 * throwing — at that point there is no layout left to render inside. This one
 * replaces the document, which is why it carries its own `<html>`, its own
 * direction and its own palette: nothing above it survived to provide them.
 *
 * Deliberately thin. Every import here is a thing that can fail in the same way
 * the layout just did, so it pulls in the tokens and the base stylesheet and
 * nothing else — no brand art, no API client, no data. A fallback that can
 * itself throw is not a fallback.
 *
 * The reload is a full one rather than a `reset()`: the failure was in the
 * document shell, and re-rendering a shell that just failed to render is not a
 * plan.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="fa" dir="rtl">
      <head>
        <meta name="theme-color" content={colors.paper} />
        <style dangerouslySetInnerHTML={{ __html: cssVariables() }} />
      </head>
      <body>
        <main
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: '0.9rem',
            margin: '3rem auto',
            padding: '2.5rem 1.5rem',
            maxWidth: '32rem',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '1.2rem' }}>الو نون در دسترس نیست</h1>
          <p style={{ maxWidth: '44ch', lineHeight: 1.8 }}>
            سرویس موقتاً بالا نیامد. سفارش‌ها و موجودی کیف پول شما دست‌نخورده است. چند لحظه دیگر
            دوباره تلاش کنید.
          </p>
          {/*
            A plain anchor, and `next/link` would be wrong here. The router is
            part of what just failed to render, so a client navigation would try
            to reuse the broken shell; a full document request is the recovery.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a className="an-button" href="/">
            تلاش دوباره
          </a>
          {error.digest ? (
            <p style={{ fontSize: '0.85rem' }}>
              کد پیگیری این خطا: <code dir="ltr">{error.digest}</code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}

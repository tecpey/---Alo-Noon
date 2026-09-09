import Link from 'next/link'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import '../storefront.css'
import './legal.css'

import { BrandMark } from '../components/brand-mark'

export const metadata: Metadata = {
  title: 'قوانین و راهنما | الو نون',
  description: 'قوانین استفاده، حریم خصوصی، شرایط بازگشت وجه و راه‌های تماس با الو نون',
}

const SECTIONS = [
  { href: '/legal/terms', label: 'قوانین و مقررات' },
  { href: '/legal/refunds', label: 'بازگشت وجه' },
  { href: '/legal/privacy', label: 'حریم خصوصی' },
  { href: '/legal/contact', label: 'تماس با ما' },
] as const

/**
 * The pages a customer reads before they trust a shop with a card.
 *
 * Deliberately not `noindex`, unlike the panel and the wallet. These are the
 * pages an eNamad reviewer opens, the ones a customer searches for when they
 * want to know who they are actually buying from, and the ones a payment
 * gateway's compliance team asks to see. A trust page nobody can find is not a
 * trust page.
 */
export default function LegalLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-frame legal">
      <header className="legal__head">
        <Link href="/" aria-label="بازگشت به فروشگاه">
          <BrandMark />
        </Link>
        <nav className="legal__nav" aria-label="صفحه‌های قوانین">
          {SECTIONS.map((section) => (
            <Link key={section.href} href={section.href}>
              {section.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="legal__body">{children}</main>
    </div>
  )
}

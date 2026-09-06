import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import '../admin/admin.css'
import './bakery.css'

export const metadata: Metadata = {
  title: 'پنل نانوایی الو نون',
  description: 'صف سفارش‌های شعبه و درآمد آن',
  // A partner's queue is nobody's search result.
  robots: { index: false, follow: false },
}

/**
 * The bakery partner's panel.
 *
 * It reuses the operator panel's stylesheet rather than growing a second design
 * system: it is the same kind of tool — a dense, Persian-first working screen —
 * and two stylesheets would be two places for a retuned colour to be forgotten.
 * `bakery.css` holds only what this panel has that the other does not.
 */
export default function BakeryLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="admin-shell bakery-shell">{children}</div>
}

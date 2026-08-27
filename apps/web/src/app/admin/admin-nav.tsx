import Link from 'next/link'

import { BrandMark } from '../components/brand-mark'
import { signOutAction } from '../../lib/admin-actions'

const SECTIONS = [
  { href: '/admin', label: 'داشبورد' },
  { href: '/admin/orders', label: 'سفارش‌ها' },
  { href: '/admin/deliveries', label: 'اعزام پیک' },
  { href: '/admin/finance', label: 'گزارش مالی' },
  { href: '/admin/catalog', label: 'کاتالوگ' },
  { href: '/admin/pricing', label: 'قیمت‌گذاری' },
  { href: '/admin/providers', label: 'سرویس‌دهنده‌ها' },
  { href: '/admin/messaging', label: 'متن پیام‌ها' },
  { href: '/admin/access', label: 'دسترسی‌ها' },
] as const

/**
 * The panel's chrome. Sections are listed unconditionally rather than filtered
 * by permission: the session's grants are a cache, and hiding a link an operator
 * does hold is a worse failure than showing one they do not — the page itself
 * refuses with a message that says which permission is missing.
 */
export function AdminNav({
  active,
  title,
  subtitle,
}: Readonly<{
  active: (typeof SECTIONS)[number]['href']
  title: string
  subtitle?: string
}>) {
  return (
    <header className="admin-header">
      <div>
        {/* The mark, not the lockup: at this size the wordmark would be a
            wordmark nobody can read, and the panel is not a shopfront. */}
        <div className="admin-title">
          <BrandMark variant="mark" size={30} />
          <h1>{title}</h1>
        </div>
        {subtitle && <p className="muted">{subtitle}</p>}
        <nav className="admin-nav">
          {SECTIONS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className={section.href === active ? 'current' : ''}
              aria-current={section.href === active ? 'page' : undefined}
            >
              {section.label}
            </Link>
          ))}
        </nav>
      </div>
      <form action={signOutAction}>
        <button type="submit" className="ghost">
          خروج
        </button>
      </form>
    </header>
  )
}

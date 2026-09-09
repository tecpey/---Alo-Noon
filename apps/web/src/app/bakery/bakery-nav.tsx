import Link from 'next/link'

import { BrandMark } from '../components/brand-mark'
import { branchSignOutAction } from '../../lib/admin-actions'
import type { BranchContextSummary } from '../../lib/admin-api'

const SECTIONS = [
  { href: '/bakery', label: 'صف سفارش‌ها' },
  { href: '/bakery/earnings', label: 'درآمد شعبه' },
] as const

/**
 * The panel's chrome, and the one place that names which counter you are at.
 *
 * The branch is shown on every page on purpose. A person who runs two branches
 * and forgets which one they are looking at will accept the wrong shop's orders,
 * and no amount of correctness in the API prevents that.
 */
export function BakeryNav({
  active,
  title,
  branches,
}: Readonly<{
  active: (typeof SECTIONS)[number]['href']
  title: string
  branches: readonly BranchContextSummary[]
}>) {
  const bakery = branches[0]?.bakeryNameFa
  const where = branches.map((branch) => `${branch.branchNameFa} (${branch.cityNameFa})`).join('، ')

  return (
    <header className="admin-header">
      <div>
        <div className="admin-title">
          <BrandMark variant="mark" size={30} />
          <h1>{title}</h1>
        </div>
        {branches.length > 0 && (
          <p className="muted">
            {bakery} — {where}
          </p>
        )}
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
      <form action={branchSignOutAction}>
        <button type="submit" className="ghost">
          خروج
        </button>
      </form>
    </header>
  )
}

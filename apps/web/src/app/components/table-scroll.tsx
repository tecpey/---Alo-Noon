import type { ReactNode } from 'react'

/**
 * A wide table in a box that scrolls sideways — reachable from the keyboard.
 *
 * On a phone, and in the admin panel on a narrow laptop, a table wider than
 * the screen scrolls inside its own box. A box that scrolls is only usable to
 * someone who can scroll it: without a tab stop, an operator on a keyboard or
 * a screen reader never reaches the columns past the edge — which in the trial
 * balance are the credit column and the difference. axe-core reported it as
 * `scrollable-region-focusable` (WCAG 2.1.1) on the finance, tariff and access
 * tables.
 *
 * Focusable, so the arrow keys scroll it; a named region, so what a screen
 * reader announces on arrival is which table this is rather than "group".
 */
export function TableScroll({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  )
}

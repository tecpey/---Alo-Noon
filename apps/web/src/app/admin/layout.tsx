import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import './admin.css'

export const metadata: Metadata = {
  title: 'پنل مدیریت الو نون',
  description: 'پیکربندی درگاه پرداخت و سرویس پیامک',
  // Nothing under /admin belongs in a search index or a shared link preview.
  robots: { index: false, follow: false },
}

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="admin-shell">{children}</div>
}

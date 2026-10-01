import type { ReactNode } from 'react'
import { connection } from 'next/server'
import { Navigation } from '../components/controls'
import { envValue } from '../../daemon/src/config/paths'
import './globals.css'
export const metadata = {
  title: 'contentd-system · Admin',
  description: 'contentd-system operator dashboard',
}
export default async function Layout({ children }: { children: ReactNode }) {
  await connection()
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a className="brand" href="/">
            contentd-system<span> / admin</span>
          </a>
          <Navigation />
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          root={envValue(process.env, 'CONTENTD_ROOT') ?? 'not configured'} · Times shown in
          server-local time (TZ={process.env.TZ ?? 'system'})
        </footer>
      </body>
    </html>
  )
}

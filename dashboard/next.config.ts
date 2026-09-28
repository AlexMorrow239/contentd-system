import type { NextConfig } from 'next'
import path from 'node:path'
const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  outputFileTracingRoot: path.resolve(import.meta.dirname, '..'),
}
export default config

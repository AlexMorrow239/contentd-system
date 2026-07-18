import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import BetterSqlite3 from 'better-sqlite3'
import type { Database } from 'better-sqlite3'

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url))

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  // better-sqlite3 v12+ enables foreign_keys by default; this project keeps
  // FK enforcement OFF by design (schema documents relationships, app code
  // owns integrity; tests insert child rows standalone).
  db.pragma('foreign_keys = OFF')
  db.exec(readFileSync(schemaPath, 'utf8'))
  return db
}

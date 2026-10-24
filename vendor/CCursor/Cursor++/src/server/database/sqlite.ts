/**
 * SQLite 持久层 — 独立运行版 (node:sqlite)
 *
 * 原实现从 Cursor app 里动态 require `@vscode/sqlite3`。
 * 我们的独立 BYOK server 不在 Cursor 里跑，改用 Node 内置的 `node:sqlite`，
 * 对外保持完全相同的异步接口 (AsyncDatabase / AsyncStatement)。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { getDatabaseFilePath } from '../config/paths'
import { logger } from '../logger'

export interface RunResult {
  lastID: number
  changes: number
}

export interface AsyncStatement {
  run: (params?: unknown) => Promise<RunResult>
  get: <T = unknown>(params?: unknown) => Promise<T | undefined>
  all: <T = unknown>(params?: unknown) => Promise<T[]>
  finalize: () => Promise<void>
}

export interface AsyncDatabase {
  prepare: (sql: string) => AsyncStatement
  exec: (sql: string) => Promise<void>
  run: (sql: string, params?: unknown) => Promise<RunResult>
  get: <T = unknown>(sql: string, params?: unknown) => Promise<T | undefined>
  all: <T = unknown>(sql: string, params?: unknown) => Promise<T[]>
  transaction: <T>(fn: () => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

function bindArgs(params?: unknown): any[] {
  if (params === undefined || params === null)
    return []
  if (Array.isArray(params))
    return params
  // Named parameters object.
  return [params]
}

function wrapStatement(stmt: StatementSync): AsyncStatement {
  return {
    async run(params?: unknown): Promise<RunResult> {
      const r = stmt.run(...bindArgs(params)) as { changes: number | bigint, lastInsertRowid: number | bigint }
      return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) }
    },
    async get<T = unknown>(params?: unknown): Promise<T | undefined> {
      return stmt.get(...bindArgs(params)) as T | undefined
    },
    async all<T = unknown>(params?: unknown): Promise<T[]> {
      return stmt.all(...bindArgs(params)) as T[]
    },
    async finalize(): Promise<void> {
      // StatementSync 无需显式 finalize。
    },
  }
}

function wrapDatabase(rawDb: DatabaseSync): AsyncDatabase {
  const db: AsyncDatabase = {
    prepare: (sql: string) => wrapStatement(rawDb.prepare(sql)),
    async exec(sql: string): Promise<void> {
      rawDb.exec(sql)
    },
    async run(sql: string, params?: unknown): Promise<RunResult> {
      const r = rawDb.prepare(sql).run(...bindArgs(params)) as { changes: number | bigint, lastInsertRowid: number | bigint }
      return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) }
    },
    async get<T = unknown>(sql: string, params?: unknown): Promise<T | undefined> {
      return rawDb.prepare(sql).get(...bindArgs(params)) as T | undefined
    },
    async all<T = unknown>(sql: string, params?: unknown): Promise<T[]> {
      return rawDb.prepare(sql).all(...bindArgs(params)) as T[]
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      await db.exec('BEGIN')
      try {
        const result = await fn()
        await db.exec('COMMIT')
        return result
      }
      catch (e) {
        try {
          await db.exec('ROLLBACK')
        }
        catch {}
        throw e
      }
    },
    async close(): Promise<void> {
      rawDb.close()
    },
  }
  return db
}

let db: AsyncDatabase | null = null
let dbPath: string | null = null

export function resolveAgentDatabasePath(): string {
  return process.env.BYOK_AGENT_DB_PATH || getDatabaseFilePath()
}

async function initializeSchema(database: AsyncDatabase): Promise<void> {
  await database.exec('PRAGMA journal_mode = WAL')
  await database.exec('PRAGMA synchronous = NORMAL')
  await database.exec('PRAGMA foreign_keys = ON')
  await database.exec('PRAGMA busy_timeout = 5000')

  await database.exec(`
    CREATE TABLE IF NOT EXISTS agent_blobs (
      blob_id TEXT PRIMARY KEY,
      blob_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_checkpoints (
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'committed',
      root_blob_ids_json TEXT NOT NULL,
      turn_blob_ids_json TEXT NOT NULL DEFAULT '[]',
      summary_archive_ids_json TEXT NOT NULL,
      used_tokens INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_blobs_last_accessed_at
      ON agent_blobs(last_accessed_at);

    CREATE INDEX IF NOT EXISTS idx_conversation_checkpoints_updated_at
      ON conversation_checkpoints(updated_at);

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      truncation_bubble_id_inclusive TEXT NOT NULL,
      resume_bubble_id_inclusive TEXT NOT NULL,
      previous_summary_bubble_id TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      includes_tool_results INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, kind, truncation_bubble_id_inclusive)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_lookup
      ON conversation_summaries(conversation_id, kind, updated_at DESC);
  `)

  try {
    await database.get(`SELECT kind FROM conversation_checkpoints LIMIT 1`)
  }
  catch {
    await database.exec(`
      ALTER TABLE conversation_checkpoints RENAME TO conversation_checkpoints_old;
      CREATE TABLE conversation_checkpoints (
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'committed',
        root_blob_ids_json TEXT NOT NULL,
        turn_blob_ids_json TEXT NOT NULL DEFAULT '[]',
        summary_archive_ids_json TEXT NOT NULL,
        used_tokens INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, kind)
      );
      INSERT INTO conversation_checkpoints
        SELECT conversation_id, 'committed', root_blob_ids_json, '[]', summary_archive_ids_json,
               used_tokens, max_tokens, mode, updated_at
        FROM conversation_checkpoints_old;
      DROP TABLE conversation_checkpoints_old;
    `)
  }

  try {
    await database.get(`SELECT turn_blob_ids_json FROM conversation_checkpoints LIMIT 1`)
  }
  catch {
    await database.exec(`
      ALTER TABLE conversation_checkpoints
      ADD COLUMN turn_blob_ids_json TEXT NOT NULL DEFAULT '[]';
    `)
  }
}

export async function initDatabase(): Promise<void> {
  const nextPath = resolveAgentDatabasePath()
  if (db && dbPath === nextPath)
    return

  if (db) {
    await db.close()
    db = null
  }

  mkdirSync(dirname(nextPath), { recursive: true })

  const rawDb = new DatabaseSync(nextPath)
  db = wrapDatabase(rawDb)
  dbPath = nextPath
  await initializeSchema(db)
  logger.info({ agentDbPath: nextPath }, '[DB] agent sqlite persistence ready')
}

export function getAgentDatabase(): AsyncDatabase {
  if (!db)
    throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export async function closeAgentDatabase(): Promise<void> {
  if (!db)
    return
  await db.close()
  db = null
  dbPath = null
}

export async function resetAgentDatabaseForTests(): Promise<void> {
  await closeAgentDatabase()
  await initDatabase()
}

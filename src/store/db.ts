/**
 * Postgres: пул и миграции.
 *
 * ⚠ Миграции гоняются на КАЖДОМ старте: сервис катится Watchtower'ом, отдельного шага
 * «примени миграции» на сервере просто нет.
 */
import pg from 'pg'

export type Pool = pg.Pool

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 })
}

/**
 * Нумерованные шаги, а не один `create table if not exists`.
 *
 * ⚠ Найдено ревью: с единственным `if not exists` любое будущее изменение схемы
 * (колонка, индекс, тип) на уже работающей базе молча пропускалось бы, а код уже
 * ждал бы его — и первый же автоматический выкат ломал бы работающий сервис без
 * единого сообщения. Добавлять шаги только в конец списка; менять уже применённые
 * нельзя — они на боевой базе уже отработали.
 */
export const MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '001-init',
    sql: `
      create table if not exists portal_tokens (
        domain                 text primary key,
        member_id              text        not null,
        application_token_hash text        not null,
        auth_enc               text        not null,
        expires_at             timestamptz not null,
        installed_at           timestamptz not null default now(),
        updated_at             timestamptz not null default now()
      );

      create table if not exists transfers (
        domain         text        not null,
        source_task_id bigint      not null,
        target_task_id bigint,
        status         text        not null,
        reason         text,
        created_at     timestamptz not null default now(),
        updated_at     timestamptz not null default now(),
        primary key (domain, source_task_id)
      );
    `,
  },
  {
    id: '002-transfers-status-index',
    // Операторский запрос `make transfers` сортирует по updated_at.
    sql: `create index if not exists transfers_updated_at_idx on transfers (updated_at desc);`,
  },
]

/** Произвольное, но постоянное число: под ним берётся блокировка миграций. */
const MIGRATION_LOCK_ID = 7240815

/**
 * ⚠ Под advisory-lock: два контейнера, стартующие одновременно (обычное дело при
 * перекате Watchtower'ом), иначе гоняют DDL параллельно и ловят ошибку уникальности
 * в системном каталоге Postgres — то есть падают на старте по очереди и без причины.
 */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())')

    const { rows } = await client.query<{ id: string }>('select id from schema_migrations')
    const applied = new Set(rows.map((r) => r.id))

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue
      await client.query('begin')
      try {
        await client.query(migration.sql)
        await client.query('insert into schema_migrations (id) values ($1)', [migration.id])
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {})
    client.release()
  }
}

/**
 * Postgres: пул и миграции. Схема маленькая и живёт здесь целиком — отдельный
 * инструмент миграций на две таблицы стоил бы дороже, чем экономит.
 */
import pg from 'pg'

export type Pool = pg.Pool

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 })
}

const SCHEMA = `
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
`

/**
 * ⚠ Миграции идемпотентны и гоняются на каждом старте: сервис катится Watchtower'ом,
 * то есть отдельного шага «примени миграции» на сервере просто нет.
 */
export async function migrate(pool: Pool): Promise<void> {
  await pool.query(SCHEMA)
}

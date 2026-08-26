/**
 * Журнал переносов: `портал + ID задачи-источника → ID задачи у нас`.
 * Без него повторная доставка события заводит дубль (docs/PROCESSING.md → «Дедупликация»).
 */
import type { Pool } from './db.js'

export type TransferStatus = 'pending' | 'done' | 'skipped' | 'failed'

export interface TransferRow {
  domain: string
  source_task_id: string
  target_task_id: string | null
  status: TransferStatus
  reason: string | null
}

/**
 * Занимает задачу под перенос.
 *
 * ⚠ Дедуп держится на первичном ключе БАЗЫ, а не на проверке «а есть ли уже запись»
 * перед вставкой: два события об одной задаче могут обрабатываться одновременно, и
 * между чтением и записью успевает пролезть второй воркер. `on conflict do nothing`
 * делает гонку невозможной, а не маловероятной.
 *
 * @returns `null`, если задача уже занята или перенесена; иначе занятую строку.
 */
export async function claim(pool: Pool, domain: string, sourceTaskId: number): Promise<TransferRow | null> {
  const { rows } = await pool.query<TransferRow>(
    `insert into transfers (domain, source_task_id, status)
     values ($1, $2, 'pending')
     on conflict (domain, source_task_id) do nothing
     returning *`,
    [domain, sourceTaskId],
  )
  return rows[0] ?? null
}

export async function markDone(pool: Pool, domain: string, sourceTaskId: number, targetTaskId: number): Promise<void> {
  await pool.query(
    `update transfers set status = 'done', target_task_id = $3, reason = null, updated_at = now()
     where domain = $1 and source_task_id = $2`,
    [domain, sourceTaskId, targetTaskId],
  )
}

export async function markSkipped(pool: Pool, domain: string, sourceTaskId: number, reason: string): Promise<void> {
  await pool.query(
    `update transfers set status = 'skipped', reason = $3, updated_at = now()
     where domain = $1 and source_task_id = $2`,
    [domain, sourceTaskId, reason],
  )
}

/**
 * ⚠ Провал НЕ снимает занятость: строка остаётся, и повтор задачи не создаст дубль.
 * Ретраи живут в очереди, а не в перезаходе через журнал.
 */
export async function markFailed(pool: Pool, domain: string, sourceTaskId: number, reason: string): Promise<void> {
  await pool.query(
    `update transfers set status = 'failed', reason = $3, updated_at = now()
     where domain = $1 and source_task_id = $2`,
    [domain, sourceTaskId, reason.slice(0, 500)],
  )
}

export async function find(pool: Pool, domain: string, sourceTaskId: number): Promise<TransferRow | null> {
  const { rows } = await pool.query<TransferRow>(
    'select * from transfers where domain = $1 and source_task_id = $2',
    [domain, sourceTaskId],
  )
  return rows[0] ?? null
}

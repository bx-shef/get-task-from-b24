/**
 * Журнал переносов: `портал + ID задачи-источника → ID задачи у нас`.
 * Без него повторная доставка события заводит дубль (docs/PROCESSING.md → «Дедупликация»).
 */
import type { Pool } from './db.js'

/**
 * ⚠ Статуса `skipped` здесь намеренно НЕТ. Отказ по критериям в журнал переносов не
 * пишется (docs/PROCESSING.md): на портале клиента задачи создаются постоянно, и
 * журнал переносов перестал бы быть журналом переносов. Отказы видны в логе строкой
 * `skip`. Значение, которое не может появиться, вводит оператора `make transfers`
 * в заблуждение вернее, чем его отсутствие.
 */
export type TransferStatus = 'pending' | 'done' | 'failed'

export interface TransferRow {
  domain: string
  source_task_id: string
  target_task_id: string | null
  status: TransferStatus
  reason: string | null
}

/**
 * Через сколько «занятая, но не доведённая» строка считается брошенной.
 *
 * ⚠ Нужна именно граница по времени, а не «перезанимать всё незавершённое»: два
 * события об одной задаче могут обрабатываться одновременно, и без этого условия
 * второй воркер отобрал бы строку у первого — оба создали бы задачу. Ровно это
 * поймал контрактный тест на настоящей базе. С другой стороны, воркер может умереть
 * посреди переноса, и вечно `pending` строка означала бы задачу, к которой уже никто
 * не вернётся. Окно шире, чем весь цикл ретраев очереди (5 попыток, ~3 минуты).
 */
export const STALE_CLAIM_INTERVAL = '10 minutes'

/** Чтение строки журнала: нужна операторской диагностике и контрактным тестам store. */
export async function find(pool: Pool, domain: string, sourceTaskId: number): Promise<TransferRow | null> {
  const { rows } = await pool.query<TransferRow>(
    'select * from transfers where domain = $1 and source_task_id = $2',
    [domain, sourceTaskId],
  )
  return rows[0] ?? null
}

export type ClaimResult =
  /** Заняли: можно переносить. */
  | { claimed: true }
  /** Задача уже перенесена — это норма, повторная доставка события. */
  | { claimed: false; transferred: true }
  /** Занята другим воркером прямо сейчас: повторить позже, но НЕ считать успехом. */
  | { claimed: false; transferred: false }

/**
 * Занимает задачу под перенос — или перезанимает провалившуюся/брошенную.
 *
 * ⚠ Дедуп держится на первичном ключе БАЗЫ, а не на проверке «а есть ли уже запись»
 * перед вставкой: два события об одной задаче могут обрабатываться одновременно, и
 * между чтением и записью успевает пролезть второй воркер.
 *
 * ⚠ **`do nothing` здесь был дефектом, найденным ревью.** Первая попытка занимала
 * строку и падала на создании задачи; вторая попытка очереди получала «уже занято»,
 * рапортовала «дубль» и завершалась УСПЕШНО — задача клиента не создавалась никогда
 * и молча, а до последней попытки (и до сигнала в Telegram) дело не доходило. Поэтому
 * провалившуюся строку занимаем повторно: единственное, что действительно запрещено, —
 * второй раз создать задачу, которая уже создана.
 *
 * ⚠ Строку, которую прямо сейчас переносит другой воркер (свежая `pending`), не
 * трогаем — иначе оба создадут задачу. Брошенную (старше `STALE_CLAIM_INTERVAL`)
 * занять можно: за ней уже никто не вернётся.
 *
 * @returns `null`, если задача уже перенесена или её прямо сейчас переносит другой
 *          воркер; иначе занятую строку.
 */
export async function claim(pool: Pool, domain: string, sourceTaskId: number): Promise<ClaimResult> {
  const { rows } = await pool.query<TransferRow>(
    `insert into transfers (domain, source_task_id, status)
     values ($1, $2, 'pending')
     on conflict (domain, source_task_id) do update
       set status = 'pending', updated_at = now()
       where transfers.target_task_id is null
         and (transfers.status = 'failed'
              or transfers.updated_at < now() - interval '${STALE_CLAIM_INTERVAL}')
     returning *`,
    [domain, sourceTaskId],
  )

  if (rows[0]) return { claimed: true }

  // ⚠ «Не заняли» — это ДВА разных случая, и путать их нельзя. Найдено вторым циклом
  // ревью: воркер, убитый посреди переноса (выкат, OOM), оставляет свежую `pending`
  // строку; BullMQ возвращает зависшее задание и прогоняет обработчик заново — и он
  // получал «занято», рапортовал «дубль» и завершался УСПЕШНО. Задача клиента не
  // создана, строка навсегда в `pending`, ретраев больше нет. Тот же дефект, что
  // чинили в первом цикле, только вход не «ретрай», а «рестарт контейнера».
  const existing = await find(pool, domain, sourceTaskId)
  return { claimed: false, transferred: existing?.target_task_id != null }
}

export async function markDone(pool: Pool, domain: string, sourceTaskId: number, targetTaskId: number): Promise<void> {
  await pool.query(
    `update transfers set status = 'done', target_task_id = $3, reason = null, updated_at = now()
     where domain = $1 and source_task_id = $2`,
    [domain, sourceTaskId, targetTaskId],
  )
}

/**
 * Записывает провал — создавая строку, если её ещё нет.
 *
 * ⚠ Раньше это был `update … where`, и он молча ничего не делал, когда провал случался
 * ДО `claim` (портал не ответил — самый частый сбой). Найдено ревью: строки нет,
 * `update` задевает ноль строк, и от потерянной задачи не остаётся ни следа в журнале.
 *
 * ⚠ `where transfers.target_task_id is null` — уже перенесённую задачу провал не
 * переписывает. Иначе повторное событие в момент, когда лежит Redis, помечало бы
 * успешный перенос как `failed`, человек заводил бы задачу руками, и получался бы дубль.
 */
export async function markFailed(pool: Pool, domain: string, sourceTaskId: number, reason: string): Promise<void> {
  await pool.query(
    `insert into transfers (domain, source_task_id, status, reason)
     values ($1, $2, 'failed', $3)
     on conflict (domain, source_task_id) do update
       set status = 'failed', reason = excluded.reason, updated_at = now()
       where transfers.target_task_id is null`,
    [domain, sourceTaskId, reason.slice(0, 500)],
  )
}


/**
 * Контрактные тесты журнала переносов — на НАСТОЯЩЕМ Postgres.
 *
 * ⚠ Мок здесь бесполезен: весь смысл журнала в поведении `on conflict`, то есть в
 * самой базе. Ровно на этом месте ревью нашло два дефекта, которых юниты с заглушками
 * не видели в принципе: `do nothing` хоронил задачу после первого же ретрая, а
 * `markFailed` через `update` молча ничего не делал, когда строки ещё нет.
 *
 * База берётся из DATABASE_URL (в CI — сервис postgres, локально — docker compose).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, migrate, type Pool } from '../src/store/db.js'
import { claim, find, markDone, markFailed } from '../src/store/transfers.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app'

let pool: Pool
const domain = 'contract.bitrix24.ru'

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
})

afterAll(async () => {
  await pool?.query('delete from transfers where domain = $1', [domain])
  await pool?.end()
})

beforeEach(async () => {
  await pool.query('delete from transfers where domain = $1', [domain])
})

describe('claim', () => {
  it('первый занимает, второй получает отказ', async () => {
    expect(await claim(pool, domain, 1)).not.toBeNull()
    expect(await claim(pool, domain, 1)).toBeNull()
  })

  // ⚠ Дефект, найденный ревью: с `do nothing` первая попытка занимала строку и падала,
  // а вторая получала «уже занято», рапортовала «дубль» и завершалась УСПЕШНО —
  // задача клиента не создавалась никогда и молча.
  it('после провала задачу можно занять снова', async () => {
    expect(await claim(pool, domain, 2)).not.toBeNull()
    await markFailed(pool, domain, 2, 'портал недоступен')
    expect(await claim(pool, domain, 2)).not.toBeNull()
    expect((await find(pool, domain, 2))?.status).toBe('pending')
  })

  // ⚠ А вот это — то единственное, что журнал обязан запрещать.
  it('перенесённую задачу занять нельзя', async () => {
    await claim(pool, domain, 3)
    await markDone(pool, domain, 3, 42)
    expect(await claim(pool, domain, 3)).toBeNull()
    expect((await find(pool, domain, 3))?.target_task_id).toBe('42')
  })

  // ⚠ Обратная сторона: перезанимать можно провалившуюся, но НЕ ту, что прямо сейчас
  // переносит другой воркер — иначе оба создадут задачу. Этот тест поймал ровно такую
  // ошибку в первой версии исправления.
  it('свежую занятую задачу второй воркер не отбирает', async () => {
    expect(await claim(pool, domain, 10)).not.toBeNull()
    expect(await claim(pool, domain, 10)).toBeNull()
    expect((await find(pool, domain, 10))?.status).toBe('pending')
  })

  it('брошенную занятую задачу занять можно: за ней уже никто не вернётся', async () => {
    await claim(pool, domain, 11)
    await pool.query(
      "update transfers set updated_at = now() - interval '1 hour' where domain = $1 and source_task_id = 11",
      [domain],
    )
    expect(await claim(pool, domain, 11)).not.toBeNull()
  })

  it('разные порталы и задачи не мешают друг другу', async () => {
    expect(await claim(pool, domain, 4)).not.toBeNull()
    expect(await claim(pool, domain, 5)).not.toBeNull()
  })
})

describe('markFailed', () => {
  // ⚠ Дефект, найденный ревью: `update … where` не задевал ни одной строки, когда
  // провал случался ДО claim (портал не ответил — самый частый сбой), и от потерянной
  // задачи не оставалось ни следа.
  it('оставляет след, даже если задачу не успели занять', async () => {
    await markFailed(pool, domain, 6, 'портал не ответил')
    const row = await find(pool, domain, 6)
    expect(row?.status).toBe('failed')
    expect(row?.reason).toBe('портал не ответил')
  })

  // ⚠ Иначе повторное событие при лежащем Redis переписало бы успешный перенос
  // в «провал», человек завёл бы задачу руками — и получился бы дубль.
  it('успешный перенос в провал не переписывается', async () => {
    await claim(pool, domain, 7)
    await markDone(pool, domain, 7, 99)
    await markFailed(pool, domain, 7, 'очередь недоступна')

    const row = await find(pool, domain, 7)
    expect(row?.status).toBe('done')
    expect(row?.target_task_id).toBe('99')
  })

  it('длинная причина обрезается и не роняет запись', async () => {
    await markFailed(pool, domain, 8, 'ы'.repeat(5000))
    expect((await find(pool, domain, 8))?.reason?.length).toBeLessThanOrEqual(500)
  })
})

describe('markDone', () => {
  it('записывает id задачи у нас и снимает причину провала', async () => {
    await claim(pool, domain, 9)
    await markFailed(pool, domain, 9, 'сеть')
    await claim(pool, domain, 9)
    await markDone(pool, domain, 9, 7)

    const row = await find(pool, domain, 9)
    expect(row).toMatchObject({ status: 'done', target_task_id: '7', reason: null })
  })
})

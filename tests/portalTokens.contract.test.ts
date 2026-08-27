/**
 * Контрактные тесты хранилища токенов — на НАСТОЯЩЕМ Postgres.
 *
 * ⚠ Написаны после аварии в бою: `stored.expiresAt.getTime is not a function`. Сервис
 * проработал час и упал при первом продлении токена — до этого момента ни один тест,
 * ни один прогон и ни одна проверка ревью этого не видели, потому что дефект жил
 * ровно в круге «записали → прочитали» через настоящую колонку и настоящий JSON.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool, migrate, type Pool } from '../src/store/db.js'
import { deletePortal, getPortal, saveInstall, updateAuth, verifyApplicationToken } from '../src/store/portalTokens.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app'
const ENC_KEY = '0'.repeat(64)
const domain = 'tokens-contract.bitrix24.ru'

let pool: Pool

const auth = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  clientEndpoint: 'https://tokens-contract.bitrix24.ru/rest/',
  serverEndpoint: 'https://oauth.bitrix24.tech/rest/',
}

beforeAll(async () => {
  pool = createPool(DATABASE_URL)
  await migrate(pool)
})

afterAll(async () => {
  await pool?.query('delete from portal_tokens where domain = $1', [domain])
  await pool?.end()
})

beforeEach(async () => {
  await pool.query('delete from portal_tokens where domain = $1', [domain])
  await saveInstall(pool, { domain, memberId: 'm1', applicationToken: 'app-tok', auth, expiresAt: new Date(Date.now() + 3600_000) }, ENC_KEY)
})

describe('круг сохранения и чтения', () => {
  it('токены расшифровываются обратно', async () => {
    expect(await getPortal(pool, domain, ENC_KEY)).toMatchObject(auth)
  })

  it('в базе токенов открытым текстом нет', async () => {
    const { rows } = await pool.query<{ auth_enc: string }>('select auth_enc from portal_tokens where domain = $1', [domain])
    expect(rows[0]?.auth_enc).not.toContain('at-1')
    expect(rows[0]?.auth_enc).not.toContain('rt-1')
  })
})

describe('срок жизни токена', () => {
  // ⚠ Та самая авария: сервис упал через час после установки, при первом продлении.
  it('после продления остаётся датой, а не строкой', async () => {
    const later = new Date(Date.now() + 7200_000)
    // Так его зовёт `refreshAndStore` — объектом, у которого есть и expiresAt.
    await updateAuth(pool, domain, { ...auth, accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: later } as never, later, ENC_KEY)

    const stored = await getPortal(pool, domain, ENC_KEY)
    expect(stored?.expiresAt).toBeInstanceOf(Date)
    expect(typeof stored?.expiresAt.getTime).toBe('function')
    expect(stored?.accessToken).toBe('at-2')
  })

  // ⚠ Колонка — единственный источник правды: содержимое зашифрованного блока не
  // должно уметь её перебить, чем бы туда ни попало.
  it('поле из зашифрованного блока не перебивает колонку', async () => {
    const later = new Date(Date.now() + 7200_000)
    await updateAuth(pool, domain, { ...auth, domain: 'подмена', memberId: 'подмена' } as never, later, ENC_KEY)

    const stored = await getPortal(pool, domain, ENC_KEY)
    expect(stored?.domain).toBe(domain)
    expect(stored?.memberId).toBe('m1')
    expect(stored?.expiresAt.getTime()).toBe(later.getTime())
  })
})

describe('сверка токена приложения', () => {
  it('свой проходит, чужой нет', async () => {
    expect(await verifyApplicationToken(pool, domain, 'app-tok')).toBe(true)
    expect(await verifyApplicationToken(pool, domain, 'чужой')).toBe(false)
  })

  it('неизвестный портал — отказ, а не исключение', async () => {
    expect(await verifyApplicationToken(pool, 'нет-такого.ru', 'app-tok')).toBe(false)
  })
})

describe('удаление портала', () => {
  it('снимает установку', async () => {
    await deletePortal(pool, domain)
    expect(await getPortal(pool, domain, ENC_KEY)).toBeNull()
    expect(await verifyApplicationToken(pool, domain, 'app-tok')).toBe(false)
  })
})

/**
 * ⚠ Тесты продления токенов. Ревью нашло здесь дефект, которого не видел ни один
 * юнит: вторая попытка продления брала уже потраченный refresh-токен (Битрикс24 их
 * ротирует), портал отвечал отказом, и ошибка звучала как «клиенту надо переустановить
 * приложение» — хотя переустановка не нужна.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { B24Error } from '../src/b24/errors.js'
import type { PortalConfig } from '../src/domain/portals.js'

const getPortal = vi.fn()
const updateAuth = vi.fn()
const refreshTokens = vi.fn()

vi.mock('../src/store/portalTokens.js', () => ({
  getPortal: (...args: unknown[]) => getPortal(...args),
  updateAuth: (...args: unknown[]) => updateAuth(...args),
}))
vi.mock('../src/b24/rest.js', () => ({
  refreshTokens: (...args: unknown[]) => refreshTokens(...args),
}))

const { withPortalAuth } = await import('../src/b24/portalClient.js')

const portal: PortalConfig = { domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'cid', clientSecret: 'sec' }
const access = { pool: {} as never, encKey: '0'.repeat(64) }

function stored(expiresInMs: number) {
  return {
    domain: portal.domain,
    memberId: 'm1',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    clientEndpoint: 'https://client.bitrix24.ru/rest/',
    serverEndpoint: 'https://oauth.bitrix.info/rest/',
    expiresAt: new Date(Date.now() + expiresInMs),
  }
}

beforeEach(() => {
  getPortal.mockReset()
  updateAuth.mockReset()
  refreshTokens.mockReset()
})

describe('withPortalAuth', () => {
  it('живой токен используется как есть, продления нет', async () => {
    getPortal.mockResolvedValue(stored(60 * 60 * 1000))
    const fn = vi.fn(async () => 'ok')

    expect(await withPortalAuth(access, portal, fn)).toBe('ok')
    expect(fn).toHaveBeenCalledWith({ accessToken: 'at-1', clientEndpoint: 'https://client.bitrix24.ru/rest/' })
    expect(refreshTokens).not.toHaveBeenCalled()
  })

  it('токен на исходе продлевается заранее', async () => {
    getPortal.mockResolvedValue(stored(60 * 1000))
    refreshTokens.mockResolvedValue({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: new Date() })
    const fn = vi.fn(async () => 'ok')

    await withPortalAuth(access, portal, fn)
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'at-2' }))
    expect(updateAuth).toHaveBeenCalled()
  })

  // ⚠ Тот самый дефект: во втором продлении должен участвовать НОВЫЙ refresh-токен.
  it('второе продление берёт токен из первого, а не потраченный', async () => {
    getPortal.mockResolvedValue(stored(60 * 1000))
    refreshTokens
      .mockResolvedValueOnce({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: new Date() })
      .mockResolvedValueOnce({ accessToken: 'at-3', refreshToken: 'rt-3', expiresAt: new Date() })

    const fn = vi.fn()
      .mockRejectedValueOnce(new B24Error('протух', 'expired_token', false))
      .mockResolvedValueOnce('ok')

    expect(await withPortalAuth(access, portal, fn)).toBe('ok')
    expect(refreshTokens.mock.calls[0]?.[3]).toBe('rt-1')
    expect(refreshTokens.mock.calls[1]?.[3]).toBe('rt-2')
    expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ accessToken: 'at-3' }))
  })

  it('после продления повтор ровно один: цикл «протух → продлили → протух» недопустим', async () => {
    getPortal.mockResolvedValue(stored(60 * 60 * 1000))
    refreshTokens.mockResolvedValue({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: new Date() })
    const fn = vi.fn().mockRejectedValue(new B24Error('протух', 'expired_token', false))

    await expect(withPortalAuth(access, portal, fn)).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(refreshTokens).toHaveBeenCalledTimes(1)
  })

  it('обычная ошибка портала не вызывает продления', async () => {
    getPortal.mockResolvedValue(stored(60 * 60 * 1000))
    const fn = vi.fn().mockRejectedValue(new B24Error('портал занят', 'QUERY_LIMIT_EXCEEDED', true))

    await expect(withPortalAuth(access, portal, fn)).rejects.toThrow('портал занят')
    expect(refreshTokens).not.toHaveBeenCalled()
  })

  // ⚠ Ретраить нечего: чинится только переустановкой у клиента, и узнать об этом
  // надо сразу, а не через пять попыток с нарастающей паузой.
  it('портал не установлен — ошибка невосстановимая', async () => {
    getPortal.mockResolvedValue(null)

    await expect(withPortalAuth(access, portal, vi.fn())).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
      retryable: false,
    })
  })
})

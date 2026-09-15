/**
 * Сборка клиентов SDK: проверяем то, что иначе выяснится только в бою.
 */
import { describe, expect, it } from 'vitest'

import { createHookClient, createPortalClient } from '../src/b24/sdk.js'

describe('клиент нашего портала', () => {
  it('строится из адреса вебхука и защищён', () => {
    const client = createHookClient('https://bel.bitrix24.by/rest/1/secret/')
    expect(client.getHttpClient('v2' as never).ajaxClient.defaults.maxRedirects).toBe(0)
  })

  it('отказывает на не-HTTPS и не печатает сам адрес: в нём секрет', () => {
    let message = ''
    try {
      createHookClient('http://bel.bitrix24.by/rest/1/secret/')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('secret')
  })
})

describe('клиент портала клиента', () => {
  const auth = { accessToken: 'at-1', clientEndpoint: 'https://portal.example.by/rest/' }

  it('строится из токена и адреса и защищён', () => {
    const client = createPortalClient(auth)
    expect(client.getHttpClient('v2' as never).ajaxClient.defaults.maxRedirects).toBe(0)
    expect(client.getHttpClient('v2' as never).ajaxClient.defaults.timeout).toBe(20_000)
  })

  it('сам не продлевает токен, а сообщает «протух»', async () => {
    // ⚠ Ключевой инвариант переезда. Битрикс24 ротирует refresh_token: продление в обход
    // нашего кода оставило бы в базе недействительный, и портал отвалился бы молча.
    // Поэтому клиент обязан отдавать решение слою с advisory-lock, а не чинить сам.
    const client = createPortalClient(auth)
    await expect(client.auth.refreshAuth()).rejects.toMatchObject({ code: 'expired_token' })
  })
})

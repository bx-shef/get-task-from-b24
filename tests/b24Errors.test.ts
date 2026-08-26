import { describe, expect, it } from 'vitest'
import { B24Error, EXPIRED_TOKEN_CODES, isRetryable } from '../src/b24/errors.js'
import { tokenEndpoint } from '../src/b24/rest.js'

describe('isRetryable', () => {
  it('лимиты и перегрузка портала — повторяем', () => {
    expect(isRetryable('QUERY_LIMIT_EXCEEDED')).toBe(true)
    expect(isRetryable('OPERATION_TIME_LIMIT')).toBe(true)
  })

  it('5xx и 429 — повторяем', () => {
    expect(isRetryable('', 500)).toBe(true)
    expect(isRetryable('', 503)).toBe(true)
    expect(isRetryable('', 429)).toBe(true)
  })

  // ⚠ Повтор невосстановимой ошибки оттягивает момент, когда о ней узнает человек.
  it('ошибка запроса — не повторяем', () => {
    expect(isRetryable('ERROR_CORE', 400)).toBe(false)
    expect(isRetryable('ERROR_TASKS_ACTION_NOT_ALLOWED', 403)).toBe(false)
  })
})

describe('EXPIRED_TOKEN_CODES', () => {
  it('протухший токен опознаётся во всех известных написаниях', () => {
    for (const code of ['expired_token', 'invalid_token', 'NO_AUTH_FOUND']) {
      expect(EXPIRED_TOKEN_CODES.has(code)).toBe(true)
    }
  })
})

describe('tokenEndpoint', () => {
  // ⚠ Хост берётся из события: зашитый адрес отвалился бы у части порталов и молча.
  it('строится от адреса сервера авторизации из события', () => {
    expect(tokenEndpoint('https://oauth.bitrix24.tech/rest/')).toBe('https://oauth.bitrix24.tech/oauth/token/')
    expect(tokenEndpoint('https://oauth.bitrix.info/rest/')).toBe('https://oauth.bitrix.info/oauth/token/')
  })
})

describe('B24Error', () => {
  it('несёт код и признак повторяемости', () => {
    const error = new B24Error('портал занят', 'QUERY_LIMIT_EXCEEDED', true)
    expect(error.code).toBe('QUERY_LIMIT_EXCEEDED')
    expect(error.retryable).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })
})

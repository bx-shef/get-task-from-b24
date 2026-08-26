import { describe, expect, it } from 'vitest'
import { parseBody, parseInstallEvent, parseTaskAddEvent, unflatten } from '../src/b24/eventPayload.js'

const formBody = [
  'event=ONTASKADD',
  'data%5BFIELDS_AFTER%5D%5BID%5D=555',
  'ts=1466439714',
  'auth%5Bdomain%5D=client.bitrix24.ru',
  'auth%5Bmember_id%5D=abc',
  'auth%5Bapplication_token%5D=tok',
].join('&')

describe('unflatten', () => {
  it('раскладывает скобочные ключи', () => {
    expect(unflatten({ 'data[FIELDS_AFTER][ID]': '555', 'auth[domain]': 'a.ru' }))
      .toEqual({ data: { FIELDS_AFTER: { ID: '555' } }, auth: { domain: 'a.ru' } })
  })
})

describe('parseBody', () => {
  // ⚠ Портал шлёт форму, документация показывает JSON — читаем оба вида.
  it('разбирает форму', () => {
    expect(parseBody('application/x-www-form-urlencoded', formBody))
      .toMatchObject({ event: 'ONTASKADD', auth: { domain: 'client.bitrix24.ru' } })
  })

  it('разбирает JSON', () => {
    expect(parseBody('application/json', '{"event":"ONTASKADD"}')).toEqual({ event: 'ONTASKADD' })
  })

  it('битое тело — пустой объект, а не исключение в обработчике', () => {
    expect(parseBody('application/json', 'не json')).toEqual({})
  })
})

describe('parseTaskAddEvent', () => {
  it('достаёт id задачи, домен и токен приложения', () => {
    const parsed = parseTaskAddEvent(parseBody('application/x-www-form-urlencoded', formBody))
    expect(parsed).toMatchObject({
      event: 'ONTASKADD',
      domain: 'client.bitrix24.ru',
      applicationToken: 'tok',
      taskId: 555,
    })
  })

  // ⚠ auth приходит не всегда: работать идём своими токенами, но домен и токен нужны.
  it('событие без auth разбирается, но без домена', () => {
    const parsed = parseTaskAddEvent({ event: 'ONTASKADD', data: { FIELDS_AFTER: { ID: '7' } } })
    expect(parsed).toMatchObject({ taskId: 7, domain: '' })
  })

  it('без id задачи — не событие для нас', () => {
    expect(parseTaskAddEvent({ event: 'ONTASKADD', data: {} })).toBeNull()
    expect(parseTaskAddEvent({ data: { FIELDS_AFTER: { ID: '5' } } })).toBeNull()
    expect(parseTaskAddEvent({ event: 'ONTASKADD', data: { FIELDS_AFTER: { ID: 'мусор' } } })).toBeNull()
  })

  it('берёт id из FIELDS_BEFORE, если FIELDS_AFTER пуст', () => {
    expect(parseTaskAddEvent({ event: 'ONTASKADD', data: { FIELDS_BEFORE: { ID: '9' } } })?.taskId).toBe(9)
  })
})

describe('parseInstallEvent', () => {
  const install = {
    event: 'ONAPPINSTALL',
    auth: {
      domain: 'client.bitrix24.ru',
      member_id: 'abc',
      application_token: 'tok',
      access_token: 'at',
      refresh_token: 'rt',
      client_endpoint: 'https://client.bitrix24.ru/rest/',
      server_endpoint: 'https://oauth.bitrix24.tech/rest/',
      expires_in: '3600',
    },
  }

  it('достаёт токены установки', () => {
    expect(parseInstallEvent(install)).toMatchObject({
      domain: 'client.bitrix24.ru',
      accessToken: 'at',
      refreshToken: 'rt',
      serverEndpoint: 'https://oauth.bitrix24.tech/rest/',
      expiresIn: 3600,
    })
  })

  it('без токенов установка не засчитывается', () => {
    expect(parseInstallEvent({ auth: { domain: 'a.ru' } })).toBeNull()
  })

  it('нет client_endpoint — собираем из домена', () => {
    const parsed = parseInstallEvent({ auth: { ...install.auth, client_endpoint: '' } })
    expect(parsed?.clientEndpoint).toBe('https://client.bitrix24.ru/rest/')
  })
})

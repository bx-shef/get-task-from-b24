import { describe, expect, it } from 'vitest'
import { parseBody, parseEnvelope, parseInstallEvent, parseTaskAddEvent, unflatten } from '../src/b24/eventPayload.js'

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

describe('unflatten — загрязнение прототипа', () => {
  // ⚠ Найдено ревью и воспроизведено прогоном: `auth[__proto__][polluted]=yes` писал в
  // Object.prototype всего процесса. Разбор идёт ДО сверки application_token, то есть
  // сделать это мог кто угодно.
  it('__proto__ не попадает в прототип', () => {
    unflatten({ 'auth[__proto__][polluted]': 'yes' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('constructor и prototype тоже отбрасываются', () => {
    unflatten({ 'a[constructor][prototype][x]': '1', 'b[prototype][y]': '2' })
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(({} as Record<string, unknown>).y).toBeUndefined()
  })

  it('через parseBody тоже не проходит', () => {
    parseBody('application/x-www-form-urlencoded', 'data%5B__proto__%5D%5Bboom%5D=1')
    expect(({} as Record<string, unknown>).boom).toBeUndefined()
  })

  it('обычные ключи не пострадали', () => {
    expect(unflatten({ 'auth[domain]': 'a.ru' })).toEqual({ auth: { domain: 'a.ru' } })
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

  // ⚠ Адрес портала в разобранном событии НЕ хранится: он берётся только из реестра.
  // Именно через это поле панель ревью нашла SSRF.
  it('адрес портала из тела не сохраняется', () => {
    const parsed = parseInstallEvent({ auth: { ...install.auth, client_endpoint: 'https://evil.tld/rest/' } })
    expect(JSON.stringify(parsed)).not.toContain('evil.tld')
  })

  it('права приложения разбираются из события', () => {
    expect(parseInstallEvent({ auth: { ...install.auth, scope: 'task,user_brief' } })?.scope)
      .toEqual(['task', 'user_brief'])
  })
})

describe('parseEnvelope', () => {
  // ⚠ Шапка разбирается отдельно от полей задачи: у ONAPPUNINSTALL нет id задачи, и
  // разбор «как события о задаче» отбрасывал бы его как непонятое — портал числился
  // бы подключённым после удаления приложения.
  it('читает имя события, домен и токен без полей задачи', () => {
    expect(parseEnvelope({
      event: 'ONAPPUNINSTALL',
      auth: { domain: 'client.bitrix24.ru', member_id: 'm', application_token: 'tok' },
    })).toEqual({
      event: 'ONAPPUNINSTALL',
      domain: 'client.bitrix24.ru',
      memberId: 'm',
      applicationToken: 'tok',
    })
  })

  it('имя события приводится к верхнему регистру', () => {
    expect(parseEnvelope({ event: 'onTaskAdd' }).event).toBe('ONTASKADD')
  })

  it('пустое тело не роняет разбор', () => {
    expect(parseEnvelope({})).toEqual({ event: '', domain: '', memberId: '', applicationToken: '' })
  })
})

/**
 * Транспорт переехал на официальный SDK, и вместе с ним обязаны были переехать защиты,
 * которые нашло ревью: запрет редиректов (307 сохраняет тело — токен уехал бы на чужой
 * хост) и наш таймаут.
 *
 * ⚠ Сквозной прогон против локального портала здесь невозможен: `B24Hook` строит адрес
 * жёстко как `https://…` (проверено по исходнику библиотеки), а поднимать TLS ради
 * этого дороже пользы. Поэтому защита проверяется в двух местах: что настройка
 * навешена на настоящего клиента SDK, и что сама настройка делает то, что мы про неё
 * утверждаем — на живом HTTP-сервере.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { B24Hook } from '@bitrix24/b24jssdk'
import { afterEach, describe, expect, it } from 'vitest'

import { B24Error } from '../src/b24/errors.js'
import { callSdk, harden, toB24Error } from '../src/b24/sdk.js'

let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

function hookClient() {
  return harden(new B24Hook({ b24Url: 'https://portal.example.by', userId: 1, secret: 'secret' }))
}

describe('защиты транспорта навешаны на клиента SDK', () => {
  it('редиректы запрещены, таймаут наш', () => {
    for (const version of ['v2', 'v3'] as const) {
      const axiosClient = hookClient().getHttpClient(version as never).ajaxClient
      expect(axiosClient.defaults.maxRedirects).toBe(0)
      expect(axiosClient.defaults.timeout).toBe(20_000)
    }
  })

  it('наш клиент действительно не идёт за 307 — проверено на живом сервере', async () => {
    // ⚠ Берём axios ИЗ нашего клиента SDK, а не свой: проверять надо тот экземпляр,
    // который поедет в бой. Свежий axios доказал бы только свойства библиотеки.
    const hits: string[] = []
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      if ((req.url ?? '').includes('start')) {
        res.writeHead(307, { location: '/stolen' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ result: 'ушло не туда' }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo

    const ours = hookClient().getHttpClient('v2' as never).ajaxClient
    await expect(ours.post(`http://127.0.0.1:${port}/start`, { auth: 'секрет' })).rejects.toBeTruthy()

    // Главное не текст ошибки, а что второго запроса — с тем же телом — не случилось.
    expect(hits.some((url) => url.includes('stolen'))).toBe(false)
  })
})

describe('перевод ошибок SDK в наши', () => {
  it('протухший токен — неповторяемый: повтор с тем же токеном бессмысленен', () => {
    const error = toB24Error(Object.assign(new Error('token expired'), { code: 'expired_token', status: 401 }))
    expect(error).toBeInstanceOf(B24Error)
    expect(error.code).toBe('expired_token')
    expect(error.retryable).toBe(false)
  })

  it('перегруженный портал — повторяемый: задача не должна теряться', () => {
    expect(toB24Error(Object.assign(new Error('busy'), { code: 'QUERY_LIMIT_EXCEEDED', status: 503 })).retryable).toBe(
      true,
    )
    expect(toB24Error(Object.assign(new Error('bad gateway'), { code: 'SOMETHING', status: 502 })).retryable).toBe(true)
  })

  it('свою ошибку не переписывает', () => {
    const mine = new B24Error('уже наша', 'NOT_INSTALLED', false)
    expect(toB24Error(mine)).toBe(mine)
  })
})

describe('разбор ответа портала', () => {
  /** Клиент-заглушка: проверяем НАШУ распаковку, а не сеть. */
  function stub(response: unknown) {
    return {
      actions: { v2: { call: { make: async () => response } } },
    } as never
  }

  it('отдаёт result', async () => {
    const ok = { isSuccess: true, getData: () => ({ result: { id: '1517' } }) }
    await expect(callSdk(stub(ok), 'tasks.task.get', {})).resolves.toEqual({ id: '1517' })
  })

  it('пустой список — валидный ответ: так приходит удалённая задача', async () => {
    const ok = { isSuccess: true, getData: () => ({ result: [] }) }
    await expect(callSdk(stub(ok), 'tasks.task.get', {})).resolves.toEqual([])
  })

  it('ответ без result — повторяемая ошибка, а не молчаливый undefined', async () => {
    const odd = { isSuccess: true, getData: () => ({}) }
    await expect(callSdk(stub(odd), 'tasks.task.get', {})).rejects.toMatchObject({
      code: 'NO_RESULT',
      retryable: true,
    })
  })
})

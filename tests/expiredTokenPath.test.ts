/**
 * Путь «портал сказал: токен протух» — самый дорогой в сервисе: если код ошибки не
 * доедет до `withPortalAuth`, продление не запустится, и перенос задачи умрёт
 * окончательно, хотя чинить нечего.
 *
 * ⚠ Тест написан по боевому инциденту 2026-09-15 (разбор — в `docs/WORKLOG.md`): SDK
 * заворачивает ЛЮБОЕ не-axios исключение из обработчика продления в свою `AjaxError` с
 * кодом `JSSDK_UNKNOWN_ERROR`, и наш код переставал узнавать `expired_token`.
 *
 * ⚠⚠ И он же — пример теста, который проходил по НЕВЕРНОЙ причине. Токену не давали
 * срока жизни, SDK считал его протухшим и бросал `expired_token`, НЕ ОТПРАВИВ запрос;
 * тест видел нужный код ошибки и был зелёным, а сервис в это время не мог позвать
 * портал вообще (боевая авария 2026-09-16). Поэтому здесь теперь считаются ЗАПРОСЫ,
 * дошедшие до портала: утверждение «ошибка пришла от портала» без этого счётчика
 * ничего не значит.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { callSdk, createPortalClient, toB24Error } from '../src/b24/sdk.js'
import { B24Error } from '../src/b24/errors.js'

let server: Server | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

describe('портал отвечает «токен протух»', () => {
  it('код expired_token доезжает до слоя продления, а не тонет в обёртке SDK', async () => {
    let requests = 0
    server = createServer((_req, res) => {
      requests++
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'expired_token', error_description: 'The access token provided has expired' }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo

    const client = createPortalClient({
      accessToken: 'по нашим данным живой',
      clientEndpoint: `http://127.0.0.1:${port}/rest/`,
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    await expect(callSdk(client, 'tasks.task.get', { taskId: 1 })).rejects.toMatchObject({ code: 'expired_token' })
    // ⚠ Вот ради этой строки тест переписан: ошибка обязана прийти ОТ ПОРТАЛА.
    expect(requests).toBeGreaterThan(0)
  }, 30_000)

  // ⚠ Прямой замер аварии 2026-09-16: обычный вызов с живым токеном обязан дойти до
  // портала и вернуть ответ. Раньше он не отправлялся вовсе — запросов было ноль.
  it('вызов с живым токеном доходит до портала и возвращает ответ', async () => {
    let requests = 0
    server = createServer((_req, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'application/json' })
      // Блок `time` — как у настоящего портала: SDK читает из него счётчик нагрузки,
      // и без него разбор ответа падает.
      res.end(JSON.stringify({
        result: { task: { id: 1 } },
        time: { start: 0, finish: 0, duration: 0, processing: 0, date_start: '', date_finish: '', operating_reset_at: 0, operating: 0 },
      }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo

    const client = createPortalClient({
      accessToken: 'живой',
      clientEndpoint: `http://127.0.0.1:${port}/rest/`,
      expiresAt: new Date(Date.now() + 3_600_000),
    })

    await expect(callSdk(client, 'tasks.task.get', { taskId: 1 })).resolves.toMatchObject({ task: { id: 1 } })
    expect(requests).toBe(1)
  }, 30_000)

  it('обёртка JSSDK_UNKNOWN_ERROR разворачивается в исходную ошибку', () => {
    // Так выглядит то, что SDK отдаёт наружу, когда наш обработчик продления бросил.
    const ours = new B24Error('токен портала протух', 'expired_token', false)
    const wrapped = Object.assign(new Error('токен портала протух'), { code: 'JSSDK_UNKNOWN_ERROR', status: 0 })
    Object.defineProperty(wrapped, 'originalError', { value: ours, enumerable: false })

    expect(toB24Error(wrapped)).toBe(ours)
  })
})

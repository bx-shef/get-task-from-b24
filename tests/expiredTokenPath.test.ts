/**
 * Путь «портал сказал: токен протух» — самый дорогой в сервисе: если код ошибки не
 * доедет до `withPortalAuth`, продление не запустится, и перенос задачи умрёт
 * окончательно, хотя чинить нечего.
 *
 * ⚠ Тест написан по боевому инциденту 2026-09-15 (`portal.standartno.by`, задача
 * 120378): SDK заворачивает ЛЮБОЕ не-axios исключение из обработчика продления в свою
 * `AjaxError` с кодом `JSSDK_UNKNOWN_ERROR`, и наш код переставал узнавать `expired_token`.
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
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'expired_token', error_description: 'The access token provided has expired' }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server!.address() as AddressInfo

    const client = createPortalClient({
      accessToken: 'протухший',
      clientEndpoint: `http://127.0.0.1:${port}/rest/`,
    })

    await expect(callSdk(client, 'tasks.task.get', { taskId: 1 })).rejects.toMatchObject({ code: 'expired_token' })
  }, 30_000)

  it('обёртка JSSDK_UNKNOWN_ERROR разворачивается в исходную ошибку', () => {
    // Так выглядит то, что SDK отдаёт наружу, когда наш обработчик продления бросил.
    const ours = new B24Error('токен портала протух', 'expired_token', false)
    const wrapped = Object.assign(new Error('токен портала протух'), { code: 'JSSDK_UNKNOWN_ERROR', status: 0 })
    Object.defineProperty(wrapped, 'originalError', { value: ours, enumerable: false })

    expect(toB24Error(wrapped)).toBe(ours)
  })
})

/**
 * Создание issue в репозитории клиента.
 *
 * ⚠ Проверяется против НАСТОЯЩЕГО HTTP-сервера: «токен не утёк» и «за редиректом не
 * пошли» нельзя проверить моком `fetch` — именно эти свойства живут в реальном запросе.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createIssue } from '../src/github/issues.js'
import { B24Error } from '../src/b24/errors.js'

const TOKEN = 'ghp_SecretOwnerToken0123456789'
const repo = { owner: 'bx-shef', repo: 'client' }

let server: Server | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

/** Поднимает подставной GitHub и подменяет адрес API на него. */
async function startGithub(reply: (url: string) => { status: number; headers?: Record<string, string>; body: unknown }) {
  const hits: { url: string; auth: string | undefined }[] = []
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', auth: req.headers.authorization })
    const answer = reply(req.url ?? '')
    res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers })
    res.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server!.address() as AddressInfo

  // ⚠ Адрес API в модуле — константа, поэтому подменяем сам fetch и переписываем хост.
  const real = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace('https://api.github.com', `http://127.0.0.1:${port}`)
    return real(url, init)
  })

  return { hits }
}

describe('создание issue', () => {
  it('возвращает номер и ссылку', async () => {
    await startGithub(() => ({
      status: 201,
      body: { number: 17, html_url: 'https://github.com/bx-shef/client/issues/17' },
    }))

    await expect(createIssue(TOKEN, repo, { title: 'Счёт', body: 'текст' })).resolves.toEqual({
      number: 17,
      url: 'https://github.com/bx-shef/client/issues/17',
    })
  })

  it('идёт по адресу нужного репозитория и несёт токен только в заголовке', async () => {
    const { hits } = await startGithub(() => ({ status: 201, body: { number: 1, html_url: '' } }))
    await createIssue(TOKEN, repo, { title: 'x', body: 'y' })

    expect(hits[0]?.url).toBe('/repos/bx-shef/client/issues')
    expect(hits[0]?.auth).toBe(`Bearer ${TOKEN}`)
    // В самом адресе токена быть не должно ни при каких обстоятельствах.
    expect(hits[0]?.url).not.toContain(TOKEN)
  })

  it('отказ GitHub не выносит токен в текст ошибки', async () => {
    // ⚠ Контракт, который документация обещает как гарантию: токен не попадает ни в
    // отчёт, ни в сообщение об ошибке. Иначе он уедет владельцу в Телеграм и в логи.
    await startGithub(() => ({ status: 404, body: { message: 'Not Found' } }))

    const error = await createIssue(TOKEN, repo, { title: 'x', body: 'y' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(B24Error)
    const dump = JSON.stringify({ ...(error as B24Error), message: (error as Error).message, stack: (error as Error).stack })
    expect(dump).not.toContain(TOKEN)
    expect((error as B24Error).retryable).toBe(false)
  })

  it('перегруженный GitHub — повторяемо, «нет такого репозитория» — нет', async () => {
    await startGithub(() => ({ status: 503, body: { message: 'Service Unavailable' } }))
    await expect(createIssue(TOKEN, repo, { title: 'x', body: 'y' })).rejects.toMatchObject({ retryable: true })
  })

  it('за редиректом не идём: в заголовке токен', async () => {
    const { hits } = await startGithub((url) =>
      url.includes('/issues')
        ? { status: 307, headers: { location: '/stolen' }, body: {} }
        : { status: 201, body: { number: 99, html_url: '' } },
    )

    await expect(createIssue(TOKEN, repo, { title: 'x', body: 'y' })).rejects.toBeInstanceOf(B24Error)
    expect(hits.some((h) => h.url.includes('stolen'))).toBe(false)
  })

  it('ответ без номера — повторяемая ошибка, а не issue без ссылки', async () => {
    await startGithub(() => ({ status: 201, body: { html_url: 'https://github.com/x/y/issues/1' } }))
    await expect(createIssue(TOKEN, repo, { title: 'x', body: 'y' })).rejects.toMatchObject({
      code: 'GITHUB_NO_NUMBER',
      retryable: true,
    })
  })
})

/**
 * Тонкий слой поверх REST Битрикс24: наш портал — через входящий вебхук,
 * портал клиента — по OAuth. Учёт вызываемых методов — docs/B24_EVENTS.md.
 */
import { B24Error, EXPIRED_TOKEN_CODES, isRetryable } from './errors.js'
import type { PortalAuth } from '../store/portalTokens.js'

const TIMEOUT_MS = 20_000

interface B24Response<T> {
  result?: T
  error?: string
  error_description?: string
}

async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // ⚠ За редиректами не идём. Ревью доказало прогоном: 307 сохраняет метод и тело,
      // undici идёт за кросс-доменным редиректом молча — и токен портала (а при
      // продлении и `client_secret`) уезжает на чужой хост, минуя весь allow-list,
      // который проверяет только ПЕРВЫЙ адрес.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    // ⚠ Сеть — всегда повторяемо: недоступность портала не делает задачу невалидной.
    throw new B24Error(`сеть: ${(cause as Error).message}`, 'NETWORK', true)
  }

  const payload = (await response.json().catch(() => ({}))) as B24Response<T>

  if (payload.error) {
    const code = payload.error
    throw new B24Error(
      payload.error_description ?? code,
      code,
      EXPIRED_TOKEN_CODES.has(code) ? false : isRetryable(code, response.status),
    )
  }

  if (!response.ok) {
    throw new B24Error(`HTTP ${response.status}`, `HTTP_${response.status}`, isRetryable('', response.status))
  }

  if (payload.result === undefined) {
    throw new B24Error('портал ответил без result', 'NO_RESULT', true)
  }

  return payload.result
}

/** Вызов метода в НАШЕМ портале через входящий вебхук. */
export function callWebhook<T>(webhookUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  return post<T>(`${webhookUrl.replace(/\/+$/, '')}/${method}.json`, params)
}

/** Вызов метода на портале КЛИЕНТА по OAuth-токену. */
export function callPortal<T>(
  auth: Pick<PortalAuth, 'accessToken' | 'clientEndpoint'>,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const base = auth.clientEndpoint.replace(/\/+$/, '')
  return post<T>(`${base}/${method}.json`, { ...params, auth: auth.accessToken })
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  return (await response.json().catch(() => ({}))) as TokenResponse
}

export interface RefreshedTokens {
  accessToken: string
  refreshToken: string
  expiresAt: Date
}

/**
 * Адрес сервера авторизации приходит в событии (`auth.server_endpoint`) и указывает
 * на `/rest/`; сам обмен токенов живёт по `/oauth/token/` того же хоста.
 *
 * ⚠ Хост берём из события, а не хардкодим: у порталов в разных облаках он разный,
 * а зашитый адрес отвалился бы ровно у части клиентов и молча. Но принимаем его
 * только из allow-list (`isKnownOauthHost`): адрес из тела запроса — это адрес, куда
 * уедет `client_secret`, и доверять ему на слово нельзя.
 */
export function tokenEndpoint(serverEndpoint: string): string {
  return new URL('/oauth/token/', serverEndpoint).toString()
}

/**
 * Сервер авторизации по умолчанию.
 *
 * ⚠ `oauth.bitrix24.tech`, а не `oauth.bitrix.info`: документация называет доверенным
 * именно его — «все операции с секретным кодом приложения должны проводиться
 * исключительно с сервером авторизации oauth.bitrix24.tech». Найдено вторым циклом ревью.
 */
export const DEFAULT_OAUTH_ENDPOINT = 'https://oauth.bitrix24.tech/rest/'

/** Точный список хостов сервера авторизации. */
const KNOWN_OAUTH_HOSTS = new Set(['oauth.bitrix24.tech', 'oauth.bitrix.info'])

/**
 * ⚠ Без этой проверки посторонний, приславший установку со своим `server_endpoint`,
 * получал бы `client_id` и `client_secret` портала прямым текстом при первом же
 * продлении токена (находка ревью).
 *
 * ⚠ Список точный, без «любой поддомен `*.bitrix24.tech`»: шире, чем нужно, — значит
 * шире, чем безопасно.
 */
export function isKnownOauthHost(serverEndpoint: string): boolean {
  try {
    const url = new URL(serverEndpoint)
    // ⚠ Проверяем и то, что в URL нет логина с паролем: `https://oauth.bitrix24.tech@evil.tld/`
    // имеет hostname `evil.tld`, но глазами читается как доверенный адрес.
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return KNOWN_OAUTH_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export async function refreshTokens(
  serverEndpoint: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<RefreshedTokens> {
  // ⚠ POST с телом, а не GET с query: в query-строке `client_secret` осел бы в
  // access-логах сервера авторизации и любого промежуточного прокси (находка ревью).
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  })

  const endpoint = tokenEndpoint(serverEndpoint)

  // ⚠ Редиректам не следуем: продление несёт `client_secret`, и 302 на чужой хост
  // увёл бы секрет туда вместе с телом запроса.
  const common = { redirect: 'error' as const, signal: AbortSignal.timeout(TIMEOUT_MS) }

  let payload: TokenResponse
  let status: number
  try {
    const first = await fetch(endpoint, {
      ...common,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    status = first.status
    payload = await readTokenResponse(first)

    // ⚠ POST документацией НЕ подтверждён: единственная описанная форма — GET с
    // query-строкой. POST выбран, чтобы `client_secret` не оседал в access-логах, но
    // ставить на непроверенное допущение всю работу с порталом нельзя: цена промаха —
    // «клиенту надо переустановить приложение» у всех клиентов сразу и через час после
    // запуска. Поэтому при отказе повторяем документированной формой. Найдено вторым
    // циклом ревью; после живого замера на первом портале лишнюю ветку убрать.
    if (!payload.access_token) {
      const url = new URL(endpoint)
      for (const [key, value] of body) url.searchParams.set(key, value)
      const second = await fetch(url, common)
      status = second.status
      payload = await readTokenResponse(second)
    }
  } catch (cause) {
    throw new B24Error(`сеть при продлении токена: ${(cause as Error).message}`, 'NETWORK', true)
  }

  if (!payload.access_token || !payload.refresh_token) {
    // ⚠ Повторяемость решает СТАТУС, а не сам факт отказа. Раньше любой ответ без
    // токенов считался невосстановимым — а после того, как флаг стал останавливать
    // очередь (`UnrecoverableError`), это означало: сервер авторизации ответил 502
    // (обычное дело) → задача потеряна окончательно, а человек читает «клиенту надо
    // переустановить приложение». Найдено вторым циклом ревью.
    const retryable = isRetryable(payload.error ?? '', status)
    throw new B24Error(
      payload.error_description ?? payload.error ?? `сервер авторизации ответил ${status}`,
      payload.error ?? 'REFRESH_FAILED',
      retryable,
    )
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
  }
}

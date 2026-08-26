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

/** Известные хосты сервера авторизации Битрикс24. */
export const DEFAULT_OAUTH_ENDPOINT = 'https://oauth.bitrix.info/rest/'

/**
 * ⚠ Без этой проверки посторонний, приславший установку со своим `server_endpoint`,
 * получал бы `client_id` и `client_secret` портала прямым текстом при первом же
 * продлении токена (находка ревью).
 */
export function isKnownOauthHost(serverEndpoint: string): boolean {
  let host: string
  try {
    const url = new URL(serverEndpoint)
    if (url.protocol !== 'https:') return false
    host = url.hostname.toLowerCase()
  } catch {
    return false
  }
  return host === 'oauth.bitrix.info' || host === 'oauth.bitrix24.tech' || host.endsWith('.bitrix24.tech')
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

  let response: Response
  try {
    response = await fetch(tokenEndpoint(serverEndpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    throw new B24Error(`сеть при продлении токена: ${(cause as Error).message}`, 'NETWORK', true)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!payload.access_token || !payload.refresh_token) {
    // ⚠ Невозможность продлить токен НЕ повторяема: клиент переустанавливает приложение.
    throw new B24Error(
      payload.error_description ?? payload.error ?? 'портал не выдал токены',
      payload.error ?? 'REFRESH_FAILED',
      false,
    )
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000),
  }
}

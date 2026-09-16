/**
 * Тонкий слой поверх REST Битрикс24: наш портал — через входящий вебхук,
 * портал клиента — по OAuth. Учёт вызываемых методов — docs/B24_EVENTS.md.
 */
import { B24Error, isRetryable } from './errors.js'
import { DEFAULT_OAUTH_ENDPOINT, isKnownOauthHost, tokenEndpoint } from './oauthHosts.js'
import { callSdk, callSdkV3, createHookClient, createPortalClient, type PortalClientAuth } from './sdk.js'
import type { TypeB24 } from '@bitrix24/b24jssdk'

// ⚠ Переэкспорт ради тех, кто уже импортирует это отсюда (обработчик установки):
// один факт — одно место, но и ломать чужие импорты ради переезда незачем.
export { DEFAULT_OAUTH_ENDPOINT, isKnownOauthHost, tokenEndpoint }

const TIMEOUT_MS = 20_000

/**
 * ⚠ Клиент нашего портала переиспользуется: создание тянет за собой axios-инстанс и
 * менеджер лимитов портала, а нам нужен один на портал, а не один на вызов — иначе учёт
 * лимитов обнулялся бы каждым вызовом и терял смысл.
 *
 * ⚠ Хранится ПАРОЙ, а не картой «адрес → клиент»: адрес вебхука — это секрет, и делать
 * из него долгоживущий ключ коллекции незачем. Вебхук у нас ровно один, из конфигурации;
 * смена адреса просто пересоздаёт клиента. Найдено панелью.
 */
let hookClient: { url: string; client: TypeB24 } | undefined

/** Вызов метода в НАШЕМ портале через входящий вебхук. */
export function callWebhook<T>(webhookUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  if (hookClient?.url !== webhookUrl) {
    hookClient = { url: webhookUrl, client: createHookClient(webhookUrl) }
  }
  return callSdk<T>(hookClient.client, method, params)
}

/** Вызов метода REST v3 в НАШЕМ портале: часть методов живёт только там. */
export function callWebhookV3<T>(webhookUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
  if (hookClient?.url !== webhookUrl) {
    hookClient = { url: webhookUrl, client: createHookClient(webhookUrl) }
  }
  return callSdkV3<T>(hookClient.client, method, params)
}

/**
 * Вызов метода на портале КЛИЕНТА по OAuth-токену.
 *
 * ⚠ Клиент не кэшируется: токен живёт час и меняется продлением, а ключом кэша был бы
 * сам токен — то есть кэш рос бы и хранил протухшее.
 */
export function callPortal<T>(
  auth: PortalClientAuth,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return callSdk<T>(createPortalClient(auth), method, params)
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

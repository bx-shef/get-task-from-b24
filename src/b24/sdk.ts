/**
 * Тонкая обёртка над официальным SDK Битрикс24: он берёт на себя транспорт и учёт
 * лимитов портала, а мы оставляем за собой то, что нашло ревью и чего у SDK нет.
 *
 * ⚠ Что обязательно навешивается поверх SDK (`harden`), и почему:
 *
 * 1. **Редиректы запрещены.** SDK ходит через axios, а у axios по умолчанию
 *    `maxRedirects: 5`. На 307 тело запроса сохраняется — то есть токен портала уехал
 *    бы на чужой хост. Ровно это ревью уже ловило в нашем `fetch` (там было
 *    `redirect: 'error'`), и терять защиту при переезде нельзя.
 * 2. **Наш таймаут.** У SDK по умолчанию 30 секунд; у нас 20 — столько, сколько
 *    обработчик события готов ждать, не подвешивая воркер очереди.
 *
 * ⚠ Ошибки SDK переводятся в наш `B24Error`: от флага «повторяемо» зависит, вернёт ли
 * BullMQ задание в очередь или похоронит его. Чужой класс ошибки этого флага не несёт.
 */
import { ApiVersion, B24Hook, B24OAuth, type TypeB24 } from '@bitrix24/b24jssdk'

import { B24Error, EXPIRED_TOKEN_CODES, isRetryable } from './errors.js'
import { DEFAULT_OAUTH_ENDPOINT } from './oauthHosts.js'

const TIMEOUT_MS = 20_000

/** Что нужно, чтобы позвать метод на портале клиента: токен и его адрес REST. */
export interface PortalAuth {
  accessToken: string
  clientEndpoint: string
}

/**
 * ⚠ Экспортируется ради теста: он строит клиента напрямую и проверяет, что защита
 * действительно навешена. Иначе она держалась бы на честном слове — а именно её здесь
 * легче всего потерять при обновлении SDK.
 */
export function harden(client: TypeB24): TypeB24 {
  for (const version of [ApiVersion.v2, ApiVersion.v3]) {
    // ⚠ Версии может не оказаться — тогда пропускаем, а не роняем клиент.
    let http
    try {
      http = client.getHttpClient(version)
    } catch {
      continue
    }
    http.ajaxClient.defaults.maxRedirects = 0
    http.ajaxClient.defaults.timeout = TIMEOUT_MS
  }
  return client
}

/** Клиент нашего портала: входящий вебхук, токен постоянный. */
export function createHookClient(webhookUrl: string): TypeB24 {
  // ⚠ Через `fromWebhookUrl`, а не конструктор: он проверяет формат и HTTPS и при
  // отказе НЕ печатает сам адрес — а в нём секрет.
  return harden(B24Hook.fromWebhookUrl(webhookUrl.replace(/\/+$/, '')))
}

/**
 * Клиент портала клиента — только на вызов, без продления.
 *
 * ⚠ Продление здесь намеренно ЗАПРЕЩЕНО. SDK умеет обновлять токен сам, но Битрикс24
 * ротирует `refresh_token`: обновление в обход нашего кода оставило бы в базе прежний,
 * уже недействительный — и портал отвалился бы молча. Поэтому обмен идёт одним путём —
 * в `withPortalAuth`, под advisory-lock и с записью результата, а SDK получает
 * обработчик, который честно говорит «протух» и отдаёт решение слою выше.
 */
export function createPortalClient(auth: PortalAuth): TypeB24 {
  const endpoint = auth.clientEndpoint.replace(/\/+$/, '')
  const domain = new URL(endpoint).host

  const client = new B24OAuth(
    {
      accessToken: auth.accessToken,
      // ⚠ Поля установки, которых у нас нет и быть не должно: `application_token` мы
      // храним хэшем, id пользователя и состав прав не сохраняем вовсе. Для вызова
      // метода они не нужны, а продления здесь не происходит (см. выше).
      refreshToken: '',
      applicationToken: '',
      userId: 0,
      scope: '',
      status: 'L',
      expires: 0,
      expiresIn: 0,
      domain,
      memberId: '',
      clientEndpoint: endpoint + '/',
      serverEndpoint: DEFAULT_OAUTH_ENDPOINT,
    },
    { clientId: '', clientSecret: '' },
  )

  client.setCustomRefreshAuth(async () => {
    throw new B24Error('токен портала протух', 'expired_token', false)
  })

  return harden(client)
}

interface SdkLikeError {
  code?: unknown
  status?: unknown
  message?: unknown
}

/**
 * Ошибки самой библиотеки: повтор их не лечит.
 *
 * ⚠ Единственное исключение из правила «нет ответа — повторяем» (см. ниже). Такие коды
 * означают, что мы неправильно позвали SDK, — это чинится правкой кода, а не ретраем.
 */
const PERMANENT_SDK_CODE = /^JSSDK_/

/**
 * Перевод ошибки SDK в нашу.
 *
 * ⚠ Коды протухшего токена помечаются НЕповторяемыми намеренно: повтор с тем же токеном
 * бессмысленен, продлением занимается слой выше (`withPortalAuth`).
 *
 * ⚠ **Ошибка без HTTP-статуса считается повторяемой**, и это не мелочь. Прежний слой на
 * `fetch` любое сетевое исключение бросал как `NETWORK, retryable: true`. У axios внутри
 * SDK обрыв соединения приходит с кодом ОС (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`) и
 * без статуса: такой код не входит ни в один наш список, и классификация «по списку»
 * пометила бы его неповторяемым. Для очереди это `UnrecoverableError` — то есть задача
 * клиента терялась бы окончательно от обычной недоступности портала, ровно от того,
 * ради чего очередь и заведена. Найдено панелью и подтверждено прогоном на ECONNREFUSED.
 */
export function toB24Error(error: unknown): B24Error {
  if (error instanceof B24Error) return error

  // ⚠ SDK заворачивает ЛЮБОЕ не-axios исключение, вылетевшее внутри HTTP-вызова, в свою
  // `AjaxError` с кодом `JSSDK_UNKNOWN_ERROR`, пряча исходное в `originalError`. Для нас
  // это не мелочь: так терялся код `expired_token`, который бросает наш обработчик
  // продления, — и слой `withPortalAuth` переставал узнавать «надо продлить токен».
  // Перенос задачи умирал окончательно там, где чинить было нечего.
  // Боевой инцидент 2026-09-15, разбор — в docs/WORKLOG.md. ⚠ Адрес портала клиента
  // сюда не пишем: конвенция проекта держит их вне кода, место разбора — журнал.
  const original = (error as { originalError?: unknown } | null)?.originalError
  if (original instanceof B24Error) return original

  const sdk = error as SdkLikeError
  const code = typeof sdk.code === 'string' && sdk.code ? sdk.code : 'SDK_ERROR'
  const status = typeof sdk.status === 'number' ? sdk.status : 0
  const message = typeof sdk.message === 'string' && sdk.message ? sdk.message : String(error)

  return new B24Error(message, code, isRetryableSdkError(code, status))
}

function isRetryableSdkError(code: string, status: number): boolean {
  if (EXPIRED_TOKEN_CODES.has(code)) return false
  if (isRetryable(code, status)) return true
  // Портал ответил (4xx) — виноват запрос, повтор ничего не изменит.
  if (status > 0) return false
  if (PERMANENT_SDK_CODE.test(code)) return false
  // Ответа не было вовсе: сеть, DNS, обрыв. Повторяем — как делал прежний слой.
  return true
}

/**
 * Вызов метода REST v3.
 *
 * ⚠ Отдельно от v2 не ради симметрии: часть методов живёт ТОЛЬКО в v3 — например
 * `tasks.task.chat.message.send`, её адрес `/rest/api/…`. Вызов такого метода через v2
 * просто не найдёт его. Какой версией звать — свойство метода, а не наше предпочтение.
 */
export async function callSdkV3<T>(client: TypeB24, method: string, params: Record<string, unknown>): Promise<T> {
  try {
    const response = await client.actions.v3.call.make({ method, params })
    if (!response.isSuccess) {
      const first = response.getErrors().next()
      throw toB24Error(first.done ? new Error(response.getErrorMessages().join('; ')) : first.value)
    }
    const payload = response.getData() as { result?: unknown } | undefined
    if (payload?.result === undefined) throw new B24Error('портал ответил без result', 'NO_RESULT', true)
    return payload.result as T
  } catch (error) {
    throw toB24Error(error)
  }
}

/**
 * Вызов метода портала. Возвращает `result`, как это делал наш прежний слой.
 *
 * ⚠ Через `actions.v2.call`, а не `callMethod`: последний в версии 2.2.0 объявлен
 * устаревшим и отвечает `JSSDK_CORE_DEPRECATED_METHOD` вместо вызова.
 */
export async function callSdk<T>(client: TypeB24, method: string, params: Record<string, unknown>): Promise<T> {
  let payload: unknown
  try {
    const response = await client.actions.v2.call.make({ method, params })
    if (!response.isSuccess) {
      // ⚠ getErrors() отдаёт итератор, а не массив: берём первую ошибку через next().
      const first = response.getErrors().next()
      throw toB24Error(first.done ? new Error(response.getErrorMessages().join('; ')) : first.value)
    }
    payload = response.getData()
  } catch (error) {
    throw toB24Error(error)
  }

  const result = (payload as { result?: unknown } | undefined)?.result
  // ⚠ `undefined` — это «портал ответил не тем, чего мы ждём», и это повторяемо:
  // так выглядит и разовый сбой на его стороне. Пустой массив или `null` — валидные
  // ответы (удалённая задача приходит пустым списком), их пропускаем как есть.
  if (result === undefined) {
    throw new B24Error('портал ответил без result', 'NO_RESULT', true)
  }

  return result as T
}

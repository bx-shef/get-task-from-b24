/**
 * Классификация ответов Битрикс24: что имеет смысл повторить, а что повторять бессмысленно.
 *
 * ⚠ Разница не косметическая. Повторяя невосстановимую ошибку («нет такого поля»),
 * очередь тратит попытки и оттягивает момент, когда о беде узнает человек; НЕ повторяя
 * восстановимую («портал занят»), она теряет задачу клиента на ровном месте.
 */
export class B24Error extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'B24Error'
  }
}

const RETRYABLE_CODES = new Set([
  'QUERY_LIMIT_EXCEEDED', // портал просит притормозить
  'OPERATION_TIME_LIMIT', // портал не успел
  'INTERNAL_SERVER_ERROR',
  'ERROR_UNEXPECTED_ANSWER',
  'OVERLOAD_LIMIT',
  // ⚠ Коды транспорта из SDK. `REQUEST_TIMEOUT` особенно коварен: он приходит со
  // статусом 408, то есть выглядит как ответ портала («виноват запрос»), хотя на деле
  // ответа не было вовсе. Без него медленный портал хоронил бы задачу клиента.
  'NETWORK_ERROR',
  'REQUEST_TIMEOUT',
])

/** Токен протух — не ошибка переноса, а повод продлить авторизацию и повторить. */
export const EXPIRED_TOKEN_CODES = new Set(['expired_token', 'invalid_token', 'NO_AUTH_FOUND'])

export function isRetryable(code: string, httpStatus?: number): boolean {
  if (RETRYABLE_CODES.has(code)) return true
  // 5xx, 429 и 408 — состояние портала или канала, а не нашего запроса.
  if (httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 429 || httpStatus === 408)) return true
  return false
}

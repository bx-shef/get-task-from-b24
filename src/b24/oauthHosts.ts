/**
 * Сервер авторизации Битрикс24: куда можно отправлять `client_secret`, а куда нельзя.
 *
 * ⚠ Вынесено в отдельный модуль, чтобы им могли пользоваться и наш слой продления
 * токенов, и адаптер SDK, не импортируя друг друга по кругу.
 */

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

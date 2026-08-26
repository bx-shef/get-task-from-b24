/**
 * Доступ к порталу клиента: берём сохранённые токены, продлеваем когда надо,
 * повторяем вызов один раз, если портал сказал «токен протух».
 */
import { B24Error, EXPIRED_TOKEN_CODES } from './errors.js'
import { refreshTokens } from './rest.js'
import { getPortal, updateAuth, type PortalAuth } from '../store/portalTokens.js'
import type { PortalConfig } from '../domain/portals.js'
import { withAdvisoryLock, type Pool } from '../store/db.js'

export type Auth = Pick<PortalAuth, 'accessToken' | 'clientEndpoint'>

/** Токены плюс срок их жизни: срок нужен, чтобы отличить «свежее» от «устаревшего». */
type LiveAuth = PortalAuth & { expiresAt: Date }

/** Запас до истечения: продлеваем заранее, чтобы токен не протух посреди пары вызовов. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface PortalAccess {
  pool: Pool
  encKey: string
}

/**
 * Продлевает токены и возвращает НОВОЕ состояние.
 *
 * ⚠ Возвращает именно состояние, а не только access-токен: Битрикс24 ротирует
 * `refresh_token`, и прежний после обмена недействителен. Раньше вторая попытка
 * продления брала `stored` с уже потраченным токеном — портал отвечал отказом, и
 * ошибка звучала как «клиенту надо переустановить приложение», хотя переустановка
 * не нужна. Найдено ревью.
 */
async function refreshAndStore(access: PortalAccess, portal: PortalConfig, current: LiveAuth): Promise<LiveAuth> {
  return withAdvisoryLock(access.pool, `refresh:${portal.domain}`, async () => {
    // ⚠ Под локом перечитываем строку: пока мы ждали лока, соседнее задание могло уже
    // продлить токен. Признак «уже продлили» — БОЛЕЕ ПОЗДНИЙ срок жизни, а не иное
    // значение токена: значение отличается и когда строка устарела. Обменивать тот же
    // `refresh_token` второй раз нельзя — Битрикс24 его ротирует, и повтор вернёт отказ.
    const latest = await getPortal(access.pool, portal.domain, access.encKey)
    if (latest && latest.expiresAt.getTime() > current.expiresAt.getTime()) {
      return latest
    }

    const fresh = await refreshTokens(current.serverEndpoint, portal.clientId, portal.clientSecret, current.refreshToken)
    const auth: LiveAuth = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      clientEndpoint: current.clientEndpoint,
      serverEndpoint: current.serverEndpoint,
      expiresAt: fresh.expiresAt,
    }
    await updateAuth(access.pool, portal.domain, auth, fresh.expiresAt, access.encKey)
    return auth
  })
}

/**
 * ⚠ Портала нет в базе — это НЕ повторяемая ошибка: приложение у клиента не
 * установлено (или установка не завершилась), и никакие ретраи этого не изменят.
 * Чинится только участием клиента, поэтому ошибка должна дойти до человека быстро.
 */
export async function withPortalAuth<T>(
  access: PortalAccess,
  portal: PortalConfig,
  fn: (auth: Auth) => Promise<T>,
): Promise<T> {
  const stored = await getPortal(access.pool, portal.domain, access.encKey)
  if (!stored) {
    throw new B24Error(`портал ${portal.domain} не установлен: нет сохранённых токенов`, 'NOT_INSTALLED', false)
  }

  let current: LiveAuth = stored

  if (stored.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
    current = await refreshAndStore(access, portal, current)
  }

  try {
    return await fn({ accessToken: current.accessToken, clientEndpoint: current.clientEndpoint })
  } catch (error) {
    // ⚠ Ровно одна повторная попытка: портал мог отозвать токен раньше срока, но
    // бесконечный цикл «протух → продлили → протух» здесь недопустим.
    if (error instanceof B24Error && EXPIRED_TOKEN_CODES.has(error.code)) {
      const refreshed = await refreshAndStore(access, portal, current)
      return await fn({ accessToken: refreshed.accessToken, clientEndpoint: refreshed.clientEndpoint })
    }
    throw error
  }
}

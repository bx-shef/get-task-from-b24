/**
 * Доступ к порталу клиента: берём сохранённые токены, продлеваем когда надо,
 * повторяем вызов один раз, если портал сказал «токен протух».
 */
import { B24Error, EXPIRED_TOKEN_CODES } from './errors.js'
import { refreshTokens } from './rest.js'
import { getPortal, updateAuth, type PortalAuth } from '../store/portalTokens.js'
import type { PortalConfig } from '../domain/portals.js'
import type { Pool } from '../store/db.js'

export type Auth = Pick<PortalAuth, 'accessToken' | 'clientEndpoint'>

/** Запас до истечения: продлеваем заранее, чтобы токен не протух посреди пары вызовов. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface PortalAccess {
  pool: Pool
  encKey: string
}

async function refreshAndStore(access: PortalAccess, portal: PortalConfig, stored: PortalAuth & { domain: string }): Promise<Auth> {
  const fresh = await refreshTokens(stored.serverEndpoint, portal.clientId, portal.clientSecret, stored.refreshToken)
  const auth: PortalAuth = {
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    clientEndpoint: stored.clientEndpoint,
    serverEndpoint: stored.serverEndpoint,
  }
  await updateAuth(access.pool, portal.domain, auth, fresh.expiresAt, access.encKey)
  return { accessToken: auth.accessToken, clientEndpoint: auth.clientEndpoint }
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

  let auth: Auth = { accessToken: stored.accessToken, clientEndpoint: stored.clientEndpoint }

  if (stored.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
    auth = await refreshAndStore(access, portal, stored)
  }

  try {
    return await fn(auth)
  } catch (error) {
    // ⚠ Ровно одна повторная попытка: портал мог отозвать токен раньше срока, но
    // бесконечный цикл «протух → продлили → протух» здесь недопустим.
    if (error instanceof B24Error && EXPIRED_TOKEN_CODES.has(error.code)) {
      const refreshed = await refreshAndStore(access, portal, stored)
      return await fn(refreshed)
    }
    throw error
  }
}

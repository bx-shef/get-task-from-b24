/**
 * Разбор тела события Битрикс24.
 *
 * ⚠ Портал шлёт событие как `application/x-www-form-urlencoded` с ключами вида
 * `data[FIELDS_AFTER][ID]`, а документация показывает его как JSON. Читать оба вида
 * обязаны мы: если разбор промахнётся, обработчик молча ответит «нечего делать» —
 * и это выглядит как «события не приходят», а не как ошибка.
 */

export interface TaskAddEvent extends EventEnvelope {
  taskId: number
}

/**
 * Ключи, которые нельзя раскладывать в объект.
 *
 * ⚠ Без этого фильтра `auth[__proto__][x]=1` пишет в `Object.prototype` всего процесса —
 * а `parseBody` вызывается ПЕРВОЙ строкой обоих роутов, до сверки `application_token`.
 * То есть загрязнить прототип живого процесса (с пулом Postgres, ioredis и bullmq
 * внутри) мог кто угодно, без всякой авторизации. Найдено ревью, воспроизведено
 * прогоном: `({}).polluted === 'yes'`.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Раскладывает плоские ключи `a[b][c]=1` во вложенный объект. */
export function unflatten(flat: Record<string, string>): Record<string, unknown> {
  // ⚠ Object.create(null): у результата нет прототипа, поэтому даже промах фильтра
  // выше не даёт записи в общий Object.prototype. Два рубежа намеренно.
  const root = Object.create(null) as Record<string, unknown>

  for (const [rawKey, value] of Object.entries(flat)) {
    const path = rawKey
      .replace(/\]/g, '')
      .split('[')
      .filter((part) => part !== '')

    if (path.length === 0 || path.some((part) => FORBIDDEN_KEYS.has(part))) continue

    let node = root
    path.forEach((part, index) => {
      if (index === path.length - 1) {
        node[part] = value
        return
      }
      const next = node[part]
      if (typeof next !== 'object' || next === null) node[part] = Object.create(null)
      node = node[part] as Record<string, unknown>
    })
  }

  return root
}

export function parseBody(contentType: string | undefined, raw: string): Record<string, unknown> {
  if (contentType?.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  const flat: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(raw)) flat[key] = value
  return unflatten(flat)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Достаёт из тела то, без чего работать нельзя.
 *
 * ⚠ `auth` приходит НЕ всегда (документация Битрикс24): если хит не привязан к
 * пользователю, токенов в событии нет. Поэтому из `auth` нам обязателен только
 * `domain` + `application_token`, а работать в портал мы идём своими сохранёнными
 * токенами, а не тем, что пришло в запросе.
 */
export function parseTaskAddEvent(body: Record<string, unknown>): TaskAddEvent | null {
  const data = (typeof body.data === 'object' && body.data !== null ? body.data : {}) as Record<string, unknown>

  const after = (typeof data.FIELDS_AFTER === 'object' && data.FIELDS_AFTER !== null ? data.FIELDS_AFTER : {}) as Record<string, unknown>
  const before = (typeof data.FIELDS_BEFORE === 'object' && data.FIELDS_BEFORE !== null ? data.FIELDS_BEFORE : {}) as Record<string, unknown>

  const rawId = after.ID ?? after.id ?? before.ID ?? before.id
  const taskId = Number(rawId)
  const envelope = parseEnvelope(body)

  if (!envelope.event || !Number.isInteger(taskId) || taskId <= 0) return null

  return { ...envelope, taskId }
}

/** Общая шапка любого события портала: имя, домен и токен приложения. */
export interface EventEnvelope {
  event: string
  domain: string
  memberId: string
  applicationToken: string
}

export function parseEnvelope(body: Record<string, unknown>): EventEnvelope {
  const auth = (typeof body.auth === 'object' && body.auth !== null ? body.auth : {}) as Record<string, string>
  return {
    event: str(body.event).toUpperCase(),
    domain: str(auth.domain),
    memberId: str(auth.member_id),
    applicationToken: str(auth.application_token ?? body.application_token),
  }
}

export interface InstallEvent {
  event: string
  domain: string
  memberId: string
  applicationToken: string
  accessToken: string
  refreshToken: string
  clientEndpoint: string
  serverEndpoint: string
  expiresIn: number
}

export function parseInstallEvent(body: Record<string, unknown>): InstallEvent | null {
  const auth = (typeof body.auth === 'object' && body.auth !== null ? body.auth : body) as Record<string, string>

  const domain = str(auth.domain)
  const accessToken = str(auth.access_token)
  const refreshToken = str(auth.refresh_token)
  if (!domain || !accessToken || !refreshToken) return null

  const clientEndpoint = str(auth.client_endpoint) || `https://${domain}/rest/`
  return {
    event: str(body.event).toUpperCase(),
    domain,
    memberId: str(auth.member_id),
    applicationToken: str(auth.application_token) || str(body.application_token as string),
    accessToken,
    refreshToken,
    clientEndpoint,
    serverEndpoint: str(auth.server_endpoint) || 'https://oauth.bitrix.info/rest/',
    expiresIn: Number(auth.expires_in) > 0 ? Number(auth.expires_in) : 3600,
  }
}

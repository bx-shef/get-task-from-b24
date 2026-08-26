/**
 * Разбор ответов Битрикс24 по задачам и вызовы двух порталов.
 * Разборщики — чистые функции: именно они ломаются молча при смене формата ответа.
 */
import { callPortal, callWebhook } from './rest.js'
import { B24Error } from './errors.js'
import type { SourceTaskFull, TargetTaskFields } from '../domain/taskMapping.js'
import { portalRestUrl } from '../domain/portals.js'
import type { PortalAuth } from '../store/portalTokens.js'

type Auth = Pick<PortalAuth, 'accessToken' | 'clientEndpoint'>

/** Поля задачи метод отдаёт в camelCase, но исторически встречается и ВЕРХНИЙ_РЕГИСТР. */
function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

/**
 * ⚠ id и даты портал отдаёт СТРОКАМИ («555», «2026-08-27T15:00:00+03:00»). Сравнение
 * исполнителя с числом из окружения на нетипизированном ответе давало бы вечное
 * «не тот исполнитель» — то есть тихий отказ переносить вообще всё.
 */
export function parseSourceTask(raw: unknown): SourceTaskFull {
  if (typeof raw !== 'object' || raw === null) {
    throw new B24Error('портал вернул задачу в неожиданном виде', 'BAD_TASK', false)
  }
  const task = raw as Record<string, unknown>

  const id = toNumber(pick(task, 'id', 'ID'))
  const title = pick(task, 'title', 'TITLE')
  const responsibleId = toNumber(pick(task, 'responsibleId', 'RESPONSIBLE_ID'))
  const createdBy = toNumber(pick(task, 'createdBy', 'CREATED_BY'))

  if (id === undefined || typeof title !== 'string' || responsibleId === undefined) {
    throw new B24Error('в ответе портала нет id, названия или исполнителя', 'BAD_TASK', false)
  }

  const description = pick(task, 'description', 'DESCRIPTION')
  const deadline = pick(task, 'deadline', 'DEADLINE')

  return {
    id,
    title,
    responsibleId,
    createdBy: createdBy ?? 0,
    description: typeof description === 'string' ? description : '',
    deadline: typeof deadline === 'string' ? deadline : undefined,
  }
}

/**
 * Ответ `tasks.task.get` — `{ task: {...} }`; `tasks.task.add` — `{ task: { id } }`.
 *
 * ⚠ Страницы REST v3 объявляют в ответе и `task`, и `item` — читаем оба. Без этого
 * смена формы ответа означала бы не ретраи, а мгновенную и окончательную потерю
 * каждой задачи: `parseSourceTask` бросил бы `BAD_TASK` с `retryable: false`.
 */
export function unwrapTask(result: unknown): Record<string, unknown> {
  const wrapper = result as { task?: unknown; item?: unknown } | undefined
  const task = wrapper?.task ?? wrapper?.item ?? result
  if (typeof task !== 'object' || task === null) {
    throw new B24Error('портал ответил без задачи', 'NO_TASK', true)
  }
  return task as Record<string, unknown>
}

/** ФИО постановщика для описания: имя из двух полей, пустое — не пробел. */
export function formatUserName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const user = raw as Record<string, unknown>
  const parts = [pick(user, 'NAME', 'name'), pick(user, 'LAST_NAME', 'lastName')]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
  return parts.length > 0 ? parts.join(' ') : undefined
}

export async function fetchSourceTask(auth: Auth, taskId: number): Promise<SourceTaskFull> {
  // ⚠ Шлём и `taskId`, и `id`: страница метода перечисляет обязательными оба имени,
  // и промах именем означал бы отказ на каждой задаче.
  //
  // ⚠ `select` не передаём НАМЕРЕННО. Документация: «если select не задан, приходит
  // базовый набор полей задачи» — а нам нужен именно базовый. Список имён в ВЕРХНЕМ
  // регистре при camelCase-ответе v3 мог быть не понят методом, и тогда поля просто не
  // пришли бы: `parseSourceTask` бросил бы `BAD_TASK`, который НЕ ретраится, — то есть
  // каждая задача терялась бы мгновенно и окончательно. Найдено вторым циклом ревью.
  const result = await callPortal<unknown>(auth, 'tasks.task.get', { taskId, id: taskId })
  return parseSourceTask(unwrapTask(result))
}

/**
 * Имя постановщика — «по возможности».
 *
 * ⚠ Метод `user.get` требует скоупа `user`, которого у приложения может не быть.
 * Ронять из-за этого перенос нельзя: описание тогда просто скажет «id N» — хуже
 * читается, но задача доезжает.
 */
export async function fetchUserName(auth: Auth, userId: number): Promise<string | undefined> {
  if (!userId) return undefined
  try {
    // ⚠ Фильтром, а не верхнеуровневым ID: метод возвращает ФИЛЬТРОВАННЫЙ СПИСОК, и
    // непонятый параметр означает «отдать всех» — тогда в описание попало бы имя
    // первого сотрудника портала вместо постановщика. Это не падение, а правдоподобно
    // выглядящая неправда в задаче, которую никто не перепроверит. Найдено ревью.
    const result = await callPortal<unknown[]>(auth, 'user.get', { filter: { ID: userId } })
    const user = result?.[0] as Record<string, unknown> | undefined
    // ⚠ И всё равно сверяем, что вернулся именно он.
    if (!user || Number(user.ID ?? user.id) !== userId) return undefined
    return formatUserName(user)
  } catch {
    return undefined
  }
}

export async function createTargetTask(webhookUrl: string, fields: TargetTaskFields): Promise<number> {
  const result = await callWebhook<unknown>(webhookUrl, 'tasks.task.add', { fields })
  const id = toNumber(pick(unwrapTask(result), 'id', 'ID'))
  if (id === undefined) throw new B24Error('портал не вернул id созданной задачи', 'NO_TASK_ID', true)
  return id
}

/**
 * Доказательство, что токены установки выданы НАСТОЯЩИМ порталом.
 *
 * ⚠ Это единственная защита `/b24/install`, и без неё роут был дырой (находка ревью):
 * посторонний слал нам тело с доменом клиента из реестра и своими `access_token`,
 * `application_token` и `server_endpoint` — мы это сохраняли, после чего (а) настоящие
 * события клиента получали 401 и терялись навсегда, и (б) продление токена уходило
 * GET-ом на сервер атакующего вместе с `client_id` и `client_secret` портала.
 *
 * ⚠ Адрес вызова строится ИЗ ДОМЕНА РЕЕСТРА, а не из тела запроса. Подделать ответ
 * можно только владея самим порталом — а это и есть то, что мы проверяем.
 */
export async function verifyPortalToken(domain: string, accessToken: string): Promise<{ code?: string }> {
  const info = await callPortal<{ CODE?: string; code?: string }>(
    { accessToken, clientEndpoint: portalRestUrl(domain) },
    'app.info',
    {},
  )
  // ⚠ `CODE` у локального приложения — это его `client_id`. Сверка с реестром закрывает
  // остаток дыры: без неё установку можно перезаписать валидным токеном ЛЮБОГО другого
  // приложения того же портала — `app.info` на него ответит успешно. Найдено вторым
  // циклом ревью.
  const code = info?.CODE ?? info?.code
  return { code: typeof code === 'string' ? code : undefined }
}

/**
 * События, на которые подписываемся при установке.
 *
 * ⚠ `onAppUpdate` и `onAppUninstall` подписываются ЯВНО. Документация нигде не обещает,
 * что они доставляются на callback установки сами по себе, — а без них два тихих отказа:
 * обновлённый `application_token` не сохранится (и все события начнут получать 401 при
 * внешне исправной установке), а токены удалённого приложения останутся в базе
 * действующей установкой. Найдено вторым циклом ревью.
 */
export const BOUND_EVENTS = ['onTaskAdd', 'onAppUpdate', 'onAppUninstall'] as const

/** Повторный вызов безопасен: «обработчик уже есть» — это норма при переустановке. */
export async function bindEvent(auth: Auth, event: string, handlerUrl: string): Promise<void> {
  try {
    await callPortal(auth, 'event.bind', { event, handler: handlerUrl })
  } catch (error) {
    if (error instanceof B24Error && /handler.*already|ERROR_HANDLER_ALREADY_FOUND/i.test(error.code + error.message)) {
      return
    }
    throw error
  }
}

export async function bindAppEvents(auth: Auth, handlerUrl: string): Promise<void> {
  for (const event of BOUND_EVENTS) {
    await bindEvent(auth, event, handlerUrl)
  }
}

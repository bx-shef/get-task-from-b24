/**
 * Разбор ответов Битрикс24 по задачам и вызовы двух порталов.
 * Разборщики — чистые функции: именно они ломаются молча при смене формата ответа.
 */
import { callPortal, callWebhook } from './rest.js'
import { B24Error } from './errors.js'
import type { SourceTaskFull, TargetTaskFields } from '../domain/taskMapping.js'
import { portalRestUrl } from '../domain/portals.js'
import { taskListRows, ufValues } from './taskRows.js'
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
  // ⚠ Удалённая или недоступная задача приходит как ПУСТОЙ СПИСОК, а не как ошибка —
  // замерено на боевом портале. Без этой ветки дальше падал `parseSourceTask` с
  // «нет id, названия или исполнителя», и человек в Telegram читал бы про формат
  // ответа вместо «задачу удалили».
  if (Array.isArray(result) && result.length === 0) {
    throw new B24Error('задача не найдена или недоступна (удалена?)', 'TASK_NOT_FOUND', false)
  }

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

/**
 * Размер страницы `tasks.task.list` по умолчанию. Ответ ровно в страницу означает, что
 * фильтр не применён: по одному ID задачи-источника столько задач быть не может.
 */
const PAGE_SIZE = 50

/** Ключ, по которому задача у нас находится обратно: портал клиента + задача в нём. */
export interface TransferKey {
  sourceDomain: string
  sourceTaskId: number
  /** Код поля у нас, где лежит ID задачи клиента. */
  sourceTaskField: string
  /** Код поля у нас, где лежит домен портала клиента. */
  sourceDomainField: string
}

/**
 * Какие из вернувшихся задач ДЕЙСТВИТЕЛЬНО относятся к этой паре — чистая функция.
 *
 * ⚠ Ответ портала перепроверяется здесь целиком, и это не перестраховка. Замерено
 * (docs/PRODUCT.md, раздел 1): непонятый фильтр Битрикс24 не отвергает — он возвращает
 * ВСЁ. На дедупликации это худшая из возможных ошибок: «нашлось пятьдесят» было бы
 * принято за «уже перенесена», и задача клиента не создалась бы никогда и молча.
 *
 * ⚠ ID сравниваем числом, домен — без регистра: портал отдаёт значения строками даже
 * для числового поля, а домен мы храним нормализованным.
 */
export function matchTransferred(result: unknown, key: TransferKey): number[] {
  const found: number[] = []

  for (const row of taskListRows(result)) {
    const id = toNumber(pick(row, 'id', 'ID'))
    if (id === undefined || id <= 0) continue

    // ⚠ Значения читаем списком: множественное UF-поле портал отдаёт массивом.
    const taskIdMatches = ufValues(row, key.sourceTaskField)
      .some((value) => value.trim() !== '' && Number(value) === key.sourceTaskId)
    if (!taskIdMatches) continue

    const wanted = key.sourceDomain.trim().toLowerCase()
    const domainMatches = ufValues(row, key.sourceDomainField)
      .some((value) => value.trim().toLowerCase() === wanted)
    if (!domainMatches) continue

    found.push(id)
  }

  // По возрастанию ID: старшая задача — та, что создана раньше, и именно она остаётся
  // жить, если задач оказалось две (docs/PROCESSING.md → «Дедупликация»).
  return found.sort((a, b) => a - b)
}

/**
 * Перенесённые задачи у нас по паре «портал клиента + задача в нём».
 *
 * ⚠ Это замена журнала переносов: связка живёт в самих задачах, а не во втором месте
 * рядом с ними (docs/PRODUCT.md, раздел 1а).
 */
export async function findTransferredTasks(webhookUrl: string, key: TransferKey): Promise<number[]> {
  const result = await callWebhook<unknown>(webhookUrl, 'tasks.task.list', {
    // ⚠ Фильтр ОБЪЕКТОМ и ровно по ОДНОМУ ключу — ровно в границах замеренного
    // (docs/PRODUCT.md, раздел 1): массив и форма v3 отвергаются с 400, а конъюнкция
    // двух UF-полей на живом портале НЕ проверялась. Домен сверяет наш код ниже, и он
    // всё равно не верит ответу портала — значит второй ключ не купил бы ничего, кроме
    // незамеренного условия на пути, от которого зависит вся дедупликация. Найдено
    // панелью.
    filter: { [key.sourceTaskField]: key.sourceTaskId },
    // ⚠ `ID` в select обязателен: без него сверять будет нечего — каждая строка
    // отбракуется, и дедупликация замолчит навсегда. Стережётся тестом.
    select: ['ID', key.sourceTaskField, key.sourceDomainField],
    // ⚠ Порядок УБЫВАЮЩИЙ, хотя правило дедупликации — «остаётся меньший ID». Причина
    // в отказе, а не в правиле: метод отдаёт страницу (около 50 строк), и если портал
    // фильтр не понял и вернул всё подряд, при возрастающем порядке наша свежая задача
    // в первую страницу не попала бы — поиск ответил бы «не переносили». При убывающем
    // она первая. Сортировку по возрастанию делает `matchTransferred`, уже по своим.
    order: { ID: 'desc' },
  })
  // ⚠ Целая страница в ответе — это НЕ «нашлось много», это «фильтр не применён».
  // Отвечать по такому ответу нельзя ни «переносили» (он про чужие задачи), ни «не
  // переносили» (нужная могла остаться за страницей, а решение о МИНИМАЛЬНОМ ID разные
  // воркеры приняли бы по разным страницам — и не удалил бы никто). Единственный
  // честный ответ — «не знаю», то есть ошибка: перенос уйдёт на ретрай и разбудит
  // человека, а не заведёт дубль. Найдено вторым циклом панели.
  if (taskListRows(result).length >= PAGE_SIZE) {
    throw new B24Error(
      'портал вернул целую страницу задач — похоже, фильтр поиска не применён',
      'FILTER_IGNORED',
      true,
    )
  }

  return matchTransferred(result, key)
}

/**
 * Удаление задачи у нас. Нужно ровно одному случаю: сверка после создания нашла вторую
 * задачу по той же паре (docs/PROCESSING.md → «Дедупликация»).
 *
 * ⚠ И `taskId`, и `id`: страница метода называет обязательными оба имени.
 */
export async function deleteTargetTask(webhookUrl: string, taskId: number): Promise<void> {
  const result = await callWebhook<{ task?: unknown; result?: unknown } | boolean | null>(
    webhookUrl,
    'tasks.task.delete',
    { taskId, id: taskId },
  )
  // ⚠ Ответ проверяем: метод отдаёт `true`, а не молчание. Отказ без исключения
  // (например, «нет права на удаление» в теле) иначе превратился бы в сообщение
  // «лишняя задача удалена» про задачу, которая на портале осталась. Найдено панелью.
  const ok = result === true
    || (typeof result === 'object' && result !== null && (result.task === true || result.result === true))
  if (!ok) throw new B24Error(`портал не подтвердил удаление задачи ${taskId}`, 'DELETE_NOT_CONFIRMED', false)
}

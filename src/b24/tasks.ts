/**
 * Разбор ответов Битрикс24 по задачам и вызовы двух порталов.
 * Разборщики — чистые функции: именно они ломаются молча при смене формата ответа.
 */
import { callPortal, callWebhook } from './rest.js'
import { B24Error } from './errors.js'
import type { SourceTaskFull, TargetTaskFields } from '../domain/taskMapping.js'
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

/** Ответ `tasks.task.get` — `{ task: {...} }`; `tasks.task.add` — `{ task: { id } }`. */
export function unwrapTask(result: unknown): Record<string, unknown> {
  const wrapper = result as { task?: unknown } | undefined
  const task = wrapper?.task ?? result
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

const TASK_SELECT = ['ID', 'TITLE', 'DESCRIPTION', 'CREATED_BY', 'RESPONSIBLE_ID', 'DEADLINE']

export async function fetchSourceTask(auth: Auth, taskId: number): Promise<SourceTaskFull> {
  const result = await callPortal<unknown>(auth, 'tasks.task.get', { taskId, select: TASK_SELECT })
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
    const result = await callPortal<unknown[]>(auth, 'user.get', { ID: userId })
    return formatUserName(result?.[0])
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

/** Подписка на событие создания задачи. Повторный вызов безопасен: портал не плодит дубли. */
export async function bindTaskAddEvent(auth: Auth, handlerUrl: string): Promise<void> {
  try {
    await callPortal(auth, 'event.bind', { event: 'onTaskAdd', handler: handlerUrl })
  } catch (error) {
    // ⚠ Повторная установка приходит на уже подписанный портал — это норма, а не сбой.
    if (error instanceof B24Error && /handler.*already|ERROR_HANDLER_ALREADY_FOUND/i.test(error.code + error.message)) {
      return
    }
    throw error
  }
}

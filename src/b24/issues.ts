/**
 * Вызовы НАШЕГО портала для выгрузки задач в issue: группа клиента, отбор задач,
 * отметка о выгрузке и комментарий.
 */
import { callWebhook, callWebhookV3 } from './rest.js'
import { B24Error } from './errors.js'

/** Задача, отобранная на выгрузку. Поля — те, что нужны issue и отметке. */
export interface ExportableTask {
  id: number
  title: string
  description: string
  sourceDomain: string
  issueRef: string
}

interface RawTask {
  id?: unknown
  ID?: unknown
  title?: unknown
  TITLE?: unknown
  description?: unknown
  DESCRIPTION?: unknown
  [field: string]: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/**
 * Описание группы клиента.
 *
 * ⚠ Параметры вложены в `params` — так описан метод, и без вложенности портал отвечает
 * «не передан ID группы». Скоуп у метода `socialnetwork`, а не `task`.
 */
export async function fetchGroupDescription(webhookUrl: string, groupId: number): Promise<string> {
  const result = await callWebhook<{ DESCRIPTION?: unknown } | null>(
    webhookUrl,
    'socialnetwork.api.workgroup.get',
    { params: { groupId } },
  )
  if (!result) throw new B24Error(`группа ${groupId} не найдена на нашем портале`, 'GROUP_NOT_FOUND', false)
  return str(result.DESCRIPTION)
}

/**
 * Задачи клиента, которые ещё не выгружены.
 *
 * ⚠ Пустота поля проверяется НАШИМ кодом, а не фильтром портала. Как Битрикс24 понимает
 * «поле пустое», мы не замеряли, а непонятый фильтр он не отвергает — он возвращает всё
 * подряд (замерено, см. docs/PROCESSING.md). Цена ошибки здесь — issue по каждой задаче
 * портала разом, в чужом приватном репозитории. Поэтому фильтром отбираем только то, в
 * чём уверены, а пустоту решаем сами.
 */
export async function listTasksToExport(
  webhookUrl: string,
  options: {
    groupId: number
    responsibleId: number
    sourceDomain: string
    sourceDomainField: string
    sourceTaskField: string
    issueField: string
    limit: number
  },
): Promise<ExportableTask[]> {
  const filter: Record<string, unknown> = {
    RESPONSIBLE_ID: options.responsibleId,
    [options.sourceDomainField]: options.sourceDomain,
  }
  if (options.groupId > 0) filter.GROUP_ID = options.groupId

  const select = ['ID', 'TITLE', 'DESCRIPTION', options.sourceTaskField, options.sourceDomainField, options.issueField]
  const result = await callWebhook<{ tasks?: RawTask[]; items?: RawTask[] } | RawTask[]>(
    webhookUrl,
    'tasks.task.list',
    { filter, select, order: { ID: 'asc' } },
  )

  const rows = Array.isArray(result) ? result : (result?.tasks ?? result?.items ?? [])
  const ready: ExportableTask[] = []

  for (const row of rows) {
    const id = Number(str(row.id ?? row.ID))
    if (!Number.isInteger(id) || id <= 0) continue

    // ⚠ Портал отдаёт UF-поля как есть, но регистр ключа зависит от версии ответа —
    // смотрим оба написания, иначе «пусто» окажется ложным и задача выгрузится дважды.
    const issueRef = str(row[options.issueField] ?? row[camel(options.issueField)])
    if (issueRef.trim()) continue

    const sourceDomain = str(row[options.sourceDomainField] ?? row[camel(options.sourceDomainField)])
    ready.push({
      id,
      title: str(row.title ?? row.TITLE),
      description: str(row.description ?? row.DESCRIPTION),
      sourceDomain,
      issueRef,
    })

    if (ready.length >= options.limit) break
  }

  return ready
}

/** `UF_SOURCE_TASK_ID` → `ufSourceTaskId`: во втором написании портал отдаёт часть ответов. */
function camel(code: string): string {
  return code.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** Отметка «выгружено»: `owner/repo#17` в поле задачи. */
export async function markTaskExported(
  webhookUrl: string,
  taskId: number,
  field: string,
  value: string,
): Promise<void> {
  // ⚠ И `taskId`, и `id`: документация метода называет обязательными оба, и портал
  // принимает запрос только когда они есть (тот же приём, что в `tasks.task.get`).
  await callWebhook(webhookUrl, 'tasks.task.update', { taskId, id: taskId, fields: { [field]: value } })
}

/**
 * Комментарий в задачу со ссылкой на issue.
 *
 * ⚠ Метод живёт ТОЛЬКО в REST v3 (`/rest/api/…`): `task.commentitem.add` и
 * `task.comment.add` помечены устаревшими с версии модуля `tasks` 25.700.0.
 */
export async function commentTask(webhookUrl: string, taskId: number, text: string): Promise<void> {
  await callWebhookV3(webhookUrl, 'tasks.task.chat.message.send', { fields: { taskId, text } })
}

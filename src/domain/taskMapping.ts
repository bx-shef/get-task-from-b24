/**
 * Сборка задачи для нашего Битрикс24 из задачи клиента (docs/PROCESSING.md → «Что переносим»).
 * Чистые функции: никаких REST-вызовов.
 */
import { stripTitlePrefix, type SourceTask } from './criteria.js'

export interface SourceTaskFull extends SourceTask {
  description: string
  /** Постановщик на портале КЛИЕНТА: id и, если удалось узнать, имя. */
  createdBy: number
  createdByName?: string
  /** Крайний срок у клиента; пусто — его не ставили. */
  deadline?: string
}

export interface TargetTaskFields {
  TITLE: string
  DESCRIPTION: string
  RESPONSIBLE_ID: number
  DEADLINE: string
}

/**
 * Ссылка на задачу в портале клиента.
 *
 * ⚠ Идёт через `/company/personal/user/0/tasks/task/view/<id>/`: у Битрикс24 адрес
 * задачи привязан к пользователю, но `0` портал разворачивает в текущего сам. Взять
 * сюда id постановщика нельзя — открывший ссылку сотрудник не он.
 */
export function sourceTaskUrl(domain: string, taskId: number): string {
  return `https://${domain}/company/personal/user/0/tasks/task/view/${taskId}/`
}

/**
 * Формат даты для Битрикс24: `YYYY-MM-DDThh:mm:ss±hh:mm`.
 *
 * ⚠ `toISOString()` сюда не годится, хотя выглядит правильным: он даёт миллисекунды и
 * суффикс `Z`, а документированный тип `datetime` — ни того, ни другого. Оба исхода
 * тихие и плохие: либо `tasks.task.add` падает с `ERROR_CORE` и перенос не работает
 * вовсе, либо `Z` игнорируется, время читается как серверное и срок уезжает на
 * смещение пояса портала — а это заметит клиент, а не тест. Найдено ревью по сверке
 * с документацией.
 *
 * ⚠ Смещение пишем явным `+00:00`, а не опускаем: даты в API хранятся с учётом
 * настроек сервера, поэтому «без смещения» означает «в поясе портала», а мы считаем
 * в UTC.
 */
export function formatDeadline(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`
}

/**
 * Крайний срок: берём срок клиента; его нет — ставим сдвиг по умолчанию.
 *
 * ⚠ Пустая строка и «нулевые» даты Битрикс24 приходят как отсутствие срока, поэтому
 * проверяем разбираемость, а не просто наличие ключа: невалидная дата, отданная в
 * `tasks.task.add`, роняет создание целиком.
 */
export function resolveDeadline(sourceDeadline: string | undefined, now: Date, defaultHours: number): string {
  if (sourceDeadline) {
    const parsed = new Date(sourceDeadline)
    if (!Number.isNaN(parsed.getTime())) return formatDeadline(parsed)
  }
  return formatDeadline(new Date(now.getTime() + defaultHours * 60 * 60 * 1000))
}

/**
 * Текст описания: содержание задачи клиента плюс то, что в поля Битрикс24 не ложится.
 *
 * ⚠ Постановщик, портал и ссылка идут ТЕКСТОМ, а не полями. `CREATED_BY` — это id
 * сотрудника НАШЕГО портала; id с портала клиента означал бы там другого человека,
 * и подмена прошла бы молча.
 */
export function buildDescription(source: SourceTaskFull, domain: string): string {
  const author = source.createdByName ?? `id ${source.createdBy}`
  return [
    source.description?.trim() ?? '',
    '',
    '---',
    `Клиент: ${domain}`,
    `Поставил: ${author}`,
    `Задача у клиента: ${sourceTaskUrl(domain, source.id)}`,
  ].join('\n')
}

export interface BuildOptions {
  domain: string
  responsibleId: number
  now: Date
  defaultDeadlineHours: number
  titlePrefix?: string
}

export function buildTargetTask(source: SourceTaskFull, options: BuildOptions): TargetTaskFields {
  return {
    TITLE: stripTitlePrefix(source.title, options.titlePrefix),
    DESCRIPTION: buildDescription(source, options.domain),
    RESPONSIBLE_ID: options.responsibleId,
    DEADLINE: resolveDeadline(source.deadline, options.now, options.defaultDeadlineHours),
  }
}

/**
 * Критерии отбора задач к переносу (docs/PROCESSING.md → «Критерии отбора»).
 * Чистые функции: сеть, база и очередь сюда не заглядывают.
 */
import type { PortalConfig } from './portals.js'

export const DEFAULT_TITLE_PREFIX = '#support'

export interface SourceTask {
  id: number
  title: string
  responsibleId: number
}

export type SkipReason = 'title-prefix' | 'responsible'

export type Verdict = { transfer: true } | { transfer: false; reason: SkipReason }

/**
 * Название начинается с префикса.
 *
 * ⚠ Регистр не учитывается, ведущие пробелы игнорируются: человек, ставящий задачу,
 * пишет «#Support» и « #support» так же охотно, как канонический вариант, а отказ по
 * такому поводу выглядит как пропажа задачи, а не как несоблюдение формата.
 */
export function matchesTitlePrefix(title: string, prefix: string = DEFAULT_TITLE_PREFIX): boolean {
  return title.trimStart().toLowerCase().startsWith(prefix.toLowerCase())
}

/**
 * Срезает префикс для названия задачи у нас.
 *
 * ⚠ Пустая строка недопустима: `tasks.task.add` требует название, и задача, названная
 * ровно «#support», после срезки оставила бы нас без обязательного поля — то есть
 * перенос падал бы именно на самой лаконичной задаче.
 */
export function stripTitlePrefix(title: string, prefix: string = DEFAULT_TITLE_PREFIX): string {
  const trimmed = title.trimStart()
  if (!matchesTitlePrefix(trimmed, prefix)) return trimmed.trim()

  const rest = trimmed.slice(prefix.length).replace(/^[\s:—–-]+/, '').trim()
  return rest === '' ? trimmed.trim() : rest
}

/**
 * Решение по задаче. Отказ — это норма, а не ошибка: на портале клиента задачи
 * создаются постоянно, и подавляющее большинство нас не касается.
 */
export function decide(task: SourceTask, portal: PortalConfig, prefix: string = DEFAULT_TITLE_PREFIX): Verdict {
  if (!matchesTitlePrefix(task.title, prefix)) return { transfer: false, reason: 'title-prefix' }
  // ⚠ responsibleId — id на портале КЛИЕНТА. Сравниваем с «особым» исполнителем этого же
  // портала, никогда с нашими сотрудниками: id совпадают между порталами случайно.
  if (task.responsibleId !== portal.responsibleId) return { transfer: false, reason: 'responsible' }
  return { transfer: true }
}

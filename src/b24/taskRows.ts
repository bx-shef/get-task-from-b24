/**
 * Разбор списочных ответов по задачам: одно место на все методы, которые отдают
 * список, и на чтение UF-полей из строки такого ответа.
 *
 * ⚠ Вынесено отдельно, потому что это ФАКТЫ О ФОРМАТЕ, а не логика: как метод
 * заворачивает список и в каком регистре приходит ключ UF-поля. Разъедься эти два
 * разбора по модулям — один научится читать новый формат, а второй продолжит молча
 * возвращать пусто.
 */

/** Значение поля строкой: портал отдаёт числа строками, но не всегда (docs/PRODUCT.md). */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/** `UF_SOURCE_TASK_ID` → `ufSourceTaskId`: во втором написании портал отдаёт часть ответов. */
export function camel(code: string): string {
  return code.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

export type TaskRow = Record<string, unknown>

/**
 * Список задач из ответа метода: `{ tasks: [] }`, `{ items: [] }` или просто массив.
 *
 * ⚠ Читаем все три формы намеренно: страницы REST v3 объявляют `items`, v2 отдаёт
 * `tasks`, а непонятая форма означала бы «задач нет» — то есть в дедупликации
 * «переносов не было», и задача завелась бы второй раз.
 */
export function taskListRows(result: unknown): TaskRow[] {
  if (Array.isArray(result)) return result as TaskRow[]
  const wrapper = result as { tasks?: unknown; items?: unknown } | null | undefined
  const rows = wrapper?.tasks ?? wrapper?.items
  return Array.isArray(rows) ? (rows as TaskRow[]) : []
}

/**
 * ВСЕ значения UF-поля строки ответа — с учётом обоих написаний ключа.
 *
 * ⚠ Список, а не одно значение: множественное пользовательское поле портал отдаёт
 * МАССИВОМ. Читая такой ответ как строку, мы получили бы пусто — и на дедупликации это
 * означало бы «не переносили» на каждом событии, то есть новую задачу каждый раз, при
 * внешне исправном ответе портала. Найдено панелью.
 */
export function ufValues(row: TaskRow, code: string): string[] {
  const raw = row[code] ?? row[camel(code)]
  if (Array.isArray(raw)) return raw.map(str).filter((v) => v !== '')
  const value = str(raw)
  return value === '' ? [] : [value]
}

/** Первое значение UF-поля — для случаев, где поле заведомо одиночное. */
export function ufValue(row: TaskRow, code: string): string {
  return ufValues(row, code)[0] ?? ''
}

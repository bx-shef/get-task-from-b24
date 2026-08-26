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
  /** Группа (проект) у нас. Отсутствует, когда группа не задана. */
  GROUP_ID?: number
  /**
   * Пользовательские поля кладутся по коду из настроек.
   *
   * ⚠ Шаблон `UF_${string}`, а не `string`: открытая сигнатура снимала контроль типов
   * со ВСЕХ полей сразу — опечатка в имени системного поля перестала бы ловиться
   * компилятором ради одного пользовательского. Найдено ревью.
   */
  [userField: `UF_${string}`]: unknown
}

/**
 * Код пользовательского поля обязан выглядеть как код пользовательского поля.
 *
 * ⚠ Значение приходит из окружения и подставляется КЛЮЧОМ в тело запроса к порталу.
 * Без проверки опечатка вроде `UF_ID, DEADLINE` молча добавила бы в запрос поле,
 * которого никто не просил, а разбираться пришлось бы по странному поведению задач.
 */
export const USER_FIELD_PATTERN = /^UF_[A-Z0-9_]+$/

export function isUserFieldCode(code: string): code is `UF_${string}` {
  return USER_FIELD_PATTERN.test(code)
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
/**
 * Потолки на текст, приезжающий с чужого портала.
 *
 * ⚠ Содержимое задачи пишет сотрудник клиента, а едет оно в НАШ портал и в Telegram.
 * Без потолка одна задача с мегабайтным описанием превращается в мегабайтный запрос
 * к `tasks.task.add` и в сообщение, которое Telegram отвергнет целиком.
 */
export const MAX_TITLE_LENGTH = 250
export const MAX_DESCRIPTION_LENGTH = 20_000

export function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

export function buildDescription(source: SourceTaskFull, domain: string): string {
  const author = source.createdByName ?? `id ${source.createdBy}`
  return [
    clamp(source.description?.trim() ?? '', MAX_DESCRIPTION_LENGTH),
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
  /** `0` или отсутствие — задача заводится без группы. */
  groupId?: number
  /**
   * Код поля у нас, куда положить ID задачи клиента (например `UF_AUTO_123456`).
   * Пусто — поле не заполняется.
   */
  sourceTaskField?: string | null
}

export function buildTargetTask(source: SourceTaskFull, options: BuildOptions): TargetTaskFields {
  const fields: TargetTaskFields = {
    TITLE: clamp(stripTitlePrefix(source.title, options.titlePrefix), MAX_TITLE_LENGTH),
    DESCRIPTION: buildDescription(source, options.domain),
    RESPONSIBLE_ID: options.responsibleId,
    DEADLINE: resolveDeadline(source.deadline, options.now, options.defaultDeadlineHours),
  }

  // ⚠ Поле добавляется только когда группа задана. Ноль порталу не шлём: `GROUP_ID`
  // в `fields` метода документацией вообще не описан, и слать неописанное поле со
  // значением, которого у нас нет, — это спорить с порталом о том, чего мы не просили.
  // ⚠ Неверный id группы портал, судя по документации, молча принимает: отказа среди
  // описанных ошибок метода нет. Поэтому группа печатается в лог успешного переноса —
  // иначе задачи уезжали бы в чужую группу, и заметил бы это человек, а не сервис.
  if (options.groupId && options.groupId > 0) fields.GROUP_ID = options.groupId

  // ⚠ Код здесь проверяется ВТОРОЙ раз: первый — в `loadConfig`, на старте. В бою
  // сюда мусор не долетает, но функция вызывается и напрямую (тесты, будущие места),
  // а ключ уезжает в тело запроса к порталу — цена пропуска выше цены лишней проверки.
  //
  // ⚠ Числом, потому что поле в портале числовое (`double`) — тип значения совпадает
  // с типом поля, и только поэтому.
  //
  // ⚠ Искать задачу по этому полю НЕЛЬЗЯ, и это замер, а не предположение: фильтр
  // `tasks.task.list` по `UF_SOURCE_TASK_ID` находит ноль задач при существующем
  // значении, а в camelCase (`ufSourceTaskId`) молча игнорируется и возвращает всё
  // подряд. Поле пишется для человека и на будущее; сопоставление переносов держится
  // на журнале (`transfers`), а не на портале.
  if (options.sourceTaskField && isUserFieldCode(options.sourceTaskField)) {
    fields[options.sourceTaskField] = source.id
  }

  return fields
}

/**
 * Текст issue по задаче из нашего Битрикс24.
 *
 * ⚠ Обязательная часть тела — **домен нашего портала и ID задачи** (постановка
 * владельца). По ним issue разрешается обратно в задачу; без них связь односторонняя, и
 * человек, читающий issue в репозитории клиента, не знает, куда отвечать.
 */
import { clamp } from './taskMapping.js'
import { bbcodeToMd } from './bbcode/toMarkdown.js'

/** GitHub обрезает заголовок на 256 символах — режем сами, чтобы не молча. */
const MAX_TITLE = 256
/** Тело issue GitHub ограничивает 65536 символами. Оставляем запас под служебный блок. */
const MAX_BODY = 60_000

export interface IssueSource {
  taskId: number
  title: string
  description?: string | null
  /** Домен НАШЕГО портала: он же адрес возврата из issue в задачу. */
  ourDomain: string
  /** Исполнитель у нас — из него строится ссылка на задачу. */
  responsibleId: number
}

export interface IssueContent {
  title: string
  body: string
}

/** Ссылка на задачу нашего портала. */
export function taskUrl(domain: string, responsibleId: number, taskId: number): string {
  return `https://${domain}/company/personal/user/${responsibleId}/tasks/task/view/${taskId}/`
}

export function buildIssue(source: IssueSource): IssueContent {
  const title = clamp(source.title.trim() || `Задача ${source.taskId}`, MAX_TITLE)

  // ⚠ Служебный блок собирается ПЕРВЫМ и в лимит не режется, а описание подгоняется под
  // остаток. Наоборот было бы тихо неверно: блок стоит в конце, и у длинной задачи
  // обрезка съела бы ровно то, ради чего он существует, — домен и ID.
  const tail = [
    '',
    '---',
    `Битрикс24: \`${source.ourDomain}\`, задача \`${source.taskId}\``,
    taskUrl(source.ourDomain, source.responsibleId, source.taskId),
  ].join('\n')

  // ⚠ Описание приезжает из Битрикс24 в BBCode, а GitHub понимает Markdown: без
  // перевода в issue уезжает `[b]…[/b]` и `[url=…]` как есть — читаемо, но некрасиво, а
  // списки и таблицы рассыпаются совсем. Конвертер — копия из соседнего проекта
  // владельца, см. `bbcode/parser.ts`.
  //
  // ⚠ Переводим ТОЛЬКО описание. Служебный блок ниже мы пишем сами и сразу на Markdown;
  // прогонять его через конвертер значило бы переводить то, что уже переведено.
  const description = bbcodeToMd(source.description ?? '').trim() || '_Описание в задаче пустое._'
  const room = Math.max(0, MAX_BODY - tail.length)

  return { title, body: clamp(description, room) + tail }
}

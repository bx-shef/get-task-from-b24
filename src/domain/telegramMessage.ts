/**
 * Тексты сообщений в Telegram (docs/PROCESSING.md → «Уведомление в Telegram»).
 * Чистые функции: отправка живёт отдельным шагом, чтобы упавший Telegram не приводил
 * к повторному созданию задачи.
 */
import { sourceTaskUrl } from './taskMapping.js'

export interface CreatedMessageInput {
  title: string
  domain: string
  sourceTaskId: number
  targetTaskId: number
  targetDomain: string
}

export function buildCreatedMessage(input: CreatedMessageInput): string {
  return [
    '🆕 Задача создана — иди делай',
    '',
    input.title,
    `Клиент: ${input.domain}`,
    `У нас: ${taskUrl(input.targetDomain, input.targetTaskId)}`,
    `У клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
  ].join('\n')
}

export interface FailureMessageInput {
  domain: string
  sourceTaskId: number
  error: string
}

/**
 * ⚠ Портал и ID задачи обязательны в тексте: сообщение об аварии без них говорит,
 * что беда случилась, но не говорит, где её искать — а порталов 20–30.
 */
export function buildFailureMessage(input: FailureMessageInput): string {
  return [
    '⚠️ Перенос задачи не удался',
    '',
    `Клиент: ${input.domain}`,
    `Задача у клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
    `Ошибка: ${input.error}`,
  ].join('\n')
}

/**
 * Что стало с НАШЕЙ лишней задачей:
 * `removed` — удалили; `failed` — пытались и не смогли, дальше руками;
 * `theirs` — лишняя не наша: жить остаётся наша, а чужую удалит тот перенос, который
 * её создал.
 */
export type DuplicateOutcome =
  | { kind: 'removed'; ourExtraTaskId: number }
  | { kind: 'failed'; ourExtraTaskId: number }
  | { kind: 'theirs' }

export interface DuplicateMessageInput {
  domain: string
  sourceTaskId: number
  targetDomain: string
  /** Задача, которая остаётся жить, — созданная раньше. */
  keptTaskId: number
  outcome: DuplicateOutcome
  /** Лишние задачи, созданные НЕ этим переносом. */
  otherExtraTaskIds: number[]
}

function taskUrl(domain: string, taskId: number): string {
  return `https://${domain}/company/personal/user/0/tasks/task/view/${taskId}/`
}

/**
 * Сверка после создания нашла вторую задачу по той же паре.
 *
 * ⚠ Сообщение уходит ВСЕГДА, даже когда дубль удалён успешно. Журнала переносов больше
 * нет, и превентивной блокировки тоже (docs/PRODUCT.md, раздел 1а): гонка закрывается
 * постфактум, и человек обязан знать, что она случилась, — иначе редкий сбой становится
 * невидимым.
 *
 * ⚠ Исход относится ТОЛЬКО к нашей задаче, и текст обязан это различать. Написать
 * «удалено: 42, 77» про задачу, которую мы не трогали, — то же враньё, что и «удалить
 * не удалось» про ту, которую прямо сейчас корректно удаляет второй воркер. Оба варианта
 * гонят человека в портал за тем, чего там нет; пара таких сигналов — и их перестают
 * читать. Найдено двумя циклами панели подряд.
 */
export function buildDuplicateMessage(input: DuplicateMessageInput): string {
  const head = {
    removed: '♻️ Задача перенеслась дважды — лишняя удалена',
    failed: '⚠️ Задача перенеслась дважды — удалить лишнюю НЕ удалось',
    theirs: '♻️ Задача перенеслась дважды — лишнюю удалит тот перенос, который её создал',
  }[input.outcome.kind]

  const ours = input.outcome.kind === 'removed'
    ? [`Удалена: ${input.outcome.ourExtraTaskId}`]
    : input.outcome.kind === 'failed'
      ? [`Лишняя (удалить руками): ${taskUrl(input.targetDomain, input.outcome.ourExtraTaskId)}`]
      : []

  const others = input.otherExtraTaskIds.map(
    (id) => `Лишняя, не наша (удалит её перенос): ${taskUrl(input.targetDomain, id)}`,
  )

  return [
    head,
    '',
    `Клиент: ${input.domain}`,
    `Задача у клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
    `Осталась у нас: ${taskUrl(input.targetDomain, input.keptTaskId)}`,
    ...ours,
    ...others,
  ].join('\n')
}

export interface UnverifiedMessageInput {
  domain: string
  sourceTaskId: number
  targetDomain: string
  targetTaskId: number
}

/**
 * Созданная задача не находится поиском по своей же паре UF-полей.
 *
 * ⚠ Это отказ самой дедупликации, а не одного переноса: задача создана и всё выглядит
 * исправным, но следующее событие по той же задаче заведёт вторую — и так каждый раз.
 * Причина обычно одна: код UF-поля в окружении не тот, что на портале, и `tasks.task.add`
 * молча проглотил неизвестное поле.
 */
export function buildUnverifiedMessage(input: UnverifiedMessageInput): string {
  return [
    '⚠️ Дедупликация не работает: задача не ищется по своим же полям',
    '',
    `Клиент: ${input.domain}`,
    `Задача у клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
    `У нас: ${taskUrl(input.targetDomain, input.targetTaskId)}`,
    'Проверьте коды полей B24_TARGET_UF_SOURCE_TASK и B24_TARGET_UF_SOURCE_DOMAIN.',
  ].join('\n')
}

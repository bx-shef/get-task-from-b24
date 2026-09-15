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
    `У нас: https://${input.targetDomain}/company/personal/user/0/tasks/task/view/${input.targetTaskId}/`,
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

export interface DuplicateMessageInput {
  domain: string
  sourceTaskId: number
  targetDomain: string
  /** Задача, которая остаётся жить, — созданная раньше. */
  keptTaskId: number
  /** Задача-дубль. */
  extraTaskId: number
  /** Удалось ли её удалить. Нет — значит дальше руками. */
  removed: boolean
}

/**
 * Сверка после создания нашла вторую задачу по той же паре.
 *
 * ⚠ Сообщение уходит ВСЕГДА, даже когда дубль удалён успешно. Журнала переносов больше
 * нет, и превентивной блокировки тоже (docs/PRODUCT.md, раздел 1а): гонка закрывается
 * постфактум, и человек обязан знать, что она случилась, — иначе редкий сбой становится
 * невидимым.
 */
export function buildDuplicateMessage(input: DuplicateMessageInput): string {
  const head = input.removed
    ? '♻️ Задача перенеслась дважды — лишняя удалена'
    : '⚠️ Задача перенеслась дважды — удалить лишнюю НЕ удалось'
  return [
    head,
    '',
    `Клиент: ${input.domain}`,
    `Задача у клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
    `Осталась у нас: https://${input.targetDomain}/company/personal/user/0/tasks/task/view/${input.keptTaskId}/`,
    input.removed
      ? `Удалена: ${input.extraTaskId}`
      : `Лишняя (удалить руками): https://${input.targetDomain}/company/personal/user/0/tasks/task/view/${input.extraTaskId}/`,
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
    `У нас: https://${input.targetDomain}/company/personal/user/0/tasks/task/view/${input.targetTaskId}/`,
    'Проверьте коды полей B24_TARGET_UF_SOURCE_TASK и B24_TARGET_UF_SOURCE_DOMAIN.',
  ].join('\n')
}

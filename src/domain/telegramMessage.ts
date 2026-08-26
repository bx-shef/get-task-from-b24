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

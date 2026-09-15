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

export interface DuplicateMessageInput {
  domain: string
  sourceTaskId: number
  targetDomain: string
  /** Задача, которая остаётся жить, — созданная раньше. */
  keptTaskId: number
  /** Все лишние задачи по той же паре. */
  extraTaskIds: number[]
  /**
   * Что стало с лишней задачей:
   * `removed` — мы её удалили; `failed` — пытались и не смогли, дальше руками;
   * `theirs` — лишняя не наша, её удалит тот перенос, который её создал.
   */
  outcome: 'removed' | 'failed' | 'theirs'
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
 * ⚠ Три исхода различаются в тексте, и это не украшательство. Написать «удалить не
 * удалось» про задачу, которую прямо сейчас корректно удаляет второй воркер, значит
 * послать человека в портал за тем, чего там уже нет; пара таких сигналов — и их
 * перестают читать. Найдено панелью.
 */
export function buildDuplicateMessage(input: DuplicateMessageInput): string {
  const head = {
    removed: '♻️ Задача перенеслась дважды — лишняя удалена',
    failed: '⚠️ Задача перенеслась дважды — удалить лишнюю НЕ удалось',
    theirs: '♻️ Задача перенеслась дважды — лишнюю удалит тот перенос, который её создал',
  }[input.outcome]

  const extras = input.extraTaskIds.length === 0
    ? []
    : input.outcome === 'removed'
      ? [`Удалена: ${input.extraTaskIds.join(', ')}`]
      : input.extraTaskIds.map((id) => `Лишняя: ${taskUrl(input.targetDomain, id)}`)

  return [
    head,
    '',
    `Клиент: ${input.domain}`,
    `Задача у клиента: ${sourceTaskUrl(input.domain, input.sourceTaskId)}`,
    `Осталась у нас: ${taskUrl(input.targetDomain, input.keptTaskId)}`,
    ...extras,
    ...(input.outcome === 'failed' ? ['Удалить руками.'] : []),
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

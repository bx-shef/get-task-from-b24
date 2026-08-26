/**
 * Воркеры очередей: перенос задачи и отправка уведомлений.
 *
 * ⚠ Два РАЗНЫХ воркера намеренно. Упавший Telegram не должен ретраить перенос —
 * задача уже создана, и повтор завёл бы вторую.
 */
import { UnrecoverableError } from 'bullmq'
import {
  Worker,
  isLastAttempt,
  NOTIFICATIONS_QUEUE,
  NOTIFY_JOB_OPTIONS,
  TASK_EVENTS_QUEUE,
  TASK_JOB_OPTIONS,
  type JobAttempt,
  type NotificationJob,
  type TaskEventJob,
} from './queues.js'
import { transferTask, type TransferSettings } from '../pipeline/transfer.js'
import { withPortalAuth } from '../b24/portalClient.js'
import { B24Error } from '../b24/errors.js'
import { createTargetTask, fetchSourceTask, fetchUserName } from '../b24/tasks.js'
import { claim, markDone, markFailed } from '../store/transfers.js'
import { findPortal, type PortalConfig } from '../domain/portals.js'
import { sendTelegramMessage } from '../notify/telegram.js'
import type { AppContext } from '../runtime.js'
import type { AppConfig } from '../config.js'

export function log(event: string, data: Record<string, unknown>): void {
  // ⚠ В лог не попадают ни токены, ни содержимое задач клиента (ПДн сотрудников):
  // только домен, идентификаторы и код исхода.
  //
  // ⚠ Название события ставится ПОСЛЕ данных. Замерено на боевом логе: вызов с
  // `{ event: 'ONTASKADD' }` в данных затирал метку, и строка `event-rejected`
  // печаталась как `{"event":"ONTASKADD"}` — то есть диагностика врала о себе, а
  // разбирать по ней аварию пришлось бы в самый неподходящий момент.
  // ⚠ `at` и `event` ставятся ПОСЛЕ данных: поле из данных не должно затирать ни
  // метку события, ни время. Найдено ревью — сначала затиралась метка, потом время.
  console.log(JSON.stringify({ ...data, at: new Date().toISOString(), event }))
}

/**
 * Ошибку, которую повторять бессмысленно, очередь повторять не должна.
 *
 * ⚠ Флаг `retryable` вычислялся и не читался никем — находка ревью. Из-за этого
 * «портал не установлен» и «портал вернул задачу в неожиданном виде» жгли все пять
 * попыток с нарастающей паузой, а человек узнавал о беде через минуты вместо секунд.
 */
export function toQueueError(error: unknown): unknown {
  if (error instanceof B24Error && !error.retryable) {
    return new UnrecoverableError(`${error.code}: ${error.message}`)
  }
  return error
}

/** Повтора не будет: либо попытки исчерпаны, либо ошибка невосстановима. */
export function isFinalFailure(job: JobAttempt, error: unknown): boolean {
  if (error instanceof B24Error && !error.retryable) return true
  return isLastAttempt(job)
}

/**
 * Сборка настроек переноса из конфигурации и портала.
 *
 * ⚠ Вынесена из замыкания намеренно: это ШОВ между настройками и работой, и ревью
 * показало мутацией, что он был непокрыт — можно было выкинуть проброс группы или
 * кода UF-поля, и все тесты оставались зелёными. Настройка при этом валидируется на
 * старте и покрыта юнитами, но до запроса не доезжает: «настройка есть, эффекта нет».
 */
export function buildTransferSettings(config: AppConfig, portal: PortalConfig): TransferSettings {
  return {
    portal,
    targetDomain: config.targetDomain,
    targetResponsibleId: config.targetResponsibleId,
    titlePrefix: config.titlePrefix,
    defaultDeadlineHours: config.defaultDeadlineHours,
    sourceTaskField: config.targetSourceTaskField,
  }
}

export function startWorkers(ctx: AppContext): { tasks: Worker; notifications: Worker } {
  const { config, pool, queues } = ctx
  const access = { pool, encKey: config.tokenEncKey }

  async function runTransfer(job: JobAttempt & { data: TaskEventJob }): Promise<void> {
    const portal = findPortal(config.portals, job.data.domain)
    // ⚠ Портал мог исчезнуть из реестра, пока задание лежало в очереди. Это не сбой:
    // мы перестали его обслуживать, и ретраить тут нечего.
    if (!portal) {
      log('portal-unknown', { domain: job.data.domain, taskId: job.data.taskId })
      return
    }

    await transferTask(
      job.data.taskId,
      {
        loadTask: (_domain, taskId) =>
          withPortalAuth(access, portal, async (auth) => {
            const task = await fetchSourceTask(auth, taskId)
            return { ...task, createdByName: await fetchUserName(auth, task.createdBy) }
          }),
        createTask: (fields) => createTargetTask(config.targetWebhookUrl, fields),
        claim: (domain, taskId) => claim(pool, domain, taskId),
        markDone: (domain, taskId, targetTaskId) => markDone(pool, domain, taskId, targetTaskId),
        markFailed: (domain, taskId, reason) => markFailed(pool, domain, taskId, reason),
        notify: async (text) => {
          await queues.notifications.add('notify', { text }, NOTIFY_JOB_OPTIONS)
        },
        now: () => new Date(),
        log,
      },
      buildTransferSettings(config, portal),
      { isFinalFailure: (error) => isFinalFailure(job, error) },
    )
  }

  const tasks = new Worker<TaskEventJob>(
    TASK_EVENTS_QUEUE,
    async (job) => {
      try {
        await runTransfer(job)
      } catch (error) {
        throw toQueueError(error)
      }
    },
    { connection: queues.connection, prefix: queues.prefix, concurrency: 5 },
  )

  const notifications = new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      if (!config.telegram) {
        log('telegram-disabled', {})
        return
      }
      await sendTelegramMessage(config.telegram, job.data.text)
    },
    { connection: queues.connection, prefix: queues.prefix, concurrency: 2 },
  )

  for (const [name, worker] of [['tasks', tasks], ['notifications', notifications]] as const) {
    worker.on('failed', (job, error) => {
      log('job-failed', { queue: name, jobId: job?.id, attempt: job?.attemptsMade, reason: error.message })
    })
  }

  log('workers-started', { taskAttempts: TASK_JOB_OPTIONS.attempts })
  return { tasks, notifications }
}

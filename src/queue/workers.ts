/**
 * Воркеры очередей: перенос задачи и отправка уведомлений.
 *
 * ⚠ Два РАЗНЫХ воркера намеренно. Упавший Telegram не должен ретраить перенос —
 * задача уже создана, и повтор завёл бы вторую.
 */
import { Worker, isLastAttempt, NOTIFICATIONS_QUEUE, NOTIFY_JOB_OPTIONS, TASK_EVENTS_QUEUE, TASK_JOB_OPTIONS, type NotificationJob, type TaskEventJob } from './queues.js'
import { transferTask } from '../pipeline/transfer.js'
import { withPortalAuth } from '../b24/portalClient.js'
import { createTargetTask, fetchSourceTask, fetchUserName } from '../b24/tasks.js'
import { claim, markDone, markFailed } from '../store/transfers.js'
import { findPortal } from '../domain/portals.js'
import { sendTelegramMessage } from '../notify/telegram.js'
import type { AppContext } from '../runtime.js'

export function log(event: string, data: Record<string, unknown>): void {
  // ⚠ В лог не попадают ни токены, ни содержимое задач клиента (ПДн сотрудников):
  // только домен, идентификаторы и код исхода.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }))
}

export function startWorkers(ctx: AppContext): { tasks: Worker; notifications: Worker } {
  const { config, pool, queues } = ctx

  const tasks = new Worker<TaskEventJob>(
    TASK_EVENTS_QUEUE,
    async (job) => {
      const portal = findPortal(config.portals, job.data.domain)
      // ⚠ Портал мог исчезнуть из реестра, пока задание лежало в очереди. Это не сбой:
      // мы перестали его обслуживать, и ретраить тут нечего.
      if (!portal) {
        log('portal-unknown', { domain: job.data.domain, taskId: job.data.taskId })
        return
      }

      const access = { pool, encKey: config.tokenEncKey }

      await transferTask(
        job.data.taskId,
        {
          loadTask: (_domain, taskId) =>
            withPortalAuth(access, portal, async (auth) => {
              const task = await fetchSourceTask(auth, taskId)
              return { ...task, createdByName: await fetchUserName(auth, task.createdBy) }
            }),
          createTask: (fields) => createTargetTask(config.targetWebhookUrl, fields),
          claim: async (domain, taskId) => (await claim(pool, domain, taskId)) !== null,
          markDone: (domain, taskId, targetTaskId) => markDone(pool, domain, taskId, targetTaskId),
          markFailed: (domain, taskId, reason) => markFailed(pool, domain, taskId, reason),
          notify: async (text) => {
            await queues.notifications.add('notify', { text }, NOTIFY_JOB_OPTIONS)
          },
          now: () => new Date(),
          log,
        },
        {
          portal,
          targetDomain: config.targetDomain,
          targetResponsibleId: config.targetResponsibleId,
          titlePrefix: config.titlePrefix,
          defaultDeadlineHours: config.defaultDeadlineHours,
        },
        { lastAttempt: isLastAttempt(job) },
      )
    },
    { connection: queues.connection, concurrency: 5 },
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
    { connection: queues.connection, concurrency: 2 },
  )

  for (const [name, worker] of [['tasks', tasks], ['notifications', notifications]] as const) {
    worker.on('failed', (job, error) => {
      log('job-failed', { queue: name, jobId: job?.id, attempt: job?.attemptsMade, reason: error.message })
    })
  }

  log('workers-started', { taskAttempts: TASK_JOB_OPTIONS.attempts })
  return { tasks, notifications }
}

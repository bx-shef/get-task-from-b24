/**
 * Очереди BullMQ. Событие Битрикс24 не ретраится (docs/B24_EVENTS.md), поэтому
 * приём и обработка разъезжаются здесь: обработчик кладёт задание и отвечает 200.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq'
import IORedis from 'ioredis'

export const TASK_EVENTS_QUEUE = 'task-events'
export const NOTIFICATIONS_QUEUE = 'notifications'

export interface TaskEventJob {
  domain: string
  taskId: number
}

export interface NotificationJob {
  text: string
}

export function createConnection(redisUrl: string): ConnectionOptions {
  // ⚠ BullMQ требует maxRetriesPerRequest: null — иначе воркер падает при первой же
  // паузе Redis вместо того, чтобы дождаться его возвращения.
  return new IORedis(redisUrl, { maxRetriesPerRequest: null })
}

/**
 * ⚠ Пять попыток с экспоненциальной задержкой: портал клиента бывает недоступен
 * минутами, а второй попытки события у нас нет — оно уже потрачено.
 */
export const TASK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 10_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
}

export const NOTIFY_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
}

export interface Queues {
  taskEvents: Queue<TaskEventJob>
  notifications: Queue<NotificationJob>
  connection: ConnectionOptions
}

export function createQueues(redisUrl: string): Queues {
  const connection = createConnection(redisUrl)
  return {
    connection,
    taskEvents: new Queue<TaskEventJob>(TASK_EVENTS_QUEUE, { connection }),
    notifications: new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, { connection }),
  }
}

/**
 * Идентификатор задания по паре «портал + задача»: повторная доставка одного события
 * не создаёт второго задания.
 *
 * ⚠ Двоеточие в id BullMQ запрещает («Custom Id cannot contain :») — оно у него
 * разделитель ключей Redis. Замерено живым прогоном: обработчик отвечал 500, то есть
 * событие терялось ровно в том месте, которое написано ради того, чтобы не терять.
 */
export function jobId(domain: string, taskId: number): string {
  return `${domain}--${taskId}`
}

/** Последняя ли это попытка — от этого зависит, будить ли человека. */
export function isLastAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  const attempts = job.opts?.attempts ?? 1
  return job.attemptsMade + 1 >= attempts
}

export { Worker }

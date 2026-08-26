/**
 * Контрактный тест очередей на НАСТОЯЩЕМ Redis: оба воркера, поднятые в одном
 * процессе нашим же `startWorkers`, действительно разбирают свои очереди.
 *
 * ⚠ Работает в СВОЁМ пространстве ключей (`prefix`), чтобы не трогать боевые очереди
 * того же Redis, — см. комментарий у `createQueues` ниже.
 *
 * ⚠ Написан после первого живого прогона, где задача переехала, а уведомление не
 * ушло — и в логе не было ни строчки. Причина оказалась не здесь (Telegram принял
 * сообщение, разошёлся адресат), но выяснилось это только замером: юниты не
 * поднимают ни очередь, ни воркер, поэтому «уведомления вообще не разбираются»
 * они бы не заметили в принципе.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createQueues, NOTIFY_JOB_OPTIONS, TASK_JOB_OPTIONS } from '../src/queue/queues.js'
import { startWorkers } from '../src/queue/workers.js'
import type { AppConfig } from '../src/config.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app'

const config: AppConfig = {
  publicBaseUrl: 'https://example.test',
  portals: [],
  targetWebhookUrl: 'https://my.bitrix24.ru/rest/1/t/',
  targetDomain: 'my.bitrix24.ru',
  targetResponsibleId: 1,
  titlePrefix: '#support',
  defaultDeadlineHours: 24,
  telegram: null,
  targetSourceTaskField: null,
  databaseUrl: DATABASE_URL,
  redisUrl: REDIS_URL,
  tokenEncKey: '0'.repeat(64),
}

// ⚠ СВОЙ префикс ключей. Ревью доказало прогоном: без него тест поднимал очереди с
// боевыми именами, вычитывал настоящее задание из очереди разработчика и терял его
// (портал не найден в пустом реестре → задание завершалось успешно), а остаток добивал
// `obliterate`. И всё это — по команде `pnpm check`, которую наши же правила требуют
// гонять перед каждым пушем.
const queues = createQueues(REDIS_URL, 'bull-test-notify')
const workers = startWorkers({ config, pool: {} as never, queues })

afterAll(async () => {
  await Promise.allSettled([
    workers.tasks.close(),
    workers.notifications.close(),
    queues.taskEvents.obliterate({ force: true }).then(() => queues.taskEvents.close()),
    queues.notifications.obliterate({ force: true }).then(() => queues.notifications.close()),
  ])
})

async function waitForCompleted(job: { isCompleted(): Promise<boolean>; isFailed(): Promise<boolean> }, ms = 10_000): Promise<string> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await job.isCompleted()) return 'completed'
    if (await job.isFailed()) return 'failed'
    await new Promise((r) => setTimeout(r, 50))
  }
  return 'timeout'
}

describe('воркеры в одном процессе', () => {
  // ⚠ Telegram выключен (`telegram: null`) — задание обязано завершиться успешно,
  // а не зависнуть: молчащий сервис не должен копить задания.
  it('очередь уведомлений разбирается', async () => {
    const job = await queues.notifications.add('notify', { text: 'проверка' }, NOTIFY_JOB_OPTIONS)
    expect(await waitForCompleted(job)).toBe('completed')
  }, 20_000)

  // ⚠ Портала нет в пустом реестре — воркер обязан завершить задание, а не ретраить:
  // мы перестали обслуживать портал, повторять тут нечего.
  it('очередь задач разбирается и не ретраит неизвестный портал', async () => {
    const job = await queues.taskEvents.add(
      'transfer',
      { domain: 'никому.не.известен', taskId: 1 },
      { ...TASK_JOB_OPTIONS, jobId: 'contract-unknown-portal' },
    )
    expect(await waitForCompleted(job)).toBe('completed')
  }, 20_000)
})

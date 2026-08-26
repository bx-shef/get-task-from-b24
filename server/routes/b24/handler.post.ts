import { defineEventHandler, readRawBody, getRequestHeader } from 'h3'
import { getContext } from '../../../src/runtime.js'
import { parseBody, parseTaskAddEvent } from '../../../src/b24/eventPayload.js'
import { verifyApplicationToken } from '../../../src/store/portalTokens.js'
import { claim, markFailed } from '../../../src/store/transfers.js'
import { findPortal } from '../../../src/domain/portals.js'
import { jobId, TASK_JOB_OPTIONS } from '../../../src/queue/queues.js'
import { log } from '../../../src/queue/workers.js'

/**
 * Приём события портала клиента.
 *
 * ⚠ ГЛАВНОЕ ПРАВИЛО: отвечаем 200 и как можно раньше. События Битрикс24 НЕ ретраятся
 * (docs/B24_EVENTS.md) — медленный или упавший ответ означает задачу клиента,
 * потерянную навсегда и молча. Поэтому здесь только сверка подлинности и постановка
 * в очередь; работа идёт в воркере.
 */
export default defineEventHandler(async (event) => {
  const { config, pool, queues } = getContext()

  const raw = (await readRawBody(event, 'utf8')) ?? ''
  const parsed = parseTaskAddEvent(parseBody(getRequestHeader(event, 'content-type'), raw))

  if (!parsed) {
    log('event-unparsed', {})
    return { ok: true, ignored: 'unparsed' }
  }

  if (parsed.event !== 'ONTASKADD') {
    log('event-ignored', { event: parsed.event, domain: parsed.domain })
    return { ok: true, ignored: 'event' }
  }

  const portal = findPortal(config.portals, parsed.domain)
  // ⚠ Портала нет в реестре — мы его не обслуживаем. Отвечаем 200: ругаться на
  // портал, который нам не поручали, смысла нет, а 500 заставил бы его повторять.
  if (!portal) {
    log('portal-unsupported', { domain: parsed.domain, taskId: parsed.taskId })
    return { ok: true, ignored: 'portal' }
  }

  // ⚠ Единственное, что отличает событие портала от подделки: эндпоинт открыт миру.
  const authentic = parsed.applicationToken !== ''
    && (await verifyApplicationToken(pool, portal.domain, parsed.applicationToken))
  if (!authentic) {
    log('event-rejected', { domain: portal.domain, taskId: parsed.taskId })
    event.node.res.statusCode = 401
    return { ok: false, error: 'application_token' }
  }

  try {
    await queues.taskEvents.add(
      'transfer',
      { domain: portal.domain, taskId: parsed.taskId },
      // ⚠ Дедуп по jobId дублирует журнал намеренно: очередь чистится по
      // removeOnComplete, а журнал живёт вечно.
      { ...TASK_JOB_OPTIONS, jobId: jobId(portal.domain, parsed.taskId) },
    )
  } catch (error) {
    // ⚠ Очередь недоступна — событие уже потеряно: второй доставки у Битрикс24 нет.
    // Отвечаем всё равно 200: на череду 500-х портал отключает обработчик совсем,
    // и тогда потеряется не одно событие, а все следующие. Единственное, что здесь
    // можно сделать полезного, — оставить след, по которому задачу заведут руками.
    const reason = `очередь недоступна: ${(error as Error).message}`
    log('event-lost', { domain: portal.domain, taskId: parsed.taskId, reason })
    await claim(pool, portal.domain, parsed.taskId).catch(() => null)
    await markFailed(pool, portal.domain, parsed.taskId, reason).catch(() => {})
    return { ok: true, warning: 'queue_unavailable' }
  }

  log('event-queued', { domain: portal.domain, taskId: parsed.taskId })
  return { ok: true }
})

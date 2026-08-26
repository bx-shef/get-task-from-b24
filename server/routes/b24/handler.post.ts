import { defineEventHandler, getRequestHeader } from 'h3'
import { getContext } from '../../../src/runtime.js'
import { readLimitedBody } from '../../../src/http/readLimitedBody.js'
import { parseBody, parseEnvelope, parseTaskAddEvent } from '../../../src/b24/eventPayload.js'
import { deletePortal, verifyApplicationToken } from '../../../src/store/portalTokens.js'
import { markFailed } from '../../../src/store/transfers.js'
import { findPortal } from '../../../src/domain/portals.js'
import { jobId, TASK_JOB_OPTIONS } from '../../../src/queue/queues.js'
import { log } from '../../../src/queue/workers.js'

/**
 * Приём событий портала клиента: `ONTASKADD` и `ONAPPUNINSTALL`.
 *
 * ⚠ ГЛАВНОЕ ПРАВИЛО: отвечаем 200 и как можно раньше. События Битрикс24 НЕ ретраятся
 * (docs/B24_EVENTS.md) — медленный или упавший ответ означает задачу клиента,
 * потерянную навсегда и молча. Поэтому здесь только сверка подлинности и постановка
 * в очередь; работа идёт в воркере.
 */
export default defineEventHandler(async (event) => {
  const { config, pool, queues } = getContext()

  const raw = await readLimitedBody(event)
  if (raw === null) {
    log('event-too-large', {})
    event.node.res.statusCode = 413
    return { ok: false, error: 'body_too_large' }
  }

  const body = parseBody(getRequestHeader(event, 'content-type'), raw)
  const envelope = parseEnvelope(body)

  if (envelope.event !== 'ONTASKADD' && envelope.event !== 'ONAPPUNINSTALL') {
    log('event-ignored', { b24Event: envelope.event, domain: envelope.domain })
    return { ok: true, ignored: 'event' }
  }

  // ⚠ Событие без `auth` (документация Битрикс24 честно предупреждает, что так бывает)
  // выглядело как «портал не наш» — при массовом сбое эти два случая неотличимы, а
  // чинятся по-разному. Найдено ревью.
  if (envelope.domain === '') {
    log('event-no-auth', { b24Event: envelope.event })
    return { ok: true, ignored: 'no_auth' }
  }

  const portal = findPortal(config.portals, envelope.domain)
  // ⚠ Портала нет в реестре — мы его не обслуживаем. Отвечаем 200: ругаться на
  // портал, который нам не поручали, смысла нет, а 500 заставил бы его повторять.
  if (!portal) {
    log('portal-unsupported', { domain: envelope.domain, b24Event: envelope.event })
    return { ok: true, ignored: 'portal' }
  }

  // ⚠ Единственное, что отличает событие портала от подделки: эндпоинт открыт миру.
  const authentic = envelope.applicationToken !== ''
    && (await verifyApplicationToken(pool, portal.domain, envelope.applicationToken))
  if (!authentic) {
    log('event-rejected', { domain: portal.domain, b24Event: envelope.event })
    event.node.res.statusCode = 401
    return { ok: false, error: 'application_token' }
  }

  if (envelope.event === 'ONAPPUNINSTALL') {
    // ⚠ Токены удалённого приложения уже недействительны, а в базе они выглядят
    // действующей установкой — портал числился бы подключённым, ничего не перенося.
    await deletePortal(pool, portal.domain)
    log('uninstalled', { domain: portal.domain })
    return { ok: true }
  }

  const parsed = parseTaskAddEvent(body)
  if (!parsed) {
    log('event-unparsed', { domain: portal.domain })
    return { ok: true, ignored: 'unparsed' }
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
    // ⚠ markFailed — upsert, но уже перенесённую задачу он не трогает: повторное
    // событие при лежащем Redis не должно переписывать успешный перенос в «провал»,
    // иначе человек заведёт задачу руками и получится дубль (находка ревью).
    await markFailed(pool, portal.domain, parsed.taskId, reason).catch(() => {})
    return { ok: true, warning: 'queue_unavailable' }
  }

  log('event-queued', { domain: portal.domain, taskId: parsed.taskId })
  return { ok: true }
})

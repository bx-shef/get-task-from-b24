import { defineEventHandler } from 'h3'
import { getContext } from '../../src/runtime.js'

/**
 * Живость сервиса: отвечает `ok`, пока база отвечает.
 * ⚠ Redis проверяется отдельной строкой: сервис с мёртвым Redis принимает события
 * и молча их теряет — это худшее из состояний, и оно обязано быть видимым.
 */
export default defineEventHandler(async (event) => {
  const { pool, queues } = getContext()

  const db = await pool.query('select 1').then(() => true).catch(() => false)
  const redis = await queues.taskEvents.getWaitingCount().then(() => true).catch(() => false)

  const ready = db && redis
  event.node.res.statusCode = ready ? 200 : 503
  return { status: ready ? 'ok' : 'degraded', checks: { db, redis } }
})

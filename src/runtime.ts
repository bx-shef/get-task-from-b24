/**
 * Общий контекст процесса: конфигурация, пул базы, очереди. Создаётся один раз
 * при старте (server/plugins/bootstrap.ts) и берётся роутами и воркерами.
 */
import { loadConfig, type AppConfig } from './config.js'
import { createPool, migrate, type Pool } from './store/db.js'
import { createQueues, type Queues } from './queue/queues.js'

export interface AppContext {
  config: AppConfig
  pool: Pool
  queues: Queues
}

let context: AppContext | null = null

export async function initContext(): Promise<AppContext> {
  if (context) return context

  // ⚠ Конфигурация читается ДО подключений: падать из-за незаданной переменной
  // нужно на старте, а не в момент прихода первого события клиента.
  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  await migrate(pool)

  context = { config, pool, queues: createQueues(config.redisUrl) }
  return context
}

export function getContext(): AppContext {
  if (!context) throw new Error('Контекст приложения не инициализирован')
  return context
}

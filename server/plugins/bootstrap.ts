import { initContext } from '../../src/runtime.js'
import { startWorkers } from '../../src/queue/workers.js'

/**
 * Старт процесса: конфигурация → база (миграции) → очереди → воркеры.
 *
 * ⚠ Воркеры живут в том же процессе, что и HTTP. Для 20–30 порталов это дёшево и
 * не требует второго контейнера; когда потока станет больше, воркер отделяется
 * переменной окружения — но заводить её раньше нужды не надо.
 */
export default async function bootstrap(): Promise<void> {
  const ctx = await initContext()
  startWorkers(ctx)
}

/**
 * Точка входа для цели `make issues`: выгрузка задач клиента в issue его репозитория.
 *
 * ⚠ Отдельная точка входа, а не скрипт внутри `Makefile`. На сервере нет исходников, но
 * в образе есть собранный код — значит логика может жить в одном месте и пользоваться
 * настоящими модулями, вместо того чтобы дублировать их текстом в цели `make`
 * (как пришлось сделать для `backfill`, и там это стережёт отдельный тест).
 *
 * ⚠ Ничего не печатает про токены: отчёт состоит из номеров задач и ссылок `owner/repo#N`.
 */
import { loadConfig } from '../config.js'
import { findPortal, normalizeDomain } from '../domain/portals.js'
import { ExportRefused, exportIssues } from '../pipeline/exportIssues.js'

/** Потолок за прогон: дальше каждая задача — это вызов портала и вызов GitHub. */
const DEFAULT_LIMIT = 50

async function main(): Promise<number> {
  const domain = normalizeDomain(process.env.PORTAL ?? '')
  if (!domain) {
    console.error('Нужно: PORTAL=portal.example.by make issues')
    return 1
  }

  const rawLimit = (process.env.LIMIT ?? '').trim()
  const limit = rawLimit ? Number(rawLimit) : DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
    console.error(`LIMIT: ожидалось число от 1 до 200, получено «${rawLimit}»`)
    return 1
  }

  const config = loadConfig()
  const portal = findPortal(config.portals, domain)
  if (!portal) {
    console.error(`${domain} не найден среди подключённых клиентов. Смотреть: make clients`)
    return 1
  }

  const report = await exportIssues(config, portal, { limit })

  console.log(`Репозиторий: ${report.repo.owner}/${report.repo.repo}`)
  for (const line of report.lines) {
    console.log(`${line.taskId}: ${line.status === 'exported' ? line.text : `ОШИБКА — ${line.text}`}`)
  }
  console.log(`Итого: выгружено ${report.exported}, с ошибкой ${report.failed}`)

  // ⚠ Ненулевой код возврата при единственной неудаче: прогон, где часть задач не
  // выгрузилась, не должен выглядеть успешным в глазах оператора и крона.
  return report.failed > 0 ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    // Отказ до начала работы (нет настройки, нет репозитория в описании группы) —
    // это сообщение человеку, а не стек.
    console.error(error instanceof ExportRefused ? `Отказ: ${error.message}` : error)
    process.exitCode = 1
  })

/**
 * Цель `make backfill` кладёт задания в ту же очередь, что и вебхук, но делает это
 * скриптом внутри Makefile: на сервере нет ни репозитория, ни node_modules.
 *
 * ⚠ Значит имя очереди, префикс ключей, формат `jobId` и параметры повторов записаны
 * ДВАЖДЫ — в коде и в Makefile. Это ровно тот случай, про который в CLAUDE.md сказано
 * «продублированные утверждения расходятся молча»: переименуют очередь в коде, а
 * доставка задач с нового портала будет тихо падать в пустоту. Убрать дубль нельзя
 * (сервер не видит исходников), поэтому его стережёт этот тест.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { QUEUE_PREFIX, TASK_EVENTS_QUEUE, TASK_JOB_OPTIONS, jobId } from '../src/queue/queues.js'

const MAKEFILE = readFileSync(join(import.meta.dirname, '..', 'Makefile'), 'utf8')

/** Тело `define BACKFILL_JS … endef` — тот текст, который уезжает в контейнер. */
function backfillScript(): string {
  const match = /^define BACKFILL_JS$(.*?)^endef$/ms.exec(MAKEFILE)
  if (!match) throw new Error('в Makefile не найден блок define BACKFILL_JS')
  return match[1]!
}

describe('цель make backfill', () => {
  const script = backfillScript()

  it('кладёт задания в ту же очередь, что и обработчик события', () => {
    expect(script).toContain(`'${TASK_EVENTS_QUEUE}'`)
  })

  it('пишет в то же пространство ключей Redis', () => {
    expect(script).toContain(`prefix: '${QUEUE_PREFIX}'`)
  })

  it('собирает jobId так же, как код', () => {
    // В скрипте id — строка (пришла из TASKS), в коде — число; склейка обязана совпасть.
    expect(jobId('portal.example.by', 101)).toBe('portal.example.by--101')
    expect(script).toContain("const key = domain + '--' + id")
  })

  it('повторяет параметры повторов из TASK_JOB_OPTIONS', () => {
    expect(script).toContain(`attempts: ${TASK_JOB_OPTIONS.attempts}`)
    expect(script).toContain(`delay: ${TASK_JOB_OPTIONS.backoff.delay}`)
    expect(script).toContain(`type: '${TASK_JOB_OPTIONS.backoff.type}'`)
    expect(script).toContain(`removeOnComplete: { count: ${TASK_JOB_OPTIONS.removeOnComplete.count} }`)
    expect(script).toContain(`removeOnFail: { count: ${TASK_JOB_OPTIONS.removeOnFail.count} }`)
  })

  it('называет задание так же, как обработчик события', () => {
    const handler = readFileSync(
      join(import.meta.dirname, '..', 'server', 'routes', 'b24', 'handler.post.ts'),
      'utf8',
    )
    expect(handler).toContain("'transfer'")
    expect(script).toContain("queue.add('transfer'")
  })

  it('не пересоздаёт уже известное задание без FORCE', () => {
    expect(script).toContain('const known = await queue.getJob(key)')
    expect(script).toContain("process.env.FORCE === '1'")
  })

  it('не роняет батч, если задание сейчас обрабатывается', () => {
    // Активное задание удалить нельзя: BullMQ держит блокировку воркера и бросает
    // исключение. Без перехвата оно роняло все оставшиеся id.
    expect(script).toContain('await known.remove()')
    expect(/try \{[^}]*await known\.remove\(\)/s.test(script)).toBe(true)
  })

  it('гасит только блокировку, а не любую ошибку очереди', () => {
    // ⚠ Широкий catch выдал бы упавший Redis за «занято, попробуйте позже» — авария
    // уехала бы под правдоподобным текстом. Найдено вторым циклом панели.
    expect(script).toContain("includes('locked by another worker')")
    expect(script).toContain('throw error')
  })

  it('текст блокировки совпадает с тем, что бросает BullMQ', async () => {
    // ⚠ Признак — подстрока чужого сообщения об ошибке: обновят библиотеку, изменят
    // формулировку — и перехват начнёт пропускать наружу то, что должен гасить.
    // Поэтому сверяем с исходником установленной версии.
    const { readFileSync } = await import('node:fs')
    const job = readFileSync(
      join(import.meta.dirname, '..', 'node_modules', 'bullmq', 'dist', 'cjs', 'classes', 'job.js'),
      'utf8',
    )
    expect(job).toContain('locked by another worker')
  })

  it('держит тот же контракт по taskId, что и обработчик события', () => {
    expect(script).toContain('Number.isInteger(taskId) && taskId > 0')
  })

  it('Makefile разбирается и цель раскрывается', () => {
    // ⚠ Остальные проверки — текстовые: сломанный `define`/`endef` или лишняя кавычка
    // прошли бы мимо них, а сломали бы ВЕСЬ Makefile — и `client-add`, и
    // `prod-redeploy`. Узналось бы это на сервере, в неудачный момент. Найдено панелью.
    const root = join(import.meta.dirname, '..')
    const dry = execFileSync('make', ['-n', 'backfill'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PORTAL: 'portal.example.by', TASKS: '101' },
    })
    expect(dry).toContain('docker compose')
    expect(dry).toContain('app node')
  })
})

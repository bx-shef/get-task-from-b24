/**
 * Перенос одной задачи: вычитать у клиента → проверить критерии → занять в журнале →
 * создать у нас → уведомить. Спецификация — docs/PROCESSING.md.
 *
 * Побочные эффекты приходят снаружи (TransferDeps), поэтому весь порядок действий
 * проверяется тестами без сети, базы и портала.
 */
import { decide, type SkipReason } from '../domain/criteria.js'
import { buildTargetTask, type SourceTaskFull, type TargetTaskFields } from '../domain/taskMapping.js'
import { buildCreatedMessage, buildFailureMessage } from '../domain/telegramMessage.js'
import type { PortalConfig } from '../domain/portals.js'

export interface TransferDeps {
  loadTask(domain: string, taskId: number): Promise<SourceTaskFull>
  createTask(fields: TargetTaskFields): Promise<number>
  /** Занять задачу в журнале. `false` — её уже занял кто-то другой. */
  claim(domain: string, taskId: number): Promise<boolean>
  markDone(domain: string, taskId: number, targetTaskId: number): Promise<void>
  markFailed(domain: string, taskId: number, reason: string): Promise<void>
  /** Постановка сообщения в очередь уведомлений — не отправка. */
  notify(text: string): Promise<void>
  now(): Date
  log(event: string, data: Record<string, unknown>): void
}

export interface TransferSettings {
  portal: PortalConfig
  targetDomain: string
  targetResponsibleId: number
  titlePrefix: string
  defaultDeadlineHours: number
}

export type TransferOutcome =
  | { status: 'created'; targetTaskId: number }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'duplicate' }

export interface TransferContext {
  /**
   * Будет ли ещё попытка. Не булев флаг, а вопрос об ошибке: повтора не будет ни когда
   * попытки очереди исчерпаны, ни когда ошибка невосстановима («портал не установлен») —
   * а второе известно только по самой ошибке.
   */
  isFinalFailure(error: unknown): boolean
}

export async function transferTask(
  taskId: number,
  deps: TransferDeps,
  settings: TransferSettings,
  context: TransferContext = { isFinalFailure: () => false },
): Promise<TransferOutcome> {
  const domain = settings.portal.domain

  try {
    // ⚠ В событии приходит только ID (docs/B24_EVENTS.md), поэтому критерии проверяются
    // ПОСЛЕ похода в портал, а не по телу запроса.
    const source = await deps.loadTask(domain, taskId)

    const verdict = decide(source, settings.portal, settings.titlePrefix)
    if (!verdict.transfer) {
      // ⚠ Отказ — норма: на портале клиента задачи создаются постоянно. В журнал
      // переносов он не пишется, иначе журнал перестаёт быть журналом переносов.
      deps.log('skip', { domain, taskId, reason: verdict.reason })
      return { status: 'skipped', reason: verdict.reason }
    }

    // ⚠ Занимаем ДО создания: два события об одной задаче могут идти одновременно,
    // и решает это первичный ключ базы, а не проверка «уже есть?» перед вставкой.
    if (!(await deps.claim(domain, taskId))) {
      deps.log('duplicate', { domain, taskId })
      return { status: 'duplicate' }
    }

    const fields = buildTargetTask(source, {
      domain,
      responsibleId: settings.targetResponsibleId,
      now: deps.now(),
      defaultDeadlineHours: settings.defaultDeadlineHours,
      titlePrefix: settings.titlePrefix,
    })

    const targetTaskId = await deps.createTask(fields)
    await deps.markDone(domain, taskId, targetTaskId)
    deps.log('created', { domain, taskId, targetTaskId })

    // ⚠ Уведомление ставится в очередь отдельным шагом: упавший Telegram не должен
    // приводить к повторному созданию задачи — она уже создана.
    await deps.notify(
      buildCreatedMessage({
        title: fields.TITLE,
        domain,
        sourceTaskId: taskId,
        targetTaskId,
        targetDomain: settings.targetDomain,
      }),
    )

    return { status: 'created', targetTaskId }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const final = context.isFinalFailure(error)
    await deps.markFailed(domain, taskId, reason).catch(() => {})
    deps.log('failed', { domain, taskId, reason, final })

    // ⚠ Будим человека только когда повтора не будет: сигнал на каждый ретрай
    // приучает не смотреть на сигналы.
    if (final) {
      await deps.notify(buildFailureMessage({ domain, sourceTaskId: taskId, error: reason })).catch(() => {})
    }

    throw error
  }
}

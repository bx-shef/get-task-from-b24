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
import type { ClaimResult } from '../store/transfers.js'

export interface TransferDeps {
  loadTask(domain: string, taskId: number): Promise<SourceTaskFull>
  createTask(fields: TargetTaskFields): Promise<number>
  /** Занять задачу в журнале. */
  claim(domain: string, taskId: number): Promise<ClaimResult>
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
  /** Код поля у нас, куда писать ID задачи клиента. */
  sourceTaskField?: string | null
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
  let created: number | undefined

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
    const claim = await deps.claim(domain, taskId)
    if (!claim.claimed) {
      // ⚠ «Уже перенесена» и «занята другим прямо сейчас» — РАЗНЫЕ исходы, и путать их
      // нельзя. Второй случай возникает, когда воркер убит посреди переноса (выкат,
      // OOM): BullMQ возвращает зависшее задание, а мы, приняв это за дубль,
      // завершались успешно — задача клиента не создана, строка навсегда в `pending`.
      // Найдено вторым циклом ревью.
      if (claim.transferred) {
        deps.log('duplicate', { domain, taskId })
        return { status: 'duplicate' }
      }
      throw new Error('задача занята другим воркером — повторим позже')
    }

    const fields = buildTargetTask(source, {
      domain,
      responsibleId: settings.targetResponsibleId,
      now: deps.now(),
      defaultDeadlineHours: settings.defaultDeadlineHours,
      titlePrefix: settings.titlePrefix,
      // Группа задаётся ПО КЛИЕНТУ: у каждого своя, и это пятое поле в реестре.
      groupId: settings.portal.groupId,
      sourceTaskField: settings.sourceTaskField,
    })

    created = await deps.createTask(fields)
    await deps.markDone(domain, taskId, created)
    deps.log('created', { domain, taskId, targetTaskId: created, groupId: fields.GROUP_ID ?? 0 })

    // ⚠ Уведомление ставится в очередь отдельным шагом и НЕ роняет перенос: задача уже
    // создана, а повтор задания сходил бы в портал заново и завершился «дублем» —
    // работа впустую, а сообщение всё равно потеряно. Найдено вторым циклом ревью.
    await deps
      .notify(
        buildCreatedMessage({
          title: fields.TITLE,
          domain,
          sourceTaskId: taskId,
          targetTaskId: created,
          targetDomain: settings.targetDomain,
        }),
      )
      .catch((error: unknown) => {
        deps.log('notify-failed', { domain, taskId, reason: (error as Error).message })
      })

    return { status: 'created', targetTaskId: created }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const final = context.isFinalFailure(error)

    if (created !== undefined) {
      // ⚠ Задача у нас УЖЕ создана: журнал обязан это запомнить, иначе следующая
      // попытка перезаймёт строку и заведёт вторую. Этот дефект внесла правка `claim`
      // из первого цикла и поймал второй: замерено — создавались задачи 1000 и 1001.
      await deps.markDone(domain, taskId, created).catch(() => {})
      deps.log('failed-after-create', { domain, taskId, targetTaskId: created, reason })
      return { status: 'created', targetTaskId: created }
    }

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

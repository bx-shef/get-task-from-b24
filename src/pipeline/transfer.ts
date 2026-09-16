/**
 * Перенос одной задачи: вычитать у клиента → проверить критерии → спросить наш портал,
 * не переносили ли её уже → создать → сверить → уведомить. Спецификация —
 * docs/PROCESSING.md.
 *
 * ⚠ Журнала переносов больше нет: связка «задача клиента → наша задача» живёт в самих
 * UF-полях задачи (docs/PRODUCT.md, раздел 1а). Отсюда два следствия, которые надо
 * держать в голове, читая этот файл: (1) превентивной блокировки не существует, гонка
 * закрывается сверкой ПОСЛЕ создания; (2) спросить «переносили ли» можно только у
 * портала, то есть ответ стоит сетевого вызова и может не прийти.
 *
 * Побочные эффекты приходят снаружи (TransferDeps), поэтому весь порядок действий
 * проверяется тестами без сети, базы и портала.
 */
import { decide, type SkipReason } from '../domain/criteria.js'
import { buildTargetTask, type SourceTaskFull, type TargetTaskFields } from '../domain/taskMapping.js'
import {
  buildCreatedMessage,
  buildDuplicateMessage,
  buildFailureMessage,
  buildUnverifiedMessage,
  type DuplicateOutcome,
} from '../domain/telegramMessage.js'
import type { PortalConfig } from '../domain/portals.js'

export interface TransferDeps {
  loadTask(domain: string, taskId: number): Promise<SourceTaskFull>
  createTask(fields: TargetTaskFields): Promise<number>
  /**
   * ID наших задач, уже перенесённых по этой паре «портал + задача», по возрастанию.
   * Это и есть замена журнала.
   */
  findTransferred(domain: string, taskId: number): Promise<number[]>
  /** Удалить нашу задачу. Вызывается только сверкой после создания. */
  deleteTask(targetTaskId: number): Promise<void>
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
  sourceTaskField: string
  /** Код поля у нас, куда писать домен портала клиента. */
  sourceDomainField: string
}

export type TransferOutcome =
  | { status: 'created'; targetTaskId: number }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'duplicate'; targetTaskId: number }

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
      // ⚠ Отказ — норма: на портале клиента задачи создаются постоянно, и 99% из них
      // нас не касаются. Никуда, кроме лога, он не пишется.
      deps.log('skip', { domain, taskId, reason: verdict.reason })
      return { status: 'skipped', reason: verdict.reason }
    }

    // ⚠ Спрашиваем ДО создания — это ловит нормальный случай: повторная доставка
    // события или ручной досыл уже перенесённой задачи. Гонку двух воркеров эта
    // проверка НЕ закрывает и не притворяется, что закрывает: между ответом портала и
    // созданием задачи есть окно. Его закрывает сверка ниже.
    //
    // ⚠ Ошибку этого вызова НЕ проглатываем: не ответивший портал означает «не знаю,
    // переносили ли», а не «не переносили». Проглотив, мы бы на каждом сбое поиска
    // заводили второй экземпляр задачи — то есть починили бы редкий дубль ценой
    // регулярного.
    const before = await deps.findTransferred(domain, taskId)
    const alreadyTransferred = before[0]
    if (alreadyTransferred !== undefined) {
      deps.log('duplicate', { domain, taskId, targetTaskId: alreadyTransferred })
      return { status: 'duplicate', targetTaskId: alreadyTransferred }
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
      sourceDomainField: settings.sourceDomainField,
    })

    created = await deps.createTask(fields)
    deps.log('created', { domain, taskId, targetTaskId: created, groupId: fields.GROUP_ID ?? 0 })

    // ⚠ Внешний перехват — не перестраховка: внутри `verifyUnique` защищены сетевые
    // вызовы, но не `deps.log`. Упавший логгер после удаления нашей задачи улетал в
    // общий `catch` ниже, и перенос возвращал ID УЖЕ УДАЛЁННОЙ задачи. Найдено вторым
    // циклом панели.
    let verdictAfter: UniqueVerdict = { duplicate: false }
    try {
      verdictAfter = await verifyUnique(created, taskId, deps, settings)
    } catch (error) {
      try {
        deps.log('dedup-check-failed', { domain, taskId, targetTaskId: created, reason: (error as Error).message })
      } catch { /* логгер и есть источник сбоя — глотаем молча */ }
    }
    if (verdictAfter.duplicate) return { status: 'duplicate', targetTaskId: verdictAfter.keptTaskId }

    // ⚠ Ниже уходит обычное «задача создана» — в том числе когда сверка только что
    // сообщила о гонке. Это не противоречие: в той ветке жить остаётся ИМЕННО наша
    // задача, а лишнюю удалит тот перенос, который её создал. Два сообщения подряд
    // здесь честнее одного: первое объясняет, откуда взялась вторая задача.

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
      // ⚠ Задача у нас УЖЕ создана — ретраить нечего: повтор завёл бы вторую. Раньше
      // здесь дописывался журнал, теперь дописывать нечего (связку несёт сама задача),
      // но исход остаётся тем же — успех со следом в логе.
      deps.log('failed-after-create', { domain, taskId, targetTaskId: created, reason })
      return { status: 'created', targetTaskId: created }
    }

    deps.log('failed', { domain, taskId, reason, final })

    // ⚠ Будим человека только когда повтора не будет: сигнал на каждый ретрай
    // приучает не смотреть на сигналы.
    if (final) {
      await deps.notify(buildFailureMessage({ domain, sourceTaskId: taskId, error: reason })).catch(() => {})
    }

    throw error
  }
}

type UniqueVerdict = { duplicate: false } | { duplicate: true; keptTaskId: number }

/**
 * Сверка после создания — то, чем заменена блокировка журнала.
 *
 * ⚠ Живёт «на что бы там ни было»: она НЕ имеет права уронить перенос. Задача уже
 * создана, ретрай сходил бы в портал по второму кругу и в лучшем случае ничего не
 * изменил, а в худшем — завёл бы третью задачу. Поэтому любой сбой самой сверки
 * остаётся строкой в логе.
 *
 * ⚠ Из двух задач остаётся та, у которой ID меньше: она создана раньше. Правило
 * одинаково у всех воркеров — значит, столкнувшись, они выберут одну и ту же задачу,
 * а удалять её будет только тот, кто создал другую.
 */
async function verifyUnique(
  created: number,
  sourceTaskId: number,
  deps: TransferDeps,
  settings: TransferSettings,
): Promise<UniqueVerdict> {
  const domain = settings.portal.domain

  let found: number[]
  try {
    found = await deps.findTransferred(domain, sourceTaskId)
  } catch (error) {
    deps.log('dedup-check-failed', { domain, taskId: sourceTaskId, targetTaskId: created, reason: (error as Error).message })
    return { duplicate: false }
  }

  // ⚠ Созданной задачи нет в ответе — сломана сама дедупликация, а не этот перенос:
  // значит, по паре UF-полей задача не находится, и КАЖДОЕ следующее событие по ней
  // заведёт новую. Обычная причина — код поля в окружении не совпал с порталом, а
  // `tasks.task.add` неизвестное поле молча проглотил.
  if (!found.includes(created)) {
    // ⚠ Перечисляем найденные ID, а не только их число: если по паре уже есть чужая
    // задача, а нашей в ответе нет, человеку нужно знать, на что смотреть. Найдено
    // вторым циклом панели.
    deps.log('dedup-unverified', { domain, taskId: sourceTaskId, targetTaskId: created, found })
    await deps
      .notify(buildUnverifiedMessage({ domain, sourceTaskId, targetDomain: settings.targetDomain, targetTaskId: created }))
      .catch(() => {})
    return { duplicate: false }
  }

  const kept = found[0]
  if (found.length < 2 || kept === undefined) return { duplicate: false }

  // ⚠ Перечисляем ВСЕ лишние, а не одну: воркеров может столкнуться и три. Задача,
  // не названная в сигнале, останется на портале сиротой, и узнать о ней будет неоткуда.
  const extras = found.filter((id) => id !== kept)
  // ⚠ Имя по существу: истинно, когда жить остаётся НЕ наша задача, — то есть когда
  // удалять свою придётся нам. Прежнее `ours` читалось ровно наоборот, а цена ошибки
  // здесь — «удалили не ту». Найдено вторым циклом панели.
  const ourTaskIsExtra = kept !== created

  let outcome: DuplicateOutcome = { kind: 'theirs' }
  if (ourTaskIsExtra) {
    outcome = { kind: 'failed', ourExtraTaskId: created }
    // ⚠ Вторая попытка — только на ВОССТАНОВИМОЙ ошибке. Не удалённая задача остаётся
    // сиротой с заполненными UF-полями: следующий поиск найдёт обе, вернёт старшую — и
    // на дубль больше никто не посмотрит. Но повторять невосстановимое нельзя: «портал
    // не подтвердил удаление» может означать, что задачу он всё-таки удалил, и второй
    // заход получил бы отказ по несуществующей задаче — человека позвали бы удалять
    // руками то, чего нет. Оба хвоста найдены панелью.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await deps.deleteTask(created)
        outcome = { kind: 'removed', ourExtraTaskId: created }
        break
      } catch (error) {
        const retryable = (error as { retryable?: unknown } | null)?.retryable === true
        deps.log('dedup-delete-failed', {
          domain, taskId: sourceTaskId, targetTaskId: created, attempt, retryable,
          reason: (error as Error).message,
        })
        if (!retryable) break
      }
    }
  }

  // ⚠ Исход относится ТОЛЬКО к нашей задаче. Чужие лишние идут отдельной строкой: их
  // удалят те переносы, которые их создали, и назвать их «удалёнными» значит соврать.
  const otherExtraTaskIds = extras.filter((id) => id !== created)
  deps.log('dedup-duplicate', {
    domain, taskId: sourceTaskId, keptTaskId: kept, extraTaskIds: extras, outcome: outcome.kind,
  })
  await deps
    .notify(
      buildDuplicateMessage({
        domain,
        sourceTaskId,
        targetDomain: settings.targetDomain,
        keptTaskId: kept,
        outcome,
        otherExtraTaskIds,
      }),
    )
    .catch(() => {})

  // Наша задача и есть самая ранняя — перенос состоялся, исход обычный. Лишние удалят
  // те переносы, которые их создали: правило «остаётся меньший ID» у всех одно.
  return ourTaskIsExtra ? { duplicate: true, keptTaskId: kept } : { duplicate: false }
}

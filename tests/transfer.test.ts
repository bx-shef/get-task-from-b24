import { describe, expect, it, vi } from 'vitest'
import { transferTask, type TransferDeps, type TransferSettings } from '../src/pipeline/transfer.js'
import type { SourceTaskFull } from '../src/domain/taskMapping.js'
import type { ClaimResult } from '../src/store/transfers.js'

const settings: TransferSettings = {
  portal: { domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'a', clientSecret: 'b', groupId: 0 },
  targetDomain: 'my.bitrix24.ru',
  targetResponsibleId: 1,
  titlePrefix: '#support',
  defaultDeadlineHours: 24,
}

const task: SourceTaskFull = {
  id: 555,
  title: '#support Не грузится отчёт',
  description: 'белый экран',
  responsibleId: 17,
  createdBy: 3,
  createdByName: 'Иван Петров',
  deadline: undefined,
}

function makeDeps(overrides: Partial<TransferDeps> = {}): TransferDeps {
  return {
    loadTask: vi.fn(async () => task),
    createTask: vi.fn(async () => 42),
    claim: vi.fn(async () => ({ claimed: true }) as ClaimResult),
    markDone: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    now: () => new Date('2026-08-26T10:00:00.000Z'),
    log: vi.fn(),
    ...overrides,
  }
}

describe('transferTask', () => {
  it('создаёт задачу и ставит уведомление в очередь', async () => {
    const deps = makeDeps()
    const outcome = await transferTask(555, deps, settings)

    expect(outcome).toEqual({ status: 'created', targetTaskId: 42 })
    expect(deps.createTask).toHaveBeenCalledWith(expect.objectContaining({
      TITLE: 'Не грузится отчёт',
      RESPONSIBLE_ID: 1,
      DEADLINE: '2026-08-27T10:00:00+00:00',
    }))
    expect(deps.markDone).toHaveBeenCalledWith('client.bitrix24.ru', 555, 42)
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('Задача создана')
  })

  it('не тот префикс — не создаём и не занимаем журнал', async () => {
    const deps = makeDeps({ loadTask: vi.fn(async () => ({ ...task, title: 'обычная задача' })) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'skipped', reason: 'title-prefix' })
    expect(deps.claim).not.toHaveBeenCalled()
    expect(deps.createTask).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('не тот исполнитель — отказ', async () => {
    const deps = makeDeps({ loadTask: vi.fn(async () => ({ ...task, responsibleId: 99 })) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'skipped', reason: 'responsible' })
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  // ⚠ Ровно та авария, ради которой заведён журнал: повторная доставка события.
  it('задача уже перенесена — второй не создаём', async () => {
    const deps = makeDeps({ claim: vi.fn(async () => ({ claimed: false, transferred: true }) as ClaimResult) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'duplicate' })
    expect(deps.createTask).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  // ⚠ Найдено вторым циклом ревью: воркер, убитый посреди переноса, оставляет свежую
  // занятую строку. BullMQ возвращает зависшее задание — и раньше мы принимали это за
  // дубль и завершались УСПЕШНО: задача клиента не создана, ретраев больше нет.
  it('занята другим воркером — это не дубль, а повод повторить', async () => {
    const deps = makeDeps({ claim: vi.fn(async () => ({ claimed: false, transferred: false }) as ClaimResult) })
    await expect(transferTask(555, deps, settings)).rejects.toThrow(/занята другим/)
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  // ⚠ Дефект, внесённый правкой claim из первого цикла и пойманный вторым: сбой ПОСЛЕ
  // создания задачи помечал строку провалом, следующая попытка её перезанимала и
  // создавала ВТОРУЮ задачу у нас.
  it('задача создана, но журнал не записался — второй задачи не будет', async () => {
    const markDone = vi.fn()
      .mockRejectedValueOnce(new Error('база недоступна'))
      .mockResolvedValueOnce(undefined)
    const deps = makeDeps({ markDone })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(deps.markFailed).not.toHaveBeenCalled()
    expect(markDone).toHaveBeenCalledTimes(2)
  })

  // ⚠ Повтор задания сходил бы в портал заново и завершился «дублем» — работа впустую,
  // а сообщение всё равно потеряно.
  it('упавшее уведомление не роняет перенос', async () => {
    const deps = makeDeps({ notify: vi.fn(async () => { throw new Error('Redis лёг') }) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  // ⚠ Порядок обязателен: занять ДО создания, иначе гонка двух воркеров даёт дубль.
  it('занимает журнал раньше, чем создаёт задачу', async () => {
    const order: string[] = []
    const deps = makeDeps({
      claim: vi.fn(async () => { order.push('claim'); return { claimed: true } as ClaimResult }),
      createTask: vi.fn(async () => { order.push('create'); return 42 }),
    })
    await transferTask(555, deps, settings)
    expect(order).toEqual(['claim', 'create'])
  })

  it('падение создания помечает провал и пробрасывает ошибку очереди', async () => {
    const deps = makeDeps({ createTask: vi.fn(async () => { throw new Error('портал занят') }) })
    await expect(transferTask(555, deps, settings)).rejects.toThrow('портал занят')
    expect(deps.markFailed).toHaveBeenCalledWith('client.bitrix24.ru', 555, 'портал занят')
  })

  // ⚠ Сигнал на каждый ретрай приучает не смотреть на сигналы.
  it('о провале сообщаем только на последней попытке', async () => {
    const failing = { createTask: vi.fn(async (): Promise<number> => { throw new Error('таймаут') }) }

    const notLast = makeDeps(failing)
    await expect(transferTask(555, notLast, settings, { isFinalFailure: () => false })).rejects.toThrow()
    expect(notLast.notify).not.toHaveBeenCalled()

    const last = makeDeps(failing)
    await expect(transferTask(555, last, settings, { isFinalFailure: () => true })).rejects.toThrow()
    expect(vi.mocked(last.notify).mock.calls[0]?.[0]).toContain('не удался')
  })

  it('упавшая отметка провала не подменяет исходную ошибку', async () => {
    const deps = makeDeps({
      createTask: vi.fn(async (): Promise<number> => { throw new Error('портал занят') }),
      markFailed: vi.fn(async () => { throw new Error('база недоступна') }),
    })
    await expect(transferTask(555, deps, settings)).rejects.toThrow('портал занят')
  })
})

describe('швы: что из настроек доезжает до запроса', () => {
  // ⚠ Ревью показало мутацией: проброс группы можно было выкинуть, и все тесты
  // оставались зелёными. Группа переставала проставляться у ВСЕХ клиентов молча —
  // портал неверный или отсутствующий GROUP_ID не оспаривает.
  it('группа клиента доезжает до создаваемой задачи', async () => {
    const deps = makeDeps()
    await transferTask(555, deps, { ...settings, portal: { ...settings.portal, groupId: 42 } })
    expect(deps.createTask).toHaveBeenCalledWith(expect.objectContaining({ GROUP_ID: 42 }))
  })

  it('без группы поля в запросе нет', async () => {
    const deps = makeDeps()
    await transferTask(555, deps, settings)
    expect(deps.createTask).toHaveBeenCalledWith(expect.not.objectContaining({ GROUP_ID: expect.anything() }))
  })

  // ⚠ Тот же шов: настройка валидируется на старте и покрыта юнитами маппера, но
  // могла не доезжать до запроса вовсе.
  it('код поля с ID задачи клиента доезжает до создаваемой задачи', async () => {
    const deps = makeDeps()
    await transferTask(555, deps, { ...settings, sourceTaskField: 'UF_SOURCE_TASK_ID' })
    expect(deps.createTask).toHaveBeenCalledWith(expect.objectContaining({ UF_SOURCE_TASK_ID: 555 }))
  })
})

describe('обратный адрес в задаче у нас', () => {
  it('домен клиента доезжает до создаваемой задачи', async () => {
    const deps = makeDeps()
    await transferTask(555, deps, { ...settings, sourceDomainField: 'UF_SOURCE_DOMAIN' })
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ UF_SOURCE_DOMAIN: 'client.bitrix24.ru' }),
    )
  })
})

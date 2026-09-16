import { describe, expect, it, vi } from 'vitest'
import { transferTask, type TransferDeps, type TransferSettings } from '../src/pipeline/transfer.js'
import type { SourceTaskFull } from '../src/domain/taskMapping.js'
import { B24Error } from '../src/b24/errors.js'

const settings: TransferSettings = {
  portal: { domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'a', clientSecret: 'b', groupId: 0 },
  targetDomain: 'my.bitrix24.ru',
  targetResponsibleId: 1,
  titlePrefix: '#support',
  defaultDeadlineHours: 24,
  sourceTaskField: 'UF_SOURCE_TASK_ID',
  sourceDomainField: 'UF_SOURCE_DOMAIN',
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

/**
 * По умолчанию портал отвечает так, как отвечает в норме: до создания задачи нет,
 * после — ровно одна, созданная нами.
 */
function makeDeps(overrides: Partial<TransferDeps> = {}): TransferDeps {
  let created = false
  return {
    loadTask: vi.fn(async () => task),
    createTask: vi.fn(async () => {
      created = true
      return 42
    }),
    findTransferred: vi.fn(async () => (created ? [42] : [])),
    deleteTask: vi.fn(async () => {}),
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
    expect(deps.deleteTask).not.toHaveBeenCalled()
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('Задача создана')
  })

  it('не тот префикс — портал даже не спрашиваем', async () => {
    const deps = makeDeps({ loadTask: vi.fn(async () => ({ ...task, title: 'обычная задача' })) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'skipped', reason: 'title-prefix' })
    expect(deps.findTransferred).not.toHaveBeenCalled()
    expect(deps.createTask).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('не тот исполнитель — отказ', async () => {
    const deps = makeDeps({ loadTask: vi.fn(async () => ({ ...task, responsibleId: 99 })) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'skipped', reason: 'responsible' })
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  // ⚠ Ровно та авария, ради которой существовала дедупликация: повторная доставка
  // события или ручной досыл уже перенесённой задачи.
  it('задача уже перенесена — второй не создаём', async () => {
    const deps = makeDeps({ findTransferred: vi.fn(async () => [7]) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'duplicate', targetTaskId: 7 })
    expect(deps.createTask).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  // ⚠ Главный риск замены журнала на вопрос к порталу: «не знаю» нельзя принимать за
  // «не переносили», иначе каждый сбой поиска заводит вторую задачу.
  it('портал не ответил на поиск — задачу НЕ создаём, ошибку пробрасываем', async () => {
    const deps = makeDeps({ findTransferred: vi.fn(async () => { throw new Error('портал занят') }) })
    await expect(transferTask(555, deps, settings)).rejects.toThrow('портал занят')
    expect(deps.createTask).not.toHaveBeenCalled()
  })

  // ⚠ Правило «остаётся меньший ID» заявлено единым для всех путей — значит и здесь.
  it('предпроверка нашла две задачи — исходом будет старшая из них', async () => {
    const deps = makeDeps({ findTransferred: vi.fn(async () => [11, 42]) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'duplicate', targetTaskId: 11 })
  })

  // ⚠ Ветка «сбой ПОСЛЕ создания задачи»: ретраить нечего, повтор завёл бы вторую.
  // Мутация «удалить весь блок» раньше проходила мимо тестов — находка панели.
  it('сбой после создания задачи не уходит в ретрай', async () => {
    const log = vi.fn((event: string) => {
      if (event === 'created') throw new Error('логгер упал')
    })
    const deps = makeDeps({ log })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(log.mock.calls.map((c) => c[0])).toContain('failed-after-create')
  })

  // ⚠ Порядок обязателен: спросить ДО создания.
  it('спрашивает портал раньше, чем создаёт задачу', async () => {
    const order: string[] = []
    const deps = makeDeps({
      findTransferred: vi.fn(async () => { order.push('find'); return [] }),
      createTask: vi.fn(async () => { order.push('create'); return 42 }),
    })
    await transferTask(555, deps, settings)
    expect(order[0]).toBe('find')
    expect(order[1]).toBe('create')
  })

  // ⚠ Повтор задания сходил бы в портал заново и завершился «дублем» — работа впустую,
  // а сообщение всё равно потеряно.
  it('упавшее уведомление не роняет перенос', async () => {
    const deps = makeDeps({ notify: vi.fn(async () => { throw new Error('Redis лёг') }) })
    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
  })

  it('падение создания пробрасывает ошибку очереди', async () => {
    const deps = makeDeps({ createTask: vi.fn(async () => { throw new Error('портал занят') }) })
    await expect(transferTask(555, deps, settings)).rejects.toThrow('портал занят')
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
})

/**
 * Сверка после создания — то, чем заменена блокировка журнала. Раздел проверяет
 * именно её: журнала больше нет, и это единственная защита от гонки.
 */
describe('сверка после создания', () => {
  it('нашлась вторая задача старше нашей — свою удаляем и сообщаем', async () => {
    const deps = makeDeps({ findTransferred: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([11, 42]) })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'duplicate', targetTaskId: 11 })
    expect(deps.deleteTask).toHaveBeenCalledWith(42)
    const text = vi.mocked(deps.notify).mock.calls[0]?.[0] ?? ''
    expect(text).toContain('дважды')
    expect(text).toContain('лишняя удалена')
    // ⚠ Сообщение «задача создана» тут не к месту: жить остаётся чужая задача.
    expect(vi.mocked(deps.notify).mock.calls).toHaveLength(1)
  })

  // ⚠ Правило «остаётся меньший ID» одинаково у всех воркеров: столкнувшись, они
  // выберут одну и ту же задачу, и удалять будет ровно тот, кто создал вторую.
  it('наша задача старше — её не трогаем и НЕ зовём человека удалять руками', async () => {
    const deps = makeDeps({ findTransferred: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([42, 77]) })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(deps.deleteTask).not.toHaveBeenCalled()
    const race = vi.mocked(deps.notify).mock.calls[0]?.[0] ?? ''
    expect(race).toContain('удалит тот перенос')
    // ⚠ Найдено панелью: раньше сюда уходило «удалить лишнюю НЕ удалось… удалить
    // руками» — про задачу, которую прямо сейчас корректно удаляет второй воркер.
    expect(race).not.toContain('руками')
    // Перенос при этом состоялся, и обычное сообщение тоже уходит — второе по счёту.
    expect(vi.mocked(deps.notify).mock.calls[1]?.[0]).toContain('Задача создана')
  })

  // ⚠ Столкнуться могут и три воркера. Не названная в сигнале задача останется на
  // портале сиротой, и узнать о ней будет неоткуда.
  it('лишних несколько — в сигнале названы все', async () => {
    const deps = makeDeps({ findTransferred: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([42, 77, 91]) })

    await transferTask(555, deps, settings)
    const race = vi.mocked(deps.notify).mock.calls[0]?.[0] ?? ''
    expect(race).toContain('view/77/')
    expect(race).toContain('view/91/')
  })

  it('удалить дубль не вышло по восстановимой причине — пробуем дважды, потом зовём человека', async () => {
    const deps = makeDeps({
      findTransferred: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([11, 42]),
      deleteTask: vi.fn(() => { throw new B24Error('портал занят', 'TIMEOUT', true) }),
    })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'duplicate', targetTaskId: 11 })
    // ⚠ Вторая попытка — по находке панели: не удалённая задача остаётся сиротой, и
    // следующий поиск её уже не оспорит.
    expect(deps.deleteTask).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('НЕ удалось')
  })

  // ⚠ Найдено вторым циклом панели: «портал не подтвердил удаление» может означать, что
  // задачу он всё-таки удалил. Второй заход получил бы отказ по несуществующей задаче —
  // и человека позвали бы удалять руками то, чего нет.
  it('невосстановимый отказ удаления не повторяем', async () => {
    const deps = makeDeps({
      findTransferred: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([11, 42]),
      deleteTask: vi.fn(() => { throw new B24Error('нет прав', 'ACCESS_DENIED', false) }),
    })

    await transferTask(555, deps, settings)
    expect(deps.deleteTask).toHaveBeenCalledTimes(1)
  })

  it('со второй попытки удалилось — сообщение говорит «удалена»', async () => {
    const deleteTask = vi.fn()
      .mockImplementationOnce(() => { throw new B24Error('портал занят', 'TIMEOUT', true) })
      .mockImplementationOnce(async () => {})
    const deps = makeDeps({
      findTransferred: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([11, 42]),
      deleteTask,
    })

    await transferTask(555, deps, settings)
    expect(deleteTask).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('лишняя удалена')
  })

  // ⚠ Сверка не имеет права уронить перенос — буквально, включая упавший логгер.
  // Раньше исключение из `deps.log` улетало в общий catch, и сбой САМОЙ СВЕРКИ
  // записывался как `failed-after-create` — то есть выглядел сбоем переноса, которого
  // не было. Найдено вторым циклом панели.
  it('логгер упал посреди сверки — это сбой сверки, а не переноса', async () => {
    const log = vi.fn((event: string) => {
      if (event === 'dedup-duplicate') throw new Error('логгер упал')
    })
    const deps = makeDeps({
      findTransferred: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([42, 77]),
      log,
    })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    const events = log.mock.calls.map((c) => c[0])
    expect(events).toContain('dedup-check-failed')
    expect(events).not.toContain('failed-after-create')
  })

  // ⚠ Сама сверка НЕ имеет права уронить перенос: задача уже создана, а повтор завёл
  // бы вторую.
  it('портал не ответил на сверку — перенос успешен, в логе след', async () => {
    const deps = makeDeps({
      findTransferred: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('таймаут')),
    })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(vi.mocked(deps.log).mock.calls.map((c) => c[0])).toContain('dedup-check-failed')
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('Задача создана')
  })

  // ⚠ Отказ самой дедупликации, а не переноса: обычно код UF-поля в окружении не тот,
  // что на портале, и `tasks.task.add` молча проглотил неизвестное поле. Каждое
  // следующее событие заводило бы новую задачу — и никто бы не узнал.
  it('созданная задача не находится по своим же полям — зовём человека', async () => {
    const deps = makeDeps({ findTransferred: vi.fn(async () => []) })

    expect(await transferTask(555, deps, settings)).toEqual({ status: 'created', targetTaskId: 42 })
    expect(deps.deleteTask).not.toHaveBeenCalled()
    expect(vi.mocked(deps.log).mock.calls.map((c) => c[0])).toContain('dedup-unverified')
    expect(vi.mocked(deps.notify).mock.calls[0]?.[0]).toContain('Дедупликация не работает')
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

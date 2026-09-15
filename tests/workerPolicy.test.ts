import { describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'

// ⚠ Подменяем вызовы портала целиком: проверяем ШОВ (куда и с чем уходит вызов), а не
// сам вызов — он проверен в tests/transferLookup.test.ts.
vi.mock('../src/b24/tasks.js', () => ({
  createTargetTask: vi.fn(async () => 42),
  deleteTargetTask: vi.fn(async () => {}),
  fetchSourceTask: vi.fn(),
  fetchUserName: vi.fn(),
  findTransferredTasks: vi.fn(async () => []),
}))

import { createTargetTask, deleteTargetTask, findTransferredTasks } from '../src/b24/tasks.js'
import { buildTransferDeps, buildTransferSettings, isFinalFailure, log, toQueueError } from '../src/queue/workers.js'
import { B24Error } from '../src/b24/errors.js'

const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 5 } })

describe('toQueueError', () => {
  // ⚠ Найдено ревью: флаг retryable вычислялся и не читался никем, поэтому «портал не
  // установлен» жёг все пять попыток с нарастающей паузой.
  it('невосстановимая ошибка Б24 останавливает очередь сразу', () => {
    const result = toQueueError(new B24Error('не установлен', 'NOT_INSTALLED', false))
    expect(result).toBeInstanceOf(UnrecoverableError)
    expect((result as Error).message).toContain('NOT_INSTALLED')
  })

  it('восстановимая ошибка уходит в очередь как есть — её надо повторять', () => {
    const error = new B24Error('портал занят', 'QUERY_LIMIT_EXCEEDED', true)
    expect(toQueueError(error)).toBe(error)
  })

  it('обычная ошибка не подменяется', () => {
    const error = new Error('сеть')
    expect(toQueueError(error)).toBe(error)
  })
})

describe('isFinalFailure', () => {
  it('невосстановимая ошибка финальна на первой же попытке', () => {
    expect(isFinalFailure(job(0), new B24Error('не установлен', 'NOT_INSTALLED', false))).toBe(true)
  })

  it('восстановимая — только когда попытки исчерпаны', () => {
    const error = new B24Error('портал занят', 'QUERY_LIMIT_EXCEEDED', true)
    expect(isFinalFailure(job(0), error)).toBe(false)
    expect(isFinalFailure(job(4), error)).toBe(true)
  })
})

describe('buildTransferSettings', () => {
  const config = {
    targetDomain: 'my.bitrix24.ru',
    targetResponsibleId: 9,
    titlePrefix: '#support',
    defaultDeadlineHours: 12,
    targetSourceTaskField: 'UF_SOURCE_TASK_ID',
    // ⚠ Домен обязан быть в фикстуре: без него `toEqual` игнорировал ключ со значением
    // `undefined`, и тест «переносит всё, что влияет на задачу» домен НЕ проверял —
    // шов стерёг только тип. Найдено панелью.
    targetSourceDomainField: 'UF_SOURCE_DOMAIN',
  } as never
  const portal = { domain: 'c.ru', responsibleId: 17, clientId: 'a', clientSecret: 'b', groupId: 42 }

  // ⚠ Шов между конфигурацией и работой: ревью показало мутацией, что выпавший
  // проброс не ловился ничем — настройка есть, эффекта нет.
  it('переносит в настройки всё, что влияет на создаваемую задачу', () => {
    expect(buildTransferSettings(config, portal)).toEqual({
      portal,
      targetDomain: 'my.bitrix24.ru',
      targetResponsibleId: 9,
      titlePrefix: '#support',
      defaultDeadlineHours: 12,
      sourceTaskField: 'UF_SOURCE_TASK_ID',
      sourceDomainField: 'UF_SOURCE_DOMAIN',
    })
  })
})

/**
 * Второй шов того же рода — сборка побочных эффектов. Изнутри воркера её не проверить,
 * а ошибка здесь тихая и дорогая: промах адресом означает поиск дублей и УДАЛЕНИЕ задач
 * на чужом портале, а разъехавшиеся коды полей — дубль на каждом событии. Найдено
 * панелью.
 */
describe('buildTransferDeps', () => {
  const ctx = {
    config: {
      targetWebhookUrl: 'https://our.example/rest/1/hook/',
      targetSourceTaskField: 'UF_SOURCE_TASK_ID',
      targetSourceDomainField: 'UF_SOURCE_DOMAIN',
      tokenEncKey: '0'.repeat(64),
    },
    pool: {},
    queues: { notifications: { add: vi.fn(async () => {}) } },
  } as never
  const portal = { domain: 'c.ru', responsibleId: 17, clientId: 'a', clientSecret: 'b', groupId: 42 }

  it('поиск дублей и удаление идут на НАШ портал и с теми же кодами полей', async () => {
    const deps = buildTransferDeps(ctx, portal)

    await deps.findTransferred('c.ru', 555)
    expect(findTransferredTasks).toHaveBeenCalledWith('https://our.example/rest/1/hook/', {
      sourceDomain: 'c.ru',
      sourceTaskId: 555,
      sourceTaskField: 'UF_SOURCE_TASK_ID',
      sourceDomainField: 'UF_SOURCE_DOMAIN',
    })

    await deps.deleteTask(42)
    expect(deleteTargetTask).toHaveBeenCalledWith('https://our.example/rest/1/hook/', 42)
  })

  // ⚠ Создание — тот же шов и та же цена: промах адресом означает задачу на чужом
  // портале, а у нас её нет — и дедупликация её потом не найдёт, заводя ещё и ещё.
  // Найдено вторым циклом панели.
  it('задача создаётся на НАШЕМ портале', async () => {
    const deps = buildTransferDeps(ctx, portal)
    await deps.createTask({ TITLE: 'x' } as never)
    expect(createTargetTask).toHaveBeenCalledWith('https://our.example/rest/1/hook/', { TITLE: 'x' })
  })

  // ⚠ Потеря уведомления молчалива по своей природе: задача переехала, а человек не
  // узнал. Проверяем, что текст доезжает до очереди уведомлений.
  it('уведомление кладётся в очередь уведомлений вместе с текстом', async () => {
    const deps = buildTransferDeps(ctx, portal)
    await deps.notify('привет')
    const add = (ctx as unknown as { queues: { notifications: { add: ReturnType<typeof vi.fn> } } })
      .queues.notifications.add
    expect(add).toHaveBeenCalledWith('notify', { text: 'привет' }, expect.anything())
  })
})

describe('log', () => {
  // ⚠ То, ради чего PR трогал log(): поле из данных затирало метку события, и строка
  // `event-rejected` печаталась в боевом логе как {"event":"ONTASKADD"}.
  it('поле из данных не затирает ни метку события, ни время', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('event-rejected', { b24Event: 'ONTASKADD', event: 'подмена', at: 'подмена' })
    const line = JSON.parse(spy.mock.calls[0]?.[0] as string) as Record<string, string>
    spy.mockRestore()

    expect(line.event).toBe('event-rejected')
    expect(line.b24Event).toBe('ONTASKADD')
    expect(line.at).not.toBe('подмена')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { buildTransferSettings, isFinalFailure, log, toQueueError } from '../src/queue/workers.js'
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
    })
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

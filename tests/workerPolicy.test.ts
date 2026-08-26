import { describe, expect, it } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { isFinalFailure, toQueueError } from '../src/queue/workers.js'
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

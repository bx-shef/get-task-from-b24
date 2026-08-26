import { describe, expect, it } from 'vitest'
import { isLastAttempt, jobId, TASK_JOB_OPTIONS } from '../src/queue/queues.js'

describe('isLastAttempt', () => {
  // ⚠ От этого зависит, будить ли человека: сигнал на каждом ретрае обесценивает сигнал.
  it('считает попытки от настроек задания', () => {
    expect(isLastAttempt({ attemptsMade: 0, opts: { attempts: 5 } })).toBe(false)
    expect(isLastAttempt({ attemptsMade: 3, opts: { attempts: 5 } })).toBe(false)
    expect(isLastAttempt({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(true)
  })

  it('без настройки попыток задание одноразовое', () => {
    expect(isLastAttempt({ attemptsMade: 0, opts: {} })).toBe(true)
  })
})

describe('TASK_JOB_OPTIONS', () => {
  // ⚠ Второй попытки события у нас нет — оно потрачено порталом однократно.
  it('переносы ретраятся с нарастающей задержкой', () => {
    expect(TASK_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(3)
    expect(TASK_JOB_OPTIONS.backoff.type).toBe('exponential')
  })
})

describe('jobId', () => {
  // ⚠ Замерено живым прогоном: с двоеточием BullMQ отвечает «Custom Id cannot contain :»,
  // обработчик падает в 500 — и событие теряется в том самом месте, что написано ради
  // того, чтобы не терять.
  it('не содержит двоеточия', () => {
    expect(jobId('client.bitrix24.ru', 555)).not.toContain(':')
  })

  it('различает задачи и порталы', () => {
    expect(jobId('a.bitrix24.ru', 1)).not.toBe(jobId('b.bitrix24.ru', 1))
    expect(jobId('a.bitrix24.ru', 1)).not.toBe(jobId('a.bitrix24.ru', 2))
  })

  it('одна и та же задача даёт один и тот же id', () => {
    expect(jobId('a.bitrix24.ru', 7)).toBe(jobId('a.bitrix24.ru', 7))
  })
})

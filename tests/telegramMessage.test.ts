import { describe, expect, it } from 'vitest'
import { buildCreatedMessage, buildFailureMessage } from '../src/domain/telegramMessage.js'

describe('buildCreatedMessage', () => {
  it('несёт обе ссылки и клиента', () => {
    const text = buildCreatedMessage({
      title: 'Не грузится отчёт',
      domain: 'client.bitrix24.ru',
      sourceTaskId: 555,
      targetTaskId: 42,
      targetDomain: 'my.bitrix24.ru',
    })
    expect(text).toContain('Не грузится отчёт')
    expect(text).toContain('client.bitrix24.ru')
    expect(text).toContain('https://my.bitrix24.ru/company/personal/user/0/tasks/task/view/42/')
    expect(text).toContain('https://client.bitrix24.ru/company/personal/user/0/tasks/task/view/555/')
  })
})

describe('buildFailureMessage', () => {
  // ⚠ Порталов 20–30: сообщение без портала и id говорит о беде, но не о том, где искать.
  it('называет портал и задачу клиента', () => {
    const text = buildFailureMessage({ domain: 'client.bitrix24.ru', sourceTaskId: 555, error: 'таймаут' })
    expect(text).toContain('client.bitrix24.ru')
    expect(text).toContain('/tasks/task/view/555/')
    expect(text).toContain('таймаут')
  })
})

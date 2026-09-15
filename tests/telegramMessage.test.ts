import { describe, expect, it } from 'vitest'
import {
  buildCreatedMessage,
  buildDuplicateMessage,
  buildFailureMessage,
  buildUnverifiedMessage,
} from '../src/domain/telegramMessage.js'

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

/**
 * Сообщения о сбоях дедупликации. ⚠ Оба обязаны называть портал и обе задачи: журнала
 * переносов больше нет, и кроме этого сообщения человеку негде узнать, что случилось.
 */
describe('buildDuplicateMessage', () => {
  it('удалённый дубль: видно, что осталось и что удалено', () => {
    const text = buildDuplicateMessage({
      domain: 'client.bitrix24.ru',
      sourceTaskId: 555,
      targetDomain: 'my.bitrix24.ru',
      keptTaskId: 11,
      extraTaskId: 42,
      removed: true,
    })
    expect(text).toContain('лишняя удалена')
    expect(text).toContain('client.bitrix24.ru')
    expect(text).toContain('/555/')
    expect(text).toContain('view/11/')
    expect(text).toContain('42')
  })

  it('удалить не вышло — сообщение даёт ССЫЛКУ на лишнюю, её удалять руками', () => {
    const text = buildDuplicateMessage({
      domain: 'client.bitrix24.ru',
      sourceTaskId: 555,
      targetDomain: 'my.bitrix24.ru',
      keptTaskId: 11,
      extraTaskId: 42,
      removed: false,
    })
    expect(text).toContain('НЕ удалось')
    expect(text).toContain('https://my.bitrix24.ru/company/personal/user/0/tasks/task/view/42/')
  })
})

describe('buildUnverifiedMessage', () => {
  // ⚠ Сообщение обязано назвать причину: без подсказки про коды полей человек будет
  // искать поломку в переносе, которого нет — задача-то создалась.
  it('называет обе переменные окружения, с которых начинать', () => {
    const text = buildUnverifiedMessage({
      domain: 'client.bitrix24.ru',
      sourceTaskId: 555,
      targetDomain: 'my.bitrix24.ru',
      targetTaskId: 42,
    })
    expect(text).toContain('Дедупликация не работает')
    expect(text).toContain('B24_TARGET_UF_SOURCE_TASK')
    expect(text).toContain('B24_TARGET_UF_SOURCE_DOMAIN')
    expect(text).toContain('view/42/')
  })
})

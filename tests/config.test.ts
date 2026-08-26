import { describe, expect, it } from 'vitest'
import { loadConfig, targetDomainFromWebhook, type Env } from '../src/config.js'

const base: Env = {
  PUBLIC_BASE_URL: 'https://get-task-from-b24.bx-shef.by/',
  B24_PORTAL_01: 'client.bitrix24.ru,17,local.a,secret-a',
  B24_TARGET_WEBHOOK_URL: 'https://my.bitrix24.ru/rest/1/token/',
  B24_TARGET_RESPONSIBLE_ID: '1',
  DATABASE_URL: 'postgres://app:app@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  B24_TOKEN_ENC_KEY: '0'.repeat(64),
}

describe('loadConfig', () => {
  it('собирает конфигурацию и срезает хвостовой слэш базового адреса', () => {
    const cfg = loadConfig(base)
    expect(cfg.publicBaseUrl).toBe('https://get-task-from-b24.bx-shef.by')
    expect(cfg.portals).toHaveLength(1)
    expect(cfg.titlePrefix).toBe('#support')
    expect(cfg.defaultDeadlineHours).toBe(24)
    expect(cfg.telegram).toBeNull()
  })

  // ⚠ Домен для ссылок берётся из вебхука: вторая переменная с тем же фактом разъехалась бы молча.
  it('домен нашего портала берётся из вебхука', () => {
    expect(loadConfig(base).targetDomain).toBe('my.bitrix24.ru')
    expect(targetDomainFromWebhook('https://my.bitrix24.ru/rest/1/t/')).toBe('my.bitrix24.ru')
  })

  it('без обязательной переменной — падаем на старте с именем переменной', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ ...base, B24_TARGET_WEBHOOK_URL: undefined })).toThrow(/B24_TARGET_WEBHOOK_URL/)
  })

  it('нечисловой id исполнителя не проходит', () => {
    expect(() => loadConfig({ ...base, B24_TARGET_RESPONSIBLE_ID: 'первый' })).toThrow(/положительное целое/)
    expect(() => loadConfig({ ...base, B24_TARGET_RESPONSIBLE_ID: '0' })).toThrow(/положительное целое/)
  })

  // ⚠ Молчащий Telegram выглядит как исправный сервис.
  it('половина настроек Telegram — ошибка', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 'x' })).toThrow(/только вместе/)
    expect(() => loadConfig({ ...base, TELEGRAM_CHAT_ID: '-100' })).toThrow(/только вместе/)
  })

  it('обе настройки Telegram — включён', () => {
    const cfg = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '-100' })
    expect(cfg.telegram).toEqual({ botToken: 'x', chatId: '-100' })
  })

  it('свой префикс из окружения побеждает умолчание', () => {
    expect(loadConfig({ ...base, TASK_TITLE_PREFIX: '#help' }).titlePrefix).toBe('#help')
  })
})

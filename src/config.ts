/**
 * Чтение и проверка окружения. Всё, что сервис умеет настраивать, собрано здесь;
 * секретов в коде нет (docs/CLAUDE.md → «Конвенции»).
 */
import { parsePortals, type PortalConfig } from './domain/portals.js'
import { DEFAULT_TITLE_PREFIX } from './domain/criteria.js'

export interface TelegramConfig {
  botToken: string
  chatId: string
}

export interface AppConfig {
  publicBaseUrl: string
  portals: PortalConfig[]
  targetWebhookUrl: string
  targetDomain: string
  targetResponsibleId: number
  titlePrefix: string
  defaultDeadlineHours: number
  telegram: TelegramConfig | null
  databaseUrl: string
  redisUrl: string
  tokenEncKey: string
}

export type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Не задана обязательная переменная окружения ${name}`)
  return value
}

function positiveInt(env: Env, name: string, fallback?: number): number {
  const raw = env[name]?.trim()
  if (!raw) {
    if (fallback !== undefined) return fallback
    throw new Error(`Не задана обязательная переменная окружения ${name}`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}: ожидалось положительное целое, получено «${raw}»`)
  }
  return value
}

/**
 * Домен нашего портала вытаскивается из URL вебхука.
 *
 * ⚠ Он нужен только для ссылок в Telegram. Отдельной переменной не заводим:
 * два источника одного факта разъезжаются молча, и ссылка тогда ведёт не туда,
 * оставаясь на вид правильной.
 */
export function targetDomainFromWebhook(webhookUrl: string): string {
  const url = new URL(webhookUrl)
  return url.host
}

export function loadConfig(env: Env = process.env): AppConfig {
  const targetWebhookUrl = required(env, 'B24_TARGET_WEBHOOK_URL')

  let targetDomain: string
  try {
    targetDomain = targetDomainFromWebhook(targetWebhookUrl)
  } catch {
    throw new Error('B24_TARGET_WEBHOOK_URL: не разбирается как URL')
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = env.TELEGRAM_CHAT_ID?.trim()
  // ⚠ Полконфигурации Telegram — это выключенный Telegram, и молчащий сервис выглядел бы
  // исправным. Либо обе переменные, либо ни одной.
  if (Boolean(botToken) !== Boolean(chatId)) {
    throw new Error('TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID задаются только вместе')
  }

  return {
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL').replace(/\/+$/, ''),
    portals: parsePortals(env.B24_PORTALS),
    targetWebhookUrl,
    targetDomain,
    targetResponsibleId: positiveInt(env, 'B24_TARGET_RESPONSIBLE_ID'),
    titlePrefix: env.TASK_TITLE_PREFIX?.trim() || DEFAULT_TITLE_PREFIX,
    defaultDeadlineHours: positiveInt(env, 'DEFAULT_DEADLINE_HOURS', 24),
    telegram: botToken && chatId ? { botToken, chatId } : null,
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
    tokenEncKey: required(env, 'B24_TOKEN_ENC_KEY'),
  }
}

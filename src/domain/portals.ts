/**
 * Реестр порталов клиентов: читается из переменных окружения `B24_PORTAL_*`.
 *
 * Формат одной строки: `домен,id исполнителя,client_id,client_secret`
 *
 * ⚠ Формат выбран НЕ из вкуса, а замерен на живом прогоне. JSON-массив одной
 * переменной разваливается о `source .env` — шелл съедает кавычки; разделитель `|`
 * разваливается там же — шелл видит конвейер («17: command not found»). Запятая
 * проходит и через шелл, и через `env_file` docker compose, а в доменах, числовых id
 * и ключах Битрикс24 не встречается. Плюс порталов 20–30: строка на портал правится
 * по одной, в том числе с телефона, а длинный JSON — только целиком и вслепую.
 *
 * ⚠ Здесь живёт только НЕИЗМЕНЯЕМОЕ: домен, id «особого» исполнителя и ключи
 * локального приложения. Живые OAuth-токены продлеваются в рантайме и хранятся в БД —
 * окружение не переписывается само (docs/CLIENT_APP.md).
 */

export interface PortalConfig {
  domain: string
  responsibleId: number
  clientId: string
  clientSecret: string
}

export const PORTAL_ENV_PREFIX = 'B24_PORTAL_'

/**
 * Приводит домен к сравнимому виду: без схемы, без пути, без хвостового слэша,
 * в нижнем регистре.
 *
 * ⚠ Сравнение доменов посимвольное, а приходят они из разных источников: в окружение
 * их пишет человек, в событие — портал. «https://Client.bitrix24.ru/» и
 * «client.bitrix24.ru» это один портал, и без нормализации второй не нашёлся бы
 * в реестре — то есть событие отбрасывалось бы как «портал не поддерживается».
 */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
}

/** Разбирает одну строку реестра. Имя переменной нужно только для текста ошибки. */
export function parsePortalLine(name: string, line: string): PortalConfig {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length !== 4) {
    throw new Error(`${name}: ожидалось «домен,id исполнителя,client_id,client_secret», получено ${parts.length} полей`)
  }

  const [rawDomain, rawResponsible, clientId, clientSecret] = parts as [string, string, string, string]
  const domain = normalizeDomain(rawDomain)
  const responsibleId = Number(rawResponsible)

  if (!domain) throw new Error(`${name}: не указан домен портала`)
  if (!Number.isInteger(responsibleId) || responsibleId <= 0) {
    throw new Error(`${name}: id исполнителя должен быть положительным целым, получено «${rawResponsible}»`)
  }
  if (!clientId || !clientSecret) {
    throw new Error(`${name}: не указаны client_id или client_secret локального приложения`)
  }

  return { domain, responsibleId, clientId, clientSecret }
}

/** Собирает реестр из всех переменных `B24_PORTAL_*`. Пустой реестр — отказ обслуживать всех. */
export function parsePortals(env: Record<string, string | undefined>): PortalConfig[] {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith(PORTAL_ENV_PREFIX) && value?.trim())
    // ⚠ Порядок фиксируем по имени переменной: окружение отдаёт ключи в произвольном
    // порядке, а сообщения об ошибках и логи должны быть воспроизводимыми.
    .sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    throw new Error(`Не задан ни один портал клиента: нужна хотя бы одна переменная ${PORTAL_ENV_PREFIX}*`)
  }

  const portals = entries.map(([name, value]) => parsePortalLine(name, (value as string).trim()))

  // ⚠ Дубль домена — это не «лишняя строка», а два разных набора ключей на один портал:
  // какой из них применится, зависело бы от порядка переменных, то есть от случайности.
  const seen = new Map<string, string>()
  entries.forEach(([name], index) => {
    const portal = portals[index] as PortalConfig
    const first = seen.get(portal.domain)
    if (first) throw new Error(`Домен ${portal.domain} указан дважды: ${first} и ${name}`)
    seen.set(portal.domain, name)
  })

  return portals
}

/** Портал из реестра по домену. Не нашли — обслуживать не обязаны. */
export function findPortal(portals: readonly PortalConfig[], domain: string): PortalConfig | undefined {
  const needle = normalizeDomain(domain)
  return portals.find((p) => p.domain === needle)
}

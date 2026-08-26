import { z } from 'zod'

/**
 * Реестр порталов клиентов: читается из переменной окружения B24_PORTALS.
 *
 * ⚠ Здесь живёт только НЕИЗМЕНЯЕМОЕ: домен, id «особого» исполнителя и ключи
 * локального приложения. Живые OAuth-токены продлеваются в рантайме и хранятся в БД —
 * окружение не переписывается само (docs/CLIENT_APP.md).
 */
const PortalSchema = z.object({
  domain: z.string().min(1),
  responsibleId: z.coerce.number().int().positive(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})

export type PortalConfig = z.infer<typeof PortalSchema> & { domain: string }

/**
 * Приводит домен к сравнимому виду: без схемы, без пути, без хвостового слэша,
 * в нижнем регистре.
 *
 * ⚠ Сравнение доменов посимвольное, а приходят они из разных источников: из env их
 * пишет человек, из события — портал. «https://Client.bitrix24.ru/» и
 * «client.bitrix24.ru» это один портал, и без нормализации второй просто не нашёлся бы
 * в списке — то есть событие было бы отброшено как «портал не поддерживается».
 */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
}

/** Разбирает B24_PORTALS. Бросает с внятным текстом: пустой реестр — это отказ обслуживать всех. */
export function parsePortals(raw: string | undefined): PortalConfig[] {
  if (!raw || raw.trim() === '') {
    throw new Error('B24_PORTALS пуст: не задан ни один портал клиента')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('B24_PORTALS: не разбирается как JSON-массив')
  }

  const list = z.array(PortalSchema).min(1).safeParse(parsed)
  if (!list.success) {
    throw new Error(`B24_PORTALS: ${list.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }

  const portals = list.data.map((p) => ({ ...p, domain: normalizeDomain(p.domain) }))

  // ⚠ Дубль домена — это не «лишняя строка», а два разных набора ключей на один портал:
  // какой из них применится, зависело бы от порядка в JSON, то есть от случайности.
  const seen = new Set<string>()
  for (const p of portals) {
    if (seen.has(p.domain)) throw new Error(`B24_PORTALS: домен ${p.domain} указан дважды`)
    seen.add(p.domain)
  }

  return portals
}

/** Портал из реестра по домену. Не нашли — обслуживать не обязаны. */
export function findPortal(portals: readonly PortalConfig[], domain: string): PortalConfig | undefined {
  const needle = normalizeDomain(domain)
  return portals.find((p) => p.domain === needle)
}

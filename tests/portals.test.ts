import { describe, expect, it } from 'vitest'
import { findPortal, normalizeDomain, parsePortalLine, parsePortals } from '../src/domain/portals.js'

const env = { B24_PORTAL_01: 'client.bitrix24.ru,17,local.a,secret-a' }

describe('normalizeDomain', () => {
  it('срезает схему, путь и регистр', () => {
    expect(normalizeDomain('https://Client.Bitrix24.ru/rest/')).toBe('client.bitrix24.ru')
    expect(normalizeDomain('  client.bitrix24.ru  ')).toBe('client.bitrix24.ru')
  })
})

describe('parsePortalLine', () => {
  it('разбирает строку и нормализует домен', () => {
    expect(parsePortalLine('B24_PORTAL_01', ' https://Client.bitrix24.ru/ , 17 , local.a , secret-a '))
      .toEqual({ domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'local.a', clientSecret: 'secret-a', groupId: 0 })
  })

  // ⚠ Пятое поле необязательно: строки, заведённые до появления групп, обязаны
  // продолжать работать — иначе обновление роняет сервис у всех клиентов сразу.
  it('без пятого поля группа равна нулю', () => {
    expect(parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s').groupId).toBe(0)
    expect(parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s,').groupId).toBe(0)
  })

  it('пятым полем задаётся группа у нас', () => {
    expect(parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s,42').groupId).toBe(42)
  })

  it('мусор вместо группы не проходит', () => {
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s,группа')).toThrow(/id группы/)
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s,-1')).toThrow(/id группы/)
  })

  it('лишние поля — ошибка с внятным текстом', () => {
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,1,c,s,1,лишнее')).toThrow(/id группы\]/)
  })

  it('не хватает поля — ошибка называет переменную и ожидаемый вид', () => {
    expect(() => parsePortalLine('B24_PORTAL_01', 'client.bitrix24.ru,17'))
      .toThrow(/B24_PORTAL_01.*домен,id исполнителя/)
  })

  it('id исполнителя обязан быть положительным целым', () => {
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,ноль,c,s')).toThrow(/положительным целым/)
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,0,c,s')).toThrow(/положительным целым/)
  })

  it('без ключей приложения портал не подключить', () => {
    expect(() => parsePortalLine('B24_PORTAL_01', 'a.ru,1,,s')).toThrow(/client_id/)
  })
})

describe('parsePortals', () => {
  it('собирает реестр из всех переменных B24_PORTAL_*', () => {
    const portals = parsePortals({
      B24_PORTAL_02: 'two.bitrix24.ru,2,local.b,sb',
      B24_PORTAL_01: 'one.bitrix24.ru,1,local.a,sa',
      DATABASE_URL: 'postgres://…',
    })
    expect(portals.map((p) => p.domain)).toEqual(['one.bitrix24.ru', 'two.bitrix24.ru'])
  })

  it('пустой реестр — ошибка, а не пустой список', () => {
    expect(() => parsePortals({})).toThrow(/Не задан ни один портал/)
    expect(() => parsePortals({ B24_PORTAL_01: '   ' })).toThrow(/Не задан ни один портал/)
  })

  // ⚠ Дубль домена — два набора ключей на один портал: победитель зависел бы от порядка.
  it('дубль домена — ошибка, в том числе после нормализации', () => {
    expect(() => parsePortals({
      B24_PORTAL_01: 'a.ru,1,c1,s1',
      B24_PORTAL_02: 'https://A.ru/,2,c2,s2',
    })).toThrow(/дважды: B24_PORTAL_01 и B24_PORTAL_02/)
  })
})

describe('findPortal', () => {
  const portals = parsePortals(env)

  it('находит по домену из события в любом написании', () => {
    expect(findPortal(portals, 'CLIENT.bitrix24.ru')?.responsibleId).toBe(17)
    expect(findPortal(portals, 'https://client.bitrix24.ru/')?.responsibleId).toBe(17)
  })

  it('чужой портал не находится', () => {
    expect(findPortal(portals, 'other.bitrix24.ru')).toBeUndefined()
  })
})

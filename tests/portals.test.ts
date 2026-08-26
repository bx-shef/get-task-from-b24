import { describe, expect, it } from 'vitest'
import { findPortal, normalizeDomain, parsePortals } from '../src/domain/portals.js'

const one = JSON.stringify([
  { domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'local.a', clientSecret: 's' },
])

describe('normalizeDomain', () => {
  it('срезает схему, путь и регистр', () => {
    expect(normalizeDomain('https://Client.Bitrix24.ru/rest/')).toBe('client.bitrix24.ru')
    expect(normalizeDomain('  client.bitrix24.ru  ')).toBe('client.bitrix24.ru')
  })
})

describe('parsePortals', () => {
  it('разбирает список и нормализует домены', () => {
    const portals = parsePortals(JSON.stringify([
      { domain: 'https://Client.bitrix24.ru/', responsibleId: '17', clientId: 'a', clientSecret: 'b' },
    ]))
    expect(portals).toEqual([{ domain: 'client.bitrix24.ru', responsibleId: 17, clientId: 'a', clientSecret: 'b' }])
  })

  it('пустой реестр — ошибка, а не пустой список', () => {
    expect(() => parsePortals(undefined)).toThrow(/B24_PORTALS пуст/)
    expect(() => parsePortals('   ')).toThrow(/B24_PORTALS пуст/)
  })

  it('не-JSON — внятная ошибка', () => {
    expect(() => parsePortals('client.bitrix24.ru,17')).toThrow(/не разбирается как JSON/)
  })

  it('портал без ключей приложения не проходит', () => {
    expect(() => parsePortals(JSON.stringify([{ domain: 'a.ru', responsibleId: 1 }]))).toThrow(/clientId/)
  })

  it('responsibleId обязан быть положительным целым', () => {
    expect(() => parsePortals(JSON.stringify([
      { domain: 'a.ru', responsibleId: 0, clientId: 'a', clientSecret: 'b' },
    ]))).toThrow()
  })

  // ⚠ Дубль домена — два набора ключей на один портал: победитель зависел бы от порядка.
  it('дубль домена — ошибка, в том числе после нормализации', () => {
    expect(() => parsePortals(JSON.stringify([
      { domain: 'a.ru', responsibleId: 1, clientId: 'a', clientSecret: 'b' },
      { domain: 'https://A.ru/', responsibleId: 2, clientId: 'c', clientSecret: 'd' },
    ]))).toThrow(/дважды/)
  })
})

describe('findPortal', () => {
  const portals = parsePortals(one)

  it('находит по домену из события в любом написании', () => {
    expect(findPortal(portals, 'CLIENT.bitrix24.ru')?.responsibleId).toBe(17)
    expect(findPortal(portals, 'https://client.bitrix24.ru/')?.responsibleId).toBe(17)
  })

  it('чужой портал не находится', () => {
    expect(findPortal(portals, 'other.bitrix24.ru')).toBeUndefined()
  })
})

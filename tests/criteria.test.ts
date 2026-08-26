import { describe, expect, it } from 'vitest'
import { decide, matchesTitlePrefix, stripTitlePrefix } from '../src/domain/criteria.js'
import type { PortalConfig } from '../src/domain/portals.js'

const portal: PortalConfig = {
  domain: 'client.bitrix24.ru',
  responsibleId: 17,
  clientId: 'a',
  clientSecret: 'b',
  groupId: 0,
}

describe('matchesTitlePrefix', () => {
  it('регистр и ведущие пробелы не мешают', () => {
    expect(matchesTitlePrefix('#support Не грузится отчёт')).toBe(true)
    expect(matchesTitlePrefix('#Support Не грузится отчёт')).toBe(true)
    expect(matchesTitlePrefix('   #SUPPORT авария')).toBe(true)
  })

  it('префикс внутри названия не считается', () => {
    expect(matchesTitlePrefix('Срочно #support авария')).toBe(false)
    expect(matchesTitlePrefix('supportная задача')).toBe(false)
  })

  // ⚠ Найдено ревью: голый startsWith тащил «#supportive маркетинг» в перенос и обрезал
  // название до «ive маркетинг».
  it('слово, начинающееся с префикса, — не префикс', () => {
    expect(matchesTitlePrefix('#supportive маркетинг')).toBe(false)
    expect(matchesTitlePrefix('#support2 авария')).toBe(false)
  })

  it('префикс без хвоста — всё ещё префикс', () => {
    expect(matchesTitlePrefix('#support')).toBe(true)
    expect(matchesTitlePrefix('#support: авария')).toBe(true)
  })
})

describe('stripTitlePrefix', () => {
  it('срезает префикс и разделитель', () => {
    expect(stripTitlePrefix('#support Не грузится отчёт')).toBe('Не грузится отчёт')
    expect(stripTitlePrefix('#Support: не грузится отчёт')).toBe('не грузится отчёт')
    expect(stripTitlePrefix('  #support — авария')).toBe('авария')
  })

  // ⚠ tasks.task.add требует название: пустая строка уронила бы создание задачи.
  it('название ровно из префикса не превращается в пустую строку', () => {
    expect(stripTitlePrefix('#support')).toBe('#support')
    expect(stripTitlePrefix('#support   ')).toBe('#support')
  })

  it('чужое название возвращается как есть', () => {
    expect(stripTitlePrefix('Обычная задача')).toBe('Обычная задача')
  })
})

describe('decide', () => {
  it('переносим только при совпадении обоих критериев', () => {
    expect(decide({ id: 1, title: '#support авария', responsibleId: 17 }, portal)).toEqual({ transfer: true })
  })

  it('не тот префикс — отказ', () => {
    expect(decide({ id: 1, title: 'авария', responsibleId: 17 }, portal))
      .toEqual({ transfer: false, reason: 'title-prefix' })
  })

  it('не тот исполнитель — отказ', () => {
    expect(decide({ id: 1, title: '#support авария', responsibleId: 42 }, portal))
      .toEqual({ transfer: false, reason: 'responsible' })
  })
})

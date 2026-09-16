/**
 * Миграции — единственное место, где код меняет боевую базу без человека: они гоняются
 * на КАЖДОМ старте, а старт делает Watchtower.
 *
 * ⚠ Правило «шаги только дописываются в конец, применённые не меняются» до сих пор
 * держалось на комментарии в `src/store/db.ts`. Цена нарушения выросла: шаг
 * `003-drop-transfers` удаляет таблицу, и правка уже применённого шага вскрылась бы на
 * проде, а не в CI. Найдено вторым циклом панели.
 */
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../src/store/db.js'

/** Снимок применённых шагов. Дописывать в КОНЕЦ; менять строки нельзя. */
const APPLIED = ['001-init', '002-transfers-status-index', '003-drop-transfers']

describe('миграции', () => {
  it('уже применённые шаги остались на своих местах и в том же порядке', () => {
    expect(MIGRATIONS.slice(0, APPLIED.length).map((m) => m.id)).toEqual(APPLIED)
  })

  it('идентификаторы уникальны', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('нумерация возрастает — иначе порядок применения читается неверно', () => {
    const numbers = MIGRATIONS.map((m) => Number(m.id.slice(0, 3)))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(numbers.every(Number.isInteger)).toBe(true)
  })

  // ⚠ Шаг, удаляющий данные, обязан быть виден глазами в этом списке: следующий такой
  // не должен проехать в общей куче правок.
  it('удаляющие шаги перечислены явно', () => {
    const destructive = MIGRATIONS.filter((m) => /\bdrop\b/i.test(m.sql)).map((m) => m.id)
    expect(destructive).toEqual(['003-drop-transfers'])
  })
})

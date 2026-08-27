import { describe, expect, it } from 'vitest'
import { formatUserName, parseSourceTask, unwrapTask } from '../src/b24/tasks.js'

describe('parseSourceTask', () => {
  // ⚠ Портал отдаёт id строками: нетипизированное сравнение дало бы вечный отказ переносить.
  it('строковые id превращаются в числа', () => {
    const task = parseSourceTask({
      id: '555',
      title: '#support авария',
      responsibleId: '17',
      createdBy: '3',
      description: 'текст',
      deadline: '2026-08-27T15:00:00+03:00',
    })
    expect(task.id).toBe(555)
    expect(task.responsibleId).toBe(17)
    expect(task.createdBy).toBe(3)
  })

  it('понимает ВЕРХНИЙ_РЕГИСТР полей', () => {
    const task = parseSourceTask({ ID: 1, TITLE: 'т', RESPONSIBLE_ID: 2, CREATED_BY: 3, DESCRIPTION: 'd' })
    expect(task).toMatchObject({ id: 1, title: 'т', responsibleId: 2, createdBy: 3, description: 'd' })
  })

  it('пустой срок — это отсутствие срока, а не пустая строка', () => {
    expect(parseSourceTask({ id: 1, title: 'т', responsibleId: 2, deadline: '' }).deadline).toBeUndefined()
  })

  it('без исполнителя или названия — внятная ошибка, а не undefined дальше по коду', () => {
    expect(() => parseSourceTask({ id: 1, title: 'т' })).toThrow(/нет id, названия или исполнителя/)
    expect(() => parseSourceTask(null)).toThrow(/неожиданном виде/)
  })
})

describe('unwrapTask', () => {
  it('снимает обёртку task', () => {
    expect(unwrapTask({ task: { id: 5 } })).toEqual({ id: 5 })
    expect(unwrapTask({ id: 5 })).toEqual({ id: 5 })
  })

  // ⚠ REST v3 объявляет в ответе и task, и item. Без второго смена формы ответа
  // означала бы не ретраи, а окончательную потерю каждой задачи (BAD_TASK неповторяем).
  it('понимает обёртку item', () => {
    expect(unwrapTask({ item: { id: 5 } })).toEqual({ id: 5 })
  })

  it('пустой ответ — повторяемая ошибка', () => {
    expect(() => unwrapTask(undefined)).toThrow(/без задачи/)
  })
})

describe('formatUserName', () => {
  it('склеивает имя и фамилию', () => {
    expect(formatUserName({ NAME: 'Иван', LAST_NAME: 'Петров' })).toBe('Иван Петров')
    expect(formatUserName({ NAME: 'Иван' })).toBe('Иван')
  })

  it('пустой пользователь — undefined, а не строка из пробелов', () => {
    expect(formatUserName({ NAME: '', LAST_NAME: '' })).toBeUndefined()
    expect(formatUserName(undefined)).toBeUndefined()
  })
})

describe('удалённая задача', () => {
  // ⚠ Замерено на боевом портале: tasks.task.get для удалённой задачи отдаёт ПУСТОЙ
  // СПИСОК, а не ошибку. Без этой ветки человек читал бы в Telegram про формат ответа
  // вместо «задачу удалили», а очередь жгла бы попытки на невосстановимом.
  it('пустой список — внятная невосстановимая ошибка', () => {
    expect(() => unwrapTask([])).toThrow(/не найдена или недоступна/)
    try {
      unwrapTask([])
    } catch (error) {
      expect(error).toMatchObject({ code: 'TASK_NOT_FOUND', retryable: false })
    }
  })

  it('непустой список задачей не считается, но и не путается с удалением', () => {
    expect(() => unwrapTask([{ id: 1 }])).not.toThrow(/не найдена/)
  })
})

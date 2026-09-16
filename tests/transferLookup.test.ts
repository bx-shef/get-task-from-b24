/**
 * Поиск перенесённой задачи по паре UF-полей — то, чем заменён журнал переносов.
 *
 * ⚠ Главное здесь: ответу портала мы не верим на слово. Замерено (docs/PRODUCT.md,
 * раздел 1): непонятый фильтр Битрикс24 не отвергает — он возвращает ВСЁ. Прими мы
 * это за «уже перенесена», и задача клиента не создалась бы никогда и молча.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callWebhook = vi.fn()
vi.mock('../src/b24/rest.js', () => ({
  callWebhook: (...args: unknown[]) => callWebhook(...args),
  callPortal: vi.fn(),
}))

const { matchTransferred, findTransferredTasks, deleteTargetTask } = await import('../src/b24/tasks.js')

const key = {
  sourceDomain: 'client.example.ru',
  sourceTaskId: 555,
  sourceTaskField: 'UF_SOURCE_TASK_ID',
  sourceDomainField: 'UF_SOURCE_DOMAIN',
}

const hook = 'https://our.example/rest/1/hook/'

// ⚠ Фигурные скобки здесь обязательны. Без них стрелка ВОЗВРАЩАЕТ сам мок (это
// возвращает `mockReset`), Vitest принимает возвращённое значение за результат хука —
// и брошенная в тесте ошибка перестаёт ловиться `rejects`: тест падает с той самой
// ошибкой, которую проверяет. Замерено, час поисков.
beforeEach(() => { callWebhook.mockReset() })

describe('matchTransferred', () => {
  it('находит задачу, у которой совпала вся пара', () => {
    const rows = [{ ID: '1001', UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'client.example.ru' }]
    expect(matchTransferred({ tasks: rows }, key)).toEqual([1001])
  })

  // ⚠ Портал отдаёт значения строками даже для числового поля — замерено.
  it('значение полем-числом и полем-строкой читается одинаково', () => {
    const rows = [{ id: 1001, ufSourceTaskId: 555, ufSourceDomain: 'client.example.ru' }]
    expect(matchTransferred({ items: rows }, key)).toEqual([1001])
  })

  // ⚠ Это и есть защита от «фильтр не понят — верните всё».
  it('чужие задачи из ответа отбрасываются, а не считаются совпадением', () => {
    const rows = [
      { ID: '1', UF_SOURCE_TASK_ID: '777', UF_SOURCE_DOMAIN: 'client.example.ru' },
      { ID: '2', UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'other.example.ru' },
      { ID: '3' },
      { ID: '0', UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'client.example.ru' },
      { ID: '4', UF_SOURCE_TASK_ID: '', UF_SOURCE_DOMAIN: 'client.example.ru' },
      { ID: '5', UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'client.example.ru' },
    ]
    expect(matchTransferred(rows, key)).toEqual([5])
  })

  // ⚠ Множественное пользовательское поле портал отдаёт МАССИВОМ. Прочитанное как
  // строка, оно даёт пусто — и дедупликация молча отвечает «не переносили» на каждом
  // событии, при внешне исправном ответе. Код от этого защищён, но без этого теста
  // защита снималась бы мимо CI. Найдено вторым циклом панели.
  it('значения массивом читаются наравне со строкой', () => {
    const rows = [{ ID: '1001', UF_SOURCE_TASK_ID: ['555'], UF_SOURCE_DOMAIN: ['client.example.ru'] }]
    expect(matchTransferred(rows, key)).toEqual([1001])
  })

  it('в массиве ищется любое совпадение, пустые значения не мешают', () => {
    const rows = [{ ID: '1002', UF_SOURCE_TASK_ID: ['', 555], UF_SOURCE_DOMAIN: ['other.example.ru', 'client.example.ru'] }]
    expect(matchTransferred(rows, key)).toEqual([1002])
  })

  it('домен сверяется без учёта регистра', () => {
    const rows = [{ ID: '9', UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'Client.Example.RU ' }]
    expect(matchTransferred(rows, key)).toEqual([9])
  })

  // ⚠ Порядок — часть правила «остаётся задача с меньшим ID»: она создана раньше.
  it('результат отсортирован по возрастанию ID', () => {
    const rows = [77, 11, 42].map((id) => ({
      ID: String(id), UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'client.example.ru',
    }))
    expect(matchTransferred(rows, key)).toEqual([11, 42, 77])
  })

  it('непонятый ответ — это «не нашли», а не падение', () => {
    expect(matchTransferred(null, key)).toEqual([])
    expect(matchTransferred({ result: 'ok' }, key)).toEqual([])
    expect(matchTransferred({ tasks: 'нет' }, key)).toEqual([])
  })
})

describe('findTransferredTasks', () => {
  // ⚠ Фильтр — ровно в границах замеренного: объектом и по ОДНОМУ ключу. Конъюнкцию
  // двух UF-полей на живом портале никто не проверял, а от этого вызова зависит вся
  // дедупликация: непонятое условие даёт либо 400 на каждом переносе, либо пусто — то
  // есть дубли. Домен сверяет наш код, портал об этом не просят. Найдено панелью.
  it('шлёт фильтр объектом и по одному ключу, а в select — ID и оба поля', async () => {
    callWebhook.mockImplementation(async () => ({ tasks: [] }))
    await findTransferredTasks(hook, key)

    const [url, method, params] = callWebhook.mock.calls[0] as [string, string, {
      filter: Record<string, unknown>
      select: string[]
      order: Record<string, unknown>
    }]
    expect(url).toBe(hook)
    expect(method).toBe('tasks.task.list')
    expect(params.filter).toEqual({ UF_SOURCE_TASK_ID: 555 })
    // ⚠ Точный список, а не «содержит»: без `ID` каждая строка ответа отбраковалась бы
    // и дедупликация замолчала бы навсегда. Мутация «убрать ID» раньше проходила мимо
    // тестов — находка панели.
    expect(params.select).toEqual(['ID', 'UF_SOURCE_TASK_ID', 'UF_SOURCE_DOMAIN'])
    // ⚠ Порядок убывающий: если портал фильтр не понял и отдал всё подряд, свежая
    // задача обязана попасть в первую страницу ответа.
    expect(params.order).toEqual({ ID: 'desc' })
  })

  // ⚠ Целая страница в ответе — это «фильтр не применён», а не «нашлось много».
  // Отвечать по такому ответу нельзя ничем, кроме ошибки: разные воркеры увидели бы
  // разные страницы, каждый счёл бы себя старшим — и дубль не удалил бы никто.
  it('целая страница в ответе — это ошибка, а не результат', async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      ID: String(i + 1), UF_SOURCE_TASK_ID: '555', UF_SOURCE_DOMAIN: 'client.example.ru',
    }))
    callWebhook.mockImplementation(async () => ({ tasks: page }))
    await expect(findTransferredTasks(hook, key)).rejects.toThrow(/фильтр поиска не применён/)
  })

  // ⚠ Ошибку наверх, а не пустой список: «портал не ответил» — это «не знаю»,
  // и принять его за «не переносили» значит завести вторую задачу.
  it('ошибка портала пробрасывается наверх', async () => {
    callWebhook.mockImplementation(() => { throw new Error('портал занят') })
    await expect(findTransferredTasks(hook, key)).rejects.toThrow('портал занят')
  })
})

describe('deleteTargetTask', () => {
  // ⚠ Страница метода называет обязательными оба имени параметра.
  it('шлёт и taskId, и id', async () => {
    callWebhook.mockImplementation(async () => ({ task: true }))
    await deleteTargetTask(hook, 42)
    expect(callWebhook).toHaveBeenCalledWith(hook, 'tasks.task.delete', { taskId: 42, id: 42 })
  })

  it('понимает и голое true, и обёртку result', async () => {
    callWebhook.mockImplementation(async () => true)
    await expect(deleteTargetTask(hook, 42)).resolves.toBeUndefined()
    callWebhook.mockImplementation(async () => ({ result: true }))
    await expect(deleteTargetTask(hook, 43)).resolves.toBeUndefined()
  })

  // ⚠ Отказ без исключения («нет права на удаление» в теле ответа) иначе превратился бы
  // в сообщение «лишняя задача удалена» про задачу, которая осталась. Найдено панелью.
  it('не подтверждённое удаление — это ошибка, а не успех', async () => {
    callWebhook.mockImplementation(async () => ({ task: false }))
    await expect(deleteTargetTask(hook, 42)).rejects.toThrow(/не подтвердил удаление/)
  })
})

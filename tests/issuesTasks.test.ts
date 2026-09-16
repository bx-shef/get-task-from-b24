/**
 * Отбор задач на выгрузку.
 *
 * ⚠ Главное здесь — «поле пустое» решает НАШ код, а не фильтр портала. Как Битрикс24
 * понимает пустоту UF-поля, мы не замеряли, а непонятый фильтр он не отвергает — он
 * возвращает всё подряд. Цена ошибки: issue по каждой задаче портала разом, в чужом
 * приватном репозитории.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callWebhook = vi.fn()
vi.mock('../src/b24/rest.js', () => ({
  callWebhook: (...args: unknown[]) => callWebhook(...args),
  callWebhookV3: vi.fn(),
}))

const { listTasksToExport, markTaskExported } = await import('../src/b24/issues.js')

const options = {
  groupId: 12,
  responsibleId: 29,
  sourceDomain: 'portal.example.by',
  sourceDomainField: 'UF_SOURCE_DOMAIN',
  sourceTaskField: 'UF_SOURCE_TASK_ID',
  issueField: 'UF_ISSUE',
  limit: 50,
}

beforeEach(() => callWebhook.mockReset())

describe('отбор задач на выгрузку', () => {
  it('фильтр портала содержит только то, в чём мы уверены — без «поле пустое»', async () => {
    callWebhook.mockResolvedValue({ tasks: [] })
    await listTasksToExport('https://our.example/rest/1/hook/', options)

    const params = callWebhook.mock.calls[0]?.[2] as { filter: Record<string, unknown>; select: string[] }
    expect(params.filter).toMatchObject({ RESPONSIBLE_ID: 29, UF_SOURCE_DOMAIN: 'portal.example.by', GROUP_ID: 12 })
    expect(JSON.stringify(params.filter)).not.toContain('UF_ISSUE')
    // Поле обязано быть в select — иначе «пусто» окажется ложным у всех задач подряд.
    expect(params.select).toContain('UF_ISSUE')
  })

  it('задачи с заполненным полем отбрасываются нашим кодом', async () => {
    callWebhook.mockResolvedValue({
      tasks: [
        { id: '1', title: 'уже выгружена', UF_ISSUE: 'bx-shef/client#3' },
        { id: '2', title: 'ещё нет', UF_ISSUE: '' },
        { id: '3', title: 'пробел не считается значением', UF_ISSUE: '   ' },
      ],
    })

    const tasks = await listTasksToExport('https://our.example/rest/1/hook/', options)
    expect(tasks.map((t) => t.id)).toEqual([2, 3])
  })

  it('поле в camelCase тоже считается заполненным — иначе задача выгрузится дважды', async () => {
    // Портал отдаёт часть ответов в camelCase; пропустить это — значит создать дубль.
    callWebhook.mockResolvedValue({ tasks: [{ id: '4', title: 'x', ufIssue: 'bx-shef/client#9' }] })
    await expect(listTasksToExport('https://our.example/rest/1/hook/', options)).resolves.toEqual([])
  })

  it('потолок соблюдается', async () => {
    callWebhook.mockResolvedValue({
      tasks: [1, 2, 3, 4, 5].map((id) => ({ id: String(id), title: 'x', UF_ISSUE: '' })),
    })
    const tasks = await listTasksToExport('https://our.example/rest/1/hook/', { ...options, limit: 2 })
    expect(tasks).toHaveLength(2)
  })

  it('группа 0 не попадает в фильтр: иначе портал вернёт задачи без группы', async () => {
    callWebhook.mockResolvedValue({ tasks: [] })
    await listTasksToExport('https://our.example/rest/1/hook/', { ...options, groupId: 0 })
    const params = callWebhook.mock.calls[0]?.[2] as { filter: Record<string, unknown> }
    expect(params.filter).not.toHaveProperty('GROUP_ID')
  })
})

/**
 * Отметка «выгружено» — самое дорогое место цели: не легла, и следующий прогон заведёт
 * ВТОРОЙ issue в приватном репозитории клиента, а это не отзывается.
 *
 * ⚠ Написано по боевому прогону 2026-09-16: портал принял `tasks.task.update` без
 * единой жалобы, а поле осталось пустым — неизвестный ключ в `fields` он молча
 * проглатывает. Отсутствие ошибки успехом не считается.
 */
describe('отметка о выгрузке сверяется чтением', () => {
  const hook = 'https://our.example/rest/1/hook/'

  it('значение легло — молча и без лишних вызовов', async () => {
    callWebhook.mockImplementation(async (_url: string, method: string) => (
      method === 'tasks.task.get' ? { task: { id: '1747', UF_ISSUE: 'owner/repo#12' } } : true
    ))

    await expect(markTaskExported(hook, 1747, 'UF_ISSUE', 'owner/repo#12')).resolves.toBeUndefined()

    const methods = callWebhook.mock.calls.map((c) => c[1])
    expect(methods).toEqual(['tasks.task.update', 'tasks.task.get'])
  })

  it('поле в select запрашивается явно — иначе сверять нечего', async () => {
    callWebhook.mockImplementation(async (_url: string, method: string) => (
      method === 'tasks.task.get' ? { task: { id: '1747', UF_ISSUE: 'owner/repo#12' } } : true
    ))

    await markTaskExported(hook, 1747, 'UF_ISSUE', 'owner/repo#12')

    const params = callWebhook.mock.calls[1]?.[2] as { select: string[] }
    expect(params.select).toContain('UF_ISSUE')
  })

  it('портал принял запись, а поле пустое — это ОШИБКА, а не успех', async () => {
    callWebhook.mockImplementation(async (_url: string, method: string) => (
      method === 'tasks.task.get' ? { task: { id: '1747' } } : true
    ))

    await expect(markTaskExported(hook, 1747, 'UF_ISSUE', 'owner/repo#12'))
      .rejects.toThrow(/осталось пустым/)
  })

  it('в поле оказалось чужое значение — тоже ошибка, и она его называет', async () => {
    callWebhook.mockImplementation(async (_url: string, method: string) => (
      method === 'tasks.task.get' ? { task: { id: '1747', UF_ISSUE: 'other/repo#3' } } : true
    ))

    await expect(markTaskExported(hook, 1747, 'UF_ISSUE', 'owner/repo#12'))
      .rejects.toThrow(/other\/repo#3/)
  })

  // ⚠ Регистр ключа в ответе зависит от версии — иначе «не легло» окажется ложным, и
  // цель начнёт ругаться на исправную запись.
  it('camelCase в ответе портала читается наравне с ВЕРХНИМ регистром', async () => {
    callWebhook.mockImplementation(async (_url: string, method: string) => (
      method === 'tasks.task.get' ? { task: { id: '1747', ufIssue: 'owner/repo#12' } } : true
    ))

    await expect(markTaskExported(hook, 1747, 'UF_ISSUE', 'owner/repo#12')).resolves.toBeUndefined()
  })
})

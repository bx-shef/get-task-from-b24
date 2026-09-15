/**
 * Конвейер выгрузки: проверяем порядок шагов и поведение при сбоях. Оба важнее «успешного
 * пути»: issue в приватном репозитории клиента нельзя ни отозвать, ни создать дважды
 * незаметно.
 */
import { describe, expect, it, vi } from 'vitest'

import { ExportRefused, exportIssues, type ExportDeps } from '../src/pipeline/exportIssues.js'
import type { AppConfig } from '../src/config.js'
import type { PortalConfig } from '../src/domain/portals.js'

const portal: PortalConfig = {
  domain: 'portal.example.by',
  responsibleId: 1,
  clientId: 'local.x',
  clientSecret: 'secret',
  groupId: 12,
}

const config = {
  targetWebhookUrl: 'https://our.example/rest/1/hook/',
  targetDomain: 'our.example',
  targetSourceTaskField: 'UF_SOURCE_TASK_ID',
  targetSourceDomainField: 'UF_SOURCE_DOMAIN',
  issues: { githubToken: 'ghp_x', responsibleId: 29, issueField: 'UF_ISSUE' },
} as unknown as AppConfig

function deps(overrides: Partial<ExportDeps> = {}, tasks = [{ id: 1517, title: 'Счёт', description: 'текст', sourceDomain: portal.domain, issueRef: '' }]): ExportDeps & { calls: string[] } {
  const calls: string[] = []
  const base: ExportDeps = {
    fetchGroupDescription: async () => 'Репозиторий: https://github.com/bx-shef/client',
    listTasksToExport: async () => tasks,
    createIssue: async () => {
      calls.push('createIssue')
      return { number: 17, url: 'https://github.com/bx-shef/client/issues/17' }
    },
    markTaskExported: async () => {
      calls.push('markTaskExported')
    },
    commentTask: async () => {
      calls.push('commentTask')
    },
  }
  return { ...base, ...overrides, calls }
}

describe('выгрузка задач в issue', () => {
  it('создаёт issue, ставит отметку owner/repo#N и комментирует', async () => {
    const d = deps()
    const report = await exportIssues(config, portal, { limit: 10 }, d)

    expect(report.exported).toBe(1)
    expect(report.lines[0]?.text).toContain('bx-shef/client#17')
    expect(d.calls).toEqual(['createIssue', 'markTaskExported', 'commentTask'])
  })

  it('отметка ставится РАНЬШЕ комментария: иначе сбой между ними даёт второй issue', async () => {
    const d = deps()
    await exportIssues(config, portal, { limit: 10 }, d)
    expect(d.calls.indexOf('markTaskExported')).toBeLessThan(d.calls.indexOf('commentTask'))
  })

  it('issue создан, а отметка не записалась — кричим и даём готовую строку для рук', async () => {
    const d = deps({
      markTaskExported: async () => {
        throw new Error('портал недоступен')
      },
    })
    const report = await exportIssues(config, portal, { limit: 10 }, d)

    expect(report.failed).toBe(1)
    expect(report.lines[0]?.text).toContain('bx-shef/client#17')
    expect(report.lines[0]?.text).toContain('руками')
  })

  it('упавший комментарий не делает задачу невыгруженной', async () => {
    const d = deps({
      commentTask: async () => {
        throw new Error('чат недоступен')
      },
    })
    const report = await exportIssues(config, portal, { limit: 10 }, d)

    expect(report.exported).toBe(1)
    expect(report.lines[0]?.text).toContain('комментарий не добавлен')
  })

  it('нет ссылки в описании группы — отказ целиком, ни одна задача не тронута', async () => {
    const createIssue = vi.fn()
    const d = deps({ fetchGroupDescription: async () => 'Просто текст', createIssue })

    await expect(exportIssues(config, portal, { limit: 10 }, d)).rejects.toBeInstanceOf(ExportRefused)
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('две разные ссылки — тоже отказ: issue мог бы уехать не тому клиенту', async () => {
    const createIssue = vi.fn()
    const d = deps({
      fetchGroupDescription: async () => 'https://github.com/a/one и https://github.com/b/two',
      createIssue,
    })

    await expect(exportIssues(config, portal, { limit: 10 }, d)).rejects.toBeInstanceOf(ExportRefused)
    expect(createIssue).not.toHaveBeenCalled()
  })

  it('у клиента не задана группа — отказ до всякой работы', async () => {
    const d = deps()
    await expect(exportIssues(config, { ...portal, groupId: 0 }, { limit: 10 }, d)).rejects.toBeInstanceOf(ExportRefused)
  })

  it('выгрузка не настроена — отказ с внятной причиной', async () => {
    const d = deps()
    const bare = { ...config, issues: null } as unknown as AppConfig
    await expect(exportIssues(bare, portal, { limit: 10 }, d)).rejects.toThrow(/не настроена/)
  })

  it('сбой на одной задаче не останавливает остальные', async () => {
    let first = true
    const d = deps(
      {
        createIssue: async () => {
          if (first) {
            first = false
            throw new Error('GitHub ответил 404')
          }
          return { number: 18, url: '' }
        },
      },
      [
        { id: 1, title: 'A', description: '', sourceDomain: portal.domain, issueRef: '' },
        { id: 2, title: 'B', description: '', sourceDomain: portal.domain, issueRef: '' },
      ],
    )

    const report = await exportIssues(config, portal, { limit: 10 }, d)
    expect(report.failed).toBe(1)
    expect(report.exported).toBe(1)
  })

  it('потолок за прогон доезжает до отбора задач', async () => {
    const listTasksToExport = vi.fn().mockResolvedValue([])
    await exportIssues(config, portal, { limit: 7 }, deps({ listTasksToExport }))
    expect(listTasksToExport.mock.calls[0]?.[1]).toMatchObject({ limit: 7 })
  })
})

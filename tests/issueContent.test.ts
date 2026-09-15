import { describe, expect, it } from 'vitest'

import { buildIssue, taskUrl } from '../src/domain/issueContent.js'

const base = { taskId: 1517, title: 'Счёт не создаётся', ourDomain: 'bel.bitrix24.by', responsibleId: 29 }

describe('текст issue', () => {
  it('в теле есть домен нашего портала и ID задачи — без них issue не вернуть в задачу', () => {
    const issue = buildIssue({ ...base, description: 'Подробности' })
    expect(issue.body).toContain('bel.bitrix24.by')
    expect(issue.body).toContain('1517')
    expect(issue.body).toContain('Подробности')
  })

  it('ссылка на задачу строится из домена и исполнителя', () => {
    expect(taskUrl('bel.bitrix24.by', 29, 1517)).toBe(
      'https://bel.bitrix24.by/company/personal/user/29/tasks/task/view/1517/',
    )
  })

  it('пустое описание не оставляет issue без тела', () => {
    const issue = buildIssue({ ...base, description: '   ' })
    expect(issue.body).toContain('Описание в задаче пустое')
    expect(issue.body).toContain('1517')
  })

  it('заголовок не пустой даже у безымянной задачи', () => {
    expect(buildIssue({ ...base, title: '   ' }).title).toBe('Задача 1517')
  })

  it('длинный заголовок режется, а не уезжает в отказ GitHub', () => {
    const issue = buildIssue({ ...base, title: 'я'.repeat(400) })
    expect(issue.title.length).toBeLessThanOrEqual(256)
  })

  it('у длинной задачи режется описание, а не домен с ID', () => {
    // ⚠ Служебный блок стоит в конце: обрезка «по общей длине» съела бы именно его —
    // то есть единственный способ вернуться из issue в задачу.
    const issue = buildIssue({ ...base, description: 'д'.repeat(80_000) })
    expect(issue.body.length).toBeLessThanOrEqual(60_000)
    expect(issue.body).toContain('bel.bitrix24.by')
    expect(issue.body).toContain('1517')
    expect(issue.body.endsWith('/')).toBe(true)
  })
})

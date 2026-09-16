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

/**
 * Описание приезжает из Битрикс24 в BBCode. Проверяется на НАСТОЯЩЕМ тексте из первого
 * живого прогона `make issues` (2026-09-16): именно там владелец увидел `[b]` и `[list]`
 * в issue. Выдуманный пример такого бы не показал — в нём не было бы ни ссылки внутри
 * абзаца, ни списка без переводов строки между пунктами.
 */
describe('BBCode из описания задачи переводится в Markdown', () => {
  const bbcode = [
    '[b]Что наблюдаем[/b]',
    'Форма заказа собирает данные. В сделку «Заказ с сайта'
      + ' [url=https://example.test]example.test[/url] #6810» не попадает [b]ничего[/b].',
    '',
    '[list]',
    '[*]выгрузить модуль в отдельную ветку[*]разобрать, что и как работает',
    '[/list]',
  ].join('\n')

  const { body } = buildIssue({
    taskId: 1747,
    title: 'Синхронизация с сайтом',
    description: bbcode,
    ourDomain: 'our.example.by',
    responsibleId: 29,
  })

  it('жирный, ссылка и список становятся разметкой Markdown', () => {
    expect(body).toContain('**Что наблюдаем**')
    expect(body).toContain('[example.test](https://example.test)')
    expect(body).toContain('- выгрузить модуль в отдельную ветку')
    expect(body).toContain('- разобрать, что и как работает')
  })

  it('от BBCode не остаётся следов', () => {
    const description = body.split('\n---\n')[0] ?? ''
    expect(description).not.toMatch(/\[\/?b\]|\[url=|\[list\]|\[\*\]/)
  })

  // ⚠ Служебный блок мы пишем сами и сразу на Markdown — он обязан пережить перевод
  // нетронутым: по нему issue разрешается обратно в задачу.
  it('служебный блок с доменом и ID остаётся на месте', () => {
    expect(body).toContain('Битрикс24: `our.example.by`, задача `1747`')
    expect(body).toContain('https://our.example.by/company/personal/user/29/tasks/task/view/1747/')
  })
})

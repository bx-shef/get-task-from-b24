import { describe, expect, it } from 'vitest'
import { buildDescription, buildTargetTask, clamp, formatDeadline, MAX_TITLE_LENGTH, resolveDeadline, sourceTaskUrl } from '../src/domain/taskMapping.js'
import type { SourceTaskFull } from '../src/domain/taskMapping.js'

const now = new Date('2026-08-26T10:00:00.000Z')

const source: SourceTaskFull = {
  id: 555,
  title: '#support Не грузится отчёт',
  description: 'Открываю отчёт — белый экран.',
  responsibleId: 17,
  createdBy: 3,
  createdByName: 'Иван Петров',
  deadline: '2026-08-27T15:00:00+03:00',
}

describe('sourceTaskUrl', () => {
  it('ведёт на задачу в портале клиента', () => {
    expect(sourceTaskUrl('client.bitrix24.ru', 555))
      .toBe('https://client.bitrix24.ru/company/personal/user/0/tasks/task/view/555/')
  })
})

describe('formatDeadline', () => {
  // ⚠ Найдено ревью по сверке с документацией: тип datetime у Битрикс24 —
  // YYYY-MM-DDThh:mm:ss±hh:mm, без миллисекунд и без «Z». toISOString() давал и то,
  // и другое: либо отказ метода, либо срок, уехавший на смещение пояса портала.
  it('без миллисекунд и без Z, со смещением', () => {
    expect(formatDeadline(new Date('2026-08-27T12:00:00.123Z'))).toBe('2026-08-27T12:00:00+00:00')
    expect(formatDeadline(new Date('2026-08-27T12:00:00.123Z'))).not.toContain('Z')
    expect(formatDeadline(new Date('2026-08-27T12:00:00.123Z'))).not.toContain('.')
  })
})

describe('resolveDeadline', () => {
  it('берёт срок клиента', () => {
    expect(resolveDeadline('2026-08-27T15:00:00+03:00', now, 24)).toBe('2026-08-27T12:00:00+00:00')
  })

  it('нет срока — сдвиг по умолчанию', () => {
    expect(resolveDeadline(undefined, now, 24)).toBe('2026-08-27T10:00:00+00:00')
    expect(resolveDeadline('', now, 24)).toBe('2026-08-27T10:00:00+00:00')
  })

  // ⚠ Невалидная дата в tasks.task.add роняет создание целиком.
  it('нечитаемая дата не уезжает в портал', () => {
    expect(resolveDeadline('0000-00-00 00:00:00', now, 24)).toBe('2026-08-27T10:00:00+00:00')
  })
})

describe('buildDescription', () => {
  it('несёт клиента, постановщика и ссылку', () => {
    const text = buildDescription(source, 'client.bitrix24.ru')
    expect(text).toContain('Открываю отчёт — белый экран.')
    expect(text).toContain('Клиент: client.bitrix24.ru')
    expect(text).toContain('Поставил: Иван Петров')
    expect(text).toContain('/tasks/task/view/555/')
  })

  it('имя постановщика неизвестно — остаётся id, а не пустота', () => {
    expect(buildDescription({ ...source, createdByName: undefined }, 'client.bitrix24.ru'))
      .toContain('Поставил: id 3')
  })
})

describe('buildTargetTask', () => {
  const fields = buildTargetTask(source, {
    domain: 'client.bitrix24.ru',
    responsibleId: 1,
    now,
    defaultDeadlineHours: 24,
  })

  it('название без префикса', () => {
    expect(fields.TITLE).toBe('Не грузится отчёт')
  })

  // ⚠ Исполнитель — НАШ сотрудник: id 17 с портала клиента здесь означал бы другого человека.
  it('исполнитель наш, а не с портала клиента', () => {
    expect(fields.RESPONSIBLE_ID).toBe(1)
  })

  it('срок переносится', () => {
    expect(fields.DEADLINE).toBe('2026-08-27T12:00:00+00:00')
  })
})

describe('потолки на чужой текст', () => {
  // ⚠ Содержимое задачи пишет сотрудник клиента, а едет оно в НАШ портал и в Telegram.
  it('короткий текст не трогается', () => {
    expect(clamp('коротко', 100)).toBe('коротко')
  })

  it('длинный обрезается с многоточием и укладывается в лимит', () => {
    const cut = clamp('я'.repeat(500), 100)
    expect(cut).toHaveLength(100)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('название задачи не превышает потолок', () => {
    const fields = buildTargetTask(
      { ...source, title: `#support ${'я'.repeat(1000)}` },
      { domain: 'client.bitrix24.ru', responsibleId: 1, now, defaultDeadlineHours: 24 },
    )
    expect(fields.TITLE.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
  })
})

describe('группа у нас', () => {
  const base = { domain: 'client.bitrix24.ru', responsibleId: 1, now, defaultDeadlineHours: 24 }

  // ⚠ GROUP_ID: 0 для Битрикс24 — это значение, а не «не задано». Слать его вслепую
  // значит спорить с порталом о том, чего мы не просили.
  it('без группы поля в запросе нет вовсе', () => {
    expect(buildTargetTask(source, base)).not.toHaveProperty('GROUP_ID')
    expect(buildTargetTask(source, { ...base, groupId: 0 })).not.toHaveProperty('GROUP_ID')
  })

  it('с группой поле проставляется', () => {
    expect(buildTargetTask(source, { ...base, groupId: 42 }).GROUP_ID).toBe(42)
  })
})

describe('ID задачи клиента в поле у нас', () => {
  const base = { domain: 'client.bitrix24.ru', responsibleId: 1, now, defaultDeadlineHours: 24 }

  it('код не задан — поля нет', () => {
    expect(buildTargetTask(source, base).UF_AUTO_1).toBeUndefined()
  })

  // ⚠ Числом, потому что поле в портале числовое (`double`): тип значения совпадает с
  // типом поля. Искать по этому полю нельзя — замерено, см. docs/PROCESSING.md.
  it('код задан — приезжает id задачи клиента числом', () => {
    const fields = buildTargetTask(source, { ...base, sourceTaskField: 'UF_AUTO_123456' })
    expect(fields.UF_AUTO_123456).toBe(555)
  })

  // ⚠ Значение приходит из окружения и становится КЛЮЧОМ в теле запроса к порталу.
  it('не-код игнорируется, а не подставляется в запрос', () => {
    const fields = buildTargetTask(source, { ...base, sourceTaskField: 'DEADLINE' })
    expect(fields.DEADLINE).toBe('2026-08-27T12:00:00+00:00')
  })
})

describe('домен клиента в поле у нас', () => {
  const base = { domain: 'client.bitrix24.ru', responsibleId: 1, now, defaultDeadlineHours: 24 }

  // ⚠ Домен вместе с ID задачи — это ровно то, чего хватает для обратного хода:
  // домен даёт адрес портала, id — саму задачу.
  it('код задан — приезжает домен строкой', () => {
    const fields = buildTargetTask(source, { ...base, sourceDomainField: 'UF_SOURCE_DOMAIN' })
    expect(fields.UF_SOURCE_DOMAIN).toBe('client.bitrix24.ru')
  })

  it('код не задан — поля нет', () => {
    expect(buildTargetTask(source, base).UF_SOURCE_DOMAIN).toBeUndefined()
  })

  it('оба поля вместе дают полный обратный адрес', () => {
    const fields = buildTargetTask(source, {
      ...base,
      sourceTaskField: 'UF_SOURCE_TASK_ID',
      sourceDomainField: 'UF_SOURCE_DOMAIN',
    })
    expect(fields).toMatchObject({ UF_SOURCE_TASK_ID: 555, UF_SOURCE_DOMAIN: 'client.bitrix24.ru' })
  })
})

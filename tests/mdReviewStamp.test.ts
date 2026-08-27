/**
 * Конвенция из CLAUDE.md: каждый `.md` в корне и в `docs/` несёт штамп ревью строкой
 * сразу под заголовком. Обещание «когда появятся тесты — закрепим тестом» выполнено
 * здесь; из CI одноимённый шаг убран, чтобы один факт жил в одном месте.
 *
 * Обход `docs/` рекурсивный, а исключение — списком: раньше подкаталоги не проверялись
 * просто потому, что `readdirSync` не рекурсивен, и это молча распространялось бы на
 * любую новую папку. Единственное законное исключение — `docs/spec/`: внешний документ
 * положен как есть, у него своя версия и дата.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

/** Каталоги под `docs/`, которым штамп не нужен: внешние документы как есть. */
const EXEMPT_DIRS = ['spec']

function markdownFiles(): string[] {
  const inRoot = readdirSync(ROOT).filter((f) => f.endsWith('.md'))
  return [...inRoot, ...walkDocs('docs')]
}

function walkDocs(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.includes(entry.name)) found.push(...walkDocs(join(dir, entry.name)))
    } else if (entry.name.endsWith('.md')) {
      found.push(join(dir, entry.name))
    }
  }
  return found
}

describe('штамп ревью', () => {
  const files = markdownFiles()

  it('документы вообще нашлись', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('исключение из проверки ровно одно и заявлено явно', () => {
    // Новый подкаталог в docs/ должен либо проверяться, либо попадать сюда осознанно —
    // а не оставаться непроверенным из-за формы обхода.
    expect(EXEMPT_DIRS).toEqual(['spec'])
    expect(files.some((f) => f.startsWith(join('docs', 'spec')))).toBe(false)
  })

  it.each(files)('%s несёт «> Last reviewed: ГГГГ-ММ-ДД» под заголовком', (file) => {
    const head = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, 5)
    expect(head.some((line) => /^> Last reviewed: \d{4}-\d{2}-\d{2}$/.test(line))).toBe(true)
  })
})

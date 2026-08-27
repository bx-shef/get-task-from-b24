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

/**
 * Каталоги, которым штамп не нужен: внешние документы как есть. Путь целиком, а не имя:
 * по имени исключение молча накрыло бы любой `spec` на любой глубине.
 */
const EXEMPT_DIRS = [join('docs', 'spec')]

interface Walk {
  /** Найденные `.md`, относительными путями от корня репозитория. */
  files: string[]
  /** Каталоги, которые обход пропустил, — чтобы тест мог сверить их со списком. */
  skipped: string[]
}

function markdownFiles(): string[] {
  const inRoot = readdirSync(ROOT).filter((f) => f.endsWith('.md'))
  return [...inRoot, ...walkDocs('docs').files]
}

function walkDocs(dir: string): Walk {
  const walk: Walk = { files: [], skipped: [] }
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXEMPT_DIRS.includes(path)) {
        walk.skipped.push(path)
        continue
      }
      const nested = walkDocs(path)
      walk.files.push(...nested.files)
      walk.skipped.push(...nested.skipped)
    } else if (entry.name.endsWith('.md')) {
      walk.files.push(path)
    }
  }
  return walk
}

describe('штамп ревью', () => {
  const files = markdownFiles()

  it('документы вообще нашлись', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('обход пропустил ровно docs/spec и ничего больше', () => {
    // Сверяем не список с самим собой, а то, что обход сделал на реальном дереве:
    // новый подкаталог в docs/ должен либо проверяться, либо попасть сюда осознанно.
    expect(walkDocs('docs').skipped).toEqual([join('docs', 'spec')])
    expect(files.some((f) => f.startsWith(join('docs', 'spec')))).toBe(false)
  })

  it.each(files)('%s несёт «> Last reviewed: ГГГГ-ММ-ДД» под заголовком', (file) => {
    const head = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, 5)
    expect(head.some((line) => /^> Last reviewed: \d{4}-\d{2}-\d{2}$/.test(line))).toBe(true)
  })
})

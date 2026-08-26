/**
 * Конвенция из CLAUDE.md: каждый `.md` в корне и в `docs/` несёт штамп ревью строкой
 * сразу под заголовком. Обещание «когда появятся тесты — закрепим тестом» выполнено
 * здесь; из CI одноимённый шаг убран, чтобы один факт жил в одном месте.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function markdownFiles(): string[] {
  const inRoot = readdirSync(ROOT).filter((f) => f.endsWith('.md'))
  const inDocs = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join('docs', f))
  return [...inRoot, ...inDocs]
}

describe('штамп ревью', () => {
  const files = markdownFiles()

  it('документы вообще нашлись', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)('%s несёт «> Last reviewed: ГГГГ-ММ-ДД» под заголовком', (file) => {
    const head = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, 5)
    expect(head.some((line) => /^> Last reviewed: \d{4}-\d{2}-\d{2}$/.test(line))).toBe(true)
  })
})

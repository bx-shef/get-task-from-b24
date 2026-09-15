import { describe, expect, it } from 'vitest'

import { findRepoInDescription, repoSlug } from '../src/domain/gitRepo.js'

function repoOf(description: string) {
  const found = findRepoInDescription(description)
  return found.ok ? repoSlug(found.repo) : `отказ: ${found.reason}`
}

describe('репозиторий из описания группы', () => {
  it('берёт обычную ссылку', () => {
    expect(repoOf('Проект клиента. Репозиторий: https://github.com/bx-shef/stuttgart')).toBe('bx-shef/stuttgart')
  })

  it('понимает ссылку для клона и хвостовой слеш', () => {
    expect(repoOf('https://github.com/bx-shef/stuttgart.git')).toBe('bx-shef/stuttgart')
    expect(repoOf('https://github.com/bx-shef/stuttgart/')).toBe('bx-shef/stuttgart')
  })

  it('понимает ссылку со страницы внутри репозитория', () => {
    expect(repoOf('https://github.com/bx-shef/stuttgart/tree/main/src')).toBe('bx-shef/stuttgart')
    expect(repoOf('https://github.com/bx-shef/stuttgart/issues')).toBe('bx-shef/stuttgart')
  })

  it('не спотыкается о знаки препинания вокруг ссылки', () => {
    expect(repoOf('Гит (https://github.com/bx-shef/stuttgart), договор №12.')).toBe('bx-shef/stuttgart')
  })

  it('одна и та же ссылка дважды — это один репозиторий', () => {
    expect(repoOf('https://github.com/bx-shef/stuttgart и ещё раз https://github.com/bx-shef/stuttgart/issues')).toBe(
      'bx-shef/stuttgart',
    )
  })

  it('два РАЗНЫХ репозитория — отказ, а не «берём первый»', () => {
    // ⚠ Порядок ссылок в описании случаен: «первая» назавтра может стать другой, и
    // issue уехал бы в чужой приватный репозиторий.
    const answer = findRepoInDescription('https://github.com/a/one и https://github.com/b/two')
    expect(answer.ok).toBe(false)
    expect(answer.ok === false && answer.reason).toContain('несколько разных репозиториев')
  })

  it('чужой хост — отказ', () => {
    expect(repoOf('https://gitlab.com/a/b')).toContain('отказ')
    expect(repoOf('https://evil.tld/github.com/a/b')).toContain('отказ')
  })

  it('не обманывается логином в адресе', () => {
    expect(repoOf('https://github.com@evil.tld/a/b')).toContain('отказ')
  })

  it('неполный путь — отказ', () => {
    expect(repoOf('https://github.com/bx-shef')).toContain('отказ')
    expect(repoOf('https://github.com/')).toContain('отказ')
  })

  it('служебные разделы GitHub — не репозиторий', () => {
    expect(repoOf('https://github.com/orgs/bx-shef/repositories')).toContain('отказ')
  })

  it('пустое описание — понятная причина', () => {
    const answer = findRepoInDescription('')
    expect(answer.ok === false && answer.reason).toContain('пустое')
  })

  it('описание без ссылки — понятная причина', () => {
    const answer = findRepoInDescription('Просто текст про клиента')
    expect(answer.ok === false && answer.reason).toContain('нет ссылки')
  })
})

/**
 * Репозиторий клиента берётся из описания его группы в нашем Битрикс24.
 *
 * ⚠ Разбор строгий намеренно. Цена ошибки здесь не «не нашли ссылку», а **issue уехал
 * не тому клиенту**: репозитории приватные, и чужая задача в чужом репозитории — это
 * разглашение, которое нельзя отозвать. Поэтому всё неоднозначное — отказ.
 */

/** Владелец и имя репозитория, как их понимает GitHub. */
export interface GitRepo {
  owner: string
  repo: string
}

export type RepoLookup = { ok: true; repo: GitRepo } | { ok: false; reason: string }

/** Хосты, которые считаем GitHub. Точный список: «любой поддомен» — шире, чем безопасно. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/** Имя владельца: буквы, цифры и дефис, не с дефиса и не на дефис. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
/** Имя репозитория: плюс точка и подчёркивание. */
const REPO = /^[A-Za-z0-9._-]+$/

/** `owner/repo` — короткая каноническая форма GitHub, её же пишем в UF-поле. */
export function repoSlug(repo: GitRepo): string {
  return `${repo.owner}/${repo.repo}`
}

function parseCandidate(raw: string): GitRepo | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  // ⚠ Проверяем и логин в адресе: `https://github.com@evil.tld/o/r` имеет hostname
  // `evil.tld`, но глазами читается как GitHub.
  if (url.username || url.password) return null
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null

  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null

  const owner = parts[0]!
  // `.git` в конце — обычный вид ссылки для клона, он не часть имени.
  const repo = parts[1]!.replace(/\.git$/i, '')

  if (!OWNER.test(owner) || !REPO.test(repo)) return null
  // ⚠ Лишние сегменты (`/tree/main`, `/issues`) допускаем: человек копирует ссылку с
  // той страницы, где стоял. Но первые два сегмента обязаны быть владельцем и
  // репозиторием, а не служебным путём вроде `/orgs/…`.
  if (owner.toLowerCase() === 'orgs' || owner.toLowerCase() === 'settings') return null

  return { owner, repo }
}

/**
 * Достаёт репозиторий из описания группы.
 *
 * ⚠ Две ссылки на РАЗНЫЕ репозитории — отказ, а не «берём первую». Порядок ссылок в
 * описании случаен, и «первая» назавтра может стать другой: выбор молча переехал бы на
 * чужой репозиторий, а заметили бы это по чужим issue.
 */
export function findRepoInDescription(description: string | null | undefined): RepoLookup {
  const text = String(description ?? '')
  if (!text.trim()) return { ok: false, reason: 'описание группы пустое' }

  const found = new Map<string, GitRepo>()
  for (const match of text.matchAll(/https?:\/\/\S+/gi)) {
    // Хвостовая пунктуация прилипает к ссылке, когда её вставили в текст.
    const candidate = parseCandidate(match[0].replace(/[),.;'"»]+$/, ''))
    if (candidate) found.set(repoSlug(candidate).toLowerCase(), candidate)
  }

  if (found.size === 0) return { ok: false, reason: 'в описании группы нет ссылки на репозиторий GitHub' }
  if (found.size > 1) {
    const list = [...found.values()].map(repoSlug).sort().join(', ')
    return { ok: false, reason: `в описании группы несколько разных репозиториев: ${list}` }
  }

  return { ok: true, repo: [...found.values()][0]! }
}

/**
 * Создание issue в приватном репозитории клиента.
 *
 * ⚠ Токен — personal access token владельца (решение владельца 2026-09-15). Он даёт
 * доступ ко всем репозиториям, куда пускают владельца, поэтому единственная защита от
 * «issue уехал не туда» — строгий разбор ссылки (`src/domain/gitRepo.ts`), а не права
 * токена. Токен в логи не попадает: сюда он приходит аргументом и дальше живёт только
 * в заголовке запроса.
 */
import { B24Error } from '../b24/errors.js'
import { repoSlug, type GitRepo } from '../domain/gitRepo.js'

const API = 'https://api.github.com'
const TIMEOUT_MS = 20_000

export interface CreatedIssue {
  number: number
  url: string
}

/**
 * ⚠ Ошибки GitHub переводим в наш `B24Error` ради одного флага — «повторяемо». Он же
 * решает, остановиться прогону или идти дальше: 5xx и лимит стоит повторить, а «нет
 * такого репозитория» повтором не лечится.
 */
export function githubError(status: number, message: string): B24Error {
  const retryable = status >= 500 || status === 429 || status === 408
  return new B24Error(`GitHub ответил ${status}: ${message}`, `GITHUB_${status}`, retryable)
}

export async function createIssue(
  token: string,
  repo: GitRepo,
  issue: { title: string; body: string },
): Promise<CreatedIssue> {
  let response: Response
  try {
    response = await fetch(`${API}/repos/${repo.owner}/${repo.repo}/issues`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'get-task-from-b24',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ title: issue.title, body: issue.body }),
      // ⚠ За редиректами не идём: в заголовке токен, и 307 увёл бы его на чужой хост.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (cause) {
    // Сеть — всегда повторяемо: недоступность GitHub не делает задачу невыгружаемой.
    throw new B24Error(`сеть при обращении к GitHub: ${(cause as Error).message}`, 'NETWORK', true)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    number?: unknown
    html_url?: unknown
    message?: unknown
  }

  if (!response.ok) {
    const message = typeof payload.message === 'string' ? payload.message : 'без пояснения'
    throw githubError(response.status, `${message} (${repoSlug(repo)})`)
  }

  const number = Number(payload.number)
  if (!Number.isInteger(number) || number <= 0) {
    throw new B24Error(`GitHub не вернул номер issue для ${repoSlug(repo)}`, 'GITHUB_NO_NUMBER', true)
  }

  return { number, url: typeof payload.html_url === 'string' ? payload.html_url : '' }
}

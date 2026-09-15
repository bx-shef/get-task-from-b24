/**
 * Выгрузка задач нашего Битрикс24 в issue приватного репозитория клиента.
 *
 * Порядок (постановка владельца 2026-09-15): найти клиента по домену → взять его группу
 * → из описания группы достать ссылку на репозиторий → отобрать задачи, у которых
 * заполнены поля обратного адреса и пусто поле issue, а исполнитель — специальный →
 * создать issue → записать `owner/repo#17` в поле и оставить ссылку комментарием.
 */
import { commentTask, fetchGroupDescription, listTasksToExport, markTaskExported } from '../b24/issues.js'
import { findRepoInDescription, repoSlug, type GitRepo } from '../domain/gitRepo.js'
import { buildIssue } from '../domain/issueContent.js'
import { createIssue } from '../github/issues.js'
import type { AppConfig } from '../config.js'
import type { PortalConfig } from '../domain/portals.js'

/** Строка отчёта на задачу: оператор читает её глазами, поэтому текст — часть контракта. */
export interface ExportLine {
  taskId: number
  status: 'exported' | 'failed'
  text: string
}

export interface ExportReport {
  repo: GitRepo
  lines: ExportLine[]
  exported: number
  failed: number
}

export interface ExportDeps {
  fetchGroupDescription: typeof fetchGroupDescription
  listTasksToExport: typeof listTasksToExport
  createIssue: typeof createIssue
  markTaskExported: typeof markTaskExported
  commentTask: typeof commentTask
}

const DEFAULT_DEPS: ExportDeps = {
  fetchGroupDescription,
  listTasksToExport,
  createIssue,
  markTaskExported,
  commentTask,
}

export class ExportRefused extends Error {}

/**
 * ⚠ Отказ — это отказ целиком: ни одна задача не тронута. Так решил владелец, и так
 * правильнее половинчатого прогона: «часть выгружена, часть нет» разбирать дороже, чем
 * «не выгружено ничего, вот причина».
 */
export async function exportIssues(
  config: AppConfig,
  portal: PortalConfig,
  options: { limit: number },
  deps: ExportDeps = DEFAULT_DEPS,
): Promise<ExportReport> {
  const issues = config.issues
  if (!issues) throw new ExportRefused('выгрузка не настроена: нет GITHUB_TOKEN, B24_ISSUE_RESPONSIBLE_ID или B24_TARGET_UF_ISSUE')
  if (!config.targetSourceDomainField || !config.targetSourceTaskField) {
    throw new ExportRefused('не заданы поля обратного адреса (B24_TARGET_UF_SOURCE_DOMAIN и B24_TARGET_UF_SOURCE_TASK): по ним отбираются задачи')
  }
  if (portal.groupId <= 0) {
    throw new ExportRefused(`у клиента ${portal.domain} не задана группа в реестре: из её описания берётся репозиторий`)
  }

  const description = await deps.fetchGroupDescription(config.targetWebhookUrl, portal.groupId)
  const found = findRepoInDescription(description)
  if (!found.ok) {
    throw new ExportRefused(`группа ${portal.groupId} (${portal.domain}): ${found.reason}`)
  }
  const repo = found.repo

  const tasks = await deps.listTasksToExport(config.targetWebhookUrl, {
    groupId: portal.groupId,
    responsibleId: issues.responsibleId,
    sourceDomain: portal.domain,
    sourceDomainField: config.targetSourceDomainField,
    sourceTaskField: config.targetSourceTaskField,
    issueField: issues.issueField,
    limit: options.limit,
  })

  const report: ExportReport = { repo, lines: [], exported: 0, failed: 0 }

  for (const task of tasks) {
    try {
      const content = buildIssue({
        taskId: task.id,
        title: task.title,
        description: task.description,
        ourDomain: config.targetDomain,
        responsibleId: issues.responsibleId,
      })

      const created = await deps.createIssue(issues.githubToken, repo, content)
      const ref = `${repoSlug(repo)}#${created.number}`

      // ⚠ Отметка пишется СРАЗУ после создания issue и до комментария. Если упасть
      // между ними, следующий прогон увидит поле заполненным и второй issue не создаст;
      // при обратном порядке он создал бы дубль в приватном репозитории клиента.
      try {
        await deps.markTaskExported(config.targetWebhookUrl, task.id, issues.issueField, ref)
      } catch (error) {
        // ⚠ Кричим громко и с номером issue: issue уже существует, а отметки нет —
        // следующий прогон сделает дубль, если человек не впишет ссылку руками.
        report.failed++
        report.lines.push({
          taskId: task.id,
          status: 'failed',
          text: `issue ${ref} СОЗДАН, но отметка в задаче не записана: ${(error as Error).message}. Впишите «${ref}» в поле ${issues.issueField} руками, иначе следующий прогон создаст дубль`,
        })
        continue
      }

      // Комментарий — последним: он приятен, но его потеря не ломает связь.
      let note = ''
      try {
        await deps.commentTask(config.targetWebhookUrl, task.id, `Issue: ${created.url || ref}`)
      } catch (error) {
        note = ` (комментарий не добавлен: ${(error as Error).message})`
      }

      report.exported++
      report.lines.push({ taskId: task.id, status: 'exported', text: `${ref}${note}` })
    } catch (error) {
      report.failed++
      report.lines.push({ taskId: task.id, status: 'failed', text: (error as Error).message })
    }
  }

  return report
}

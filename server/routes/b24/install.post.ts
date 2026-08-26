import { defineEventHandler, readRawBody, getRequestHeader } from 'h3'
import { getContext } from '../../../src/runtime.js'
import { parseBody, parseInstallEvent } from '../../../src/b24/eventPayload.js'
import { saveInstall } from '../../../src/store/portalTokens.js'
import { findPortal, normalizeDomain } from '../../../src/domain/portals.js'
import { bindTaskAddEvent } from '../../../src/b24/tasks.js'
import { log } from '../../../src/queue/workers.js'

/**
 * Установка приложения на портале клиента (`ONAPPINSTALL`).
 *
 * ⚠ Вызывается РОВНО ОДИН РАЗ при сохранении формы локального приложения. Здесь
 * сохраняются токены и `application_token`, здесь же делается `event.bind`.
 * Упустили этот вызов — приложение стоит, а работать не может, и починка требует
 * участия клиента (docs/CLIENT_APP.md).
 */
export default defineEventHandler(async (event) => {
  const { config, pool } = getContext()

  const raw = (await readRawBody(event, 'utf8')) ?? ''
  const parsed = parseInstallEvent(parseBody(getRequestHeader(event, 'content-type'), raw))

  if (!parsed) {
    log('install-unparsed', {})
    event.node.res.statusCode = 400
    return { ok: false, error: 'no_tokens' }
  }

  const domain = normalizeDomain(parsed.domain)
  const portal = findPortal(config.portals, domain)
  // ⚠ Портал не в реестре — установку не принимаем: иначе в базе окажутся токены
  // портала, для которого не задан «особый» исполнитель, и он молча не переносил бы
  // ни одной задачи, выглядя подключённым.
  if (!portal) {
    log('install-unsupported', { domain })
    event.node.res.statusCode = 403
    return { ok: false, error: 'portal_not_in_registry' }
  }

  await saveInstall(
    pool,
    {
      domain: portal.domain,
      memberId: parsed.memberId,
      applicationToken: parsed.applicationToken,
      auth: {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        clientEndpoint: parsed.clientEndpoint,
        serverEndpoint: parsed.serverEndpoint,
      },
      expiresAt: new Date(Date.now() + parsed.expiresIn * 1000),
    },
    config.tokenEncKey,
  )

  const handlerUrl = `${config.publicBaseUrl}/b24/handler`
  try {
    await bindTaskAddEvent(
      { accessToken: parsed.accessToken, clientEndpoint: parsed.clientEndpoint },
      handlerUrl,
    )
    log('installed', { domain: portal.domain, handler: handlerUrl })
  } catch (error) {
    // ⚠ Токены уже сохранены: подписку можно доделать повторной установкой, а вот
    // потерять токены значило бы отправить клиента заводить приложение заново.
    log('install-bind-failed', { domain: portal.domain, reason: (error as Error).message })
    return { ok: true, warning: 'event_bind_failed' }
  }

  return { ok: true }
})

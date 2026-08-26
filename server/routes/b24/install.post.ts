import { defineEventHandler, getRequestHeader } from 'h3'
import { getContext } from '../../../src/runtime.js'
import { parseBody, parseInstallEvent } from '../../../src/b24/eventPayload.js'
import { readLimitedBody } from '../../../src/http/readLimitedBody.js'
import { getPortal, saveInstall } from '../../../src/store/portalTokens.js'
import { findPortal, normalizeDomain } from '../../../src/domain/portals.js'
import { bindTaskAddEvent, verifyPortalToken } from '../../../src/b24/tasks.js'
import { DEFAULT_OAUTH_ENDPOINT, isKnownOauthHost } from '../../../src/b24/rest.js'
import { log } from '../../../src/queue/workers.js'

/**
 * Установка приложения на портале клиента (`ONAPPINSTALL`).
 *
 * ⚠ Вызывается РОВНО ОДИН РАЗ при сохранении формы локального приложения. Здесь
 * сохраняются токены и `application_token`, здесь же делается `event.bind`.
 * Упустили этот вызов — приложение стоит, а работать не может, и починка требует
 * участия клиента (docs/CLIENT_APP.md).
 *
 * ⚠ **Телу запроса не верим ни в чём, кроме токена, который сами же и проверяем.**
 * Роут открыт миру, а раньше принимал на веру всё: посторонний, приславший домен
 * клиента из реестра со своими токенами, перезаписывал установку — после чего
 * настоящие события клиента получали 401 и терялись навсегда, а продление токена
 * уходило на его сервер вместе с `client_id` и `client_secret` портала. Найдено
 * панелью ревью. Теперь: адреса берём из реестра, а не из тела; токен доказываем
 * вызовом на настоящий портал; чужой `member_id` установку не перезаписывает.
 */
export default defineEventHandler(async (event) => {
  const { config, pool } = getContext()

  const raw = await readLimitedBody(event)
  if (raw === null) {
    log('install-too-large', {})
    event.node.res.statusCode = 413
    return { ok: false, error: 'body_too_large' }
  }

  const parsed = parseInstallEvent(parseBody(getRequestHeader(event, 'content-type'), raw))

  if (!parsed) {
    log('install-unparsed', {})
    event.node.res.statusCode = 400
    return { ok: false, error: 'no_tokens' }
  }

  // ⚠ `ONAPPUPDATE` принимаем здесь же, и это не удобство. В нём приходит ОБНОВЛЁННЫЙ
  // `application_token`: клиент правит что-нибудь в форме приложения — и без этой ветки
  // каждое следующее событие получало бы от нас 401 и терялось, а внешне всё выглядело
  // бы установленным и подписанным. Найдено ревью по сверке с документацией.
  if (parsed.event && parsed.event !== 'ONAPPINSTALL' && parsed.event !== 'ONAPPUPDATE') {
    log('install-wrong-event', { event: parsed.event })
    event.node.res.statusCode = 400
    return { ok: false, error: 'wrong_event' }
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

  // ⚠ Доказательство подлинности: вызов уходит на адрес ИЗ РЕЕСТРА. Подделать ответ
  // может только тот, кто владеет самим порталом.
  let scope: string[]
  try {
    scope = await verifyPortalToken(portal.domain, parsed.accessToken)
  } catch (error) {
    log('install-token-rejected', { domain: portal.domain, reason: (error as Error).message })
    event.node.res.statusCode = 403
    return { ok: false, error: 'token_not_verified' }
  }

  // ⚠ Скоуп `task` обязателен: без него приложение установится, а перенос молча не
  // заработает — и разбираться будут по жалобе клиента, а не по отказу установки.
  if (scope.length > 0 && !scope.includes('task')) {
    log('install-scope-missing', { domain: portal.domain, scope: scope.join(',') })
    event.node.res.statusCode = 403
    return { ok: false, error: 'scope_task_required' }
  }

  // ⚠ Переустановка своим порталом — норма; чужим `member_id` — попытка перехвата.
  const existing = await getPortal(pool, portal.domain, config.tokenEncKey)
  if (existing && parsed.memberId && existing.memberId && existing.memberId !== parsed.memberId) {
    log('install-member-mismatch', { domain: portal.domain })
    event.node.res.statusCode = 409
    return { ok: false, error: 'member_id_mismatch' }
  }

  const serverEndpoint = isKnownOauthHost(parsed.serverEndpoint) ? parsed.serverEndpoint : DEFAULT_OAUTH_ENDPOINT

  await saveInstall(
    pool,
    {
      domain: portal.domain,
      memberId: parsed.memberId,
      applicationToken: parsed.applicationToken,
      auth: {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        // ⚠ Адрес портала — из реестра, а не из тела: иначе это готовый SSRF, и все
        // наши вызовы «в портал клиента» уходили бы на чужой сервер.
        clientEndpoint: `https://${portal.domain}/rest/`,
        serverEndpoint,
      },
      expiresAt: new Date(Date.now() + parsed.expiresIn * 1000),
    },
    config.tokenEncKey,
  )

  const handlerUrl = `${config.publicBaseUrl}/b24/handler`
  try {
    await bindTaskAddEvent(
      { accessToken: parsed.accessToken, clientEndpoint: `https://${portal.domain}/rest/` },
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

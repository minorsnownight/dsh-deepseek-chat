/**
 * dsh-deepseek-chat — Host half.
 *
 * Starts the loopback reverse proxy for chat.deepseek.com and exposes one
 * same-origin route for the browser half:
 *
 *   GET /deepseek-chat/status -> { ok, url, upstream, cookies }
 *
 * The proxy origin is a separate loopback port on purpose: the proxied page
 * keeps its own origin for localStorage (so the chat app's `userToken`
 * survives restarts), while the cookie half of the login lives in the jar.
 * The port is fixed by default because a stable origin is what keeps that
 * localStorage alive across DSH restarts.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { CookieJar } from './jar.js'
import { createChatProxy, isLoopbackHostname } from './proxy.js'

export const name = 'dsh-deepseek-chat'

/** Routes need the Web host server; everything else is optional. */
export const inject = ['webServer']

/**
 * Browser-trust fence for this plugin's own routes: Host must be loopback and
 * a browser-supplied Origin must match it. Same intent as the `/api` gateway's
 * fence — a DNS-rebinding / cross-site defense, not authentication.
 */
function isTrustedRequest(req, trustedHosts) {
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${authority}`)
  } catch {
    return false
  }
  const loopback = isLoopbackHostname(hostUrl.hostname)
  const trusted = trustedHosts.some((entry) => {
    try {
      const candidate = new URL(`http://${entry}`)
      return candidate.host === hostUrl.host || candidate.hostname === hostUrl.hostname
    } catch {
      return false
    }
  })
  if (!loopback && !trusted) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** The connection row's live `trustedHosts` (the `/api` fence's own list). */
function trustedHostsOf(ctx) {
  try {
    for (const entry of ctx.loader?.entries?.() ?? []) {
      if (entry.options?.name === 'connection') {
        const config = entry.options.config
        if (Array.isArray(config?.trustedHosts)) return config.trustedHosts
      }
    }
  } catch {
    // The loader row is optional here; loopback still passes the fence.
  }
  return []
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [config] - this row's configuration.
 * @param {number} [config.port] - preferred loopback port (default 45917).
 * @param {string} [config.host] - loopback bind address (default 127.0.0.1).
 * @param {string} [config.upstream] - upstream origin (default https://chat.deepseek.com).
 * @param {string} [config.dataDir] - cookie-jar directory (default `$DSH_HOME/deepseek-chat`).
 */
export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dataDir = typeof config.dataDir === 'string' && config.dataDir !== ''
    ? config.dataDir
    : join(home, 'deepseek-chat')
  const upstream = typeof config.upstream === 'string' && config.upstream !== ''
    ? config.upstream
    : 'https://chat.deepseek.com'
  const host = typeof config.host === 'string' && config.host !== '' ? config.host : '127.0.0.1'
  const port = Number.isInteger(config.port) ? config.port : 45917

  const jar = new CookieJar(join(dataDir, 'cookies.json'))
  const proxy = createChatProxy({ upstream, jar, host, port })
  let ready
  let disposed = false

  ctx.effect(() => {
    ready = proxy.listen().then(
      (origin) => {
        if (!disposed) console.log(`[dsh-deepseek-chat] proxy listening at ${origin} (upstream ${upstream})`)
        return origin
      },
      (error) => {
        console.error('[dsh-deepseek-chat] proxy failed to start:', error?.message ?? error)
        return undefined
      },
    )
    return () => {
      disposed = true
      void jar.flush()
      void proxy.close()
    }
  }, 'dsh-deepseek-chat: loopback chat proxy')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/deepseek-chat',
    handler: async (req, res) => {
      const trustedHosts = trustedHostsOf(ctx)
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (pathname === '/deepseek-chat/status') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        await ready
        const url = proxy.origin()
        if (url === undefined) {
          writeJson(res, 503, { ok: false, error: 'proxy-not-ready' })
          return
        }
        writeJson(res, 200, {
          ok: true,
          url: url.endsWith('/') ? url : `${url}/`,
          upstream,
          cookies: jar.size,
        })
        return
      }
      writeJson(res, 404, { ok: false, error: 'not-found' })
    },
  }), 'dsh-deepseek-chat: host routes')
}

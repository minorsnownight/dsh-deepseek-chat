/**
 * The local reverse proxy that makes chat.deepseek.com embeddable.
 *
 * chat.deepseek.com answers with `Content-Security-Policy: frame-ancestors
 * 'none'`, so a plain iframe is refused outright. The proxy binds the upstream
 * site to a stable loopback origin and removes only that one directive — every
 * other upstream header (including the rest of the CSP, if the site ever ships
 * one) passes through untouched. Response bodies are streamed byte-for-byte,
 * which keeps SSE chat streaming, uploads and downloads intact.
 *
 * Request/response rules:
 * - request `Cookie` comes from the persisted jar, never from the embedding
 *   page (so DSH's own loopback cookies can never leak upstream);
 * - response `Set-Cookie` is absorbed into the jar and never handed to the
 *   browser (so the login survives even a cleared browser cookie store);
 * - `Location` pointing at the upstream origin is rewritten to this origin;
 * - the listener is loopback-only, and requests carrying a foreign `Origin`
 *   are refused (a cross-site page cannot drive the proxied session).
 */
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** HTML larger than this is streamed unchanged instead of buffered for rewriting. */
const REWRITE_LIMIT = 8 * 1024 * 1024

/**
 * Script injected into every proxied document.
 *
 * chat.deepseek.com shows its "Abnormal usage environment" notice whenever
 * `navigator.userAgent` contains `Electron` (or the page sees
 * `window.process.type === 'renderer'`). DSH's desktop shell is Electron, so
 * the notice would greet every user of this plugin. The shim hides only those
 * two markers, keeping the real Chrome part of the UA intact.
 */
const ENV_SHIM = String.raw`<script data-dsh-deepseek-chat="env-shim">(()=>{try{const clean=u=>String(u||"").replace(/\sElectron\/[\d.]+/gi,"").replace(/\sDeepSeek(?: Harness)?\/[\d.]+/gi,""),rawUa=clean(navigator.userAgent),rawVersion=clean(navigator.appVersion);Object.defineProperty(navigator,"userAgent",{get:()=>rawUa,configurable:true});Object.defineProperty(navigator,"appVersion",{get:()=>rawVersion,configurable:true})}catch(e){}try{if(window.process&&window.process.type==="renderer")Object.defineProperty(window,"process",{value:undefined,configurable:true})}catch(e){}})()</script>`

/** Remove the Electron/app markers from a User-Agent string. */
export function stripElectronUa(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value
    .replace(/\sElectron\/[\d.]+/gi, '')
    .replace(/\sDeepSeek(?: Harness)?\/[\d.]+/gi, '')
    .trim()
  return cleaned === '' ? undefined : cleaned
}

/** Insert the environment shim at the top of the document's head. */
export function injectEnvShim(html) {
  const match = /<head[^>]*>/i.exec(html)
  if (match === null) return `${ENV_SHIM}${html}`
  const at = match.index + match[0].length
  return `${html.slice(0, at)}${ENV_SHIM}${html.slice(at)}`
}

/** Whether a hostname names the local loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Strip only the `frame-ancestors` directive from a CSP header value. */
export function stripFrameAncestors(value) {
  const text = Array.isArray(value) ? value.join(', ') : String(value)
  const kept = text
    .split(';')
    .map(directive => directive.trim())
    .filter(directive => directive !== '' && !/^frame-ancestors(\s|$)/i.test(directive))
  return kept.join('; ')
}

/** Rewrite a redirect that points at the upstream origin back to this proxy. */
export function rewriteLocation(location, upstream) {
  const raw = Array.isArray(location) ? location[0] : String(location)
  let parsed
  try {
    parsed = new URL(raw, upstream)
  } catch {
    return raw
  }
  if (parsed.origin !== new URL(upstream).origin) return raw
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/**
 * Drop `crossorigin` / `integrity` from the upstream HTML.
 *
 * DeepSeek serves its scripts and styles from fe-static.deepseek.com, tagged
 * `crossorigin` plus an SRI hash. The CDN answers `Access-Control-Allow-Origin`
 * only for `https://chat.deepseek.com`, so from a proxied origin every one of
 * those requests fails CORS and the page replaces itself with a
 * "page resource load failed" screen. Classic cross-origin scripts need no
 * CORS at all, so removing the two attributes restores the app without
 * touching any other asset.
 */
export function rewriteHtml(html) {
  return html
    .replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
    .replace(/\s+integrity(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
}

/** Decode a content-encoded body just enough to rewrite HTML. */
function decodeBody(buffer, encoding) {
  if (encoding === '' || encoding === 'identity') return buffer
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(buffer)
    if (encoding === 'deflate') return inflateSync(buffer)
    if (encoding === 'br') return brotliDecompressSync(buffer)
  } catch {
    return undefined
  }
  return undefined
}

function parseAuthority(value) {
  try {
    return new URL(`http://${value}`)
  } catch {
    return undefined
  }
}

function sendText(res, status, text) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Create the proxy server (not yet listening).
 * @param {object} options
 * @param {string} options.upstream - upstream origin, e.g. `https://chat.deepseek.com`.
 * @param {import('./jar.js').CookieJar} options.jar - the persisted cookie jar.
 * @param {string} [options.host] - bind address; loopback only by design.
 * @param {number} [options.port] - preferred port (a stable origin keeps the page's localStorage).
 * @param {string[]} [options.extraPorts] - fallback ports when the preferred one is busy.
 * @returns {{ listen: () => Promise<string>, close: () => Promise<void>, origin: () => string | undefined }}
 */
export function createChatProxy({ upstream, jar, host = '127.0.0.1', port = 45917, extraPorts = [45918, 45919, 45920] }) {
  const upstreamUrl = new URL(upstream)
  const upstreamOrigin = upstreamUrl.origin
  const upstreamHost = upstreamUrl.host
  let server
  let origin

  const handle = (req, res) => {
    const authority = req.headers.host ?? ''
    const hostUrl = parseAuthority(authority)
    if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) {
      sendText(res, 421, 'dsh-deepseek-chat: loopback Host required')
      return
    }
    const requestOrigin = req.headers.origin
    if (requestOrigin !== undefined && requestOrigin !== `http://${authority}`) {
      if (!(requestOrigin === 'null' && (req.method === 'GET' || req.method === 'HEAD'))) {
        sendText(res, 403, 'dsh-deepseek-chat: cross-origin request refused')
        return
      }
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.internal')
    } catch {
      sendText(res, 400, 'bad request')
      return
    }

    // The plugin owns no routes on the proxied origin; keep the namespace
    // reserved so it can never be forwarded upstream by accident.
    if (url.pathname.startsWith('/__dsh/')) {
      sendText(res, 404, 'dsh-deepseek-chat: not found')
      return
    }
    forward(req, res, url)
  }

  const forward = (req, res, url) => {
    const wantsHtml = `${req.headers.accept ?? ''}`.includes('text/html')
      || req.headers['sec-fetch-mode'] === 'navigate'
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue
      if (name === 'sec-fetch-site' || name.startsWith('x-forwarded-')) continue
      headers[name] = value
    }
    headers.host = upstreamHost
    headers.origin = upstreamOrigin
    headers.referer = `${upstreamOrigin}/`
    const cleanUa = stripElectronUa(headers['user-agent'])
    if (cleanUa !== undefined) headers['user-agent'] = cleanUa
    // Document responses get rewritten, so ask for the bytes as they are.
    if (wantsHtml) headers['accept-encoding'] = 'identity'
    const cookie = jar.header()
    if (cookie !== '') headers.cookie = cookie

    const target = new URL(upstreamUrl)
    target.pathname = url.pathname
    target.search = url.search

    const proxyReq = httpsRequest(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port === '' ? 443 : upstreamUrl.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        servername: upstreamUrl.hostname,
      },
      (upstreamRes) => {
        jar.absorb(upstreamRes.headers['set-cookie'])
        const outgoing = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (name === 'set-cookie') continue
          if (HOP_BY_HOP.has(name)) continue
          if (name === 'x-frame-options') continue
          if (name === 'content-security-policy') {
            const filtered = stripFrameAncestors(value)
            if (filtered !== '') outgoing[name] = filtered
            continue
          }
          if (name === 'location') {
            outgoing[name] = rewriteLocation(value, upstreamOrigin)
            continue
          }
          outgoing[name] = value
        }
        const contentType = `${upstreamRes.headers['content-type'] ?? ''}`
        const status = upstreamRes.statusCode ?? 502
        const rewritable = wantsHtml
          && /text\/html/i.test(contentType)
          && status !== 204
          && status !== 304
          && (upstreamRes.headers['content-length'] === undefined
            || Number(upstreamRes.headers['content-length']) <= REWRITE_LIMIT)

        if (!rewritable) {
          res.writeHead(status, outgoing)
          upstreamRes.pipe(res)
          upstreamRes.on('error', () => { res.destroy() })
          return
        }

        const chunks = []
        let size = 0
        let overflow = false
        upstreamRes.on('data', (chunk) => {
          size += chunk.length
          if (size > REWRITE_LIMIT) overflow = true
          chunks.push(chunk)
        })
        upstreamRes.on('error', () => { res.destroy() })
        upstreamRes.on('end', () => {
          if (overflow) {
            // Too large to buffer: forward untouched (only possible if the
            // upstream ignored `identity`, which the app's own HTML never is).
            res.writeHead(status, outgoing)
            res.end(Buffer.concat(chunks))
            return
          }
          const encoding = `${upstreamRes.headers['content-encoding'] ?? ''}`.toLowerCase()
          const decoded = decodeBody(Buffer.concat(chunks), encoding)
          if (decoded === undefined) {
            res.writeHead(status, outgoing)
            res.end(Buffer.concat(chunks))
            return
          }
          const body = Buffer.from(injectEnvShim(rewriteHtml(decoded.toString('utf8'))), 'utf8')
          delete outgoing['content-encoding']
          outgoing['content-length'] = String(body.length)
          res.writeHead(status, outgoing)
          res.end(body)
        })
      },
    )

    proxyReq.setTimeout(300_000, () => {
      proxyReq.destroy(new Error('upstream timeout'))
    })
    proxyReq.on('error', (error) => {
      if (res.writableEnded) return
      sendText(res, 502, `dsh-deepseek-chat: upstream unreachable (${error?.message ?? error})`)
    })
    req.on('aborted', () => { proxyReq.destroy() })
    res.on('close', () => { proxyReq.destroy() })
    req.pipe(proxyReq)
  }

  const listen = async () => {
    if (server !== undefined) return origin
    await jar.load()
    const candidates = [port, ...extraPorts, 0]
    let lastError
    for (const candidate of candidates) {
      const candidateServer = createServer(handle)
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => { candidateServer.removeListener('listening', onListening); reject(error) }
          const onListening = () => { candidateServer.removeListener('error', onError); resolve() }
          candidateServer.once('error', onError)
          candidateServer.once('listening', onListening)
          candidateServer.listen(candidate, host)
        })
      } catch (error) {
        lastError = error
        candidateServer.close()
        if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') continue
        throw error
      }
      server = candidateServer
      server.requestTimeout = 0
      server.headersTimeout = 120_000
      server.keepAliveTimeout = 72_000
      server.on('error', (error) => {
        console.warn('[dsh-deepseek-chat] proxy server error:', error?.message ?? error)
      })
      const address = server.address()
      const hostPart = host.includes(':') ? `[${host}]` : host
      origin = `http://${hostPart}:${address.port}`
      return origin
    }
    throw lastError ?? new Error('no loopback port available')
  }

  const close = async () => {
    const current = server
    server = undefined
    origin = undefined
    if (current === undefined) return
    await new Promise((resolve) => {
      current.close(() => resolve())
      current.closeAllConnections?.()
    })
  }

  return {
    listen,
    close,
    origin: () => origin,
  }
}

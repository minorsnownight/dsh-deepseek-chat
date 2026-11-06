/**
 * A tiny, dependency-free cookie jar for the DeepSeek Chat reverse proxy.
 *
 * Why a server-side jar at all: chat.deepseek.com marks its session cookies
 * `Secure; HttpOnly; SameSite=Strict`, and the page runs inside an iframe, so
 * Chromium's third-party-cookie rules can neither store nor replay them
 * reliably. Keeping the cookies on the Host side makes the login independent
 * of the embedding page's cookie policy — and it is what makes "remember the
 * login across DSH restarts" work at all.
 *
 * Session cookies (no `Max-Age` / `Expires`) are intentionally persisted: the
 * DeepSeek session cookie is a session cookie, and dropping it on restart is
 * exactly the behaviour this plugin exists to avoid. An explicit delete
 * (`Max-Age=0` or a past `Expires`) still removes the entry.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class CookieJar {
  /** @param {string} file - absolute path of the persisted JSON jar. */
  constructor(file) {
    this.file = file
    /** @type {Map<string, { value: string, expires?: number }>} */
    this.cookies = new Map()
    this.loaded = false
    this.saveTimer = undefined
    this.writeChain = Promise.resolve()
  }

  /** Load the jar from disk; a missing or malformed file starts empty. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      for (const entry of parsed?.cookies ?? []) {
        if (typeof entry?.name !== 'string' || typeof entry?.value !== 'string') continue
        this.cookies.set(entry.name, {
          value: entry.value,
          ...(typeof entry.expires === 'number' ? { expires: entry.expires } : {}),
        })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[dsh-deepseek-chat] cookie jar unreadable:', error?.message ?? error)
    }
  }

  /** Number of live cookies (expired entries excluded). */
  get size() {
    this.prune()
    return this.cookies.size
  }

  /** Whether any cookie is currently stored. */
  get hasCookies() {
    return this.size > 0
  }

  /** Prune expired cookies. */
  prune() {
    const now = Date.now()
    for (const [name, cookie] of this.cookies) {
      if (cookie.expires !== undefined && cookie.expires <= now) this.cookies.delete(name)
    }
  }

  /** The `Cookie` request header value for the upstream host. */
  header() {
    this.prune()
    const parts = []
    for (const [name, cookie] of this.cookies) parts.push(`${name}=${cookie.value}`)
    return parts.join('; ')
  }

  /**
   * Store the `Set-Cookie` header lines of one upstream response.
   * @param {string[] | undefined} lines - Node's raw `set-cookie` header value(s).
   */
  absorb(lines) {
    if (lines === undefined || lines.length === 0) return
    for (const line of lines) {
      const segments = String(line).split(';')
      const pair = segments.shift() ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (name === '') continue
      let expires
      let deleted = false
      for (const segment of segments) {
        const [rawKey, rawValue] = segment.split('=')
        const key = rawKey?.trim().toLowerCase()
        const val = rawValue?.trim()
        if (key === 'max-age' && val !== undefined) {
          const seconds = Number(val)
          if (Number.isFinite(seconds)) {
            if (seconds <= 0) deleted = true
            else expires = Date.now() + seconds * 1000
          }
        } else if (key === 'expires' && val !== undefined) {
          const at = Date.parse(val)
          if (!Number.isNaN(at)) {
            if (at <= Date.now()) deleted = true
            else expires = at
          }
        }
      }
      if (deleted) this.cookies.delete(name)
      else this.cookies.set(name, expires === undefined ? { value } : { value, expires })
    }
    this.scheduleSave()
  }

  /** Debounced persistence: chat traffic sets cookies in bursts. */
  scheduleSave() {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.save()
    }, 300)
    this.saveTimer.unref?.()
  }

  /** Resolve once every scheduled write has reached the disk. */
  async flush() {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
      await this.save()
    }
    await this.writeChain
  }

  async save() {
    const body = JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), cookies: [...this.cookies].map(([name, cookie]) => ({ name, ...cookie })) },
      null,
      2,
    )
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, body, { mode: 0o600 })
      await rename(temporary, this.file)
    }
    this.writeChain = this.writeChain.then(write, write)
    try {
      await this.writeChain
    } catch (error) {
      console.warn('[dsh-deepseek-chat] cookie jar write failed:', error?.message ?? error)
    }
  }
}

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CookieJar } from '../lib/jar.js'
import { injectEnvShim, isLoopbackHostname, rewriteHtml, rewriteLocation, stripElectronUa, stripFrameAncestors } from '../lib/proxy.js'

test('stripFrameAncestors removes only that directive', () => {
  assert.equal(stripFrameAncestors("frame-ancestors 'none'"), '')
  const kept = stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; img-src https:")
  assert.equal(kept, "default-src 'self'; img-src https:")
})

test('rewriteHtml drops crossorigin and integrity attributes', () => {
  const html = '<script crossorigin defer integrity="sha384-abc" src="https://cdn/x.js"></script>'
    + '<link crossorigin href="https://cdn/x.css" rel="stylesheet">'
  const rewritten = rewriteHtml(html)
  assert.equal(rewritten.includes('crossorigin'), false)
  assert.equal(rewritten.includes('integrity'), false)
  assert.equal(rewritten.includes('https://cdn/x.js'), true)
})

test('rewriteLocation only rewrites the upstream origin', () => {
  const upstream = 'https://chat.deepseek.com'
  assert.equal(rewriteLocation('https://chat.deepseek.com/sign_in?a=1', upstream), '/sign_in?a=1')
  assert.equal(rewriteLocation('/sign_in', upstream), '/sign_in')
  assert.equal(rewriteLocation('https://example.com/x', upstream), 'https://example.com/x')
})

test('isLoopbackHostname accepts loopback literals only', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('127.8.9.10'), true)
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('10.0.0.1'), false)
  assert.equal(isLoopbackHostname('127.0.0.1.evil.com'), false)
})

test('CookieJar persists session cookies and honours deletion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chat-jar-'))
  try {
    const file = join(dir, 'cookies.json')
    const jar = new CookieJar(file)
    await jar.load()
    jar.absorb(['ds_session_id=abc; Path=/; HttpOnly; Secure; SameSite=Strict', 'gone=1; Max-Age=0'])
    assert.match(jar.header(), /ds_session_id=abc/)
    assert.equal(jar.header().includes('gone=1'), false)
    await jar.flush()

    const reloaded = new CookieJar(file)
    await reloaded.load()
    assert.match(reloaded.header(), /ds_session_id=abc/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stripElectronUa keeps the Chrome part and drops Electron markers', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36 Electron/44.7.0 DeepSeek Harness/0.2.1'
  assert.equal(stripElectronUa(ua), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36')
})

test('injectEnvShim runs before the first document script', () => {
  const html = '<html><head><script>window.x=1</script></head><body></body></html>'
  const shimmed = injectEnvShim(html)
  const shimAt = shimmed.indexOf('data-dsh-deepseek-chat="env-shim"')
  const scriptAt = shimmed.indexOf('<script>window.x=1</script>')
  assert.ok(shimAt > 0 && shimAt < scriptAt)
  assert.ok(injectEnvShim('<body></body>').startsWith('<script'))
})

/**
 * dsh-deepseek-chat — browser half.
 *
 * Registers a right-sidebar tab type whose body embeds chat.deepseek.com
 * through the Host half's loopback proxy, plus a guide card that opens it.
 * The bundle is hand-written in the DSH module-loader closure shape (the same
 * shape the official client bundles use), so no build step is needed:
 * `window.__ModuleLoader__.load({ id: <package name>, factory })`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** Tab type identity in the tab registry (unique across registrations). */
    const ID = 'dsh-deepseek-chat'
    /** The tab discriminator `openTab('deepseek-chat')` names. */
    const KIND = 'deepseek-chat'
    const STYLE_ID = 'dsh-deepseek-chat-style'
    const ZH = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')

    const text = ZH
      ? {
        title: 'DeepSeek 聊天',
        loading: '正在启动本地代理…',
        error: '聊天页面暂时无法打开',
        retry: '重试',
      }
      : {
        title: 'DeepSeek Chat',
        loading: 'Starting the local proxy…',
        error: 'The chat page is unavailable right now',
        retry: 'Retry',
      }

    // No header chrome at all: the proxied page is the whole panel. Only the
    // startup/error notice is drawn by this plugin.
    const CSS = `
      .dsc-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary)}
      .dsc-body{position:relative;flex:1;min-height:0;background:#fff}
      .dsc-frame{display:block;width:100%;height:100%;border:0;background:#fff}
      .dsc-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1,#fff))}
      .dsc-message{max-width:360px;word-break:break-word}
      .dsc-actions{display:flex;gap:8px}
      .dsc-action{border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.28));background:transparent;color:inherit;font:inherit;padding:4px 12px;border-radius:8px;cursor:pointer}
      .dsc-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
    `

    /** Inject the tab stylesheet once (idempotent across HMR re-activations). */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Read the Host half's status route (same-origin in both Web and Desktop). */
    async function readStatus() {
      const response = await fetch('/deepseek-chat/status', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    /** The left-nav glyph for the DeepSeek entry. */
    function ChatGlyph(props) {
      const size = props?.size ?? 20
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        className: props?.className,
      }, [
        h('path', { key: 'bubble', d: 'M4 5.5h16v10.2H9.6L5 19.4v-3.7H4z' }),
        h('path', { key: 'wave', d: 'M8.4 10.6c1.2 1.1 2.4 1.1 3.6 0s2.4-1.1 3.6 0' }),
      ])
    }

    /**
     * The full-width panel page: the proxied app fills the whole main content
     * area. Only a startup/error notice is drawn by this plugin.
     */
    function DeepSeekPage() {
      const [state, setState] = React.useState({ phase: 'loading' })

      const refresh = React.useCallback(async () => {
        try {
          const body = await readStatus()
          setState({ phase: 'ready', url: body.url })
        } catch (error) {
          setState(previous => ({
            phase: 'error',
            message: error instanceof Error ? error.message : String(error),
            ...(previous.url !== undefined ? { url: previous.url } : {}),
          }))
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const ready = state.phase === 'ready'
      const base = ready ? (state.url.endsWith('/') ? state.url : `${state.url}/`) : undefined

      return h('div', { className: 'dsc-root' }, [
        h('div', { className: 'dsc-body', key: 'body' }, [
          ready
            ? h('iframe', {
              key: `frame-${base}`,
              className: 'dsc-frame',
              src: base,
              title: text.title,
              allow: 'clipboard-read; clipboard-write; fullscreen; microphone',
              allowFullScreen: true,
            })
            : h('div', { className: 'dsc-center', key: 'center' }, [
              h('div', { key: 'msg', className: 'dsc-message' }, state.phase === 'error'
                ? `${text.error}${state.message ? `：${state.message}` : ''}`
                : text.loading),
              h('div', { key: 'actions', className: 'dsc-actions' }, [
                h('button', {
                  key: 'retry',
                  type: 'button',
                  className: 'dsc-action',
                  onClick: () => { setState({ phase: 'loading' }); void refresh() },
                }, text.retry),
              ]),
            ]),
        ]),
      ])
    }

    /**
     * Browser half entry: register the full-width page and its left-nav row.
     * @param {any} ctx - client cordis context.
     */
    function apply(ctx) {
      ensureStyle()

      // The full-width page in the main content area, opened by the left nav row.
      // Register the page before the nav row: a row whose main entry is missing
      // would throw when clicked.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: KIND,
      }, DeepSeekPage))

      // The left navigation row: the shell wraps this glyph in a button and
      // calls ctx.layout.selectPanel(KIND) when the row is picked.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: KIND,
        order: 20,
        label: () => (ZH ? 'DeepSeek 聊天' : 'DeepSeek Chat'),
      }, ChatGlyph))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})

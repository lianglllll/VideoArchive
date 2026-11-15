// 录像档案 · 设置页里的入口（真正的界面在 /video-archive/，这里只放一个入口和状态）
window.__ModuleLoader__.load({
  id: '@local/video-archive',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    const API = '/video-archive/api'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
      err: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
    }

    const S = {
      card: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '14px', background: C.bg, marginBottom: '12px' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '6px', padding: '6px 11px', fontSize: '12px', cursor: 'pointer' },
      primary: { border: '1px solid transparent', background: C.accent, color: '#08111f', borderRadius: '6px', padding: '6px 11px', fontSize: '12px', cursor: 'pointer', fontWeight: 700 },
      stat: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '6px 10px', minWidth: '74px' },
      statValue: { fontSize: '16px', fontWeight: 700, color: C.text, lineHeight: 1.25 },
      statLabel: { fontSize: '10px', color: C.faint, marginTop: '1px' },
      small: { color: C.faint, fontSize: '11px', lineHeight: 1.75 },
      line: { color: C.sub, fontSize: '12px', wordBreak: 'break-all', lineHeight: 1.7 },
    }

    async function call(path, init) {
      const response = await fetch(`${API}${path}`, {
        method: init?.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-va': '1' },
        cache: 'no-store',
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      })
      const data = await response.json().catch(() => null)
      if (!data || data.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
      return data
    }

    function Page() {
      const [live, setLive] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        try {
          setLive(await call('/state'))
          setError('')
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 5000)
        return () => clearInterval(timer)
      }, [refresh])

      const act = async (path, body, message) => {
        setBusy(true)
        try {
          await call(path, { method: 'POST', body: body || {} })
          setError(message || '')
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }

      try {
        return renderPage({ live, error, busy, act })
      } catch (caught) {
        return h('div', { style: { color: C.err, fontSize: '12px' } }, `录像档案面板出错了：${caught.message}`)
      }
    }

    function renderPage({ live, error, busy, act }) {
      const stats = live?.stats || {}
      const config = live?.config || {}

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        h('div', { style: { ...S.small, marginBottom: '10px' } }, '把游戏录像整理成能搜、能看的档案：自己挑文件加进来，填标题、游戏、摘要。'),
        error ? h('div', { style: { color: C.err, fontSize: '12px', marginBottom: '8px' } }, error) : null,
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: { ...S.row, marginBottom: '10px' } },
            h('div', { style: S.stat }, h('div', { style: S.statValue }, String(stats.videos || 0)), h('div', { style: S.statLabel }, '个视频')),
            h('div', { style: S.stat }, h('div', { style: S.statValue }, String(stats.missing || 0)), h('div', { style: S.statLabel }, '个文件不在')),
          ),
          h(
            'div',
            { style: { ...S.row, marginBottom: '8px' } },
            h('button', { style: S.primary, onClick: () => window.open('/video-archive/', '_blank', 'noopener') }, '打开录像档案'),
            live?.busy ? h('span', { style: { color: C.accent, fontSize: '12px' } }, '正在处理…') : null,
          ),
          h('div', { style: S.small }, `ffmpeg：${live?.ffmpeg?.ok ? '就绪' : '没找到'}`),
          h('div', { style: S.small }, '添加视频、填信息、归档都在「打开录像档案」里做，那边是完整界面。'),
        ),
      )
    }

    /** 侧栏图标：录像带 + 播放键 */
    function ArchiveGlyph({ size = 18 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2.6, y: 4.6, width: 18.8, height: 14.8, rx: 3.2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M10.2 9.4v5.2l4.4-2.6z', fill: 'currentColor' }),
        h('path', { d: 'M6.4 21.3h11.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    /** 侧栏点进来看到的主界面：直接把 /video-archive/ 嵌进来；嵌不动就退化成「新标签页打开」 */
    function ArchivePanel() {
      const frameRef = React.useRef(null)
      const [blocked, setBlocked] = useState(false)

      useEffect(() => {
        const timer = setTimeout(() => {
          try {
            const doc = frameRef.current?.contentDocument
            if (!doc || !doc.body || doc.body.childElementCount === 0) setBlocked(true)
          } catch (error) {
            setBlocked(true)
          }
        }, 1500)
        return () => clearTimeout(timer)
      }, [])

      if (blocked) {
        return h(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', background: '#0a0a0f' } },
          h(
            'div',
            { style: { textAlign: 'center', color: C.sub, fontSize: '13px', lineHeight: 1.9 } },
            h('div', { style: { color: C.text, fontSize: '15px', fontWeight: 700, marginBottom: '6px' } }, '录像档案'),
            h('div', null, '这个环境不让嵌页面，点下面在新标签页里打开。'),
            h(
              'button',
              {
                style: { ...S.primary, marginTop: '12px', padding: '8px 16px' },
                onClick: () => window.open('/video-archive/', '_blank', 'noopener'),
              },
              '打开录像档案',
            ),
          ),
        )
      }

      return h(
        'div',
        { style: { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', background: '#0a0a0f' } },
        h('iframe', {
          ref: frameRef,
          src: '/video-archive/',
          title: '录像档案',
          allow: 'fullscreen; autoplay; encrypted-media',
          style: { flex: 1, width: '100%', height: '100%', minHeight: 0, border: 0, display: 'block', background: '#0a0a0f' },
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const safe = (label, register) => {
          try {
            register()
          } catch (error) {
            console.warn(`[video-archive] ${label} 注册失败：${error?.message || error}`)
          }
        }

        // 左侧导航栏里的一项（和「插件市场」并排），点一下就是完整界面
        safe('sidebar.panellist', () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'video-archive', order: 12, label: () => '录像档案' },
              ArchiveGlyph,
            ),
          ),
        )

        // 这一项对应的主区域内容
        safe('main', () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'video-archive' }, ArchivePanel)))

        // 设置里也留一个入口（顺手能看状态、扫描）
        safe('settings.section', () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'video-archive', order: 62, label: () => '录像档案' }, Page),
          ),
        )
      },
    }
  },
})

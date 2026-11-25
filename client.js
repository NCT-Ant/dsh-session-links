window.__ModuleLoader__.load({
  id: 'dsh-session-links',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-session-links/'
    const POLL_MS = 4000

    // ---------------- store ----------------

    const store = {
      snapshot: { groups: [], sessions: [], votes: [], colors: {}, options: null, stats: null, cache: null, ready: false },
      listeners: new Set(),
      timer: null,
      picker: { open: false, sessionId: null, x: 0, y: 0 },
      panel: { open: false, sessionId: null, selected: [], name: '', busy: false, message: '', pos: null, announceText: '', editingGroupId: null },
      notify() {
        const value = store.snapshot
        for (const listener of Array.from(store.listeners)) listener(value)
      },
      setGroups(groups) {
        if (!Array.isArray(groups)) return
        store.snapshot = { ...store.snapshot, groups }
        store.notify()
      },
      setSessions(sessions) {
        if (!Array.isArray(sessions)) return
        store.snapshot = { ...store.snapshot, sessions }
        store.notify()
      },
      async refresh() {
        try {
          const [stateRes, sessionsRes] = await Promise.all([
            fetch(API + 'state', { cache: 'no-store' }),
            fetch(API + 'sessions', { cache: 'no-store' }),
          ])
          const stateValue = await stateRes.json().catch(() => ({}))
          const sessionsValue = await sessionsRes.json().catch(() => ({}))
          store.snapshot = {
            groups: Array.isArray(stateValue.groups) ? stateValue.groups : store.snapshot.groups,
            sessions: Array.isArray(sessionsValue.sessions) ? sessionsValue.sessions : store.snapshot.sessions,
            votes: Array.isArray(stateValue.votes) ? stateValue.votes : store.snapshot.votes,
            colors: stateValue.colors && typeof stateValue.colors === 'object' ? stateValue.colors : store.snapshot.colors,
            options: stateValue.options && typeof stateValue.options === 'object' ? stateValue.options : store.snapshot.options,
            stats: stateValue.stats && typeof stateValue.stats === 'object' ? stateValue.stats : store.snapshot.stats,
            cache: stateValue.cache && typeof stateValue.cache === 'object' ? stateValue.cache : store.snapshot.cache,
            ready: true,
          }
          store.notify()
        } catch {
          /* 忽略轮询失败 */
        }
      },
      start() {
        if (store.timer) return
        void store.refresh()
        store.timer = setInterval(() => void store.refresh(), POLL_MS)
      },
      stop() {
        if (!store.timer) return
        clearInterval(store.timer)
        store.timer = null
      },
      patchPanel(patch) {
        store.panel = { ...store.panel, ...patch }
        store.notify()
        panelListeners.forEach((listener) => listener(store.panel))
      },
      setPicker(patch) {
        store.picker = { ...store.picker, ...patch }
        store.snapshot = { ...store.snapshot }
        store.notify()
      },
    }

    const COLOR_PRESETS = [
      { name: '蓝', value: '#EAF2FF' },
      { name: '青', value: '#E6F5F7' },
      { name: '绿', value: '#EAF7EE' },
      { name: '橄榄', value: '#EFF4E3' },
      { name: '米', value: '#F7F2E6' },
      { name: '杏', value: '#FDEEDF' },
      { name: '粉', value: '#FCEAEE' },
      { name: '紫', value: '#F1ECFB' },
      { name: '灰', value: '#EFEFEE' },
      { name: '雾蓝', value: '#E8EDF5' },
      { name: '薄荷', value: '#E4F4EC' },
      { name: '沙', value: '#F4ECE3' },
    ]

    function buildColorCss(colors) {
      if (!colors || typeof colors !== 'object') return ''
      return Object.keys(colors)
        .filter((sessionId) => typeof colors[sessionId] === 'string')
        .map(
          (sessionId) =>
            'div[data-row-key="session:' + sessionId + '"]{background-color:' + colors[sessionId] + ' !important;}',
        )
        .join('\n')
    }

    // 把每个会话的底色写进一张全局样式表；用 data-row-key 定位，避免依赖构建期哈希类名。
    function installColorStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      let element = document.getElementById('dsh-session-links-colors')
      if (!element) {
        element = document.createElement('style')
        element.id = 'dsh-session-links-colors'
        document.head.appendChild(element)
      }
      let last = null
      const update = (snap) => {
        const css = buildColorCss(snap && snap.colors)
        if (css === last) return
        last = css
        element.textContent = css
      }
      update(store.snapshot)
      store.listeners.add(update)
      return () => {
        store.listeners.delete(update)
        try {
          element.remove()
        } catch {
          /* ignore */
        }
      }
    }

    const panelListeners = new Set()

    function useSnapshot() {
      const [snap, setSnap] = React.useState(store.snapshot)
      React.useEffect(() => {
        store.listeners.add(setSnap)
        setSnap(store.snapshot)
        return () => store.listeners.delete(setSnap)
      }, [])
      return snap
    }

    function usePanel() {
      const [panel, setPanel] = React.useState(store.panel)
      React.useEffect(() => {
        panelListeners.add(setPanel)
        setPanel(store.panel)
        return () => panelListeners.delete(setPanel)
      }, [])
      return panel
    }

    function usePicker() {
      useSnapshot()
      return store.picker
    }

    function groupOf(snap, sessionId) {
      if (!sessionId) return null
      return snap.groups.find((group) => Array.isArray(group.sessions) && group.sessions.includes(sessionId)) || null
    }

    function sessionTitle(snap, sessionId) {
      const found = snap.sessions.find((item) => item.sessionId === sessionId)
      if (found && found.title) return found.title
      return '会话 ' + String(sessionId).slice(0, 8)
    }

    function voteSummary(snap, vote) {
      if (!vote) return ''
      if (vote.mode === 'order' && Array.isArray(vote.order) && vote.order.length > 0) {
        return '顺序：' + vote.order.map((id) => sessionTitle(snap, id)).join(' → ')
      }
      if (vote.winner) return '执行者：' + sessionTitle(snap, vote.winner)
      return vote.error || '未形成结论'
    }

    async function post(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const value = await res.json().catch(() => ({}))
      if (Array.isArray(value.groups)) store.setGroups(value.groups)
      void store.refresh()
      return value
    }

    // ---------------- 图标 ----------------

    function ChainIcon(props) {
      const size = props && props.size ? props.size : 14
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5' }),
        h('path', { d: 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5' }),
      )
    }

    // ---------------- 侧边栏行内标记 ----------------

    function SessionLinkBadge(props) {
      const snap = useSnapshot()
      const group = groupOf(snap, props && props.sessionId)
      if (!group) return null
      return h(
        'span',
        {
          title: '已连接到「' + group.name + '」（' + group.sessions.length + ' 个会话）',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            color: 'var(--dsw-alias-brand-primary)',
          },
        },
        h(ChainIcon, { size: 14 }),
      )
    }

    // ---------------- 会话标题旁按钮 ----------------

    function HeaderLinkAction(props) {
      const snap = useSnapshot()
      const sessionId = props && props.sessionId
      const group = groupOf(snap, sessionId)

      function onClick() {
        store.patchPanel({
          open: true,
          sessionId: sessionId || null,
          selected: group ? group.sessions.slice() : sessionId ? [sessionId] : [],
          name: group ? group.name : '',
          message: '',
        })
      }

      return h(
        'button',
        {
          type: 'button',
          title: group ? '已连接到「' + group.name + '」' : '连接到其他会话',
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: group ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: group ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '1',
            cursor: 'pointer',
          },
        },
        h(ChainIcon, { size: 13 }),
        h(
          'span',
          null,
          group
            ? '已连接 · ' +
              (group.name.length > 8 ? group.name.slice(0, 8) + '…' : group.name) +
              (group.leader === props.sessionId ? ' · 组长' : '')
            : '连接会话',
        ),
      )
    }

    // ---------------- 面板 ----------------

    const styles = {
      mask: {
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 900,
        pointerEvents: 'none',
      },
      card: {
        position: 'fixed',
        right: 24,
        bottom: 24,
        width: 340,
        maxHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      body: {
        overflowY: 'auto',
        overflowX: 'hidden',
        flex: 1,
        minHeight: 0,
        padding: '0 14px 14px 14px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 14px 8px 14px',
        flexShrink: 0,
        background: 'var(--dsw-alias-bg-layer-1)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      search: {
        width: '100%',
        height: 28,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '0 8px',
        fontSize: 12,
        boxSizing: 'border-box',
        marginBottom: 8,
      },
      groupRow: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '7px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        marginBottom: 6,
        cursor: 'pointer',
      },
      title: { fontSize: 14, fontWeight: 600 },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        marginBottom: 6,
        cursor: 'pointer',
      },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      message: { fontSize: 12, fontWeight: 600, marginTop: 8, marginBottom: 4 },
      input: {
        width: '100%',
        height: 30,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        padding: '0 8px',
        fontSize: 13,
        boxSizing: 'border-box',
        marginBottom: 10,
      },
      primary: {
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      ghost: {
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        cursor: 'pointer',
      },
      danger: {
        height: 26,
        padding: '0 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12,
        cursor: 'pointer',
      },
      close: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 18,
        lineHeight: '1',
        cursor: 'pointer',
        padding: '0 4px',
      },
      section: { marginTop: 12, marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
    }

    function Panel() {
      const snap = useSnapshot()
      const panel = usePanel()
      const dragRef = React.useRef(null)
      const options = snap.options || { compact: true, maxChars: 1200, dedupeMs: 8000, quiet: true }
      const stats = snap.stats || null
      const cache = snap.cache || null
      const [maxCharsText, setMaxCharsText] = React.useState(String(options.maxChars))
      const [query, setQuery] = React.useState('')
      React.useEffect(() => {
        setMaxCharsText(String(options.maxChars))
      }, [options.maxChars])
      if (!panel.open) return null

      async function saveOptions(patch) {
        try {
          await post('options', patch)
        } catch {
          store.patchPanel({ message: '保存上下文节能设置失败' })
          return
        }
        await store.refresh()
      }

      function commitMaxChars() {
        const value = Number(maxCharsText)
        if (!Number.isFinite(value) || value < 200 || value > 8000) {
          setMaxCharsText(String(options.maxChars))
          store.patchPanel({ message: '单条上限需在 200–8000 字之间' })
          return
        }
        if (Math.round(value) === options.maxChars) return
        void saveOptions({ maxChars: Math.round(value) })
      }

      async function cleanupCache() {
        let result
        try {
          result = await post('gc', {})
        } catch {
          store.patchPanel({ message: '清理缓存失败' })
          return
        }
        const total = result && typeof result.total === 'number' ? result.total : 0
        store.patchPanel({
          message: total > 0
            ? '已清理 ' + total + ' 项缓存（消息 ' + result.freed.recent + ' · 投票 ' + result.freed.votes +
              ' · 去重 ' + result.freed.dedupe + ' · 待重投 ' + result.freed.pending + '）'
            : '没有需要清理的缓存',
        })
        await store.refresh()
      }

      const editing = panel.editingGroupId
        ? snap.groups.find((group) => group.id === panel.editingGroupId) || null
        : null
      const keyword = query.trim().toLowerCase()
      const candidates = snap.sessions.filter((item) => {
        if (item.blank && !item.running) return false
        if (!keyword) return true
        const title = sessionTitle(snap, item.sessionId) || ''
        return title.toLowerCase().includes(keyword) || item.sessionId.toLowerCase().includes(keyword)
      })
      const selected = panel.selected || []

      function startDrag(event) {
        if (event.button !== 0) return
        const host = event.currentTarget.parentElement
        if (!host) return
        const rect = host.getBoundingClientRect()
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
        const width = rect.width
        const height = rect.height
        event.preventDefault()
        const move = (moveEvent) => {
          if (!dragRef.current) return
          const maxX = Math.max(0, window.innerWidth - Math.min(width, 120))
          const maxY = Math.max(0, window.innerHeight - Math.min(height, 60))
          const x = Math.min(Math.max(0, moveEvent.clientX - dragRef.current.dx), maxX)
          const y = Math.min(Math.max(0, moveEvent.clientY - dragRef.current.dy), maxY)
          store.patchPanel({ pos: { x, y } })
        }
        const stop = () => {
          dragRef.current = null
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', stop)
          document.body.style.userSelect = ''
        }
        document.body.style.userSelect = 'none'
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', stop)
      }

      const cardStyle = panel.pos
        ? {
            ...styles.card,
            left: panel.pos.x,
            top: panel.pos.y,
            right: 'auto',
            bottom: 'auto',
            maxHeight: 'min(70vh, ' + Math.max(240, window.innerHeight - panel.pos.y - 24) + 'px)',
          }
        : styles.card

      function toggle(sessionId) {
        const checked = selected.includes(sessionId)
        const next = checked ? selected.filter((id) => id !== sessionId) : selected.concat(sessionId)
        let message = ''
        if (!checked) {
          const owner = groupOf(snap, sessionId)
          if (owner && owner.id !== (editing && editing.id)) {
            message = '「' + sessionTitle(snap, sessionId) + '」会从「' + owner.name + '」移出（保存后生效）'
          }
        }
        store.patchPanel({ selected: next, message })
      }

      async function connect() {
        if (selected.length < 2) {
          store.patchPanel({ message: '至少选择两个会话' })
          return
        }
        store.patchPanel({ busy: true, message: '' })
        const payload = { sessionIds: selected, name: panel.name }
        if (panel.editingGroupId) payload.groupId = panel.editingGroupId
        const value = await post('connect', payload)
        const removed = value && Array.isArray(value.removedFrom) ? value.removedFrom : []
        const groupId = value && value.group && value.group.id ? value.group.id : panel.editingGroupId || null
        store.patchPanel({
          busy: false,
          editingGroupId: value && value.ok ? groupId : panel.editingGroupId || null,
          message: value && value.ok
            ? (panel.editingGroupId ? '已保存该组的成员' : '已新建连接组') +
              (removed.length ? '；已从「' + removed.join('」「') + '」移出' : '')
            : (value && value.error) || '连接失败',
        })
        void store.refresh()
      }

      async function disconnect() {
        if (!panel.sessionId) return
        store.patchPanel({ busy: true, message: '' })
        await post('disconnect', { sessionId: panel.sessionId })
        store.patchPanel({ busy: false, selected: [], message: '已断开当前会话' })
        void store.refresh()
      }

      async function dissolve(groupId) {
        store.patchPanel({ busy: true })
        let result = null
        try {
          result = await post('dissolve', { groupId })
        } catch {
          store.patchPanel({ busy: false, message: '解散失败，请稍后再试' })
          return
        }
        if (result && result.ok === false) {
          store.patchPanel({ busy: false, message: result.error || '解散失败' })
          return
        }
        const freed = result && result.freed ? result.freed : null
        const total = freed ? freed.recent + freed.votes + freed.dedupe + freed.pending : 0
        const patch = {
          busy: false,
          message: total > 0 ? '已解散连接组，顺手清理了 ' + total + ' 项冗余缓存' : '已解散连接组',
        }
        if (panel.editingGroupId === groupId) {
          patch.editingGroupId = null
          patch.selected = []
          patch.name = ''
        }
        store.patchPanel(patch)
        void store.refresh()
      }

      async function setLeader(groupId, leaderSessionId) {
        await post('leader', { groupId, leaderSessionId })
        store.patchPanel({ message: leaderSessionId ? '已任命组长' : '已撤销组长' })
        void store.refresh()
      }

      async function announce() {
        const text = (panel.announceText || '').trim()
        if (!selected.length) {
          store.patchPanel({ message: '先勾选要通报的会话' })
          return
        }
        if (!text) {
          store.patchPanel({ message: '请输入要通报的内容' })
          return
        }
        store.patchPanel({ busy: true, message: '' })
        const value = await post('announce', {
          sessionIds: selected,
          text,
          sessionId: panel.sessionId || '',
        })
        const count = value && Array.isArray(value.delivered) ? value.delivered.length : 0
        store.patchPanel({
          busy: false,
          announceText: value && value.ok ? '' : panel.announceText,
          message: value && value.ok ? '已通报给 ' + count + ' 个会话（对方只需知道，不必回复）' : (value && value.error) || '通报失败',
        })
      }

      const rows = candidates.map((item) => {
        const group = groupOf(snap, item.sessionId)
        const checked = selected.includes(item.sessionId)
        return h(
          'label',
          {
            key: item.sessionId,
            style: {
              ...styles.row,
              borderColor: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
            },
          },
          h('input', { type: 'checkbox', checked, onChange: () => toggle(item.sessionId) }),
          h(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionTitle(snap, item.sessionId)),
            h(
              'span',
              { style: styles.sub },
              item.running ? '运行中' : '空闲',
              group ? ' · 已在「' + group.name + '」' : '',
              group && group.leader === item.sessionId ? ' · ★组长' : '',
            ),
          ),
          group && (!panel.editingGroupId || panel.editingGroupId === group.id)
            ? h(
                'button',
                {
                  type: 'button',
                  title: group.leader === item.sessionId ? '撤销这个会话的组长身份' : '把这个会话任命为组长',
                  style: { ...styles.ghost, height: 24, padding: '0 8px', flexShrink: 0 },
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void setLeader(group.id, group.leader === item.sessionId ? '' : item.sessionId)
                  },
                },
                group.leader === item.sessionId ? '撤销组长' : '设为组长',
              )
            : null,
        )
      })

      const groups = snap.groups.map((group) => {
        const active = !!(editing && editing.id === group.id)
        return h(
          'div',
          {
            key: group.id,
            style: {
              ...styles.groupRow,
              borderColor: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
            },
            title: '点击编辑这一组的成员',
            onClick: () =>
              store.patchPanel({
                editingGroupId: group.id,
                selected: group.sessions.slice(),
                name: group.name,
                message: '正在编辑「' + group.name + '」',
              }),
          },
          h(ChainIcon, { size: 13 }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
            h('span', { style: { fontWeight: 600 } }, group.name + (active ? ' · 编辑中' : '')),
            h('span', { style: styles.sub }, group.sessions.map((id) => sessionTitle(snap, id)).join('、')),
            h('span', { style: styles.sub }, group.leader ? '组长：' + sessionTitle(snap, group.leader) : '尚未任命组长'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: { ...styles.danger, flexShrink: 0 },
              onClick: (event) => {
                event.stopPropagation()
                void dissolve(group.id)
              },
            },
            '解散',
          ),
        )
      })

      const latestVote = Array.isArray(snap.votes) && snap.votes.length ? snap.votes[snap.votes.length - 1] : null

      return h(
        'div',
        { style: styles.mask },
        h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: { ...styles.head, cursor: 'grab', userSelect: 'none' }, onMouseDown: startDrag, title: '按住拖动面板' },
            h('span', { style: styles.title }, '连接会话'),
            h('button', { type: 'button', style: styles.close, title: '关闭', onClick: () => store.patchPanel({ open: false }) }, '×'),
          ),
          h(
            'div',
            { style: styles.body },
            h(
              'div',
              { style: { ...styles.sub, marginTop: 10 } },
              panel.sessionId ? '当前会话：' + sessionTitle(snap, panel.sessionId) : '选择要连接到一起的会话',
            ),
            panel.message ? h('div', { style: styles.message }, panel.message) : null,
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 11 } },
              h('div', { style: { ...styles.section, marginTop: 0 } }, '现有连接组（' + snap.groups.length + '）'),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.ghost, height: 22, padding: '0 8px' },
                  onClick: () => store.patchPanel({ editingGroupId: null, selected: [], name: '', message: '新建连接组：勾选会话后点下面的按钮' }),
                },
                '新建',
              ),
            ),
            groups.length ? groups : h('div', { style: styles.sub }, '还没有连接组'),
            h('div', { style: { ...styles.section, marginTop: 10 } }, editing ? '编辑「' + editing.name + '」' : '连接组名称'),
            h('input', {
              style: styles.input,
              value: panel.name,
              placeholder: '可选，例如「前端重构」',
              onChange: (event) => store.patchPanel({ name: event.target.value }),
            }),
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginBottom: 6 } },
              h(
                'button',
                { type: 'button', style: styles.primary, disabled: panel.busy, onClick: () => void connect() },
                panel.busy ? '处理中…' : editing ? '保存该组成员' : '新建连接组',
              ),
              panel.sessionId
                ? h('button', { type: 'button', style: styles.ghost, disabled: panel.busy, onClick: () => void disconnect() }, '断开当前会话')
                : null,
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('div', { style: styles.section }, '选择会话（' + selected.length + ' 个已选）'),
              selected.length
                ? h(
                    'button',
                    { type: 'button', style: { ...styles.ghost, height: 22, padding: '0 8px' }, onClick: () => store.patchPanel({ selected: [] }) },
                    '清空',
                  )
                : null,
            ),
            h('input', {
              style: styles.search,
              value: query,
              placeholder: '搜索会话名称或 id',
              onChange: (event) => setQuery(event.target.value),
            }),
            rows.length ? rows : h('div', { style: styles.sub }, keyword ? '没有匹配的会话' : '没有可选会话'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 } },
            h('div', { style: styles.section }, '会话通报（不需要对方回复）'),
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.ghost, height: 22, padding: '0 8px' },
                onClick: () => store.patchPanel({ selected: snap.sessions.map((item) => item.sessionId) }),
              },
              '全选会话',
            ),
          ),
          h('textarea', {
            style: {
              width: '100%',
              minHeight: 56,
              resize: 'vertical',
              boxSizing: 'border-box',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-base)',
              color: 'var(--dsw-alias-label-primary)',
              padding: '6px 8px',
              fontFamily: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
            },
            value: panel.announceText || '',
            placeholder: '例如：我新装了 xxx 插件，之后大家都可以用了',
            onChange: (event) => store.patchPanel({ announceText: event.target.value }),
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 6 } },
            h(
              'button',
              { type: 'button', style: styles.primary, disabled: panel.busy, onClick: () => void announce() },
              '通报给所选会话',
            ),
          ),
          h(
            'div',
            { style: { ...styles.sub, margin: '4px 0 2px', lineHeight: 1.6 } },
            '通报与普通广播的区别：收件会话只需要知道这件事，不必给出回复或动手执行。',
          ),
          h(
            'div',
            {
              style: {
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
                padding: '8px 10px',
                margin: '12px 0 4px',
              },
            },
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, '上下文节能'),
              h(
                'span',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                options.compact ? '紧凑模式' : '全文模式',
              ),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: !!options.compact,
                onChange: (event) => void saveOptions({ compact: event.target.checked }),
              }),
              '紧凑转写（短前缀〔来源〕，省 token）',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 6 } },
              h('span', { style: { flexShrink: 0 } }, '单条上限'),
              h('input', {
                type: 'number',
                min: 200,
                max: 8000,
                step: 100,
                value: maxCharsText,
                onChange: (event) => setMaxCharsText(event.target.value),
                onBlur: commitMaxChars,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') commitMaxChars()
                },
                style: {
                  width: 74,
                  boxSizing: 'border-box',
                  borderRadius: 4,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                  padding: '2px 6px',
                  fontFamily: 'inherit',
                  fontSize: 12,
                },
              }),
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '字，超出提示用 read 取全文'),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 4, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: !!options.dedupeMs,
                onChange: (event) => void saveOptions({ dedupeMs: event.target.checked ? 8000 : 0 }),
              }),
              '跳过重复（8 秒内相同内容只转一次）',
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, marginBottom: 4, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: options.quiet !== false,
                onChange: (event) => void saveOptions({ quiet: event.target.checked }),
                style: { marginTop: 2 },
              }),
              h(
                'span',
                null,
                '静默执行（组内消息不必回复正文，结果只报组长）',
                h(
                  'span',
                  { style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  '只有失败/严重错误、或用户在当前会话插话时才输出文字',
                ),
              ),
            ),
            stats
              ? h(
                  'div',
                  { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } },
                  '已转发 ' + stats.relays + ' 条 · 投递 ' + stats.chars + ' 字（原文 ' + stats.rawChars +
                    ' 字，省下 ' + stats.savedPercent + '%）· 跳过重复 ' + stats.skipped + ' 条',
                )
              : null,
            cache
              ? h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginTop: 6,
                      fontSize: 11,
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  h(
                    'span',
                    null,
                    '运行时缓存：消息 ' + cache.recentEntries + ' 条 · 投票 ' + cache.votes +
                      ' 条 · 待重投 ' + cache.pendingItems + ' 项',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      title: '清理已解散组留下的缓存（解散/移出时也会自动清理）',
                      style: {
                        border: '1px solid var(--dsw-alias-border-l1)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-primary)',
                        borderRadius: 6,
                        fontSize: 11,
                        padding: '2px 8px',
                        cursor: 'pointer',
                      },
                      onClick: () => void cleanupCache(),
                    },
                    '清理缓存',
                  ),
                )
              : null,
          ),
          latestVote
            ? h(
                'div',
                {
                  style: {
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    margin: '10px 0 2px',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
                  h(
                    'span',
                    { style: { fontSize: 12, fontWeight: 600 } },
                    latestVote.mode === 'order' ? '组内投票 · 排执行顺序' : '组内投票 · 选执行者',
                  ),
                  h(
                    'span',
                    { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                    latestVote.phase === 'done' ? '已完成' : latestVote.phase === 'failed' ? '未形成结论' : '进行中',
                  ),
                ),
                h(
                  'div',
                  { style: { fontSize: 12, marginBottom: 3, lineHeight: 1.5 } },
                  '任务：' +
                    (latestVote.task && latestVote.task.length > 40
                      ? latestVote.task.slice(0, 40) + '…'
                      : latestVote.task || ''),
                ),
                h('div', { style: { fontSize: 12, fontWeight: 600, lineHeight: 1.5 } }, voteSummary(snap, latestVote)),
              )
            : h(
                'div',
                { style: { ...styles.sub, marginTop: 6, lineHeight: 1.6 } },
                '会话自决策：在会话里交办任务时，组内会自动发起投票（选执行者 / 排执行顺序），这里显示最近一次结果。',
              ),
            h(
              'div',
              { style: { ...styles.sub, marginTop: 8, lineHeight: 1.6 } },
              '连接后，你发送的每条消息会同时送达组内所有会话；各会话共享同一工作目录，产物可互相查看与修改。',
            ),
            h(
              'div',
              { style: { ...styles.sub, marginTop: 6, lineHeight: 1.6 } },
              '可以同时存在多个连接组；同一个会话只属于一个组 —— 把会话勾进这一组就会从原来的组移出（不足两人自动散伙）。点上面的组可以编辑它的成员。',
            ),
          ),
        ),
      )
    }

    function SwatchIcon(props) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: 3,
          background: (props && props.color) || 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
          flexShrink: 0,
        },
      })
    }

    // 会话右键菜单里的「会话颜色」入口，和「分岔会话」同一个菜单
    function SessionColorMenuItem(props) {
      const sessionId = props && props.sessionId
      const title = (props && props.displayTitle) || '该会话'
      if (!sessionId) return null
      function open(event) {
        event.preventDefault()
        event.stopPropagation()
        store.setPicker({ open: true, sessionId })
        try {
          const hooks = props.hooks
          const menuState = hooks && hooks.menuOpenState
          if (menuState) {
            if (typeof menuState.close === 'function') menuState.close()
            else if (typeof menuState.setOpen === 'function') menuState.setOpen(false)
          }
        } catch {
          /* 菜单关闭失败不影响取色 */
        }
      }
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
            borderRadius: 6,
            fontFamily: 'inherit',
          },
          title: '给「' + title + '」选一个底色',
          onClick: open,
        },
        h(SwatchIcon, { color: store.snapshot.colors && store.snapshot.colors[sessionId] }),
        '会话颜色',
      )
    }

    function ColorPicker() {
      const snap = useSnapshot()
      const picker = usePicker()
      if (!picker || !picker.open || !picker.sessionId) return null
      const current = snap.colors && snap.colors[picker.sessionId]

      async function choose(color) {
        store.setPicker({ open: false })
        await post('color', { sessionId: picker.sessionId, color: color || '' })
        void store.refresh()
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            left: '50%',
            top: '26%',
            transform: 'translateX(-50%)',
            zIndex: 1200,
            width: 292,
            padding: '14px 16px 16px',
            borderRadius: 12,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-1)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.16)',
            pointerEvents: 'auto',
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '会话颜色'),
            h(
              'div',
              {
                style: {
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              sessionTitle(snap, picker.sessionId),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: {
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 16,
                cursor: 'pointer',
                lineHeight: 1,
                padding: 2,
              },
              onClick: () => store.setPicker({ open: false }),
            },
            '×',
          ),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 } },
          COLOR_PRESETS.map((preset) =>
            h('button', {
              key: preset.value,
              type: 'button',
              title: preset.name,
              style: {
                height: 30,
                borderRadius: 8,
                background: preset.value,
                cursor: 'pointer',
                border:
                  current === preset.value
                    ? '2px solid var(--dsw-alias-brand-primary)'
                    : '1px solid var(--dsw-alias-border-l1)',
              },
              onClick: () => void choose(preset.value),
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 12 } },
          h(
            'button',
            {
              type: 'button',
              style: {
                height: 28,
                padding: '0 12px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
              onClick: () => void choose(''),
            },
            '清除颜色',
          ),
        ),
      )
    }

    // ---------------- 注册 ----------------

    // 会话级 Slot（conversation.session.*）只有在打开会话后才会被声明，
    // 启动瞬间注册会抛错，Cordis 会把整个插件标记为 failed 并阻塞 Web 启动。
    // 因此逐个注册、失败后按退避重试，任何一次失败都不再向上抛。
    const SLOT_REGISTRATIONS = [
      [
        { name: 'sidebar.session.row.trailing', id: 'session-links-badge', order: 50, label: '连接标记' },
        SessionLinkBadge,
      ],
      [
        { name: 'conversation.session.header.actions', id: 'session-links-action', order: 30, label: '连接会话' },
        HeaderLinkAction,
      ],
      [{ name: 'shell.overlay', id: 'session-links-panel', order: 900 }, Panel],
      [
        { name: 'sidebar.workspaces.session.menu.item', id: 'session-links-color', order: 20, label: '会话颜色' },
        SessionColorMenuItem,
      ],
      [{ name: 'shell.overlay', id: 'session-links-picker', order: 1100 }, ColorPicker],
    ]

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          store.start()
          return () => store.stop()
        })

        ctx.effect(() => installColorStyles())

        const disposers = []
        const registered = new Set()
        const warned = new Set()
        let timer = null
        let attempts = 0
        let disposed = false

        const tryRegister = () => {
          timer = null
          attempts += 1
          for (const [options, component] of SLOT_REGISTRATIONS) {
            if (registered.has(options.id)) continue
            try {
              disposers.push(ctx.slots.register(options, component))
              registered.add(options.id)
            } catch (error) {
              if (!warned.has(options.id)) {
                warned.add(options.id)
                try {
                  console.warn('[session-links] Slot 暂不可用，稍后重试：' + options.name, error && error.message)
                } catch {
                  /* ignore */
                }
              }
            }
          }
          if (!disposed && registered.size < SLOT_REGISTRATIONS.length && attempts < 120) {
            timer = setTimeout(tryRegister, 1000)
          }
        }
        tryRegister()

        ctx.effect(() => () => {
          disposed = true
          if (timer !== null) {
            clearTimeout(timer)
            timer = null
          }
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignore */
            }
          }
        })
      },
    }
  },
})

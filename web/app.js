const API = '/video-archive/api'
const $ = (selector) => document.querySelector(selector)

const state = {
  videos: [],
  stats: {},
  live: null,
  selected: '',
  dirty: false,
  polling: false,
  pollTimer: null,
  lastFilled: -1,
  tab: 'library',
  games: [],
  categories: [],
  gameQuery: '',
  gameCategory: '',
  editingGame: '',
  browse: { game: '', year: '', month: '', day: '' },
  browseQuery: '',
  deps: null,
  deleting: '',
}

/* ------------------------------------------------------------------ 工具 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function clock(seconds) {
  // 跟播放器一致用「向下取整」，避免 3.7 秒显示成 0:04、播放器却是 0:03
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function bytes(size) {
  const num = Number(size) || 0
  if (num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = num
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

function dateText(ms) {
  if (!ms) return '时间未知'
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fullDate(ms) {
  if (!ms) return '时间未知'
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

let toastTimer = null
function toast(message, kind = '') {
  const box = $('#toast')
  box.textContent = message
  box.className = `toast ${kind}`
  box.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    box.hidden = true
  }, 3200)
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-va': '1' },
    cache: 'no-store',
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  let response
  try {
    response = await fetch(`${API}${path}`, init)
  } catch (error) {
    throw new Error('连不上插件：确认 DSH 开着，插件已加载')
  }
  const data = await response.json().catch(() => null)
  if (!data || typeof data !== 'object') throw new Error(`接口 ${path} 没返回 JSON（HTTP ${response.status}）`)
  if (!response.ok || data.ok === false) throw new Error(String(data.error || `HTTP ${response.status}`))
  return data
}

/* ------------------------------------------------------------------ 加载 */
async function load({ silent = false } = {}) {
  try {
    const [videos, live] = await Promise.all([api('/videos'), api('/state')])
    state.videos = videos.videos || []
    state.stats = videos.stats || live.stats || {}
    state.live = live
    try {
      const view = await api('/games')
      state.games = view.games || []
      state.categories = view.categories || []
    } catch {
      state.games = state.games || []
      state.categories = state.categories || []
    }
    render()
    renderJobs()
    renderSettings()
    if (state.selected) refreshDetail(state.selected, { silent: true })
  } catch (error) {
    if (!silent) toast(error.message, 'err')
    $('#subtitle').textContent = error.message
  }
}

/* ------------------------------------------------------------------ 删除 */
function openDeleteModal(id) {
  const item = state.videos.find((entry) => entry.id === id)
  if (!item) return
  state.deleting = id
  $('#delName').textContent = `${item.title || item.name}${item.game ? ` · ${item.game}` : ''}`
  $('#deleteModal').hidden = false
}

function closeDeleteModal() {
  $('#deleteModal').hidden = true
  state.deleting = ''
}

async function removeVideo(withFile) {
  const id = state.deleting
  if (!id) return
  const recordButton = $('#delRecordOnly')
  const fileButton = $('#delWithFile')
  recordButton.disabled = true
  fileButton.disabled = true
  try {
    const result = await api('/remove', { method: 'POST', body: { id, withFile } })
    toast(withFile ? (result.recycled ? '已删除，文件在回收站里' : '已删除') : '已从档案移除，文件还在')
    closeDeleteModal()
    if (state.selected === id) closeDetail()
    await load({ silent: true })
  } catch (error) {
    toast(error.message, 'err')
  } finally {
    recordButton.disabled = false
    fileButton.disabled = false
  }
}

/* ------------------------------------------------------------------ 渲染 */
function render() {
  const tab = state.tab
  $('#grid').hidden = tab !== 'library'
  $('#browseView').hidden = tab !== 'browse'
  $('#gamesView').hidden = tab !== 'games'
  $('#settingsView').hidden = tab !== 'settings'
  if (tab === 'library') {
    renderGrid()
  } else if (tab === 'browse') {
    $('#empty').hidden = true
    renderBrowse()
  } else if (tab === 'games') {
    $('#empty').hidden = true
    renderGames()
  } else {
    $('#empty').hidden = true
    renderSettings()
  }
  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === state.tab)
  })
  const stats = state.stats || {}
  const parts = [`${stats.videos || 0} 个视频`]
  if (stats.totalSeconds) {
    const seconds = Number(stats.totalSeconds) || 0
    parts.push(seconds >= 3600 ? `共 ${(seconds / 3600).toFixed(1)} 小时` : `共 ${Math.max(1, Math.round(seconds / 60))} 分钟`)
  }
  if (stats.totalBytes) parts.push(bytes(stats.totalBytes))
  $('#subtitle').textContent = parts.join(' · ')

  // 设了扫描文件夹才显示「再扫一遍」
  const rescan = $('#btnRescan')
  if (rescan) rescan.hidden = !state.live?.config?.scanFolder
}

function renderJobs() {
  const live = state.live
  const box = $('#jobs')
  const busy = !!(live && live.busy)
  if (!busy) {
    box.hidden = true
    return
  }
  box.hidden = false
  const progress = live.progress || { total: 0, done: 0 }
  const total = Math.max(progress.total || 0, 1)
  const done = Math.min(progress.done || 0, total)
  $('#jobsFill').style.width = `${Math.round((done / total) * 100)}%`
  const label = live.current ? `处理：${live.current.name}（${done}/${total}）` : `排队中…（${done}/${total}）`
  $('#jobsLabel').textContent = label
}

/** 算「处理过」：填过标题/游戏/摘要，或者已经归档挪走了 */
function isProcessed(item) {
  return Boolean(item.filled || item.movedAt)
}

function filtered(source = state.videos) {
  const list = [...source]
  list.sort((a, b) => (b.meta?.createdAt || b.mtimeMs || 0) - (a.meta?.createdAt || a.mtimeMs || 0))
  return list
}

function cardHtml(item) {
  const badge = item.state === 'missing'
    ? '<span class="badge error">文件不在了</span>'
    : item.state === 'raw'
      ? '<span class="badge pending">缺 ffmpeg</span>'
      : item.state === 'recording'
        ? '<span class="badge pending">录制中</span>'
        : item.state === 'analyzing' || item.state === 'queued'
          ? '<span class="badge pending">入库中</span>'
          : ''

  const cover = item.cover
    ? `<img loading="lazy" src="${esc(item.cover)}" alt="" />`
    : '<div class="placeholder">还没有封面</div>'
  const tags = (item.tags || []).slice(0, 4).map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')
  const summary = item.summary
    ? `<p class="summary">${esc(item.summary)}</p>`
    : '<p class="summary placeholder-text">还没写摘要，点开补两句</p>'
  return `<article class="card" data-id="${item.id}">
    <div class="cover">
      ${cover}
      ${badge}
      <span class="duration">${item.meta?.duration ? clock(item.meta.duration) : '—'}</span>
      <div class="play-hint"><span>▶</span></div>
    </div>
    <div class="card-body">
      <h3>${esc(item.title)}</h3>
      <div class="meta-line">
        ${item.game ? `<span class="game-pill">${esc(item.game)}</span>` : ''}
        <span>${dateText(item.meta?.createdAt || item.mtimeMs)}</span>
        <span>·</span>
        <span>${item.sizeText || bytes(item.size)}</span>
        ${item.state === 'missing' ? '<span>·</span><span style="color:var(--err)">文件不在了</span>' : ''}
      </div>
      ${summary}
      <div class="tags">${tags}</div>
    </div>
  </article>`
}

function renderGrid() {
  const grid = $('#grid')
  const empty = $('#empty')

  if (!state.videos.length) {
    grid.innerHTML = ''
    empty.hidden = false
    const hasFolder = Boolean(state.live?.config?.scanFolder)
    empty.innerHTML = `<h2>还没有视频</h2>
      <p>${
        hasFolder
          ? '把录像放进设置里那个文件夹，然后重新打开这个页面就会自动收进来。'
          : '先去「设置」里填一个录像文件夹，之后打开这个页面就会把里面的视频自动收进来。'
      }</p>
      <div class="row"><button class="btn primary" id="emptySettings">${hasFolder ? '去设置看看' : '去设置填文件夹'}</button></div>`
    document.querySelector('#emptySettings').onclick = () => {
      state.tab = 'settings'
      render()
    }
    return
  }

  const pending = state.videos.filter((item) => !isProcessed(item))
  if (!pending.length) {
    grid.innerHTML = ''
    empty.hidden = false
    empty.innerHTML = `<h2>没有待处理的录像了</h2>
      <p>填过信息的都收在「游戏录像」里，按游戏、年月日翻。</p>
      <div class="row"><button class="btn primary" id="emptyBrowse">去游戏录像</button></div>`
    document.querySelector('#emptyBrowse').onclick = () => {
      state.tab = 'browse'
      render()
    }
    return
  }

  const list = filtered(pending)
  if (!list.length) {
    grid.innerHTML = ''
    empty.hidden = false
    empty.innerHTML = `<h2>没有匹配的录像</h2><p>换个关键词试试。</p>`
    return
  }

  empty.hidden = true
  grid.innerHTML = list.map(cardHtml).join('')
  grid.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDetail(card.dataset.id)
  })
}

/* ------------------------------------------------------------------ 游戏录像（按 游戏 → 年 → 月 → 日 逛） */
function dayOf(ms) {
  const date = new Date(ms || Date.now())
  return {
    y: String(date.getFullYear()),
    m: String(date.getMonth() + 1).padStart(2, '0'),
    d: String(date.getDate()).padStart(2, '0'),
  }
}

function gameLabel(game) {
  return game && game !== '__none' ? game : '未设置游戏'
}

/** 游戏层：用带封面的卡片 */
function browseCard(group, level) {
  const category = level === 'game' ? (state.games || []).find((game) => game.name === group.key)?.category || '' : ''
  const cover = group.cover
    ? `<img loading="lazy" src="${esc(group.cover)}" alt="" />`
    : '<div class="no-cover">还没有封面</div>'
  const meta = [
    category ? `<span class="cat-chip">${esc(category)}</span>` : '',
    group.seconds ? `<span>${clock(group.seconds)}</span>` : '',
  ]
    .filter(Boolean)
    .join('')
  return `<article class="game-card browse-card" data-level="${level}" data-key="${esc(group.key)}">
    <div class="game-cover">
      ${cover}
      <span class="game-count">${group.count} 个视频</span>
    </div>
    <div class="game-body">
      <h3>${esc(group.label)}</h3>
      <div class="game-meta">${meta || '<span>还没填信息</span>'}</div>
    </div>
  </article>`
}

/** 年 / 月 / 日：不用大卡片，就一行一行列出来（只显示数量，不显示总时长） */
function browseRow(group, level) {
  return `<button class="browse-row" data-level="${level}" data-key="${esc(group.key)}">
    <span class="row-name">${esc(group.label)}</span>
    <span class="row-meta">${group.count} 个视频</span>
    <span class="row-arrow" aria-hidden="true">›</span>
  </button>`
}

function renderBrowse() {
  const crumbs = $('#crumbs')
  const countNode = $('#browseCount')
  const bodyNode = $('#browseBody')
  if (!crumbs || !countNode || !bodyNode) return

  const search = $('#browseSearch')
  if (search && document.activeElement !== search && search.value !== state.browseQuery) {
    search.value = state.browseQuery
  }

  if (!state.videos.length) {
    crumbs.innerHTML = '<button class="crumb current" data-crumb="root">全部游戏</button>'
    countNode.textContent = ''
    bodyNode.innerHTML = '<div class="games-empty">还没有视频。把录像放进扫描文件夹，或者点右上角 ↻ 扫一遍。</div>'
    bindCrumbs()
    return
  }

  // 搜到东西就直接列出来，不跟树状目录混在一起
  const query = String(state.browseQuery || '').trim()
  if (query) {
    const needle = query.toLowerCase()
    const hits = state.videos
      .filter((item) =>
        [item.title, item.game, item.summary, item.name, (item.tags || []).join(' '), item.folder]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
      .sort((a, b) => (b.meta?.createdAt || b.mtimeMs || 0) - (a.meta?.createdAt || a.mtimeMs || 0))
    crumbs.innerHTML = `<button class="crumb" data-crumb="root">全部游戏</button><span class="sep">›</span><span class="crumb current">搜「${esc(query)}」</span>`
    countNode.textContent = `找到 ${hits.length} 个`
    bodyNode.innerHTML = hits.length
      ? `<div class="grid">${hits.map(cardHtml).join('')}</div>`
      : '<div class="games-empty">没有匹配的录像，换个词试试</div>'
    bindCrumbs()
    bodyNode.querySelectorAll('.card').forEach((card) => {
      card.onclick = () => openDetail(card.dataset.id)
    })
    return
  }

  const b = state.browse
  const pool = b.game ? state.videos.filter((item) => (item.game || '__none') === b.game) : state.videos

  const level = b.day ? 'videos' : b.month ? 'day' : b.year ? 'month' : b.game ? 'year' : 'game'

  const crumbList = [`<button class="crumb ${b.game ? '' : 'current'}" data-crumb="root">全部游戏</button>`]
  if (b.game) {
    crumbList.push('<span class="sep">›</span>', `<button class="crumb ${b.year ? '' : 'current'}" data-crumb="game">${esc(gameLabel(b.game))}</button>`)
  }
  if (b.year) {
    crumbList.push('<span class="sep">›</span>', `<button class="crumb ${b.month ? '' : 'current'}" data-crumb="year">${b.year}年</button>`)
  }
  if (b.month) {
    crumbList.push('<span class="sep">›</span>', `<button class="crumb ${b.day ? '' : 'current'}" data-crumb="month">${Number(b.month)}月</button>`)
  }
  if (b.day) {
    crumbList.push('<span class="sep">›</span>', `<button class="crumb current" data-crumb="day">${Number(b.day)}日</button>`)
  }

  let body = ''

  if (level === 'videos') {
    const items = pool
      .filter((item) => {
        const d = dayOf(item.meta?.createdAt || item.mtimeMs)
        return d.y === b.year && d.m === b.month && d.d === b.day
      })
      .sort((a, c) => (a.meta?.createdAt || a.mtimeMs || 0) - (c.meta?.createdAt || c.mtimeMs || 0))
    body = items.length ? `<div class="grid">${items.map(cardHtml).join('')}</div>` : '<div class="games-empty">这一天没有录像</div>'
  } else {
    const groups = new Map()
    for (const item of pool) {
      const d = dayOf(item.meta?.createdAt || item.mtimeMs)
      let key = ''
      let label = ''
      if (level === 'game') {
        key = item.game || '__none'
        label = gameLabel(key)
      } else if (level === 'year') {
        key = d.y
        label = `${d.y}年`
      } else if (level === 'month') {
        key = d.m
        label = `${Number(d.m)}月`
      } else {
        key = d.d
        label = `${Number(d.d)}日`
      }
      const group = groups.get(key) || { key, label, count: 0, seconds: 0, cover: '', lastAt: 0 }
      group.count += 1
      group.seconds += Number(item.meta?.duration) || 0
      group.lastAt = Math.max(group.lastAt, item.meta?.createdAt || item.mtimeMs || 0)
      if (!group.cover && item.cover) group.cover = item.cover
      groups.set(key, group)
    }
    const list = [...groups.values()]
    if (level === 'game') list.sort((a, c) => c.count - a.count || String(a.label).localeCompare(String(c.label), 'zh'))
    else if (level === 'day') list.sort((a, c) => Number(a.key) - Number(c.key))
    else list.sort((a, c) => Number(c.key) - Number(a.key))

    body = list.length
      ? level === 'game'
        ? `<div class="games">${list.map((group) => browseCard(group, level)).join('')}</div>`
        : `<div class="browse-rows">${list.map((group) => browseRow(group, level)).join('')}</div>`
      : '<div class="games-empty">这里还没有录像</div>'
  }

  crumbs.innerHTML = crumbList.join('')
  // 没在搜索就不显示数量提示，界面更干净
  countNode.textContent = ''
  bodyNode.innerHTML = body
  bindCrumbs()

  bodyNode.querySelectorAll('.browse-card, .browse-row').forEach((node) => {
    const lv = node.dataset.level
    const key = node.dataset.key
    node.onclick = () => {
      state.browseQuery = ''
      if (lv === 'game') state.browse = { game: key, year: '', month: '', day: '' }
      else if (lv === 'year') state.browse = { ...state.browse, year: key, month: '', day: '' }
      else if (lv === 'month') state.browse = { ...state.browse, month: key, day: '' }
      else if (lv === 'day') state.browse = { ...state.browse, day: key }
      renderBrowse()
    }
  })

  bodyNode.querySelectorAll('.card').forEach((card) => {
    card.onclick = () => openDetail(card.dataset.id)
  })
}

/** 面包屑返回：顺便把搜索清掉 */
function bindCrumbs() {
  $('#crumbs')
    .querySelectorAll('[data-crumb]')
    .forEach((node) => {
      if (node.classList.contains('current')) return
      const which = node.dataset.crumb
      node.onclick = () => {
        state.browseQuery = ''
        if (which === 'root') state.browse = { game: '', year: '', month: '', day: '' }
        else if (which === 'game') state.browse = { ...state.browse, year: '', month: '', day: '' }
        else if (which === 'year') state.browse = { ...state.browse, month: '', day: '' }
        else if (which === 'month') state.browse = { ...state.browse, day: '' }
        renderBrowse()
      }
    })
}

/* ------------------------------------------------------------------ 游戏库 */
function renderGames() {
  const view = $('#gamesView')
  const games = state.games || []
  const categories = state.categories || []

  // 骨架只建一次。输入框绝不能每次敲键就重建——否则中文输入法（还在组字）会被打断。
  if (!view.dataset.ready) {
    view.innerHTML = `<div class="games-toolbar">
        <input id="gameSearch" class="grow" placeholder="搜游戏名 / 别名" autocomplete="off" />
        <button class="btn" id="btnNewGame">＋ 新建游戏</button>
        <button class="btn ghost" id="btnCats">管理类别</button>
        <span class="spacer"></span>
        <span class="hint" id="gamesCount" style="margin:0"></span>
      </div>
      <nav class="filters" id="gameChips" style="margin-bottom:14px"></nav>
      <div id="gamesBody"></div>`
    view.dataset.ready = '1'
    const search = $('#gameSearch')
    let timer = 0
    search.oninput = (event) => {
      state.gameQuery = event.target.value
      // 输入法组字期间不重画，等 compositionend 之后再说
      if (event.isComposing) return
      clearTimeout(timer)
      timer = setTimeout(() => renderGamesBody(), 120)
    }
    search.addEventListener('compositionend', () => {
      clearTimeout(timer)
      timer = setTimeout(() => renderGamesBody(), 0)
    })
    $('#btnNewGame').onclick = () => openGameModal('')
    $('#btnCats').onclick = () => openCategoryModal()
  }

  const search = $('#gameSearch')
  if (document.activeElement !== search && search.value !== state.gameQuery) {
    search.value = state.gameQuery
  }
  $('#gamesCount').textContent = `${games.length} 个游戏 · ${categories.length} 个类别`
  renderGameChips(games, categories)
  renderGamesBody()
}

function renderGameChips(games, categories) {
  const counts = {}
  for (const game of games) {
    const key = game.category || ''
    counts[key] = (counts[key] || 0) + 1
  }
  const chips = [{ key: '', label: '全部', count: games.length }]
    .concat(categories.map((category) => ({ key: category, label: category, count: counts[category] || 0 })))
    .concat([{ key: '__none', label: '未分类', count: counts[''] || 0 }])
  const box = $('#gameChips')
  box.innerHTML = chips
    .map(
      (chip) =>
        `<button class="chip ${state.gameCategory === chip.key ? 'active' : ''}" data-gcat="${esc(chip.key)}">${esc(chip.label)}<b>${chip.count}</b></button>`,
    )
    .join('')
  box.querySelectorAll('[data-gcat]').forEach((button) => {
    button.onclick = () => {
      state.gameCategory = button.dataset.gcat
      renderGameChips(state.games || [], state.categories || [])
      renderGamesBody()
    }
  })
}

function renderGamesBody() {
  const body = $('#gamesBody')
  if (!body) return
  let list = [...(state.games || [])]
  if (state.gameCategory === '__none') list = list.filter((game) => !game.category)
  else if (state.gameCategory) list = list.filter((game) => game.category === state.gameCategory)
  const query = state.gameQuery.trim().toLowerCase()
  if (query) {
    list = list.filter((game) => [game.name, ...(game.aliases || [])].join(' ').toLowerCase().includes(query))
  }

  const cards = list
    .map(
      (game) => `<article class="game-card" data-id="${game.id}">
        <div class="game-cover">
          ${game.cover ? `<img loading="lazy" src="${esc(game.cover)}" alt="" />` : '<div class="no-cover">还没有封面</div>'}
          <span class="game-count">${game.count} 个视频</span>
        </div>
        <div class="game-body">
          <h3>${esc(game.name)}</h3>
          <div class="game-meta">
            ${game.category ? `<span class="cat-chip">${esc(game.category)}</span>` : '<span class="cat-chip none">未分类</span>'}
            <span>${clock(game.seconds || 0)}</span>
          </div>
          ${game.aliases?.length ? `<div class="game-aliases">别名：${esc(game.aliases.join('、'))}</div>` : ''}
        </div>
      </article>`,
    )
    .join('')

  body.innerHTML = list.length
    ? `<div class="games">${cards}</div>`
    : `<div class="games-empty">这里还没有游戏。<br />打开页面自动收进几个视频之后，游戏会自动出现在这里；也可以点「新建游戏」先手动建好、分好类别。</div>`

  body.querySelectorAll('.game-card').forEach((card) => {
    card.onclick = () => openGameModal(card.dataset.id)
  })
}

function openGameModal(id) {
  state.editingGame = id || ''
  const game = id ? (state.games || []).find((item) => item.id === id) : null
  $('#gName').value = game ? game.name : ''
  $('#gAliases').value = game ? (game.aliases || []).join(', ') : ''

  const categoryOptions = ['<option value="">未分类</option>']
    .concat((state.categories || []).map((category) => `<option value="${esc(category)}">${esc(category)}</option>`))
    .join('')
  $('#gCategory').innerHTML = categoryOptions
  if (game?.category) $('#gCategory').value = game.category

  $('#gMerge').innerHTML =
    '<option value="">选一个游戏…</option>' +
    (state.games || [])
      .filter((item) => item.id !== id)
      .map((item) => `<option value="${item.id}">${esc(item.name)}</option>`)
      .join('')
  $('#gMerge').disabled = !id
  $('#gMergeBtn').disabled = !id
  $('#gDelete').style.display = id ? '' : 'none'
  $('#gTip').textContent = game
    ? `${game.count} 个视频 · ${clock(game.seconds || 0)} · 最近 ${dateText(game.lastAt)}`
    : '新建一个游戏，之后填视频信息时可以直接选它。'
  $('#gameModal').hidden = false
  document.body.style.overflow = 'hidden'
  $('#gName').focus()
}

function closeGameModal() {
  $('#gameModal').hidden = true
  state.editingGame = ''
  document.body.style.overflow = ''
}

async function saveGame() {
  const id = state.editingGame
  const payload = {
    name: $('#gName').value.trim(),
    category: $('#gCategory').value,
    aliases: $('#gAliases').value,
  }
  if (!payload.name) {
    toast('游戏名不能为空', 'err')
    return
  }
  try {
    if (id) {
      await api('/games', { method: 'POST', body: { action: 'update', id, patch: payload } })
    } else {
      await api('/games', { method: 'POST', body: { action: 'create', name: payload.name, category: payload.category, aliases: payload.aliases } })
    }
    toast('已保存')
    closeGameModal()
    await load({ silent: true })
  } catch (error) {
    $('#gTip').textContent = error.message
  }
}

async function mergeGame() {
  const id = state.editingGame
  const target = $('#gMerge').value
  if (!id || !target) {
    $('#gTip').textContent = '先选一个要合并进去的游戏'
    return
  }
  const fromName = (state.games || []).find((item) => item.id === id)?.name || ''
  const toName = (state.games || []).find((item) => item.id === target)?.name || ''
  if (!window.confirm(`把「${fromName}」合并到「${toName}」？下面 ${fromName} 的视频都会改成 ${toName}。`)) return
  try {
    await api('/games', { method: 'POST', body: { action: 'merge', from: id, to: target } })
    toast(`已合并到「${toName}」`)
    closeGameModal()
    await load({ silent: true })
  } catch (error) {
    $('#gTip').textContent = error.message
  }
}

async function deleteGame() {
  const id = state.editingGame
  const game = (state.games || []).find((item) => item.id === id)
  if (!game) return
  if (!window.confirm(`删除「${game.name}」？只是从游戏库里删掉，视频不会被删。`)) return
  try {
    await api('/games', { method: 'POST', body: { action: 'delete', id } })
    toast('已删除')
    closeGameModal()
    await load({ silent: true })
  } catch (error) {
    $('#gTip').textContent = error.message
  }
}

/* ------------------------------------------------------------------ 类别 */
function openCategoryModal() {
  renderCategoryList()
  $('#newCategory').value = ''
  $('#catModal').hidden = false
  document.body.style.overflow = 'hidden'
}

function closeCategoryModal() {
  $('#catModal').hidden = true
  document.body.style.overflow = ''
}

function renderCategoryList() {
  const list = $('#catList')
  const categories = state.categories || []
  if (!categories.length) {
    list.innerHTML = '<div class="hint" style="margin:0">还没有类别，先加一个。</div>'
    return
  }
  list.innerHTML = categories
    .map(
      (category) =>
        `<div class="cat-row" data-cat="${esc(category)}"><span>${esc(category)}</span><span class="row" style="gap:10px"><button class="link" data-rename="1">改名</button><button class="link" data-remove="1">删除</button></span></div>`,
    )
    .join('')

  list.querySelectorAll('.cat-row').forEach((row) => {
    const name = row.dataset.cat
    row.querySelector('[data-rename]').onclick = () => {
      const wrapper = row.querySelector('span:first-child')
      row.innerHTML = `<input class="grow" value="${esc(name)}" style="height:30px" /><span class="row" style="gap:10px"><button class="link" data-ok="1">确定</button><button class="link" data-cancel="1">取消</button></span>`
      const input = row.querySelector('input')
      input.focus()
      input.select()
      row.querySelector('[data-cancel]').onclick = () => renderCategoryList()
      row.querySelector('[data-ok]').onclick = async () => {
        try {
          await api('/categories', { method: 'POST', body: { action: 'rename', from: name, to: input.value.trim() } })
          await load({ silent: true })
          renderCategoryList()
        } catch (error) {
          toast(error.message, 'err')
        }
      }
    }
    row.querySelector('[data-remove]').onclick = async () => {
      if (!window.confirm(`删除类别「${name}」？用这个类别的游戏会回到「未分类」。`)) return
      try {
        await api('/categories', { method: 'POST', body: { action: 'remove', name } })
        await load({ silent: true })
        renderCategoryList()
      } catch (error) {
        toast(error.message, 'err')
      }
    }
  })
}

/* ------------------------------------------------------------------ 详情 */
/** 把游戏库填进详情里的下拉框；selected 指定当前值 */
function renderGameOptions(selected = '') {
  const select = $('#dGame')
  if (!select) return
  const games = state.games || []
  select.innerHTML = ['<option value="">未设置</option>']
    .concat(games.map((game) => `<option value="${esc(game.name)}">${esc(game.name)}</option>`))
    .join('')
  select.value = games.some((game) => game.name === selected) ? selected : ''
}

function openDetail(id) {
  state.selected = id
  state.dirty = false
  const modal = $('#detail')
  modal.hidden = false
  refreshDetail(id)
  document.body.style.overflow = 'hidden'
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}#v/${encodeURIComponent(id)}`)
  } catch {
    /* ignore */
  }
}

function closeDetail() {
  $('#detail').hidden = true
  state.selected = ''
  state.dirty = false
  const player = $('#player')
  player.pause()
  player.removeAttribute('src')
  player.load()
  delete player.dataset.id
  document.body.style.overflow = ''
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch {
    /* ignore */
  }
}

function refreshDetail(id) {
  const item = state.videos.find((entry) => entry.id === id)
  if (!item) {
    closeDetail()
    return
  }
  const player = $('#player')
  const src = `${API}/video?id=${encodeURIComponent(id)}`
  if (player.dataset.id !== id) {
    player.dataset.id = id
    player.src = src
    $('#playerHint').hidden = true
    player.onerror = () => {
      const hint = $('#playerHint')
      hint.hidden = false
      hint.textContent = '这个格式浏览器放不了（比如部分 mkv/flv）。点「打开文件夹」，用系统播放器看。'
    }
  }

  // 顶部只留游戏名，文件名不再重复显示（标题为空时用占位提示）
  $('#dKicker').textContent = item.game || '未识别游戏'
  renderGameOptions(item.user?.game || '')
  if (!state.dirty) {
    $('#dTitle').value = item.user?.title || item.name
    $('#dSummary').value = item.user?.summary ?? ''
    $('#dTags').value = (item.user?.tags || []).join(', ')
  }

  const duration = Number(item.meta?.duration) || 0
  const facts = [
    duration > 0 ? clock(duration) : '时长未知',
    item.meta?.width ? `${item.meta.width}×${item.meta.height}` : '',
    item.meta?.fps ? `${Math.round(item.meta.fps)} fps` : '',
    item.sizeText || bytes(item.size),
    item.meta?.vcodec ? String(item.meta.vcodec).toUpperCase() : '',
  ].filter(Boolean)
  $('#dFacts').innerHTML = facts.map((fact) => `<span>${esc(fact)}</span>`).join('')

  const frames = item.frames || []
  $('#frames').innerHTML = frames
    .map(
      (frame, index) =>
        `<div class="frame" data-t="${frame.t}"><img loading="lazy" src="${esc(frame.url)}" alt="" /><em>${frame.timeText}</em></div>`,
    )
    .join('')
  $('#frames')
    .querySelectorAll('.frame')
    .forEach((node) => {
      node.onclick = () => {
        player.currentTime = Number(node.dataset.t) || 0
        player.play().catch(() => {})
        $('#frames').querySelectorAll('.frame').forEach((other) => other.classList.remove('active'))
        node.classList.add('active')
      }
    })

  // 录制中就在卡片上有个「录制中」角标，这里不再重复写说明文字
}

async function saveDetail() {
  const item = state.videos.find((entry) => entry.id === state.selected)
  if (!item) return
  const wasPending = !isProcessed(item)
  try {
    const result = await api('/update', {
      method: 'POST',
      body: {
        id: item.id,
        title: $('#dTitle').value.trim(),
        summary: $('#dSummary').value.trim(),
        tags: $('#dTags').value,
        game: $('#dGame').value.trim(),
      },
    })
    state.dirty = false
    if (result.moveError) toast(`已保存，但归档失败：${result.moveError}`, 'err')
    else if (result.moved) toast(`已保存，并归档到 ${result.entry?.path || '目标文件夹'}`)
    else toast(wasPending ? '已保存，已经收进「游戏录像」' : '已保存')
    await load({ silent: true })
  } catch (error) {
    toast(error.message, 'err')
  }
}

/* ------------------------------------------------------------------ 设置 */
function renderSettings() {
  const config = state.live?.config || {}
  $('#cfgFrames').value = String(config.frames || 6)
  if (document.activeElement?.id !== 'cfgScanFolder') $('#cfgScanFolder').value = config.scanFolder || ''
  $('#cfgScanDeep').checked = config.scanDeep === true
  renderDeps()
}

/** 依赖体检：ffmpeg / 档案目录 / 录像文件夹 / Node */
async function loadDeps(force = false) {
  if (state.deps && !force) return state.deps
  try {
    state.deps = await api('/deps')
  } catch (error) {
    state.deps = { ok: false, items: [{ name: '依赖体检', ok: false, detail: error.message, fix: '' }] }
  }
  return state.deps
}

function renderDeps() {
  const box = $('#envBox')
  if (!box) return
  const deps = state.deps
  if (!deps) {
    box.textContent = '检查中…'
    loadDeps().then(renderDeps)
    return
  }
  box.innerHTML = deps.items
    .map((item) => {
      const detail = esc(item.detail || '').replace(/\n/g, '<br />')
      const fix = item.ok || !item.fix ? '' : `<div class="hint" style="margin:5px 0 0;color:inherit">${esc(item.fix).replace(/\n/g, '<br />')}</div>`
      return `<div style="margin-bottom:8px"><span class="${item.ok ? 'ok' : 'bad'}">${item.ok ? '✓' : '✗'} ${esc(item.name)}</span> ${detail}${fix}</div>`
    })
    .join('')
}

async function patchConfig(patch) {
  try {
    await api('/config', { method: 'POST', body: { patch } })
    await load({ silent: true })
  } catch (error) {
    toast(error.message, 'err')
  }
}

/** 扫一遍设定好的录像文件夹（只在打开页面时或手动点的时候跑） */
async function runScanFolder(manual) {
  const config = state.live?.config || {}
  if (!config.scanFolder) {
    if (manual) toast('先在设置里填要扫的文件夹', 'err')
    return
  }
  try {
    const result = await api('/scan-folder', { method: 'POST', body: {} })
    if (result.added || result.relinked) {
      const parts = [`收了 ${result.added} 个新录像`]
      if (result.relinked) parts.push(`认回 ${result.relinked} 个`)
      toast(parts.join('，'))
      startPolling()
      await load({ silent: true })
    } else if (manual) {
      toast(`扫了 ${result.scanned || 0} 个文件，没有新的`)
    }
  } catch (error) {
    if (manual) toast(error.message, 'err')
  }
}

let autoScanDone = false
function autoScanOnOpen() {
  if (autoScanDone) return
  const config = state.live?.config || {}
  // 只要设了文件夹，打开页面就收一次；没有额外的开关
  if (!config.scanFolder) return
  autoScanDone = true
  // 一分钟内扫过就不再扫：来回切页签时不反复读盘
  let last = 0
  try {
    last = Number(sessionStorage.getItem('va:lastScan') || 0)
  } catch {
    last = 0
  }
  if (Date.now() - last < 60_000) return
  try {
    sessionStorage.setItem('va:lastScan', String(Date.now()))
  } catch {
    /* ignore */
  }
  // 先让页面画完再说，别和首屏抢
  setTimeout(() => {
    if (!document.hidden) runScanFolder(false)
  }, 800)
}

/* ------------------------------------------------------------------ 轮询 */
function startPolling() {
  if (state.polling) return
  state.polling = true
  const tick = async () => {
    try {
      const live = await api('/state')
      state.live = live
      renderJobs()
      const filled = live.stats?.filled ?? 0
      if (!live.busy) {
        state.polling = false
        state.pollTimer = null
        if (filled !== state.lastFilled) {
          state.lastFilled = filled
          await load({ silent: true })
        }
        renderJobs()
        return
      }
      if (filled !== state.lastFilled) {
        state.lastFilled = filled
        load({ silent: true })
      }
      state.pollTimer = setTimeout(tick, 1500)
    } catch (error) {
      state.polling = false
      state.pollTimer = null
      renderJobs()
    }
  }
  tick()
}

/* ------------------------------------------------------------------ 事件 */
function bind() {
  // 游戏录像页签里的搜索：输入法组字期间不重画，防抖后再过滤
  const browseSearch = $('#browseSearch')
  let browseTimer = 0
  browseSearch.oninput = (event) => {
    state.browseQuery = event.target.value
    if (event.isComposing) return
    clearTimeout(browseTimer)
    browseTimer = setTimeout(() => renderBrowse(), 120)
  }
  browseSearch.addEventListener('compositionend', () => {
    state.browseQuery = browseSearch.value
    clearTimeout(browseTimer)
    browseTimer = setTimeout(() => renderBrowse(), 0)
  })
  browseSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      browseSearch.value = ''
      state.browseQuery = ''
      renderBrowse()
    }
  })

  $('#btnCancel').onclick = async () => {
    try {
      await api('/cancel', { method: 'POST' })
      toast('已停下，队列里的先不做了')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  document.querySelectorAll('#tabs .tab').forEach((tab) => {
    tab.onclick = () => {
      state.tab = tab.dataset.tab || 'library'
      render()
    }
  })

  document.querySelectorAll('[data-close]').forEach((node) => {
    node.onclick = () => {
      const target = node.dataset.close
      if (target === 'detail') closeDetail()
      else if (target === 'gameModal') closeGameModal()
      else if (target === 'catModal') closeCategoryModal()
      else if (target === 'deleteModal') closeDeleteModal()
    }
  })

  $('#gSave').onclick = () => saveGame()
  $('#gMergeBtn').onclick = () => mergeGame()
  $('#gDelete').onclick = () => deleteGame()
  ;['#gName', '#gAliases'].forEach((selector) => {
    $(selector).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveGame()
    })
  })

  $('#btnAddCategory').onclick = async () => {
    const name = $('#newCategory').value.trim()
    if (!name) return
    try {
      await api('/categories', { method: 'POST', body: { action: 'add', name } })
      $('#newCategory').value = ''
      await load({ silent: true })
      renderCategoryList()
    } catch (error) {
      toast(error.message, 'err')
    }
  }
  $('#newCategory').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#btnAddCategory').click()
  })

  $('#dSave').onclick = () => saveDetail()
  $('#dRefresh').onclick = async () => {
    const id = state.selected
    if (!id) return
    const button = $('#dRefresh')
    button.disabled = true
    button.classList.add('spinning')
    try {
      const result = await api('/refresh', { method: 'POST', body: { id } })
      toast(result.duration ? `已重新读取：${clock(result.duration)}` : '读不到信息（可能文件还在写）', result.duration ? '' : 'err')
      await load({ silent: true })
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      button.disabled = false
      button.classList.remove('spinning')
    }
  }
  $('#dReveal').onclick = async () => {
    try {
      await api('/reveal', { method: 'POST', body: { id: state.selected } })
      toast('已在资源管理器里打开')
    } catch (error) {
      toast(error.message, 'err')
    }
  }
  $('#dDelete').onclick = () => openDeleteModal(state.selected)
  $('#delRecordOnly').onclick = () => removeVideo(false)
  $('#delWithFile').onclick = () => removeVideo(true)
  const markDirty = () => {
    state.dirty = true
  }
  ;['#dTitle', '#dSummary', '#dTags', '#dGame'].forEach((selector) => {
    $(selector).addEventListener('input', markDirty)
  })

  $('#btnRescan').onclick = () => runScanFolder(true)

  // 被嵌在 DSH 侧栏里时，给一个「弹成独立窗口」的出口：边聊边看
  if (window.self !== window.top) {
    const popout = $('#btnPopout')
    popout.hidden = false
    popout.onclick = () => {
      const origin = state.live?.origin || ''
      const url = origin ? `${origin}/video-archive/` : location.href
      const win = window.open(url, 'video-archive-window', 'popup=yes,width=1280,height=880')
      if (win) win.focus()
      else toast(`浏览器拦了新窗口，把 ${url} 复制到浏览器打开`, 'err')
    }
  }

  $('#cfgFrames').onchange = (event) => patchConfig({ frames: Number(event.target.value) })
  $('#cfgScanFolder').onchange = (event) => patchConfig({ scanFolder: event.target.value.trim() })
  $('#cfgScanDeep').onchange = (event) => patchConfig({ scanDeep: event.target.checked })

  $('#btnCheckEnv').onclick = async () => {
    $('#btnCheckEnv').disabled = true
    try {
      await loadDeps(true)
      renderDeps()
      toast(state.deps.ok ? '全部就绪' : '有不可用的项，看下面的「修」', state.deps.ok ? '' : 'err')
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      $('#btnCheckEnv').disabled = false
    }
  }

  document.addEventListener('keydown', (event) => {
    // 输入法组字中（比如正在打中文），别让快捷键抢键，也别把 Esc 当成关窗口
    if (event.isComposing) return
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    if (event.key === 'Escape') {
      if (!$('#deleteModal').hidden) closeDeleteModal()
      else if (!$('#detail').hidden) closeDetail()
      else if (!$('#gameModal').hidden) closeGameModal()
      else if (!$('#catModal').hidden) closeCategoryModal()
      return
    }
    if (typing) return
    if (!$('#detail').hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const list = filtered()
      const index = list.findIndex((item) => item.id === state.selected)
      if (index < 0) return
      const next = list[index + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next) {
        state.dirty = false
        state.selected = next.id
        refreshDetail(next.id)
      }
    }
  })
}

bind()
load().then(() => {
  // 支持 ?q=xxx 直接带搜索词进来（也方便收藏一条搜索结果）
  const initialQuery = new URLSearchParams(location.search).get('q')
  if (initialQuery) {
    state.browseQuery = initialQuery
    state.tab = 'browse'
    render()
  }
  applyHash()
  autoScanOnOpen()
})

function applyHash() {
  const hash = String(location.hash || '')
  if (hash.startsWith('#browse')) {
    const parts = hash
      .slice('#browse'.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    state.browse = { game: parts[0] || '', year: parts[1] || '', month: parts[2] || '', day: parts[3] || '' }
    state.browseQuery = ''
    state.tab = 'browse'
    render()
    return
  }
  if (hash === '#games') {
    state.tab = 'games'
    render()
    return
  }
  if (hash === '#settings') {
    state.tab = 'settings'
    render()
    return
  }
  const gameMatch = hash.match(/^#game\/(.+)$/)
  if (gameMatch) {
    const id = decodeURIComponent(gameMatch[1])
    if ((state.games || []).some((item) => item.id === id)) openGameModal(id)
    return
  }
  const match = hash.match(/^#v\/(.+)$/)
  if (match) {
    const id = decodeURIComponent(match[1])
    if (state.videos.some((item) => item.id === id)) openDetail(id)
  }
}

window.addEventListener('hashchange', applyHash)

// 每 15 秒瞄一眼后台状态；页面被藏起来（切去聊天）时完全不干活，避免抢主线程
setInterval(() => {
  if (document.hidden) return
  if (!state.polling) {
    api('/state')
      .then((live) => {
        state.live = live
        if (live.busy) startPolling()
      })
      .catch(() => {})
  }
}, 15000)

// 切走的时候把播放器松开（释放解码器和连接），切回来再按需接上，减少来回切换的卡顿
function releasePlayer() {
  const player = $('#player')
  if (!player) return
  if (!player.paused) player.pause()
  if (player.src) {
    player.removeAttribute('src')
    player.load()
  }
}

function restorePlayer() {
  if (!state.selected) return
  const player = $('#player')
  if (!player || player.src || $('#detail').hidden) return
  player.src = `/video-archive/api/video?id=${encodeURIComponent(state.selected)}`
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) releasePlayer()
  else restorePlayer()
})

window.addEventListener('pagehide', releasePlayer)

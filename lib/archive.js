import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, fmtBytes, fmtClock, now, safeName, recycleFile } from './util.js'
import { probeVideo } from './probe.js'
import { extractFrames } from './frames.js'
import { Store } from './store.js'
import { gameKey } from './games.js'

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.flv', '.mov', '.avi', '.ts', '.webm', '.m4v', '.wmv', '.mpg', '.mpeg', '.m2ts'])
const SKIP_DIRS = new Set(['node_modules', 'system volume information', '$recycle.bin', '.git', '.cache'])
const MAX_DEPTH = 6

function isVideo(file) {
  return VIDEO_EXT.has(path.extname(file).toLowerCase())
}

/** 目标位置重名时自动加 (2)、(3)… */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}

function walk(root, limit = MAX_DEPTH) {
  const found = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (depth > limit) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.')) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile() && isVideo(full)) {
        found.push(full)
      }
    }
  }
  return found
}

export class Archive {
  constructor({ store, ffmpeg, games = null, logger = console }) {
    this.store = store
    this.ffmpeg = ffmpeg
    this.games = games
    this.logger = logger
    this.queue = []
    this.queued = new Set()
    this.current = null
    this.running = false
    this.cancelled = false
    this.total = 0
    this.done = 0
    this.recordTimer = null
    this.retryCount = new Map()
    this.adoptGames()
  }

  /** 老数据里的游戏名先收进游戏库，避免同一个游戏散成好几条。 */
  adoptGames() {
    if (!this.games) return
    for (const entry of this.store.entries()) {
      const name = entry.user?.game
      if (name) this.games.ensure(name)
    }
  }

  // ------------------------------------------------------------ 生命周期
  stop() {
    if (this.recordTimer) clearInterval(this.recordTimer)
    this.recordTimer = null
    this.cancel()
  }

  // ------------------------------------------------------------ 状态
  state() {
    const stats = this.store.stats()
    const ff = this.ffmpeg.resolve()
    const config = this.store.getConfig()
    return {
      ok: true,
      busy: this.running,
      current: this.current
        ? { id: this.current.id, name: this.current.name, kind: this.current.kind }
        : null,
      progress: { total: this.total, done: this.done, pending: this.queue.length },
      stats,
      config,
      dataDir: this.store.dataDir,
      ffmpeg: { ok: ff.ok, dir: ff.dir, source: ff.source },
      at: now(),
    }
  }

  /** 打开页面时扫一遍设定的文件夹：只收还没进档案的，已经在的跳过。 */
  scanFolder() {
    const config = this.store.getConfig()
    const folder = String(config.scanFolder || '').trim()
    if (!folder) return { ok: false, error: '还没设置要扫的文件夹' }
    const root = path.resolve(folder)
    let stat = null
    try {
      stat = fs.statSync(root)
    } catch {
      return { ok: false, error: '这个文件夹不存在' }
    }
    if (!stat.isDirectory()) return { ok: false, error: '这不是文件夹' }

    // 勾了「包括子文件夹」就往下走三层，没勾只收这一层
    const found = []
    if (config.scanDeep) {
      const stack = [{ dir: root, depth: 0 }]
      while (stack.length) {
        const { dir, depth } = stack.pop()
        if (depth > 3) continue
        let entries = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const item of entries) {
          const full = path.join(dir, item.name)
          if (item.isDirectory()) {
            if (item.name.startsWith('.') || item.name === 'node_modules') continue
            stack.push({ dir: full, depth: depth + 1 })
          } else if (item.isFile() && isVideo(item.name)) {
            found.push(full)
          }
        }
      }
    } else {
      let entries = []
      try {
        entries = fs.readdirSync(root, { withFileTypes: true })
      } catch (error) {
        return { ok: false, error: `读不了这个文件夹：${error.message}` }
      }
      for (const item of entries) {
        if (item.isFile() && isVideo(item.name)) found.push(path.join(root, item.name))
      }
    }

    // 别把我们自己的档案目录当成录像收进来
    const dataRoot = this.store.dataDir.endsWith(path.sep) ? this.store.dataDir : `${this.store.dataDir}${path.sep}`
    const files = found.filter((file) => !file.startsWith(dataRoot))
    const result = this.addPaths(files)
    return { ...result, scanned: files.length, folder: root }
  }

  /** 把指定路径的视频加进档案（只加传进来的这些，不会去看别的文件）。 */
  addPaths(paths) {
    const list = Array.isArray(paths) ? paths : [paths]
    const result = { ok: true, added: 0, skipped: 0, errors: [], entries: [] }
    for (const raw of list) {
      const file = path.resolve(String(raw || '').trim())
      if (!file) continue
      try {
        const stat = fs.statSync(file)
        if (!stat.isFile()) {
          result.errors.push(`${file}：不是文件`)
          continue
        }
        if (!isVideo(file)) {
          result.errors.push(`${path.basename(file)}：不是视频格式`)
          continue
        }
        const id = Store.idFor(file)
        if (this.store.get(id)) {
          result.skipped += 1
          continue
        }
        const entry = {
          id,
          path: file,
          name: path.basename(file),
          rel: path.basename(file),
          folder: path.dirname(file),
          size: stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
          state: 'queued',
          error: '',
        }
        this.store.upsert(entry)
        this.enqueue({ kind: 'meta', id, name: entry.name })
        result.added += 1
        result.entries.push({ id, name: entry.name })
      } catch (error) {
        result.errors.push(`${path.basename(file)}：${error.message}`)
      }
    }
    if (!result.added && result.errors.length) result.ok = false
    this.store.flush()
    return result
  }


  // ------------------------------------------------------------ 队列
  enqueue(job) {
    if (!job?.id) return
    if (this.queued.has(job.id) && this.queue.some((item) => item.id === job.id)) return
    this.queue.push(job)
    this.queued.add(job.id)
    this.total += 1
    this.pump()
  }

  pump() {
    if (this.running) return
    this.running = true
    this.cancelled = false
    this.loop().catch((error) => {
      this.logger.warn?.(`队列异常：${error.message}`)
      this.running = false
    })
  }

  async loop() {
    while (!this.cancelled) {
      const job = this.queue.shift()
      if (!job) break
      this.queued.delete(job.id)
      this.current = job
      try {
        await this.runMeta(job.id)
      } catch (error) {
        this.logger.warn?.(`处理 ${job.name || job.id} 失败：${error.message}`)
        this.store.upsert({ id: job.id, state: 'error', error: error.message.slice(0, 300) })
      } finally {
        this.current = null
        this.done += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    this.running = false
    this.store.flush()
    if (this.queue.length && !this.cancelled) this.pump()
  }

  cancel() {
    this.cancelled = true
    for (const job of this.queue) {
      this.store.upsert({ id: job.id, state: 'ready', error: '' })
    }
    this.queue = []
    this.queued.clear()
    this.total = this.done
  }

  // ------------------------------------------------------------ 单个任务
  async runMeta(id) {
    const entry = this.store.get(id)
    if (!entry) return
    if (!fs.existsSync(entry.path)) {
      this.store.upsert({ id, state: 'missing', error: '文件不在了' })
      return
    }
    // 没装 ffmpeg 也别报错：先存成「原始条目」，描述照样能填，装好之后再重新读取
    if (!this.ffmpeg.resolve().ok) {
      this.store.upsert({ id, state: 'raw', error: '' })
      this.store.flush()
      return
    }
    this.store.upsert({ id, state: 'analyzing', error: '' })
    const probed = await probeVideo(this.ffmpeg, entry.path)
    if (!probed.ok) {
      // 可能是 ffmpeg 被卸载/挪走了：重新找一次，确实没有就降级成「原始条目」
      if (!this.ffmpeg.resolve(true).ok) {
        this.store.upsert({ id, state: 'raw', error: '' })
        return
      }
      this.markUnfinished(id, entry, probed.error)
      return
    }
    // 时长读不到（正在写的 MP4 常见）也当成没读完，等录完再补
    if (!(Number(probed.meta.duration) > 0)) {
      this.markUnfinished(id, entry, '读不到时长，可能还在录制')
      return
    }
    const thumbDir = this.store.thumbDir(id)
    ensureDir(thumbDir)
    const frames = await extractFrames(this.ffmpeg, entry.path, thumbDir, {
      count: this.store.getConfig().frames,
      duration: probed.meta.duration,
    })
    if (!frames.ok) {
      this.store.upsert({ id, meta: probed.meta })
      this.markUnfinished(id, entry, frames.error)
      return
    }
    this.store.upsert({
      id,
      meta: probed.meta,
      frames: frames.frames,
      cover: frames.cover,
      sheet: frames.sheet,
      state: 'ready',
      error: '',
    })
    this.retryCount.delete(id)
    this.store.touch()
  }

  /** 手动重新读一遍元数据（时长不对、或者装了 ffmpeg 之后用）。 */
  async refresh(id) {
    const entry = this.store.get(id)
    if (!entry) return { ok: false, error: '没有这个视频' }
    this.ffmpeg.resolve(true)
    this.retryCount.delete(id)
    await this.runMeta(id)
    const after = this.store.get(id)
    return { ok: true, entry: after, state: after?.state || '', duration: after?.meta?.duration || 0 }
  }

  /**
   * 读不出信息时的处理：文件是最近还在变的，就当成「正在录制」，
   * 先让你填信息，过一会儿自动重试；否则才记成真错误。
   */
  markUnfinished(id, entry, message) {
    let stat = null
    try {
      stat = fs.statSync(entry.path)
    } catch {
      this.store.upsert({ id, state: 'missing', error: '文件不在了' })
      return
    }
    const fresh = Date.now() - stat.mtimeMs < 120_000
    const tries = (this.retryCount.get(id) || 0) + 1
    this.retryCount.set(id, tries)
    if (!fresh || tries > 240) {
      this.store.upsert({ id, state: 'error', error: message })
      return
    }
    this.store.upsert({
      id,
      state: 'recording',
      error: '还在录制，录完会自动补上时长和封面',
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    })
    this.watchRecording()
  }

  /** 只为「正在录制」的条目起一个轻量定时器，录完自动补信息；没有这类条目就停掉。 */
  watchRecording() {
    if (this.recordTimer) return
    this.recordTimer = setInterval(() => {
      const pending = this.store.entries().filter((item) => item.state === 'recording')
      if (!pending.length) {
        clearInterval(this.recordTimer)
        this.recordTimer = null
        return
      }
      for (const item of pending) {
        if (!fs.existsSync(item.path)) {
          this.store.upsert({ id: item.id, state: 'missing', error: '文件不在了' })
          continue
        }
        this.runMeta(item.id).catch(() => {})
      }
    }, 30_000)
    if (typeof this.recordTimer.unref === 'function') this.recordTimer.unref()
  }


  /** 保存用户改的信息。保存成功后，如果开了归档，就按当前设置挪文件。 */
  async update(id, patch) {
    const entry = this.store.get(id)
    if (!entry) return { ok: false, error: '没有这个视频' }
    const user = { ...(entry.user || {}) }
    if (patch.title !== undefined) user.title = String(patch.title).slice(0, 80)
    if (patch.game !== undefined) {
      const name = String(patch.game).trim().slice(0, 40)
      const game = name && this.games ? this.games.ensure(name) : null
      user.game = game ? game.name : name
    }
    if (patch.summary !== undefined) user.summary = String(patch.summary).slice(0, 600)
    if (patch.tags !== undefined) {
      const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags || '').split(/[,，、]/)
      user.tags = tags.map((item) => String(item).trim().replace(/^#/, '')).filter(Boolean).slice(0, 10)
    }
    this.store.upsert({ id, user })
    return { ok: true, entry: this.store.get(id) }
  }

  // ------------------------------------------------------------ 游戏库
  /** 游戏库视图：每个游戏挂上视频数、封面、时长。 */
  /** 游戏封面：手动指定的那条视频优先，没指定就用第一条有封面的 */
  gameCover(game, buckets) {
    const picked = String(game?.cover || '')
    if (picked) {
      const entry = this.store.get(picked)
      if (entry && entry.cover) return `/video-archive/api/thumb?id=${entry.id}&f=${encodeURIComponent(entry.cover)}`
    }
    return buckets.get(game.id)?.cover || ''
  }

  gamesView() {
    const buckets = new Map()
    for (const entry of this.store.entries()) {
      const name = entry.user?.game || ''
      if (!name) continue
      const game = this.games?.find(name)
      const key = game?.id || `raw:${name}`
      const bucket = buckets.get(key) || { count: 0, seconds: 0, cover: '', lastAt: 0 }
      bucket.count += 1
      bucket.seconds += Number(entry.meta?.duration) || 0
      bucket.lastAt = Math.max(bucket.lastAt, entry.meta?.createdAt || entry.mtimeMs || 0)
      if (!bucket.cover && entry.cover) bucket.cover = `/video-archive/api/thumb?id=${entry.id}&f=${encodeURIComponent(entry.cover)}`
      buckets.set(key, bucket)
    }
    const games = this.games
      ? this.games.list().map((game) => ({
          ...game,
          count: buckets.get(game.id)?.count || 0,
          seconds: buckets.get(game.id)?.seconds || 0,
          cover: this.gameCover(game, buckets),
          coverId: String(game.cover || ''),
          lastAt: buckets.get(game.id)?.lastAt || 0,
        }))
      : []
    return {
      ok: true,
      categories: this.games ? this.games.categories() : [],
      games,
      summary: this.games ? this.games.summary() : { games: 0, categories: 0, counts: {} },
    }
  }

  createGame(payload = {}) {
    if (!this.games) return { ok: false, error: '游戏库没就绪' }
    return this.games.create({ name: payload.name, category: payload.category || '', aliases: payload.aliases || [] })
  }

  updateGame(id, patch = {}) {
    if (!this.games) return { ok: false, error: '游戏库没就绪' }
    const before = this.games.get(String(id))
    if (!before) return { ok: false, error: '没有这个游戏' }
    const oldNames = [before.name, ...before.aliases]
    const result = this.games.update(String(id), patch)
    if (!result.ok) return result
    if (patch.name !== undefined && result.game.name !== before.name) {
      this.applyGameName(oldNames, result.game.name)
    }
    return result
  }

  mergeGames(fromId, toId) {
    if (!this.games) return { ok: false, error: '游戏库没就绪' }
    const result = this.games.merge(String(fromId), String(toId))
    if (!result.ok) return result
    this.applyGameName([result.from.name, ...result.from.aliases], result.to.name)
    return { ok: true, game: result.to }
  }

  removeGame(id) {
    if (!this.games) return { ok: false, error: '游戏库没就绪' }
    const view = this.gamesView().games.find((game) => game.id === String(id))
    if (!view) return { ok: false, error: '没有这个游戏' }
    if (view.count > 0) return { ok: false, error: `「${view.name}」下还有 ${view.count} 个视频，先把它们改到别的游戏再删` }
    return this.games.remove(String(id))
  }

  /** 把视频里散落的旧名字/别名统一改成新名字。 */
  applyGameName(oldNames, newName) {
    const keys = new Set(oldNames.map((name) => gameKey(name)))
    let touched = 0
    for (const entry of this.store.entries()) {
      const current = entry.user?.game || ''
      if (!current || !keys.has(gameKey(current))) continue
      const patch = { id: entry.id }
      if (entry.user?.game) patch.user = { ...entry.user, game: newName }
            this.store.upsert(patch)
      touched += 1
    }
    if (touched) {
      this.store.flush()
      this.logger.info?.(`游戏改名：${oldNames[0]} → ${newName}，影响 ${touched} 个视频`)
    }
    return touched
  }

  categories(action, payload = {}) {
    if (!this.games) return { ok: false, error: '游戏库没就绪' }
    if (action === 'add') return this.games.addCategory(payload.name)
    if (action === 'rename') return this.games.renameCategory(payload.from, payload.to)
    if (action === 'remove') return this.games.removeCategory(payload.name)
    return { ok: false, error: `不认识的类别操作：${action}` }
  }

  /** 删掉一条：withFile=true 时把文件也丢进回收站（删不掉就不删记录）。 */
  async removeVideo(id, { withFile = false } = {}) {
    const entry = this.store.get(id)
    if (!entry) return { ok: false, error: '没有这个视频' }
    let recycled = false
    if (withFile && fs.existsSync(entry.path)) {
      const result = await recycleFile(entry.path)
      if (!result.ok) return { ok: false, error: `删不掉文件：${result.error}` }
      recycled = Boolean(result.recycled)
    }
    const ok = this.store.remove(id)
    this.store.flush()
    return { ok, recycled, path: entry.path, noFile: !fs.existsSync(entry.path) }
  }

  /** 给界面看的列表：去掉路径里的敏感信息也没必要，本地用，保留。 */
  list() {
    return this.store.entries().map((entry) => {
      const gameName = entry.user?.game ?? ''
      const game = gameName && this.games ? this.games.find(gameName) : null
      const exists = fs.existsSync(String(entry.path || ''))
      return {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        exists,
        missing: !exists,
        rel: entry.rel,
        folder: entry.folder,
        size: entry.size,
        sizeText: fmtBytes(entry.size),
        mtimeMs: entry.mtimeMs,
        state: entry.state || 'ready',
        error: entry.error || '',
        meta: entry.meta || null,
        durationText: fmtClock(entry.meta?.duration || 0),
        cover: entry.cover ? `/video-archive/api/thumb?id=${entry.id}&f=${encodeURIComponent(entry.cover)}` : '',
        sheet: entry.sheet ? `/video-archive/api/thumb?id=${entry.id}&f=${encodeURIComponent(entry.sheet)}` : '',
        frames: (entry.frames || []).map((item) => ({
          t: item.t,
          timeText: fmtClock(item.t),
          url: `/video-archive/api/thumb?id=${entry.id}&f=${encodeURIComponent(item.name)}`,
        })),
        user: entry.user || null,
        title: entry.user?.title || entry.name,
        game: gameName,
        gameId: game?.id || '',
        category: game?.category || '',
        summary: entry.user?.summary ?? '',
        tags: entry.user?.tags || [],
        filled: Boolean(entry.user?.title || entry.user?.game || entry.user?.summary),
        movedAt: entry.movedAt || 0,
        movedFrom: entry.movedFrom || '',
      }
    })
  }
}

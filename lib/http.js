import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fmtBytes, fmtClock, pickFolder } from './util.js'
import { collectDeps } from './deps.js'
import { dataDirForScan } from './store.js'

// 前端带的 REQUIRED_API 必须和这个数一致，否则说明「前端新、后端旧」
const API_VERSION = 2

const PREFIX = '/video-archive'
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendFile(res, file, { download = false, cache = 'no-cache' } = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return json(res, 404, { ok: false, error: '文件不存在' })
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('content-length', stat.size)
  res.setHeader('cache-control', cache)
  if (download) res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`)
  fs.createReadStream(file).pipe(res)
  return true
}

/** 支持 Range 的流式播放，浏览器才能拖进度条。 */
function streamVideo(req, res, file, { download = false } = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return json(res, 404, { ok: false, error: '文件不存在' })
  }
  const total = stat.size
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.range
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'no-cache')
  if (download) res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(path.basename(file))}"`)

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(String(range))
    if (match) {
      let start = match[1] === '' ? null : Number(match[1])
      let end = match[2] === '' ? null : Number(match[2])
      if (start === null && end !== null) {
        start = Math.max(0, total - end)
        end = total - 1
      }
      if (start === null) start = 0
      if (end === null || end >= total) end = total - 1
      if (start > end || start >= total) {
        res.statusCode = 416
        res.setHeader('content-range', `bytes */${total}`)
        res.end()
        return true
      }
      res.statusCode = 206
      res.setHeader('content-type', type)
      res.setHeader('content-range', `bytes ${start}-${end}/${total}`)
      res.setHeader('content-length', end - start + 1)
      fs.createReadStream(file, { start, end }).pipe(res)
      return true
    }
  }

  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('content-length', total)
  fs.createReadStream(file).pipe(res)
  return true
}

function openWithSystem(file) {
  const platform = process.platform
  try {
    if (platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      return true
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [file], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function revealInExplorer(file) {
  try {
    if (process.platform !== 'win32') return openWithSystem(path.dirname(file))
    // explorer 的 /select 必须是「两个参数」：'/select,' + 完整路径。
    // 拼成一个 "/select,D:\..." 反而会被当成长文件夹名解析错（实测会落到「文档」）。
    const exists = fs.existsSync(file)
    const args = exists ? ['/select,', file] : [path.dirname(file)]
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' })
    // explorer 起不来就退一步：直接打开所在文件夹
    child.on('error', () => {
      try {
        spawn('cmd.exe', ['/c', 'start', '', path.dirname(file)], { detached: true, stdio: 'ignore' }).unref()
      } catch {
        /* ignore */
      }
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function buildMarkdown(entries) {
  const lines = ['# 录像档案', '', `导出时间：${new Date().toLocaleString('zh-CN')}`, '']
  const sorted = [...entries].sort((a, b) => (b.meta?.createdAt || b.mtimeMs || 0) - (a.meta?.createdAt || a.mtimeMs || 0))
  for (const entry of sorted) {
    const user = entry.user || {}
    const title = user.title || entry.name
    const game = user.game || ''
    const summary = user.summary || ''
    const tags = user.tags || []
    const when = new Date(entry.meta?.createdAt || entry.mtimeMs || Date.now())
    lines.push(`## ${title}`)
    lines.push('')
    const facts = [
      game ? `游戏：${game}` : '',
      `时长：${fmtClock(entry.meta?.duration || 0)}`,
      `大小：${fmtBytes(entry.size)}`,
      `录制：${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
    ].filter(Boolean)
    lines.push(`- ${facts.join(' · ')}`)
    lines.push(`- 文件：\`${entry.path}\``)
    if (summary) {
      lines.push('')
      lines.push(summary)
    }
    if (tags.length) {
      lines.push('')
      lines.push(tags.map((tag) => `\`${tag}\``).join(' '))
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function createHttpHandler({ archive, store, ffmpeg, games, getOrigin, logger = console }) {
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.replace(new RegExp(`^${PREFIX}`), '') || '/'
    const method = req.method || 'GET'
    try {
      // ---------------------------------------------------------- 静态页面
      if (method === 'GET' && (route === '/' || route === '/index.html')) {
        return sendFile(res, path.join(WEB_DIR, 'index.html'))
      }
      if (method === 'GET' && (route === '/app.js' || route === '/style.css' || route === '/icon.svg')) {
        return sendFile(res, path.join(WEB_DIR, route.slice(1)))
      }

      // ---------------------------------------------------------- 只读接口
      if (method === 'GET' && route === '/api/state') {
        const state = archive.state()
        // 嵌在 DSH 里时前端拿到的是 dsh-app:// 地址；把真实 http 源一并给它，用于弹独立窗口
        state.origin = getOrigin ? getOrigin() : ''
        state.storage = store.healthCheck()
        state.api = API_VERSION
        return json(res, 200, state)
      }
      if (method === 'GET' && route === '/api/videos') {
        return json(res, 200, { ok: true, videos: archive.list(), stats: store.stats() })
      }
      if (method === 'GET' && route === '/api/deps') {
        const result = await collectDeps({ ffmpeg, store })
        return json(res, 200, result)
      }
      if (method === 'GET' && route === '/api/games') {
        return json(res, 200, archive.gamesView())
      }
      if (method === 'GET' && route === '/api/thumb') {
        const id = String(url.searchParams.get('id') || '')
        const entry = store.get(id)
        if (!entry) return json(res, 404, { ok: false, error: '没有这个视频' })
        const wanted = path.basename(String(url.searchParams.get('f') || 'cover.jpg'))
        const dir = store.thumbDir(id)
        const file = path.join(dir, wanted)
        if (!file.startsWith(dir) || !fs.existsSync(file)) return json(res, 404, { ok: false, error: '没有这张图' })
        return sendFile(res, file, { cache: 'public, max-age=604800' })
      }
      if (method === 'GET' && route === '/api/video') {
        const id = String(url.searchParams.get('id') || '')
        const entry = store.get(id)
        if (!entry) return json(res, 404, { ok: false, error: '没有这个视频' })
        if (!fs.existsSync(entry.path)) return json(res, 404, { ok: false, error: '源文件不在了' })
        return streamVideo(req, res, entry.path, { download: url.searchParams.get('dl') === '1' })
      }
      if (method === 'GET' && route === '/api/export') {
        const format = String(url.searchParams.get('format') || 'md')
        const entries = archive.list()
        if (format === 'json') {
          const body = JSON.stringify({ exportedAt: new Date().toISOString(), videos: entries }, null, 2)
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('content-disposition', 'attachment; filename="video-archive.json"')
          res.setHeader('content-length', Buffer.byteLength(body))
          res.end(body)
          return true
        }
        const body = buildMarkdown(entries)
        res.statusCode = 200
        res.setHeader('content-type', 'text/markdown; charset=utf-8')
        res.setHeader('content-disposition', 'attachment; filename="video-archive.md"')
        res.setHeader('content-length', Buffer.byteLength(body))
        res.end(body)
        return true
      }

      // ---------------------------------------------------------- 写接口
      if (method !== 'POST') return json(res, 405, { ok: false, error: '只支持 GET/POST' })
      if (route === '/api/reload') {
        const result = store.reload()
        if (result.ok) games.setDataDir(store.dataDir)
        return json(res, result.ok ? 200 : 400, { ...result, storage: store.status() })
      }
      if (!store.canWrite()) {
        const storage = store.status()
        return json(res, 503, { ok: false, error: `档案目录现在不可用（${storage.error || '读不到'}），接回来再试` })
      }
      if (String(req.headers['x-va'] || '') !== '1') return json(res, 403, { ok: false, error: '缺少 x-va 请求头' })
      const body = await readBody(req)

      if (route === '/api/scan-folder') {
        const result = archive.scanFolder()
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/api/add') {
        const paths = Array.isArray(body.paths) ? body.paths : [body.path || '']
        const result = archive.addPaths(paths.filter(Boolean))
        return json(res, result.added || result.skipped || !result.errors.length ? 200 : 400, result)
      }
      if (route === '/api/cancel') {
        archive.cancel()
        return json(res, 200, { ok: true })
      }
      if (route === '/api/update') {
        const result = await archive.update(String(body.id || ''), body)
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/api/refresh') {
        const result = await archive.refresh(String(body.id || ''))
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/api/pick-folder') {
        // 调 Windows 原生的「选择文件夹」对话框，等用户选完再返回
        const result = await pickFolder('选择录像文件夹')
        return json(res, 200, result)
      }
      if (route === '/api/remove') {
        const result = await archive.removeVideo(String(body.id || ''), { withFile: body.withFile === true })
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/api/games') {
        const action = String(body.action || '')
        let result
        if (action === 'create') result = archive.createGame({ name: body.name, category: body.category, aliases: body.aliases })
        else if (action === 'update') result = archive.updateGame(String(body.id || ''), body.patch || {})
        else if (action === 'merge') result = archive.mergeGames(String(body.from || ''), String(body.to || ''))
        else if (action === 'delete') result = archive.removeGame(String(body.id || ''))
        else result = { ok: false, error: `不认识的操作：${action}` }
        return json(res, result.ok ? 200 : 400, { ...result, view: archive.gamesView() })
      }
      if (route === '/api/categories') {
        const action = String(body.action || '')
        const result = archive.categories(action, { name: body.name, from: body.from, to: body.to })
        return json(res, result.ok ? 200 : 400, { ...result, view: archive.gamesView() })
      }
      if (route === '/api/config') {
        const patch = body.patch || body
        const config = store.patchConfig(patch)
        // 改了录像文件夹：档案默认跟着走（除非被明确指定过目录）
        if (Object.prototype.hasOwnProperty.call(patch, 'scanFolder') && !store.explicit) {
          const derived = dataDirForScan(config.scanFolder)
          const targetFolder = String(config.scanFolder || '')
          if (derived && path.resolve(derived) !== store.dataDir && targetFolder && fs.existsSync(targetFolder)) {
            const moved = store.relocate(derived, { migrate: false, explicit: false })
            if (moved.ok) games.setDataDir(store.dataDir)
          }
        }
        return json(res, 200, { ok: true, config, dataDir: store.dataDir })
      }
      if (route === '/api/data-dir') {
        // 唯一一个「手动指定档案路径」的接口（界面上没有入口）
        const result = await store.relocate(body.path, { migrate: body.migrate === true, explicit: true })
        if (result.ok) games.setDataDir(store.dataDir)
        return json(res, result.ok ? 200 : 400, result)
      }
      if (route === '/api/reveal') {
        const entry = store.get(String(body.id || ''))
        if (!entry) return json(res, 400, { ok: false, error: '没有这个视频' })
        const ok = revealInExplorer(entry.path)
        return json(res, ok ? 200 : 400, { ok, error: ok ? '' : '打不开资源管理器' })
      }
      if (route === '/api/ffmpeg/check') {
        const info = ffmpeg.resolve(true)
        return json(res, 200, { ok: info.ok, dir: info.dir, tried: info.tried.slice(0, 10) })
      }
      return json(res, 404, {
        ok: false,
        stale: true,
        error: `这个接口属于插件新版本，当前跑的还是旧版本（重启 DSH 后可用）：${method} ${route}`,
      })
    } catch (error) {
      logger.warn?.(`HTTP ${method} ${route} 失败：${error.message}`)
      return json(res, 400, { ok: false, error: error.message })
    }
  }
  return { path: PREFIX, handler }
}

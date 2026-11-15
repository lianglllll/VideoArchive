import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, deepMerge, sha1, now, copyDir } from './util.js'

const DEFAULT_CONFIG = {
  frames: 6,
  ffmpegPath: '',
  // 打开页面时自动扫一次这个文件夹（不用就留空）
  scanFolder: '',
  scanDeep: false,
  // 保存视频信息后把录像移动到指定文件夹（默认关，动了就改原文件路径）
  moveEnabled: false,
  moveTarget: '',
  // none | game | month
  moveGroupBy: 'game',
}

// 以前版本留下、现在不用的配置，读进来直接丢掉
const LEGACY_KEYS = [
  'aiEnabled',
  'autoDescribe',
  'maxAutoDescribe',
  'describeHint',
  'folders',
  'watch',
  'watchMinutes',
  'minSizeMB',
  'skipRecentSeconds',
  'dataDir',
  'scanOnOpen',
]

/** 数据目录的「指针文件」：插件启动时读它，决定档案存在哪。 */
export function defaultLocationFile() {
  return path.join(os.homedir(), '.dsh', 'VideoArchive.location.json')
}

export function resolveDataDir(fallback, locationFile = defaultLocationFile()) {
  const saved = readJson(locationFile, {}).dataDir
  if (typeof saved === 'string' && saved.trim()) return path.resolve(saved.trim())
  return path.resolve(fallback)
}

export class Store {
  constructor({ dataDir, locationFile = '', logger = console }) {
    this.dataDir = path.resolve(dataDir)
    this.locationFile = locationFile
    this.logger = logger
    this.thumbsDir = path.join(this.dataDir, 'thumbs')
    this.indexFile = path.join(this.dataDir, 'index.json')
    this.configFile = path.join(this.dataDir, 'config.json')
    ensureDir(this.thumbsDir)
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    for (const key of LEGACY_KEYS) delete this.config[key]
    const raw = readJson(this.indexFile, { version: 1, videos: {} })
    this.db = {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      videos: raw && typeof raw.videos === 'object' && raw.videos ? raw.videos : {},
    }
    // 旧版本存的 AI 描述已经不用了，读进来顺手清掉，别让 index.json 里留一堆死数据
    let cleaned = false
    for (const entry of Object.values(this.db.videos)) {
      if (entry.caption !== undefined) {
        delete entry.caption
        cleaned = true
      }
    }
    if (cleaned) writeJsonAtomic(this.indexFile, this.db)
    this.saveTimer = null
  }

  /** 换一个存放档案的目录。migrate=true 时把 index/games/config/thumbs 一起复制过去。 */
  async relocate(nextDir, { migrate = true } = {}) {
    const target = path.resolve(String(nextDir || '').trim())
    if (!target) return { ok: false, error: '路径不能为空' }
    if (target === this.dataDir) return { ok: true, unchanged: true, dataDir: target }
    try {
      ensureDir(path.join(target, 'thumbs'))
    } catch (error) {
      return { ok: false, error: `建不了这个目录：${error.message}` }
    }

    this.flush()
    let copied = 0
    if (migrate) {
      for (const name of ['index.json', 'games.json', 'config.json']) {
        const from = path.join(this.dataDir, name)
        if (!fs.existsSync(from)) continue
        try {
          fs.copyFileSync(from, path.join(target, name))
          copied += 1
        } catch (error) {
          return { ok: false, error: `复制 ${name} 失败：${error.message}` }
        }
      }
      copied += copyDir(this.thumbsDir, path.join(target, 'thumbs'))
    }

    this.dataDir = target
    this.thumbsDir = path.join(target, 'thumbs')
    this.indexFile = path.join(target, 'index.json')
    this.configFile = path.join(target, 'config.json')

    if (this.locationFile) writeJsonAtomic(this.locationFile, { dataDir: target, updatedAt: now() })

    // 重新从新目录读一遍
    const raw = readJson(this.indexFile, { version: 1, videos: {} })
    this.db = {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      videos: raw && typeof raw.videos === 'object' && raw.videos ? raw.videos : {},
    }
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    for (const key of LEGACY_KEYS) delete this.config[key]

    this.logger.info?.(`档案目录已切到 ${target}${migrate ? `（复制了 ${copied} 个文件）` : ''}`)
    return { ok: true, dataDir: target, copied, migrated: migrate }
  }

  configPath() {
    return this.configFile
  }

  getConfig() {
    return this.config
  }

  patchConfig(patch) {
    const next = deepMerge(this.config, patch || {})
    next.frames = [4, 6, 9].includes(Number(next.frames)) ? Number(next.frames) : 6
    next.scanFolder = String(next.scanFolder || '').trim()
    next.scanDeep = Boolean(next.scanDeep)
    next.moveEnabled = Boolean(next.moveEnabled)
    next.moveTarget = String(next.moveTarget || '').trim()
    next.moveGroupBy = ['none', 'game', 'month'].includes(next.moveGroupBy) ? next.moveGroupBy : 'none'
    for (const key of LEGACY_KEYS) delete next[key]
    this.config = next
    writeJsonAtomic(this.configFile, next)
    return next
  }

  thumbDir(id) {
    return path.join(this.thumbsDir, id)
  }

  entries() {
    return Object.values(this.db.videos)
  }

  get(id) {
    return this.db.videos[id] || null
  }

  countOf(state) {
    return this.entries().filter((item) => (item.state || '') === state).length
  }

  upsert(entry) {
    if (!entry?.id) return null
    const previous = this.db.videos[entry.id] || {}
    this.db.videos[entry.id] = { ...previous, ...entry, updatedAt: now() }
    this.touch()
    return this.db.videos[entry.id]
  }

  remove(id) {
    const entry = this.db.videos[id]
    if (!entry) return false
    delete this.db.videos[id]
    try {
      fs.rmSync(this.thumbDir(id), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    this.touch()
    return true
  }

  touch() {
    this.db.updatedAt = now()
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 900)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  flush() {
    writeJsonAtomic(this.indexFile, this.db)
  }

  stats() {
    const list = this.entries()
    const filled = list.filter((item) => item.user?.title || item.user?.game || item.user?.summary).length
    const missing = list.filter((item) => item.state === 'missing').length
    const totalSeconds = list.reduce((sum, item) => sum + (Number(item.meta?.duration) || 0), 0)
    const totalBytes = list.reduce((sum, item) => sum + (Number(item.meta?.size) || 0), 0)
    return {
      videos: list.length,
      filled,
      missing,
      pending: Math.max(0, list.length - filled),
      totalSeconds,
      totalBytes,
    }
  }

  static idFor(file) {
    return sha1(path.resolve(String(file)).toLowerCase()).slice(0, 12)
  }
}

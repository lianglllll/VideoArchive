import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, readJson, readJsonStrict, writeJsonAtomic, deepMerge, sha1, now, copyDir } from './util.js'

const DEFAULT_CONFIG = {
  frames: 6,
  ffmpegPath: '',
  // 打开页面时自动扫一次这个文件夹（不用就留空）
  scanFolder: '',
  scanDeep: false,
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
  'moveEnabled',
  'moveTarget',
  'moveGroupBy',
]

/** 数据目录的「指针文件」：插件启动时读它，决定档案存在哪。 */
export function defaultLocationFile() {
  return path.join(os.homedir(), '.dsh', 'VideoArchive.location.json')
}

/** 读指针：{ dataDir, explicit }。explicit 表示是用户/agent 明确指定的，不跟随录像文件夹。 */
export function readLocation(locationFile = defaultLocationFile()) {
  const raw = readJson(locationFile, {})
  return {
    dataDir: typeof raw.dataDir === 'string' ? raw.dataDir.trim() : '',
    explicit: raw.explicit === true,
  }
}

export function resolveDataDir(fallback, locationFile = defaultLocationFile()) {
  const saved = readLocation(locationFile).dataDir
  if (saved) return path.resolve(saved)
  return path.resolve(fallback)
}

/** 档案默认放哪：<录像文件夹>/.VideoArchive；没设录像文件夹就用默认目录。 */
export function dataDirForScan(scanFolder) {
  const folder = String(scanFolder || '').trim()
  if (!folder) return ''
  return path.join(path.resolve(folder), '.VideoArchive')
}

export class Store {
  constructor({ dataDir, locationFile = '', logger = console }) {
    this.dataDir = path.resolve(dataDir)
    this.locationFile = locationFile
    this.explicit = locationFile ? readLocation(locationFile).explicit : false
    this.logger = logger
    this.thumbsDir = path.join(this.dataDir, 'thumbs')
    this.indexFile = path.join(this.dataDir, 'index.json')
    this.configFile = path.join(this.dataDir, 'config.json')
    this.readOnly = false
    this.readOnlyReason = ''
    this.lastWriteError = ''
    this.saveTimer = null

    // 先确认这块地方真的能用（外接盘没接、权限不对，都在这拦下来）
    const probe = this.probeStorage()
    if (!probe.ok) {
      this.readOnly = true
      this.readOnlyReason = probe.reason
      this.missingScanFolder = Boolean(probe.missingScanFolder)
      this.scanFolderMissing = probe.scanFolder || ''
      this.db = { version: 1, updatedAt: 0, videos: {} }
      this.config = deepMerge(DEFAULT_CONFIG, {})
      for (const key of LEGACY_KEYS) delete this.config[key]
      this.logger.warn?.(`档案目录不可用，进入只读：${probe.reason}`)
      return
    }

    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    for (const key of LEGACY_KEYS) delete this.config[key]

    // 「文件不存在」= 全新库；「读不了」= 盘掉了/坏了，绝不能当空库用
    const read = readJsonStrict(this.indexFile)
    if (!read.ok && !read.missing) {
      this.readOnly = true
      this.readOnlyReason = `读不了 index.json（${read.error}）`
      this.logger.warn?.(`${this.readOnlyReason}，进入只读`)
    }
    const raw = read.ok ? read.value : { version: 1, videos: {} }
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
    if (cleaned) this.writeSafe(this.indexFile, this.db)
  }

  /**
   * 档案目录现在能不能用（读得到、写得进）。
   * 注意：**不会**在录像文件夹不存在时把它建出来——那多半是用户改名/挪走了，
   * 悄悄建一个空文件夹只会让人以为档案没了。
   */
  probeStorage() {
    // 档案目录挂在录像文件夹下面；父目录不在 = 文件夹被改名或移动了
    const parent = path.dirname(this.dataDir)
    const underScanFolder = path.basename(this.dataDir) === '.VideoArchive'
    if (underScanFolder && !fs.existsSync(parent)) {
      return { ok: false, reason: `找不到录像文件夹：${parent}`, missingScanFolder: true, scanFolder: parent }
    }
    try {
      fs.mkdirSync(this.thumbsDir, { recursive: true })
    } catch (error) {
      return { ok: false, reason: `建不了档案目录（${error.message}）` }
    }
    const probeFile = path.join(this.dataDir, '.write-probe')
    try {
      fs.writeFileSync(probeFile, 'ok')
      fs.unlinkSync(probeFile)
    } catch (error) {
      return { ok: false, reason: `档案目录写不进去（${error.message}）` }
    }
    return { ok: true, reason: '' }
  }

  canWrite() {
    return !this.readOnly
  }

  /** 写 JSON 的统一入口：只读时拒绝，写失败立刻降级成只读并记原因 */
  writeSafe(file, value) {
    if (this.readOnly) {
      this.lastWriteError = this.readOnlyReason || '档案目录不可用'
      return false
    }
    // 写之前再看一眼目录在不在（盘可能刚掉/文件夹刚被改名）
    if (!fs.existsSync(this.dataDir)) {
      this.readOnly = true
      this.readOnlyReason = `档案目录不在了：${this.dataDir}`
      this.lastWriteError = this.readOnlyReason
      return false
    }
    if (writeJsonAtomic(file, value)) return true
    this.readOnly = true
    this.lastWriteError = `写不了 ${path.basename(file)}（盘被拔了或没权限）`
    this.readOnlyReason = this.lastWriteError
    this.logger.warn?.(this.lastWriteError)
    return false
  }

  /** 接回来之后重新读一遍盘 */
  reload() {
    const probe = this.probeStorage()
    if (!probe.ok) {
      this.readOnly = true
      this.readOnlyReason = probe.reason
      this.missingScanFolder = Boolean(probe.missingScanFolder)
      this.scanFolderMissing = probe.scanFolder || ''
      return { ok: false, error: probe.reason }
    }
    this.missingScanFolder = false
    this.scanFolderMissing = ''
    const read = readJsonStrict(this.indexFile)
    if (!read.ok && !read.missing) {
      this.readOnly = true
      this.readOnlyReason = `读不了 index.json（${read.error}）`
      return { ok: false, error: this.readOnlyReason }
    }
    const raw = read.ok ? read.value : { version: 1, videos: {} }
    this.db = {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      videos: raw && typeof raw.videos === 'object' && raw.videos ? raw.videos : {},
    }
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    for (const key of LEGACY_KEYS) delete this.config[key]
    this.readOnly = false
    this.readOnlyReason = ''
    this.lastWriteError = ''
    return { ok: true, videos: Object.keys(this.db.videos).length }
  }

  /** 列表请求时顺便摸一下目录还在不在（拔盘后十几秒内就能反映到界面） */
  healthCheck() {
    if (!this.readOnly && !fs.existsSync(this.dataDir)) {
      const parent = path.dirname(this.dataDir)
      const underScanFolder = path.basename(this.dataDir) === '.VideoArchive'
      this.readOnly = true
      this.missingScanFolder = underScanFolder && !fs.existsSync(parent)
      this.scanFolderMissing = this.missingScanFolder ? parent : ''
      this.readOnlyReason = this.missingScanFolder ? `找不到录像文件夹：${parent}` : `档案目录不在了：${this.dataDir}`
    }
    return this.status()
  }

  status() {
    return {
      ok: !this.readOnly,
      readOnly: this.readOnly,
      dataDir: this.dataDir,
      missingScanFolder: Boolean(this.missingScanFolder),
      scanFolder: this.scanFolderMissing || '',
      error: this.readOnlyReason || this.lastWriteError,
    }
  }

  /**
   * 换一个档案目录。
   * 默认只「切过去、在新目录建一套空的」（旧档案原样留在原处，切回去还能用）；
   * migrate=true 才把 index/games/thumbs 复制过去。
   * 配置（含录像文件夹）永远跟着走，否则新档案不知道自己属于哪个文件夹。
   */
  relocate(nextDir, { migrate = false, explicit = this.explicit } = {}) {
    const target = path.resolve(String(nextDir || '').trim())
    if (!target) return { ok: false, error: '路径不能为空' }
    if (target === this.dataDir) {
      this.explicit = explicit
      if (this.locationFile) writeJsonAtomic(this.locationFile, { dataDir: target, explicit, updatedAt: now() })
      return { ok: true, unchanged: true, dataDir: target }
    }
    try {
      ensureDir(path.join(target, 'thumbs'))
    } catch (error) {
      return { ok: false, error: `建不了这个目录：${error.message}` }
    }

    this.flush()
    let copied = 0
    if (migrate) {
      for (const name of ['index.json', 'games.json']) {
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

    // 配置始终写一份到新目录（不然新档案丢了 scanFolder）
    if (!writeJsonAtomic(path.join(target, 'config.json'), this.config)) {
      return { ok: false, error: '新目录写不进配置，可能没有权限' }
    }

    this.dataDir = target
    this.thumbsDir = path.join(target, 'thumbs')
    this.indexFile = path.join(target, 'index.json')
    this.configFile = path.join(target, 'config.json')

    this.explicit = explicit
    if (this.locationFile) writeJsonAtomic(this.locationFile, { dataDir: target, explicit, updatedAt: now() })

    // 重新从新目录读一遍（新目录没有 index.json 就是空库）
    const raw = readJson(this.indexFile, { version: 1, videos: {} })
    this.db = {
      version: 1,
      updatedAt: Number(raw.updatedAt) || 0,
      videos: raw && typeof raw.videos === 'object' && raw.videos ? raw.videos : {},
    }
    this.config = deepMerge(DEFAULT_CONFIG, readJson(this.configFile, {}))
    for (const key of LEGACY_KEYS) delete this.config[key]

    this.logger.info?.(`档案目录已切到 ${target}${migrate ? `（复制了 ${copied} 个文件）` : '（新目录，从空开始）'}`)
    return { ok: true, dataDir: target, copied, migrated: migrate }
  }

  /** 把当前数据目录写进指针文件（启动时调一次，下次启动就不用猜了） */
  saveLocation() {
    if (!this.locationFile) return
    writeJsonAtomic(this.locationFile, { dataDir: this.dataDir, explicit: this.explicit, updatedAt: now() })
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
    for (const key of LEGACY_KEYS) delete next[key]
    this.config = next
    this.writeSafe(this.configFile, next)
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
    this.writeSafe(this.indexFile, this.db)
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

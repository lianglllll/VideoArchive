import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, readJson, writeJsonAtomic, now } from './util.js'

const DEFAULT_CATEGORIES = ['动作', '射击', '角色扮演', '策略', '模拟经营', '多人联机', '休闲', '其他']

/** 名称归一化：去空格、标点、大小写，用来判重和匹配。 */
export function gameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s\-_·:：,，.。'’"“”()（）[\]【】]/g, '')
    .trim()
}

function cleanName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

function cleanAliases(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，、;；|]/)
  const out = []
  for (const item of list) {
    const text = cleanName(item)
    if (!text) continue
    if (!out.some((existing) => gameKey(existing) === gameKey(text))) out.push(text)
    if (out.length >= 12) break
  }
  return out
}

/**
 * 游戏库：游戏名 + 别名 + 类别。
 * 视频里存的是「显示名」，这里负责把各种叫法（别名、大小写、空格差异）收敛到同一条上。
 */
export class GameBook {
  constructor({ dataDir, logger = console }) {
    this.logger = logger
    this.setDataDir(dataDir)
  }

  /** 指向某个数据目录并读出来（切换档案目录时也用它） */
  setDataDir(dataDir) {
    this.file = path.join(dataDir, 'games.json')
    ensureDir(dataDir)
    const raw = readJson(this.file, null)
    this.db = {
      version: 1,
      categories: Array.isArray(raw?.categories) && raw.categories.length ? raw.categories.map((item) => cleanName(item)).filter(Boolean) : [...DEFAULT_CATEGORIES],
      games: raw?.games && typeof raw.games === 'object' ? raw.games : {},
    }
    return this
  }

  save() {
    writeJsonAtomic(this.file, this.db)
  }

  categories() {
    return [...this.db.categories]
  }

  setCategories(list) {
    const next = []
    for (const item of Array.isArray(list) ? list : []) {
      const name = cleanName(item)
      if (name && !next.includes(name)) next.push(name)
    }
    this.db.categories = next
    // 类别被删掉后，游戏跟着回到未分类
    for (const game of Object.values(this.db.games)) {
      if (game.category && !next.includes(game.category)) game.category = ''
    }
    this.save()
    return next
  }

  list() {
    return Object.values(this.db.games).sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
  }

  get(id) {
    return this.db.games[id] || null
  }

  /** 按名字或别名找（都做过归一化）。 */
  find(name) {
    const key = gameKey(name)
    if (!key) return null
    for (const game of Object.values(this.db.games)) {
      if (gameKey(game.name) === key) return game
      if (game.aliases.some((alias) => gameKey(alias) === key)) return game
    }
    return null
  }

  create({ name, category = '', aliases = [] } = {}) {
    const display = cleanName(name)
    if (!display) return { ok: false, error: '游戏名不能为空' }
    const existing = this.find(display)
    if (existing) return { ok: false, error: `已经有「${existing.name}」了` }
    const id = `g_${crypto.randomBytes(4).toString('hex')}`
    const game = {
      id,
      name: display,
      aliases: cleanAliases(aliases),
      category: this.db.categories.includes(category) ? category : '',
      createdAt: now(),
    }
    this.db.games[id] = game
    this.save()
    return { ok: true, game }
  }

  /** 视频描述里冒出来的名字：有就复用，没有就建一条（未分类）。 */
  ensure(name) {
    const target = cleanName(name)
    if (!target) return null
    const existing = this.find(target)
    if (existing) return existing
    const created = this.create({ name: target })
    return created.ok ? created.game : this.find(target)
  }

  update(id, patch = {}) {
    const game = this.get(id)
    if (!game) return { ok: false, error: '没有这个游戏' }
    if (patch.name !== undefined) {
      const name = cleanName(patch.name)
      if (!name) return { ok: false, error: '游戏名不能为空' }
      const clash = this.find(name)
      if (clash && clash.id !== id) return { ok: false, error: `已经有「${clash.name}」了` }
      game.name = name
    }
    if (patch.aliases !== undefined) game.aliases = cleanAliases(patch.aliases)
    if (patch.category !== undefined) game.category = this.db.categories.includes(patch.category) ? patch.category : ''
    this.save()
    return { ok: true, game }
  }

  remove(id) {
    if (!this.db.games[id]) return { ok: false, error: '没有这个游戏' }
    delete this.db.games[id]
    this.save()
    return { ok: true }
  }

  /** 把 from 合并进 to：别名并集，返回被删掉的那条，方便调用方改视频。 */
  merge(fromId, toId) {
    const from = this.get(fromId)
    const to = this.get(toId)
    if (!from || !to) return { ok: false, error: '要合并的游戏不存在' }
    if (from.id === to.id) return { ok: false, error: '不能合并到自己' }
    to.aliases = cleanAliases([...to.aliases, from.name, ...from.aliases]).filter((alias) => gameKey(alias) !== gameKey(to.name))
    if (!to.category && from.category) to.category = from.category
    delete this.db.games[fromId]
    this.save()
    return { ok: true, from, to }
  }

  addCategory(name) {
    const text = cleanName(name)
    if (!text) return { ok: false, error: '类别名不能为空' }
    if (this.db.categories.includes(text)) return { ok: false, error: '已经有这个类别了' }
    this.db.categories.push(text)
    this.save()
    return { ok: true, categories: this.categories() }
  }

  renameCategory(from, to) {
    const next = cleanName(to)
    if (!next) return { ok: false, error: '类别名不能为空' }
    if (!this.db.categories.includes(from)) return { ok: false, error: '没有这个类别' }
    if (this.db.categories.includes(next)) return { ok: false, error: '已经有这个类别了' }
    this.db.categories = this.db.categories.map((item) => (item === from ? next : item))
    for (const game of Object.values(this.db.games)) {
      if (game.category === from) game.category = next
    }
    this.save()
    return { ok: true, categories: this.categories() }
  }

  removeCategory(name) {
    this.db.categories = this.db.categories.filter((item) => item !== name)
    for (const game of Object.values(this.db.games)) {
      if (game.category === name) game.category = ''
    }
    this.save()
    return { ok: true, categories: this.categories() }
  }

  summary() {
    const games = this.list()
    const counts = {}
    for (const game of games) counts[game.category || ''] = (counts[game.category || ''] || 0) + 1
    return { games: games.length, categories: this.categories().length, counts }
  }
}

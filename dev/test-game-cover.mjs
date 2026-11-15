// 游戏封面：上传的图 > 指定视频 > 默认
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { GameBook } from '../lib/games.js'
import { Archive } from '../lib/archive.js'

const log = { info: () => {}, warn: () => {}, error: () => {} }
const ffmpeg = { resolve: () => ({ ok: true, ffmpeg: '', ffprobe: '' }), run: async () => ({ ok: false }) }

let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cover-'))
fs.mkdirSync(path.join(base, 'Case'))
const store = new Store({ dataDir: path.join(base, 'Case', '.VideoArchive'), logger: log })
store.patchConfig({ scanFolder: path.join(base, 'Case') })
const games = new GameBook({ dataDir: store.dataDir, logger: log })
const archive = new Archive({ store, ffmpeg, games, logger: log })

const game = games.ensure('CFHD')
store.upsert({ id: 'v1', path: path.join(base, 'Case', 'a.mp4'), name: 'a.mp4', size: 1, state: 'ready', cover: 'cover.jpg', user: { game: 'CFHD', title: 'a' } })
store.upsert({ id: 'v2', path: path.join(base, 'Case', 'b.mp4'), name: 'b.mp4', size: 1, state: 'ready', cover: 'cover.jpg', user: { game: 'CFHD', title: 'b' } })
store.flush()

let view = archive.gamesView().games.find((g) => g.id === game.id)
check('默认来自第一条视频', view.cover.includes('id=v1'), true)

// 上传一张图
const name = archive.saveGameCover(game.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpg')
games.update(game.id, { cover: `file:${name}` })
view = archive.gamesView().games.find((g) => g.id === game.id)
check('上传后走 game-cover 接口', view.cover.includes('/api/game-cover?id='), true)
check('文件名带游戏 id 前缀', fs.existsSync(path.join(store.dataDir, 'covers', name)), true)

// 换一张：旧的应该被清掉
const name2 = archive.saveGameCover(game.id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpg')
games.update(game.id, { cover: `file:${name2}` })
archive.dropGameCoverFiles(game.id, name2)
check('换图后旧图被删', fs.existsSync(path.join(store.dataDir, 'covers', name)), false)
check('新图还在', fs.existsSync(path.join(store.dataDir, 'covers', name2)), true)

// 指定某条视频的封面
games.update(game.id, { cover: 'v2' })
view = archive.gamesView().games.find((g) => g.id === game.id)
check('指定视频后走 thumb 接口', view.cover.includes('id=v2'), true)

// 清空回默认
games.update(game.id, { cover: '' })
archive.dropGameCoverFiles(game.id, '')
view = archive.gamesView().games.find((g) => g.id === game.id)
check('清空后回到默认', view.cover.includes('id=v1'), true)
check('清空后图片被删干净', fs.existsSync(path.join(store.dataDir, 'covers', name2)), false)

fs.rmSync(base, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 项不符合预期` : '\n✓ 全部符合预期')
process.exit(fail ? 1 : 0)
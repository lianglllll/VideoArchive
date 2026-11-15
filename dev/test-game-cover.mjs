// 游戏封面：手动指定某条视频的封面，没指定就用默认
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

games.ensure('CFHD')

// 造两个视频，各带封面
store.upsert({ id: 'v1', path: path.join(base, 'Case', 'a.mp4'), name: 'a.mp4', size: 1, state: 'ready', cover: 'cover.jpg', user: { game: 'CFHD', title: 'a' } })
store.upsert({ id: 'v2', path: path.join(base, 'Case', 'b.mp4'), name: 'b.mp4', size: 1, state: 'ready', cover: 'cover.jpg', user: { game: 'CFHD', title: 'b' } })
store.flush()

let view = archive.gamesView().games.find((g) => g.name === 'CFHD')
check('默认封面来自第一条', view.cover.includes('id=v1'), true)
check('coverId 为空', view.coverId, '')

games.update(view.id, { cover: 'v2' })
view = archive.gamesView().games.find((g) => g.name === 'CFHD')
check('指定后封面来自 v2', view.cover.includes('id=v2'), true)
check('coverId = v2', view.coverId, 'v2')

games.update(view.id, { cover: '' })
view = archive.gamesView().games.find((g) => g.name === 'CFHD')
check('清掉后回到默认', view.cover.includes('id=v1'), true)

fs.rmSync(base, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 项不符合预期` : '\n✓ 全部符合预期')
process.exit(fail ? 1 : 0)

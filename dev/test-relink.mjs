// 文件夹改名后重新扫：按「同名 + 同大小」把老记录接回来
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../lib/store.js'
import { GameBook } from '../lib/games.js'
import { Archive } from '../lib/archive.js'

const log = { info: () => {}, warn: () => {}, error: () => {} }
const ffmpeg = { resolve: () => ({ ok: true, ffmpeg: '', ffprobe: '', dir: '' }), run: async () => ({ ok: false, stderr: 'mock' }) }

let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'va-relink-'))
const dirA = path.join(base, 'GameVideo')
const dirB = path.join(base, 'GameVideo1')
fs.mkdirSync(dirA)
fs.mkdirSync(dirB)

const store = new Store({ dataDir: path.join(base, 'archive'), logger: log })
const games = new GameBook({ dataDir: store.dataDir, logger: log })
const archive = new Archive({ store, ffmpeg, games, logger: log })

// 先在 A 里收一个文件
const fileA = path.join(dirA, 'clip.mp4')
fs.writeFileSync(fileA, Buffer.alloc(2048, 7))
const first = archive.addPaths([fileA])
check('首次加入 1 条', first.added + first.relinked, 1)
const before = store.entries()[0]
check('记录路径指向 A', before.path, fileA)

// 文件夹改名（把文件挪到 B）
const fileB = path.join(dirB, 'clip.mp4')
fs.renameSync(fileA, fileB)
check('旧路径已不存在', fs.existsSync(before.path), false)

// 重新扫 B
const again = archive.addPaths([fileB])
check('认回 1 条（不新增）', again.relinked, 1)
check('没有新增记录', again.added, 0)
const after = store.entries()[0]
check('记录总数仍是 1', store.entries().length, 1)
check('id 没变', after.id, before.id)
check('路径更新到 B', after.path, fileB)

fs.rmSync(base, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 项不符合预期` : '\n✓ 全部符合预期')
process.exit(fail ? 1 : 0)

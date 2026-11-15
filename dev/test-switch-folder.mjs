// 换录像文件夹：只在新目录建一套空的，旧档案原样留着
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, dataDirForScan } from '../lib/store.js'

const log = { info: () => {}, warn: () => {}, error: () => {} }
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'va-switch-'))
const dirA = path.join(base, 'A', '.VideoArchive')
const dirB = path.join(base, 'B', '.VideoArchive')

const store = new Store({ dataDir: dirA, logger: log })
store.patchConfig({ scanFolder: path.join(base, 'A') })
store.upsert({ id: 'v1', path: path.join(base, 'A', 'one.mp4'), name: 'one.mp4', size: 1 })
store.flush()
check('A 里有 1 条', store.entries().length, 1)

// 切到 B（就是 patched config 后由 http 层调 relocate 的那一步）
store.patchConfig({ scanFolder: path.join(base, 'B') })
const moved = store.relocate(dataDirForScan(path.join(base, 'B')), { migrate: false, explicit: false })
check('切换成功', moved.ok, true)
check('当前是 B', store.dataDir, dirB)
check('B 是空库', store.entries().length, 0)
check('B 有 config.json', fs.existsSync(path.join(dirB, 'config.json')), true)
check('B 没有 index.json', fs.existsSync(path.join(dirB, 'index.json')), false)
check('B 的 config 记住了 scanFolder', store.getConfig().scanFolder, path.join(base, 'B'))

// 旧档案还在
const oldIndex = JSON.parse(fs.readFileSync(path.join(dirA, 'index.json'), 'utf8'))
check('A 的 index.json 仍有 v1', Object.keys(oldIndex.videos), ['v1'])

// 切回 A：重新读到原来的记录
store.patchConfig({ scanFolder: path.join(base, 'A') })
store.relocate(dataDirForScan(path.join(base, 'A')), { migrate: false, explicit: false })
check('切回 A 后读到 1 条', store.entries().length, 1)

fs.rmSync(base, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 项不符合预期` : '\n✓ 全部符合预期')
process.exit(fail ? 1 : 0)

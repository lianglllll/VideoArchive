// 断盘保护的自测：真实文件系统上跑三种情况
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../lib/store.js'

const log = { info: () => {}, warn: (msg) => console.log('   [warn]', msg), error: () => {} }
let fail = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) fail += 1
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ① 盘不在（不存在的盘符）
const missingDir = 'Z:\\no-such-drive\\.VideoArchive'
const s1 = new Store({ dataDir: missingDir, logger: log })
const st1 = s1.status()
check('盘不在 → 只读', st1.readOnly, true)
check('盘不在 → ok=false', st1.ok, false)
check('盘不在 → 写入被拒', s1.writeSafe(path.join(missingDir, 'x.json'), { a: 1 }), false)
check('盘不在 → 没有偷偷建文件', fs.existsSync(missingDir), false)

// ② 目录在，但 index.json 读不了（模拟盘掉线后写入半截 / 损坏）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'va-guard-'))
fs.writeFileSync(path.join(root, 'index.json'), '{ 这不是 json', 'utf8')
const s2 = new Store({ dataDir: root, logger: log })
check('index.json 损坏 → 只读', s2.status().readOnly, true)
const before = fs.readFileSync(path.join(root, 'index.json'), 'utf8')
s2.upsert({ id: 'abc', path: 'x.mp4', name: 'x.mp4' })
s2.flush()
const after = fs.readFileSync(path.join(root, 'index.json'), 'utf8')
check('只读时 flush 不会覆盖原文件', after === before, true)

// ③ 修好之后 reload 能恢复
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, videos: { abc: { id: 'abc', path: 'x.mp4' } } }), 'utf8')
const reloaded = s2.reload()
check('reload 成功', reloaded.ok, true)
check('reload 读回条数', reloaded.videos, 1)
check('reload 后恢复可写', s2.canWrite(), true)
check('reload 后写入成功', s2.writeSafe(path.join(root, 'x.json'), { a: 1 }), true)

// ④ 录像文件夹被改名/挪走：不能在原地建一个空文件夹
const gone = path.join(os.tmpdir(), `va-gone-${Date.now()}`)
const goneDataDir = path.join(gone, '.VideoArchive')
const s4 = new Store({ dataDir: goneDataDir, logger: log })
const st4 = s4.status()
check('文件夹不在 → 只读', st4.readOnly, true)
check('文件夹不在 → 标记 missingScanFolder', st4.missingScanFolder, true)
check('文件夹不在 → 没有被重建出来', fs.existsSync(gone), false)

fs.rmSync(root, { recursive: true, force: true })
console.log(fail ? `\n✗ ${fail} 项不符合预期` : '\n✓ 全部符合预期')
process.exit(fail ? 1 : 0)

// 从 app.asar 里读一个文件出来（Node 自带 asar 支持，用来查 SDK 源码）
// 用法：node dev/read-asar.mjs <asar路径> <包内路径> [字节数]
import fs from 'node:fs'

const [asarPath, innerPath, limitArg] = process.argv.slice(2)
if (!asarPath || !innerPath) {
  console.error('用法：node read-asar.mjs <app.asar> <包内路径> [字节数]')
  process.exit(1)
}
const limit = Number(limitArg) || 6000

const buf = fs.readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
let header = null
for (const offset of [8, 12, 16]) {
  try {
    const strLen = buf.readUInt32LE(offset)
    if (strLen <= 0 || strLen > 20 * 1024 * 1024) continue
    const text = buf.subarray(offset + 4, offset + 4 + strLen).toString('utf8')
    header = JSON.parse(text)
    break
  } catch {
    /* try next */
  }
}
if (!header) {
  console.error('解析 asar 头失败')
  process.exit(1)
}

const dataBase = 8 + headerSize
const parts = innerPath.split('/').filter(Boolean)
let node = header
for (const part of parts) {
  node = node?.files?.[part]
  if (!node) {
    console.error(`找不到 ${innerPath}`)
    process.exit(1)
  }
}
if (node.files) {
  console.log(`# ${innerPath} 是目录，包含：`)
  for (const [name, child] of Object.entries(node.files)) {
    console.log(`  ${child.files ? '[dir]' : `[${child.size}B]`} ${name}`)
  }
  process.exit(0)
}
const start = dataBase + Number(node.offset)
const size = Number(node.size)
const chunk = buf.subarray(start, start + Math.min(size, limit))
const outIndex = process.argv.indexOf('--out')
if (outIndex > 0 && process.argv[outIndex + 1]) {
  fs.writeFileSync(process.argv[outIndex + 1], chunk, 'utf8')
  console.log(`# 已写出 ${process.argv[outIndex + 1]}（${chunk.length} 字节）`)
} else {
  console.log(`# ${innerPath}  (offset=${start} size=${size})`)
  console.log(chunk.toString('utf8'))
}

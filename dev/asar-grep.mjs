// 在 app.asar 里按正则找文件名、再按正则搜内容（排查 DSH 客户端 API 用）
// node dev/asar-grep.mjs <asar> --files '<路径正则>' [--grep '<内容正则>'] [--context 2]
import fs from 'node:fs'

const args = process.argv.slice(2)
const asarPath = args[0]
const getArg = (flag) => {
  const index = args.indexOf(flag)
  return index > 0 ? args[index + 1] : ''
}
const fileRe = new RegExp(getArg('--files') || '.', 'i')
const grepRe = getArg('--grep') ? new RegExp(getArg('--grep'), 'i') : null
const context = Number(getArg('--context') || 0)

const buf = fs.readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
let header = null
for (const offset of [8, 12, 16]) {
  try {
    const strLen = buf.readUInt32LE(offset)
    if (strLen <= 0 || strLen > 20 * 1024 * 1024) continue
    header = JSON.parse(buf.subarray(offset + 4, offset + 4 + strLen).toString('utf8'))
    break
  } catch {
    /* next */
  }
}
if (!header) {
  console.error('解析 asar 头失败')
  process.exit(1)
}
const dataBase = 8 + headerSize
const hits = []

function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (child.files) {
      walk(child, full)
      continue
    }
    if (!fileRe.test(full)) continue
    const start = dataBase + Number(child.offset)
    const size = Number(child.size)
    if (size > 4 * 1024 * 1024) continue
    hits.push({ path: full, text: buf.subarray(start, start + size).toString('utf8') })
  }
}

walk(header, '')
console.log(`# 匹配到 ${hits.length} 个文件`)

for (const file of hits) {
  if (!grepRe) {
    console.log(file.path)
    continue
  }
  const lines = file.text.split('\n')
  const found = []
  lines.forEach((line, index) => {
    if (grepRe.test(line)) found.push(index)
  })
  if (!found.length) continue
  console.log(`\n## ${file.path}`)
  const seen = new Set()
  for (const index of found.slice(0, 8)) {
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i += 1) {
      if (seen.has(i)) continue
      seen.add(i)
      const mark = i === index ? '>' : ' '
      console.log(`${mark} ${String(i + 1).padStart(5)} ${lines[i].slice(0, 220)}`)
    }
  }
}

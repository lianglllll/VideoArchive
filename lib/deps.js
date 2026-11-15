// 依赖体检：装完之后让 agent / 用户自己跑一次，确认「能不能用」。
// 思路来自 surfcore：不打包第三方二进制，而是「多路查找 + 明确报错 + 一个体检入口」。
import fs from 'node:fs'
import path from 'node:path'

/**
 * @returns {{ok:boolean, items:Array<{name:string, ok:boolean, detail:string, fix:string}>}}
 */
export async function collectDeps({ ffmpeg, store }) {
  const items = []

  // ① ffmpeg（读时长 / 抽封面）
  const info = ffmpeg.resolve(true)
  if (info.ok) {
    const version = await ffmpeg.version()
    items.push({
      name: 'ffmpeg',
      ok: true,
      detail: version ? `${version}\n  路径：${info.dir}` : `已找到（跑不起来？）\n  路径：${info.dir}`,
      fix: '',
    })
  } else {
    items.push({
      name: 'ffmpeg',
      ok: false,
      detail: `没找到（找过 ${info.tried.length} 个位置）`,
      fix: ffmpeg.hint(),
    })
  }

  // ② 档案目录可写
  let dirOk = false
  let dirError = ''
  try {
    fs.mkdirSync(store.dataDir, { recursive: true })
    const probe = path.join(store.dataDir, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    dirOk = true
  } catch (error) {
    dirError = error.message
  }
  items.push({
    name: '档案目录可写',
    ok: dirOk,
    detail: dirOk ? store.dataDir : `${store.dataDir}（${dirError}）`,
    fix: dirOk ? '' : '检查这个目录的权限，或者在设置里换一个位置',
  })

  // ③ 录像文件夹（可选）
  const scanFolder = String(store.getConfig().scanFolder || '').trim()
  if (!scanFolder) {
    items.push({ name: '录像文件夹', ok: true, detail: '没设置（不设也行，可以在设置里填一个让打开页面时自动收）', fix: '' })
  } else {
    let ok = false
    try {
      ok = fs.statSync(scanFolder).isDirectory()
    } catch {
      ok = false
    }
    items.push({
      name: '录像文件夹',
      ok,
      detail: scanFolder,
      fix: ok ? '' : '这个路径现在打不开，去设置里改一下',
    })
  }

  // ④ Node 版本
  const major = Number(process.versions.node.split('.')[0])
  items.push({
    name: 'Node.js',
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    fix: major >= 20 ? '' : '升级到 Node 20 或更高',
  })

  return { ok: items.every((item) => item.ok), items }
}

/** 体检结果的纯文本版（给工具输出用） */
export function depsToText(result) {
  const lines = ['== 依赖体检 ==']
  for (const item of result.items) {
    lines.push(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    if (!item.ok && item.fix) lines.push(item.fix.split('\n').map((line) => `    ${line}`).join('\n'))
  }
  lines.push('')
  lines.push(result.ok ? '✓ 全部可用' : '✗ 有不可用的项，照着上面的「修」处理；处理完再跑一次。')
  return lines.join('\n')
}

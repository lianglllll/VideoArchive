// 把录像档案挂进 DSH 的桌面 profile（另一台电脑上也能直接跑这个脚本）。
//   node install.mjs            挂到默认 profile（desktop）
//   node install.mjs --profile <名字>
//   node install.mjs --remove   从 profile 里摘掉（不动插件文件和数据）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const profileIndex = args.indexOf('--profile')
const profileName = profileIndex >= 0 ? args[profileIndex + 1] : 'desktop'

const dshHome = path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)
const packageFile = path.join(profileDir, 'package.json')
const bundleName = '@local/video-archive'
const linkTarget = `link:${pluginDir.replace(/\\/g, '/')}`

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!fs.existsSync(packageFile)) {
  fail(`找不到 DSH profile：${packageFile}\n  先启动一次 DSH，或者用 --profile <名字> 指定。`)
}

const raw = fs.readFileSync(packageFile, 'utf8')
let profile
try {
  profile = JSON.parse(raw)
} catch (error) {
  fail(`profile 的 package.json 不是合法 JSON：${error.message}`)
}

fs.writeFileSync(`${packageFile}.bak-video-archive-${Date.now()}`, raw, 'utf8')

profile.dsh = profile.dsh || {}
profile.dsh.profile = profile.dsh.profile || {}
profile.dsh.profile.bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : []
profile.dependencies = profile.dependencies && typeof profile.dependencies === 'object' ? profile.dependencies : {}

const linkPath = path.join(profileDir, 'node_modules', '@local', 'video-archive')

if (remove) {
  profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== bundleName)
  delete profile.dependencies[bundleName]
  try {
    fs.rmSync(linkPath, { force: true })
  } catch {
    /* ignore */
  }
  fs.writeFileSync(packageFile, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  console.log('✓ 已从 profile 摘掉录像档案，重启 DSH 生效。插件文件和数据都没动。')
  process.exit(0)
}

if (!profile.dsh.profile.bundles.includes(bundleName)) profile.dsh.profile.bundles.push(bundleName)
profile.dependencies[bundleName] = linkTarget
fs.writeFileSync(packageFile, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')

try {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(pluginDir, linkPath, 'junction')
} catch (error) {
  fail(`建软链接失败：${error.message}\n  用管理员身份重跑一次，或者手动把 ${pluginDir} 建个 junction 到 ${linkPath}`)
}

console.log('✓ 录像档案已挂进 DSH')
console.log(`  插件目录：${pluginDir}`)
console.log(`  profile：${profileName}`)
console.log(`  档案目录：默认 ~/.dsh/video-archive，装好后可以在「设置 → 档案存哪」改`)
console.log('')
console.log('下一步：重启 DSH（或者重新打开一次应用），然后：')
console.log('  · 设置 → 录像档案  里有入口')
console.log('  · 或者直接打开 http://127.0.0.1:<DSH端口>/video-archive/')

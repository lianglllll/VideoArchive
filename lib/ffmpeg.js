import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const IS_WIN = process.platform === 'win32'
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库自带的 bin/：想随包放一份静态构建时用（不要提交二进制，只在本地或 release 里给） */
const REPO_BIN = path.join(HERE, '..', 'bin')

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function findOnPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`)
      if (isFile(candidate)) return candidate
    }
  }
  return ''
}

function walkForExe(root, name, depthLeft) {
  if (depthLeft < 0) return ''
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = walkForExe(path.join(root, entry.name), name, depthLeft - 1)
    if (found) return found
  }
  return ''
}

/** 常见的 ffmpeg 安装位置，按可靠性从高到低。 */
function candidateHomes() {
  const home = os.homedir()
  const list = [
    REPO_BIN,
    path.join(home, '.dsh', 'tools', 'ffmpeg', 'bin'),
    path.join(home, '.dsh', 'tools', 'ffmpeg'),
    path.join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
    'C:\\ffmpeg\\bin',
    'C:\\ProgramData\\chocolatey\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ]
  if (IS_WIN && process.env.LOCALAPPDATA) {
    const winget = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    try {
      for (const name of fs.readdirSync(winget)) {
        if (/ffmpeg/i.test(name)) {
          const found = walkForExe(path.join(winget, name), IS_WIN ? 'ffmpeg.exe' : 'ffmpeg', 4)
          if (found) list.unshift(path.dirname(found))
        }
      }
    } catch {
      /* ignore */
    }
  }
  return list
}

export class Ffmpeg {
  constructor({ configPath = '', logger = console } = {}) {
    this.configPath = configPath || ''
    this.logger = logger
    this.info = null
  }

  resolve(force = false) {
    if (this.info && !force) return this.info
    const exe = IS_WIN ? '.exe' : ''
    const tried = []

    const externalDirs = []
    if (this.configPath) externalDirs.push(path.dirname(this.configPath))
    for (const key of ['VA_FFMPEG', 'FFMPEG', 'FFMPEG_PATH']) {
      const value = process.env[key]
      if (!value) continue
      externalDirs.push(/\.exe$/i.test(value) || path.basename(value).startsWith('ffmpeg') ? path.dirname(value) : value)
    }

    const check = (dir) => {
      const ffmpeg = path.join(dir, `ffmpeg${exe}`)
      const ffprobe = path.join(dir, `ffprobe${exe}`)
      if (isFile(ffmpeg) && isFile(ffprobe)) return { ffmpeg, ffprobe, dir }
      tried.push(dir)
      return null
    }

    let found = null
    for (const dir of externalDirs) {
      found = check(dir)
      if (found) break
    }

    if (!found && this.configPath && isFile(this.configPath)) {
      const dir = path.dirname(this.configPath)
      const ffprobe = path.join(dir, `ffprobe${exe}`)
      if (isFile(ffprobe)) found = { ffmpeg: this.configPath, ffprobe, dir }
    }

    if (!found) {
      for (const dir of candidateHomes()) {
        found = check(dir)
        if (found) break
      }
    }

    if (!found) {
      const onPath = findOnPath('ffmpeg')
      if (onPath) found = check(path.dirname(onPath))
    }

    this.info = found
      ? { ok: true, ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, dir: found.dir, source: 'disk', tried }
      : { ok: false, ffmpeg: '', ffprobe: '', dir: '', source: 'missing', tried }
    if (!this.info.ok) this.logger.warn?.(`没找到 ffmpeg。找过这些位置：${tried.slice(0, 8).join(' | ') || '(空)'}`)
    return this.info
  }

  /** 缺 ffmpeg 时给人 / 给 agent 的补救办法（出现在错误里、deps 工具里、设置页里） */
  hint() {
    return [
      '找不到 ffmpeg（读时长、抽封面要用它）。任选一种解决：',
      '① 装一个：winget install Gyan.FFmpeg   （或 scoop install ffmpeg / brew install ffmpeg）',
      '② 用环境变量指定：set VA_FFMPEG=D:\\path\\to\\ffmpeg.exe',
      `③ 把 ffmpeg.exe 和 ffprobe.exe 放进 ${REPO_BIN} 或 ${path.join(os.homedir(), '.dsh', 'tools', 'ffmpeg', 'bin')}`,
      '装好之后回设置页点「重新检测」；已经加进来的视频，点详情里的 ⟳ 重新读取信息。',
    ].join('\n')
  }

  /** 取版本号首行，给人 / 给 agent 看一眼是不是真的能跑 */
  async version() {
    const info = this.resolve()
    if (!info.ok) return ''
    const result = await this.run(info.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 8000 })
    return String(result.stdout || '').split('\n')[0].trim()
  }

  run(bin, args, { timeoutMs = 120_000, cwd } = {}) {
    return new Promise((resolve) => {
      if (!bin) {
        resolve({ ok: false, code: -1, stdout: '', stderr: 'ffmpeg 未就绪', timedOut: false })
        return
      }
      let child
      try {
        child = spawn(bin, args, { windowsHide: true, cwd })
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: '', stderr: error.message, timedOut: false })
        return
      }
      const out = []
      const err = []
      let settled = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, Math.max(2000, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()

      child.stdout?.on('data', (chunk) => out.push(chunk))
      child.stderr?.on('data', (chunk) => err.push(chunk))
      const finish = (code, message) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        resolve({ ok: code === 0, code, stdout, stderr: message || stderr, timedOut })
      }
      child.on('error', (error) => finish(-1, error.message))
      child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
    })
  }
}

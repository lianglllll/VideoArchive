import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

/**
 * 弹 Windows 的「选择文件夹」对话框，返回选中的路径（取消返回空字符串）。
 * 结果通过临时文件传回来，避免中文路径被控制台的编码搞乱。
 * @returns {Promise<{ok:boolean, path?:string, canceled?:boolean, error?:string}>}
 */
export function pickFolder(title = '选择录像文件夹') {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '这个系统没有内置的文件夹选择框，直接填路径吧' })
      return
    }
    const outFile = path.join(os.tmpdir(), `va-pick-${Date.now()}.txt`)
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${String(title).replace(/'/g, "''")}'`,
      '$d.ShowNewFolderButton = $true',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
      `  [System.IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))`,
      '}',
    ].join('\n')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
    )
    let stderr = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        fs.rmSync(outFile, { force: true })
      } catch {
        /* ignore */
      }
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: '等太久没选（超过 5 分钟）' })
    }, 300_000)
    if (typeof timer.unref === 'function') timer.unref()
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim().slice(0, 200) || `powershell 退出码 ${code}` })
        return
      }
      let picked = ''
      try {
        picked = fs.readFileSync(outFile, 'utf8').trim()
      } catch {
        picked = ''
      }
      finish(picked ? { ok: true, path: picked } : { ok: true, path: '', canceled: true })
    })
  })
}

/**
 * 删除一个文件，Windows 下丢进回收站（可恢复）；其他平台直接删。
 * @returns {Promise<{ok:boolean, recycled?:boolean, error?:string}>}
 */
export function recycleFile(file) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(file, { force: true })
        resolve({ ok: true, recycled: false })
      } catch (error) {
        resolve({ ok: false, error: error.message })
      }
      return
    }
    const escaped = String(file).replace(/'/g, "''")
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}','OnlyErrorDialogs','SendToRecycleBin')`
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
    })
    let stderr = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, recycled: true })
      else finish({ ok: false, error: stderr.trim().slice(0, 300) || `powershell 退出码 ${code}` })
    })
  })
}

export function now() {
  return Date.now()
}

export function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

export function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex')
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  return dir
}

/** 递归复制目录（档案搬家用），返回复制的文件数。 */
export function copyDir(from, to) {
  let count = 0
  let entries = []
  try {
    entries = fs.readdirSync(from, { withFileTypes: true })
  } catch {
    return 0
  }
  ensureDir(to)
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) count += copyDir(source, target)
    else if (entry.isFile()) {
      try {
        fs.copyFileSync(source, target)
        count += 1
      } catch {
        /* ignore */
      }
    }
  }
  return count
}

export function readJson(file, fallback) {
  const result = readJsonStrict(file)
  return result.ok ? result.value : fallback
}

/**
 * 和 readJson 一样，但能区分「文件不存在」和「读不了」（外接盘没接、权限问题）。
 * @returns {{ok:true, value:any} | {ok:false, missing:boolean, error:string}}
 */
export function readJsonStrict(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, missing: error.code === 'ENOENT', error: error.message }
  }
  if (!raw.trim()) return { ok: false, missing: false, error: '文件是空的' }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, missing: false, error: `不是合法 JSON：${error.message}` }
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
      return true
    } catch {
      return false
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    }
  }
}

export function fmtBytes(bytes) {
  const num = Number(bytes) || 0
  if (num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  let value = num
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export function fmtClock(seconds) {
  // 跟播放器一致用向下取整：3.7 秒显示 0:03，而不是 0:04
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 把各种时间写法（秒 / 毫秒 / ISO 字符串 / "01:23"）统一成毫秒时间戳。 */
export function toMs(value) {
  if (value === null || value === undefined || value === '') return 0
  const num = Number(value)
  if (Number.isFinite(num) && num > 0) return num < 1e11 ? Math.round(num * 1000) : Math.round(num)
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

/** "12:34" / "1:02:03" / "83" → 秒。 */
export function parseClock(value) {
  if (typeof value === 'number') return Math.max(0, value)
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':').map((item) => Number(item))
  if (parts.some((item) => !Number.isFinite(item))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

export function safeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** 浅的深合并：对象递归合并，数组直接替换。 */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

/** 从模型回复里抠出第一个 JSON 对象。 */
export function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(raw)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1))
  for (const candidate of candidates) {
    const trimmed = String(candidate).trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      /* try next */
    }
  }
  return null
}

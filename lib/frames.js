import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './util.js'

const FRAME_W = 640
const FRAME_H = 360

/** 均匀取样：每段的正中间，避开开头/结尾的黑场。 */
export function pickTimes(duration, count) {
  const n = Math.max(1, Math.round(count || 6))
  const total = Number(duration) || 0
  if (total <= 1.2) return [0.1]
  const times = []
  for (let i = 0; i < n; i += 1) {
    const t = (total * (i + 0.5)) / n
    times.push(Math.min(Math.max(0.1, t), total - 0.15))
  }
  return times
}

function round(n) {
  return Math.round(n * 1000) / 1000
}

function cleanDir(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpg|jpeg)$/i.test(name)) continue
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function grab(ffmpeg, bin, file, target, seconds) {
  const result = await ffmpeg.run(
    bin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      Number(seconds).toFixed(3),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease,pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2`,
      '-q:v',
      '4',
      '-y',
      target,
    ],
    { timeoutMs: 40_000 },
  )
  return result.ok && fs.existsSync(target)
}

/**
 * 抽 N 帧 + 拼一张联系表（contact sheet）。
 * 单帧用于时间轴和大图，联系表用来喂给模型（一张图看完整段）。
 */
export async function extractFrames(ffmpeg, file, outDir, { count = 6, duration = 0 } = {}) {
  const info = ffmpeg.resolve()
  if (!info.ok) return { ok: false, error: '没有找到 ffmpeg，抽不了画面' }
  const wanted = [4, 6, 9].includes(Number(count)) ? Number(count) : 6
  ensureDir(outDir)
  cleanDir(outDir)

  const times = pickTimes(duration, wanted)
  const made = []
  for (let index = 0; index < wanted; index += 1) {
    const seconds = times[index] ?? Math.max(0.1, (Number(duration) || 2) * ((index + 0.5) / wanted))
    const target = path.join(outDir, `f${index}.jpg`)
    let ok = await grab(ffmpeg, info.ffmpeg, file, target, seconds)
    if (!ok && seconds > 0.4) ok = await grab(ffmpeg, info.ffmpeg, file, target, seconds / 2)
    if (ok) made.push({ index, t: round(seconds), name: path.basename(target) })
  }

  if (made.length === 0) {
    return { ok: false, error: '一帧都没抽出来（文件可能损坏，或者还在录制中）' }
  }

  // 缺帧的格子用最近一帧补满，保证联系表是完整网格
  for (let index = 0; index < wanted; index += 1) {
    const target = path.join(outDir, `f${index}.jpg`)
    if (fs.existsSync(target)) continue
    const closest = made.reduce((best, item) => (Math.abs(item.index - index) < Math.abs(best.index - index) ? item : best), made[0])
    try {
      fs.copyFileSync(path.join(outDir, closest.name), target)
    } catch {
      /* ignore */
    }
  }

  const cols = wanted === 4 ? 2 : 3
  const rows = Math.ceil(wanted / cols)
  const sheetPath = path.join(outDir, 'sheet.jpg')
  const sheet = await ffmpeg.run(
    info.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-framerate',
      '1',
      '-start_number',
      '0',
      '-i',
      path.join(outDir, 'f%d.jpg'),
      '-vf',
      `tile=${cols}x${rows}`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-y',
      sheetPath,
    ],
    { timeoutMs: 40_000 },
  )

  let finalSheet = sheetPath
  if (!sheet.ok || !fs.existsSync(sheetPath)) {
    finalSheet = path.join(outDir, 'sheet-fallback.jpg')
    try {
      fs.copyFileSync(path.join(outDir, made[Math.floor(made.length / 2)].name), finalSheet)
    } catch {
      finalSheet = ''
    }
  }

  const coverSource = made[Math.min(made.length - 1, Math.floor(made.length * 0.6))]
  const coverPath = path.join(outDir, 'cover.jpg')
  try {
    fs.copyFileSync(path.join(outDir, coverSource.name), coverPath)
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    frames: made.map((item) => ({ t: item.t, name: item.name })),
    sheet: finalSheet ? path.basename(finalSheet) : '',
    cover: fs.existsSync(coverPath) ? 'cover.jpg' : made[0].name,
    cols,
    rows,
  }
}

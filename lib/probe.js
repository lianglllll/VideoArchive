import fs from 'node:fs'
import path from 'node:path'
import { toMs } from './util.js'

function toNumber(value, fallback = 0) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function parseRate(value) {
  const text = String(value || '')
  if (!text) return 0
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number)
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den
    return 0
  }
  const num = Number(text)
  return Number.isFinite(num) ? num : 0
}

/**
 * 用 ffprobe 读一个视频的基本信息。
 * @returns {{ok:boolean, error?:string, meta?:object}}
 */
export async function probeVideo(ffmpeg, file) {
  const bin = ffmpeg.resolve().ffprobe
  if (!bin) return { ok: false, error: '没有 ffprobe，请先装 ffmpeg' }
  const result = await ffmpeg.run(
    bin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 45_000 },
  )
  if (!result.ok) return { ok: false, error: (result.stderr || '').trim().slice(0, 400) || 'ffprobe 读取失败' }
  let data
  try {
    data = JSON.parse(result.stdout)
  } catch {
    return { ok: false, error: 'ffprobe 输出看不懂' }
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((item) => item.codec_type === 'video') || {}
  const audio = streams.find((item) => item.codec_type === 'audio') || {}
  const format = data.format || {}

  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    /* ignore */
  }

  const duration = toNumber(format.duration) || toNumber(video.duration) || 0
  const size = toNumber(format.size) || (stat ? stat.size : 0)
  const createdAt =
    toMs(format.tags?.creation_time) ||
    toMs(video.tags?.creation_time) ||
    (stat ? Math.round(stat.mtimeMs) : 0)

  return {
    ok: true,
    meta: {
      duration: Math.max(0, duration),
      size,
      bitrate: toNumber(format.bit_rate),
      width: toNumber(video.width),
      height: toNumber(video.height),
      fps: Math.round(parseRate(video.avg_frame_rate || video.r_frame_rate) * 100) / 100,
      vcodec: String(video.codec_name || ''),
      acodec: String(audio.codec_name || ''),
      hasAudio: Boolean(audio.codec_type),
      container: String(format.format_name || path.extname(file).replace('.', '')),
      createdAt,
    },
  }
}

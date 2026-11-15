// 本地开发用：不开 DSH 也能把整个插件跑起来，用来调界面和流程。
// 用法：node dev/run.js  →  http://127.0.0.1:5188/video-archive/
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../lib/store.js'
import { Ffmpeg } from '../lib/ffmpeg.js'
import { GameBook } from '../lib/games.js'
import { Archive } from '../lib/archive.js'
import { createHttpHandler } from '../lib/http.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DATA = path.join(ROOT, 'dev', '.data')
const PORT = Number(process.env.PORT || 5188)

const logger = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
}

const store = new Store({ dataDir: DATA, logger })
const ffmpeg = new Ffmpeg({ configPath: store.getConfig().ffmpegPath, logger })
const games = new GameBook({ dataDir: DATA, logger })
const archive = new Archive({ store, ffmpeg, games, logger })
const { handler } = createHttpHandler({ archive, store, ffmpeg, games, logger })

http
  .createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(String(error?.stack || error))
    })
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`录像档案（开发模式）→ http://127.0.0.1:${PORT}/video-archive/`)
    console.log(`数据目录：${DATA}`)
    console.log(`ffmpeg：${ffmpeg.resolve().dir || '没找到'}`)
  })



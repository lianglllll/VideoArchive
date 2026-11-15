// 录像档案 · DSH 插件
// 自己挑视频加进来，读时长/抽封面，手工填标题游戏摘要，按需归档到指定文件夹。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, resolveDataDir, defaultLocationFile, dataDirForScan } from './lib/store.js'
import { Ffmpeg } from './lib/ffmpeg.js'
import { GameBook } from './lib/games.js'
import { Archive } from './lib/archive.js'
import { createHttpHandler } from './lib/http.js'
import { registerTools } from './lib/tools.js'

export const inject = ['tools', 'webServer']

export const name = 'video-archive'

export function apply(ctx) {
  const logger = ctx.logger
  const fallbackDir = path.join(os.homedir(), '.dsh', 'VideoArchive')
  const devDir = process.env.VA_DATA_DIR ? path.resolve(process.env.VA_DATA_DIR) : ''
  const dataDir = devDir || resolveDataDir(fallbackDir)
  const locationFile = devDir ? path.join(path.dirname(dataDir), 'VideoArchive.location.json') : defaultLocationFile()

  const store = new Store({ dataDir, locationFile, logger })

  // 档案默认跟着录像文件夹走：<录像文件夹>/.VideoArchive。
  // 只有指针里明确指定过（explicit）才不动它。
  if (!store.explicit) {
    const scanFolder = String(store.getConfig().scanFolder || '')
    const derived = dataDirForScan(scanFolder)
    // 录像文件夹被改名/挪走时不要 relocate，否则会把空文件夹给你建回来
    if (derived && path.resolve(derived) !== store.dataDir && scanFolder && fs.existsSync(scanFolder)) {
      const moved = store.relocate(derived, { migrate: false, explicit: false })
      if (!moved.ok) logger.warn?.(`档案目录没切过去：${moved.error}`)
    }
  }
  store.saveLocation()

  const ffmpeg = new Ffmpeg({ configPath: store.getConfig().ffmpegPath, logger })
  const games = new GameBook({ dataDir: store.dataDir, logger })
  const archive = new Archive({ store, ffmpeg, games, logger })

  registerTools(ctx, { archive, store, ffmpeg, games })

  // 这个插件页面被嵌在 DSH 里时，地址是 dsh-app:// 协议，直接 window.open 会被拦。
  // 所以把真正的 http 地址（http://127.0.0.1:<端口>）告诉前端，让它弹独立窗口。
  const getOrigin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch {
      return ''
    }
  }

  const http = createHttpHandler({ archive, store, ffmpeg, games, getOrigin, logger })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: http.path, handler: http.handler }), 'video-archive: http')

  ctx.effect(
    () => () => {
      archive.stop()
      store.flush()
    },
    'video-archive: dispose',
  )

  logger.info(`录像档案已加载：档案存在 ${store.dataDir}，页面 /video-archive/`)
  if (!ffmpeg.resolve().ok) logger.warn('没找到 ffmpeg：抽不了画面。装一个（winget install Gyan.FFmpeg）或在设置里指路径。')

  return { archive, store, ffmpeg, games }
}

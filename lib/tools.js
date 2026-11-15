import { fmtBytes, fmtClock } from './util.js'
import { collectDeps, depsToText } from './deps.js'

function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    execute,
  }
}

const NO_PROPS = { type: 'object', properties: {}, additionalProperties: false }

export function registerTools(ctx, { archive, store, ffmpeg, games }) {
  const register = (tool, label) => ctx.effect(() => ctx.tools.register(tool), label)

  register(
    defineTool(
      'video_archive_status',
      '看录像档案的当前状态：一共多少个视频、多少个已经填过信息、有没有在后台处理、ffmpeg 是否就绪。',
      NO_PROPS,
      async () => {
        const status = archive.state()
        return {
          ...status,
          summary: `${status.stats.videos} 个视频，已填写 ${status.stats.filled} 个，待填写 ${status.stats.pending} 个`,
        }
      },
    ),
    'video-archive: status',
  )

  register(
    defineTool(
      'video_archive_add',
      '把一个或几个视频文件加进档案库（读时长、抽封面）。传完整的文件路径，可传多个。不会自动去扫文件夹。',
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '视频文件的完整路径，可多个' },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      async ({ paths }) => archive.addPaths(Array.isArray(paths) ? paths : [paths]),
    ),
    'video-archive: add',
  )

  register(
    defineTool(
      'video_archive_list',
      '列出档案库里的视频（按录制时间倒序）：标题、游戏、时长、摘要、标签、是否已填写。可以用 query 搜标题/游戏/标签/文件名。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（可选）' },
          limit: { type: 'number', description: '最多返回几个，默认 30' },
        },
        additionalProperties: false,
      },
      async ({ query, limit }) => {
        const text = String(query || '').trim().toLowerCase()
        const list = archive
          .list()
          .filter((item) =>
            text
              ? [item.title, item.game, item.summary, item.name, (item.tags || []).join(' ')].join(' ').toLowerCase().includes(text)
              : true,
          )
          .sort((a, b) => (b.meta?.createdAt || b.mtimeMs || 0) - (a.meta?.createdAt || a.mtimeMs || 0))
          .slice(0, Math.max(1, Math.min(200, Number(limit) || 30)))
          .map((item) => ({
            id: item.id,
            title: item.title,
            game: item.game,
            duration: item.durationText,
            recordedAt: item.meta?.createdAt ? new Date(item.meta.createdAt).toLocaleString('zh-CN') : '',
            size: item.sizeText || fmtBytes(item.size),
            summary: item.summary,
            tags: item.tags,
            filled: item.filled,
            path: item.path,
          }))
        return { count: list.length, videos: list }
      },
    ),
    'video-archive: list',
  )

  register(
    defineTool(
      'video_archive_get',
      '看一个视频的完整档案：标题、游戏、摘要、标签、文件路径、关键帧时间。',
      {
        type: 'object',
        properties: { id: { type: 'string', description: '视频 id' } },
        required: ['id'],
        additionalProperties: false,
      },
      async ({ id }) => {
        const item = archive.list().find((entry) => entry.id === String(id))
        if (!item) return { ok: false, error: '没有这个视频' }
        return {
          ok: true,
          id: item.id,
          title: item.title,
          game: item.game,
          summary: item.summary,
          tags: item.tags,
          duration: item.durationText,
          path: item.path,
          frames: (item.frames || []).map((frame) => frame.timeText),
          filled: item.filled,
        }
      },
    ),
    'video-archive: get',
  )

  register(
    defineTool(
      'video_archive_games',
      '看 / 改游戏库（游戏名 + 别名 + 类别）。action=list 列出所有游戏和类别；create 新建；update 改名/改类别/加别名；merge 合并两个游戏；delete 删掉一个空游戏。',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'merge', 'delete'], description: '默认 list' },
          id: { type: 'string', description: 'update / delete 时的游戏 id' },
          name: { type: 'string', description: 'create 时的游戏名' },
          category: { type: 'string', description: '类别名（要先存在）' },
          aliases: { type: 'array', items: { type: 'string' }, description: '别名列表' },
          patch: { type: 'object', description: 'update 的字段：{name, category, aliases}', additionalProperties: true },
          from: { type: 'string', description: 'merge：被并掉的游戏 id' },
          to: { type: 'string', description: 'merge：保留下来的游戏 id' },
        },
        additionalProperties: false,
      },
      async ({ action, id, name, category, aliases, patch, from, to }) => {
        const what = String(action || 'list')
        if (what === 'create') return archive.createGame({ name, category, aliases })
        if (what === 'update') {
          const fields = patch && typeof patch === 'object' ? patch : { name, category, aliases }
          return archive.updateGame(String(id || ''), fields)
        }
        if (what === 'merge') return archive.mergeGames(String(from || ''), String(to || ''))
        if (what === 'delete') return archive.removeGame(String(id || ''))
        return archive.gamesView()
      },
    ),
    'video-archive: games',
  )

  register(
    defineTool(
      'video_archive_config',
      '看 / 改录像档案的设置。常用：{frames:6, scanFolder:"D:\\\\GameVideo", scanDeep:true}。只传要改的字段。',
      {
        type: 'object',
        properties: { patch: { type: 'object', description: '要合并进配置的对象', additionalProperties: true } },
        additionalProperties: false,
      },
      async ({ patch }) => {
        if (!patch || typeof patch !== 'object') return { config: store.getConfig() }
        const config = store.patchConfig(patch)
        if (patch.ffmpegPath !== undefined) ffmpeg.configPath = String(config.ffmpegPath || '')
        return { config }
      },
    ),
    'video-archive: config',
  )

  register(
    defineTool(
      'video_archive_remove',
      '从档案里删掉一条视频。默认只删记录（硬盘上的文件保留）；withFile:true 会把文件一起丢进回收站。',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频 id' },
          withFile: { type: 'boolean', description: '是否连文件一起删（进回收站），默认 false' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      async ({ id, withFile }) => archive.removeVideo(String(id || ''), { withFile: withFile === true }),
    ),
    'video-archive: remove',
  )

  register(
    defineTool(
      'video_archive_deps',
      '依赖体检：ffmpeg 有没有、档案目录能不能写、录像文件夹在不在、Node 版本够不够。缺东西时会给出可直接执行的修法（比如 winget install Gyan.FFmpeg）。装在别人机器上、或者抽不了封面时先跑这个。',
      NO_PROPS,
      async () => {
        const result = await collectDeps({ ffmpeg, store })
        return { ...result, summary: depsToText(result) }
      },
    ),
    'video-archive: deps',
  )
}

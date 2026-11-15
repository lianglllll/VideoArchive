// 用假 ctx 调一遍 apply()，确认插件能正常加载、注册不报错。
import { apply, inject } from '../index.js'
import os from 'node:os'
import path from 'node:path'

process.env.VA_DATA_DIR = path.join(os.tmpdir(), 'va-apply-test')

const calls = []
const ctx = {
  logger: {
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  },
  webServer: { register: (route) => (calls.push(['webServer', route.path]), { dispose() {} }) },
  tools: { register: (tool) => (calls.push(['tool', tool.name]), { dispose() {} }) },
  effect: (fn) => {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
}

try {
  const result = apply(ctx)
  console.log('注入项：', inject.join(', '))
  console.log('注册：', calls.map((item) => item.slice(0, 2).join(':')).join(' | '))
  console.log('state：', JSON.stringify(result.archive.state().stats))
  console.log('OK')
  process.exit(0)
} catch (error) {
  console.error('FAIL', error)
  process.exit(1)
}

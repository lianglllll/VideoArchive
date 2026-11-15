// 不开 DSH 也要能自检：给 client.js 一个假的 __ModuleLoader__ / React / slots，
// 确认 apply() 真的把「侧栏项 + 主面板 + 设置项」都注册上了，而且不会抛错。
// node dev/client-test.js
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

function createElement(type, props, ...children) {
  return { type, props: props || {}, children }
}
const React = {
  createElement,
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

const mod = await import('../client.js') // 触发 load（副作用）
if (!definition) {
  console.error('✗ client.js 没有调用 __ModuleLoader__.load')
  process.exit(1)
}

const clientModule = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的模块：${name}`)
})

const registered = []
const ctx = {
  slots: {
    inject(name, register) {
      const result = register()
      registered.push({ name, result })
      return result
    },
    register(options, component) {
      registered.push({ name: options.name, options, component })
      return () => {}
    },
  },
}

clientModule.apply(ctx)

const names = registered.map((item) => item.options?.name || item.name)
console.log('注册结果：', names.join(' | '))

const panel = registered.find((item) => item.options?.name === 'sidebar.panellist')
const main = registered.find((item) => item.options?.name === 'main')
const settings = registered.find((item) => item.options?.name === 'settings.section')

const problems = []
if (!panel) problems.push('没有注册 sidebar.panellist')
else {
  if (panel.options.id !== 'video-archive') problems.push('sidebar id 不对')
  if ((panel.options.label?.() || '') !== '录像档案') problems.push('sidebar label 不对')
  const glyph = panel.component({ size: 18, active: false })
  if (glyph?.type !== 'svg') problems.push('图标没渲染成 svg')
}
if (!main) problems.push('没有注册 main')
else {
  if (main.options.key !== 'video-archive') problems.push('main key 不对')
  const tree = main.component({})
  if (tree?.type !== 'div') problems.push('主面板根节点不对')
  const iframe = tree.children?.find?.((child) => child?.type === 'iframe')
  if (!iframe) problems.push('主面板里没有 iframe')
  else if (iframe.props.src !== '/video-archive/') problems.push('iframe src 不对')
}
if (!settings) problems.push('没有注册 settings.section')

if (problems.length) {
  console.error('✗ 有问题：', problems.join('；'))
  process.exit(1)
}
console.log('✓ 侧栏项、主面板、设置项都注册正常')

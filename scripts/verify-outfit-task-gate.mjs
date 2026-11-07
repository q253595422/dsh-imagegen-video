// 门禁：服饰穿戴提交必须走宿主异步任务队列，并能从任务卡恢复状态。
// 反向验证用它做基线：把 taskSubmit 改回阻塞式 generate 会令下列断言变红。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const source = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/client/OutfitWorkspace.tsx'), 'utf8')

// 每个缺失模式 = 一个会复现用户反馈的缺陷：
//   - 不用 taskSubmit：提交阻塞在请求里，切页后无任务记录可恢复；
//   - 不轮询 taskList：回到面板看不到进行中/失败任务；
//   - 不渲染 taskCard：等待中没有提示。
const required = [
  ['api.taskSubmit(', '提交走异步任务队列'],
  ['api.taskList()', '进面板恢复任务'],
  ['css.taskCard', '任务卡显示等待/结果'],
]

// 反向：面板里不得再自带一份历史列表。宿主的左侧历史已经列出每次生成，
// 面板里重复一份只是把同一批图渲染两遍，还让「这条结果属于哪次提交」更难看清。
// 这两条一旦回退（又把 historyList 拉回来、或重新渲染 history 区块）必须变红。
const forbidden = [
  ['api.historyList()', '历史由宿主左侧列表承担，面板不再自行拉取'],
  ['css.historyGrid', '面板不再渲染历史缩略图网格'],
]

const missing = required.filter(([needle]) => !source.includes(needle))
if (missing.length > 0) {
  for (const [, label] of missing) console.error(`MISSING ${label}`)
  console.error(`MISSING ${missing.map(([needle]) => needle).join(' | ')}`)
  process.exit(1)
}
const present = forbidden.filter(([needle]) => source.includes(needle))
if (present.length > 0) {
  for (const [, label] of present) console.error(`FORBIDDEN ${label}`)
  console.error(`FORBIDDEN ${present.map(([needle]) => needle).join(' | ')}`)
  process.exit(1)
}
console.log('PASS 服饰穿戴任务队列链路存在，且面板不再重复宿主历史')

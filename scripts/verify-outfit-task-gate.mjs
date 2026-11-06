// 门禁：服饰穿戴提交必须走宿主异步任务队列并可从任务/历史恢复。
// 反向验证用它做基线：把 taskSubmit 改回阻塞式 generate 会令下列断言变红。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const source = readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'src/client/OutfitWorkspace.tsx'), 'utf8')

// 每个缺失模式 = 一个会复现用户反馈的缺陷：
//   - 不用 taskSubmit：提交阻塞在请求里，切页后无任务记录可恢复；
//   - 不轮询 taskList：回到面板看不到进行中/失败任务；
//   - 不加载 historyList：找不到历史记录，无法确认是否曾生成成功；
//   - 不渲染 taskCard：等待中没有提示。
const required = [
  ['api.taskSubmit(', '提交走异步任务队列'],
  ['api.taskList()', '进面板恢复任务'],
  ['api.historyList()', '加载持久化历史'],
  ['css.taskCard', '任务卡显示等待/结果'],
]

const missing = required.filter(([needle]) => !source.includes(needle))
if (missing.length > 0) {
  for (const [, label] of missing) console.error(`MISSING ${label}`)
  console.error(`MISSING ${missing.map(([needle]) => needle).join(' | ')}`)
  process.exit(1)
}
console.log('PASS 服饰穿戴任务队列与历史记录链路存在')

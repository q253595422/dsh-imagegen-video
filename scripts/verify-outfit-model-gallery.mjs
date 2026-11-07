// 门禁：本机模特库只能作为人物图库的一部分存在。
// 反向验证用它做基线：把模特注入从 store 的 list 里摘掉、或让工作台重新长出
// 一套独立的模特库选择界面，下列断言都会变红。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = file => readFileSync(join(root, file), 'utf8')
const store = read('src/outfit-reference-store.ts')
const picker = read('src/client/OutfitReferencePicker.tsx')
const workspace = read('src/client/OutfitWorkspace.tsx')

const failures = []
const require_ = (condition, label) => { if (!condition) failures.push(label) }

// 服务端：人物图库的列表必须把本机模特当作一种来源返回，且只对人物。
require_(
  /request\.kind === 'portrait' \? \(await listModels\(\)\)\.map\(modelReference\) : \[\]/.test(store),
  '人物图库列表没有把本机模特库并进来',
)
require_(
  /request\.key\.startsWith\('model:'\)/.test(store) && /return modelReference\(model\)/.test(store),
  '模特条目选中时又走了一次下载，而不是直接用已落盘的原图',
)
require_(/model: \{ label:/.test(store), '来源筛选器里没有「我的模特」这一项')

// 界面：添加与 AI 生成都必须发生在人物图库内部。
// 断言的是渲染条件，不是标记字符串——把条件改成 `false ?` 时标记还留在源码里，
// 只查标记会得到一条永远绿的门禁（反向验证已抓到过这个假绿）。
require_(
  /\{kind === 'portrait' && \(api\.saveModel \|\| generateModel\) \?/.test(picker),
  '人物图库的添加模特行没有按「人物类别 + 有可用能力」渲染',
)
require_(/添加模特照片/.test(picker), '人物图库里没有上传模特照片的按钮')
require_(/AI 生成模特/.test(picker), '人物图库里没有 AI 生成模特的入口')
require_(
  /generateAiModel|generateModel\(/.test(picker),
  '图库没有接上工作台注入的生成回调',
)

// 工作台：不得再维护第二套模特库选择界面（那正是这次要合并掉的东西）。
for (const needle of ["tt('outfit.sourceLibrary')", "tt('outfit.sourceAi')", "tt('outfit.sourceUpload')", 'api.modelList()']) {
  require_(!workspace.includes(needle), `工作台仍然保留独立的模特库入口：${needle}`)
}
require_(/setPicker\('portrait'\)/.test(workspace), '工作台没有指向人物图库的选择按钮')

if (failures.length > 0) {
  for (const label of failures) console.error(`FAIL ${label}`)
  process.exit(1)
}
console.log('PASS 模特库只在人物图库里，工作台不再另开一套模特选择界面')

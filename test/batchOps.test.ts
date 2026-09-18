import assert from 'node:assert'
import {
  filterAnnotations,
  normalizeBatchTags,
  parseTagInput,
  planBatchTagUpdate,
} from '../src/lib/batchOps'
import type { Annotation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  tags: string[],
  id?: string,
  status: Annotation['status'] = 'bound',
  quote = '',
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote,
    start: 0,
    end: 5,
    note: '',
    tags,
    status,
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
  }
}

// ---------- 标签归一与输入解析 ----------

check('normalizeBatchTags：去空白 / #、丢空项、保序去重', () => {
  assert.deepStrictEqual(normalizeBatchTags([' 重点 ', '#重点', '', '  ', '甲', '甲', '乙']), [
    '重点',
    '甲',
    '乙',
  ])
  assert.deepStrictEqual(normalizeBatchTags([]), [])
})

check('parseTagInput：逗号 / 顿号 / 分号 / 空白分隔并归一去重', () => {
  assert.deepStrictEqual(parseTagInput('甲,乙，丙、丁;戊；己 庚\n辛'), [
    '甲',
    '乙',
    '丙',
    '丁',
    '戊',
    '己',
    '庚',
    '辛',
  ])
  assert.deepStrictEqual(parseTagInput(' #甲 , 甲 ，， '), ['甲'])
  assert.deepStrictEqual(parseTagInput(''), [])
})

// ---------- 组合筛选 ----------

const pool = [
  ann(['正面', '重点'], 'b1', 'bound', '苹果香蕉'),
  ann(['反面'], 'b2', 'bound', '苹果橘子'),
  ann(['正面'], 'p1', 'pending', '香蕉葡萄'),
  ann([], 'p2', 'pending', '苹果'),
]

check('筛选：状态条件（全部 / 已绑定 / 待处理）', () => {
  const base = { tags: [], tagMode: 'all' as const, keyword: '' }
  assert.deepStrictEqual(
    filterAnnotations(pool, { ...base, status: 'all' }).map((a) => a.id),
    ['b1', 'b2', 'p1', 'p2'],
  )
  assert.deepStrictEqual(
    filterAnnotations(pool, { ...base, status: 'bound' }).map((a) => a.id),
    ['b1', 'b2'],
  )
  assert.deepStrictEqual(
    filterAnnotations(pool, { ...base, status: 'pending' }).map((a) => a.id),
    ['p1', 'p2'],
  )
})

check('筛选：标签全部 / 任一', () => {
  const base = { status: 'all' as const, keyword: '' }
  assert.deepStrictEqual(
    filterAnnotations(pool, { ...base, tags: ['正面', '重点'], tagMode: 'all' }).map((a) => a.id),
    ['b1'],
  )
  assert.deepStrictEqual(
    filterAnnotations(pool, { ...base, tags: ['正面', '重点'], tagMode: 'any' }).map((a) => a.id),
    ['b1', 'p1'],
  )
  // 未选择标签时不过滤
  assert.strictEqual(filterAnnotations(pool, { ...base, tags: [], tagMode: 'all' }).length, 4)
})

check('筛选：引文关键词大小写不敏感，且与其他条件 AND 组合', () => {
  const hit = filterAnnotations(pool, {
    status: 'all',
    tags: [],
    tagMode: 'all',
    keyword: '苹果',
  })
  assert.deepStrictEqual(hit.map((a) => a.id), ['b1', 'b2', 'p2'])
  const combo = filterAnnotations(pool, {
    status: 'bound',
    tags: ['正面'],
    tagMode: 'any',
    keyword: '香蕉',
  })
  assert.deepStrictEqual(combo.map((a) => a.id), ['b1'])
  // 大小写不敏感
  const latin = [ann([], 'x', 'bound', 'Hello World')]
  assert.strictEqual(
    filterAnnotations(latin, { status: 'all', tags: [], tagMode: 'all', keyword: 'hello' }).length,
    1,
  )
  // 无匹配
  assert.strictEqual(
    filterAnnotations(pool, { status: 'all', tags: [], tagMode: 'all', keyword: '不存在' }).length,
    0,
  )
})

// ---------- 批量添加标签 ----------

check('添加标签：追加到末尾、保留原顺序、已存在的自动去重', () => {
  const anns = [ann(['甲', '乙'], 'x'), ann(['乙'], 'y'), ann([], 'z')]
  const plan = planBatchTagUpdate(anns, new Set(['x', 'y', 'z']), {
    kind: 'add',
    tags: ['乙', '丙'],
  })
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲', '乙', '丙']) // 乙已存在跳过
  assert.deepStrictEqual(plan.annotations[1]!.tags, ['乙', '丙'])
  assert.deepStrictEqual(plan.annotations[2]!.tags, ['乙', '丙'])
  assert.strictEqual(plan.changes.length, 3)
  assert.deepStrictEqual(plan.unchangedIds, [])
  // 输入不被修改
  assert.deepStrictEqual(anns[0]!.tags, ['甲', '乙'])
})

check('添加标签：全部已存在时该标注计入无变化', () => {
  const anns = [ann(['甲', '乙'], 'x'), ann(['丙'], 'y')]
  const plan = planBatchTagUpdate(anns, new Set(['x', 'y']), { kind: 'add', tags: ['甲'] })
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲', '乙'])
  assert.deepStrictEqual(plan.annotations[1]!.tags, ['丙', '甲'])
  assert.strictEqual(plan.changes.length, 1)
  assert.strictEqual(plan.changes[0]!.annotationId, 'y')
  assert.deepStrictEqual(plan.unchangedIds, ['x'])
  // 无变化项保持原引用
  assert.strictEqual(plan.annotations[0], anns[0])
})

check('添加标签：操作标签归一（去 #、去重）后生效', () => {
  const anns = [ann(['甲'], 'x')]
  const plan = planBatchTagUpdate(anns, new Set(['x']), {
    kind: 'add',
    tags: [' #乙 ', '乙', ''],
  })
  assert.deepStrictEqual(plan.op.tags, ['乙'])
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲', '乙'])
})

// ---------- 批量移除标签 ----------

check('移除标签：精确移除，其余顺序不变', () => {
  const anns = [ann(['甲', '乙', '丙'], 'x'), ann(['乙', '丁'], 'y')]
  const plan = planBatchTagUpdate(anns, new Set(['x', 'y']), {
    kind: 'remove',
    tags: ['乙', '丙'],
  })
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲'])
  assert.deepStrictEqual(plan.annotations[1]!.tags, ['丁'])
  assert.strictEqual(plan.changes.length, 2)
})

check('移除标签：不命中时计入无变化；可移除全部标签', () => {
  const anns = [ann(['甲'], 'x'), ann(['乙'], 'y')]
  const plan = planBatchTagUpdate(anns, new Set(['x', 'y']), { kind: 'remove', tags: ['甲'] })
  assert.deepStrictEqual(plan.annotations[0]!.tags, [])
  assert.deepStrictEqual(plan.annotations[1]!.tags, ['乙'])
  assert.strictEqual(plan.changes.length, 1)
  assert.deepStrictEqual(plan.unchangedIds, ['y'])
  assert.deepStrictEqual(plan.changes[0]!.before, ['甲'])
  assert.deepStrictEqual(plan.changes[0]!.after, [])
})

// ---------- 边界与纯度 ----------

check('未选中的标注不受影响；不存在的 ID 自动跳过', () => {
  const anns = [ann(['甲'], 'x'), ann(['甲'], 'y')]
  const plan = planBatchTagUpdate(anns, new Set(['y', 'ghost']), {
    kind: 'add',
    tags: ['乙'],
  })
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲'])
  assert.deepStrictEqual(plan.annotations[1]!.tags, ['甲', '乙'])
  assert.strictEqual(plan.annotations.length, 2)
  assert.strictEqual(plan.changes.length, 1)
})

check('空选择或空操作标签：无任何变更', () => {
  const anns = [ann(['甲'], 'x')]
  const noSel = planBatchTagUpdate(anns, new Set(), { kind: 'add', tags: ['乙'] })
  assert.strictEqual(noSel.changes.length, 0)
  assert.deepStrictEqual(noSel.annotations[0]!.tags, ['甲'])
  const noTags = planBatchTagUpdate(anns, new Set(['x']), { kind: 'add', tags: ['', ' '] })
  assert.strictEqual(noTags.changes.length, 0)
  assert.deepStrictEqual(noTags.annotations[0]!.tags, ['甲'])
})

check('pending 标注同样参与批量更新，状态不变', () => {
  const anns = [ann(['甲'], 'x', 'pending')]
  const plan = planBatchTagUpdate(anns, new Set(['x']), { kind: 'add', tags: ['乙'] })
  assert.deepStrictEqual(plan.annotations[0]!.tags, ['甲', '乙'])
  assert.strictEqual(plan.annotations[0]!.status, 'pending')
  assert.strictEqual(plan.changes[0]!.status, 'pending')
})

check('计划是纯函数：输入数组与标注对象不被修改', () => {
  const anns = [ann(['甲', '乙'], 'x'), ann(['丙'], 'y')]
  const snapshot = JSON.stringify(anns)
  planBatchTagUpdate(anns, new Set(['x', 'y']), { kind: 'remove', tags: ['甲', '丙'] })
  assert.strictEqual(JSON.stringify(anns), snapshot)
})

console.log(`\n全部 ${passed} 项通过`)

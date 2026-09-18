// 批量操作：组合筛选 + 批量添加 / 移除标签
//
// 筛选条件（全部条件按 AND 组合）：
//   - 标注状态：全部 / 仅已绑定 / 仅待处理；
//   - 标签：选择若干标签后，按「全部」（标注需包含全部所选标签）或「任一」（包含任一所选标签）匹配；
//     未选择标签时不过滤；
//   - 引文关键词：大小写不敏感的子串匹配；空串不过滤。
//
// 批量标签操作以「计划」形式计算（纯函数，不修改传入数据）：
// 预览阶段与确认落地使用同一个 planBatchTagUpdate，保证预览所见即最终落地；
// 取消预览时直接丢弃计划即可，不产生任何数据变更。
//   - 添加标签：新标签按输入顺序追加到原有标签之后，原顺序不变；已存在的标签自动跳过（去重）；
//   - 移除标签：精确移除命中标签，其余标签顺序不变；
//   - 标签无实际变化的标注计入 unchangedIds，不写入变更。

import type { Annotation, AnnotationStatus } from '../types'
import { normalizeTag } from './conflicts'

/** 批量筛选条件 */
export interface BatchFilter {
  /** 标注状态：all=全部；bound=仅已绑定；pending=仅待处理 */
  status: 'all' | AnnotationStatus
  /** 参与筛选的标签；空数组表示不按标签筛选 */
  tags: string[]
  /** all=需包含全部所选标签；any=包含任一所选标签即可 */
  tagMode: 'all' | 'any'
  /** 引文关键词（大小写不敏感子串匹配）；空串表示不按关键词筛选 */
  keyword: string
}

/** 批量标签操作：添加 / 移除 */
export type BatchTagOperation =
  | { kind: 'add'; tags: string[] }
  | { kind: 'remove'; tags: string[] }

/** 一条标注的标签变更明细（用于预览） */
export interface BatchTagChange {
  annotationId: string
  quote: string
  status: AnnotationStatus
  before: string[]
  after: string[]
}

/** 批量标签操作计划：既是预览数据，也是落地依据 */
export interface BatchTagPlan {
  /** 归一化后的操作（标签已去空白 / # 并去重） */
  op: BatchTagOperation
  /** 落地后的完整标注数组（顺序不变，未变更项保持原引用） */
  annotations: Annotation[]
  /** 实际发生标签变化的标注明细，按原标注顺序 */
  changes: BatchTagChange[]
  /** 被选中但标签无变化的标注 ID（添加时已全部存在 / 移除时均不命中） */
  unchangedIds: string[]
}

/** 标签列表归一：去空白与前导 #、丢弃空项、按首次出现去重（保序） */
export function normalizeBatchTags(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const t of raw) {
    const v = normalizeTag(String(t ?? ''))
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 解析批量添加的标签输入：按逗号 / 顿号 / 分号 / 空白分隔后归一去重 */
export function parseTagInput(text: string): string[] {
  return normalizeBatchTags(String(text ?? '').split(/[,，、;；\s]+/))
}

/**
 * 组合筛选：状态、标签（全部 / 任一）、引文关键词按 AND 组合。
 * 返回匹配标注（保持传入顺序）。纯函数：不修改传入数据。
 */
export function filterAnnotations(
  annotations: readonly Annotation[],
  filter: BatchFilter,
): Annotation[] {
  const keyword = filter.keyword.trim().toLowerCase()
  const tags = normalizeBatchTags(filter.tags)
  return annotations.filter((a) => {
    if (filter.status !== 'all' && a.status !== filter.status) return false
    if (tags.length > 0) {
      const hit =
        filter.tagMode === 'all'
          ? tags.every((t) => a.tags.includes(t))
          : tags.some((t) => a.tags.includes(t))
      if (!hit) return false
    }
    if (keyword && !a.quote.toLowerCase().includes(keyword)) return false
    return true
  })
}

/**
 * 计算批量标签操作计划。
 * 仅处理 selectedIds 中的标注（按原数组顺序）；不存在的 ID 自动跳过。
 * 纯函数：不修改传入数据；selectedIds 为空或操作标签归一后为空时，changes 为空。
 */
export function planBatchTagUpdate(
  annotations: readonly Annotation[],
  selectedIds: ReadonlySet<string>,
  op: BatchTagOperation,
): BatchTagPlan {
  const tags = normalizeBatchTags(op.tags)
  const normalizedOp: BatchTagOperation = { kind: op.kind, tags }
  const changes: BatchTagChange[] = []
  const unchangedIds: string[] = []

  if (tags.length === 0 || selectedIds.size === 0) {
    return { op: normalizedOp, annotations: [...annotations], changes, unchangedIds }
  }

  const removeSet = op.kind === 'remove' ? new Set(tags) : null

  const next = annotations.map((a) => {
    if (!selectedIds.has(a.id)) return a
    let after: string[]
    if (removeSet) {
      after = a.tags.filter((t) => !removeSet.has(t))
    } else {
      // 追加尚未出现的标签：原顺序不变，重复自动跳过
      after = [...a.tags]
      for (const t of tags) {
        if (!after.includes(t)) after.push(t)
      }
    }
    if (after.length === a.tags.length) {
      unchangedIds.push(a.id)
      return a
    }
    changes.push({
      annotationId: a.id,
      quote: a.quote,
      status: a.status,
      before: [...a.tags],
      after,
    })
    return { ...a, tags: after }
  })

  return { op: normalizedOp, annotations: next, changes, unchangedIds }
}

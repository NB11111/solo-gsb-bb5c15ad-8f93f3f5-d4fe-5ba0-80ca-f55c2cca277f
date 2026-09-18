import { useMemo, useState } from 'react'
import type { Annotation, AnnotationStatus } from '../types'
import {
  filterAnnotations,
  planBatchTagUpdate,
  type BatchTagOperation,
} from '../lib/batchOps'
import { badgeColor } from '../lib/segments'
import { TagEditor } from './TagEditor'

interface Props {
  annotations: Annotation[]
  activeId: string | null
  onFocus: (a: Annotation) => void
  /** 确认应用：由 App 以当前数据重算计划并在一次状态更新中原子落地 */
  onApply: (ids: string[], op: BatchTagOperation) => void
}

type StatusFilter = 'all' | AnnotationStatus

const STATUS_OPTIONS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'bound', label: '已绑定' },
  { key: 'pending', label: '待处理' },
]

/** 标签展示（# 前缀），空标签给占位 */
function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="rename-empty">（无标签）</span>
  return (
    <>
      {tags.map((t, i) => (
        <span className="ann-tag" key={`${t}-${i}`}>
          #{t}
        </span>
      ))}
    </>
  )
}

/**
 * 批量操作侧栏分区：
 * 按状态 / 标签（全部、任一）/ 引文关键词组合筛选 → 勾选（全选、反选）→
 * 添加 / 移除标签 → 逐条预览标签变化 → 确认后一次性落地。
 * 筛选与选择均为本地状态；确认前不改动任何数据。
 */
export function BatchOpsSection(props: Props) {
  const { annotations } = props

  const [status, setStatus] = useState<StatusFilter>('all')
  const [tagMode, setTagMode] = useState<'all' | 'any'>('all')
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [opKind, setOpKind] = useState<'add' | 'remove'>('add')
  const [addTags, setAddTags] = useState<string[]>([])
  const [removeTags, setRemoveTags] = useState<string[]>([])
  const [resultMsg, setResultMsg] = useState<string | null>(null)

  // 当前标注中实际使用的全部标签（筛选 chips 与添加补全的候选）
  const allAnnotationTags = useMemo(() => {
    const set = new Set<string>()
    annotations.forEach((a) => a.tags.forEach((t) => set.add(t)))
    return [...set]
  }, [annotations])

  const matched = useMemo(
    () => filterAnnotations(annotations, { status, tags: filterTags, tagMode, keyword }),
    [annotations, status, filterTags, tagMode, keyword],
  )

  // 操作目标：当前匹配结果中被勾选的标注（筛选变化后未匹配的勾选自动失效，不参与操作）
  const selectedMatched = useMemo(
    () => matched.filter((a) => selected.has(a.id)),
    [matched, selected],
  )
  const selectedIds = useMemo(
    () => new Set(selectedMatched.map((a) => a.id)),
    [selectedMatched],
  )

  // 移除操作的候选标签：选中标注上实际存在的标签（并集，按出现顺序）
  const removableTags = useMemo(() => {
    const out: string[] = []
    for (const a of selectedMatched) {
      for (const t of a.tags) {
        if (!out.includes(t)) out.push(t)
      }
    }
    return out
  }, [selectedMatched])

  const opTags = opKind === 'add' ? addTags : removeTags

  // 预览计划：与确认落地使用同一纯函数；确认时 App 以同一份输入重算，保证一致
  const plan = useMemo(
    () =>
      planBatchTagUpdate(annotations, selectedIds, {
        kind: opKind,
        tags: opKind === 'add' ? addTags : removeTags,
      }),
    [annotations, selectedIds, opKind, addTags, removeTags],
  )

  const showPreview = selectedMatched.length > 0 && opTags.length > 0
  const canConfirm = showPreview && plan.changes.length > 0

  const changeById = useMemo(
    () => new Map(plan.changes.map((c) => [c.annotationId, c])),
    [plan],
  )

  const toggleFilterTag = (tag: string) => {
    setResultMsg(null)
    setFilterTags((ts) => (ts.includes(tag) ? ts.filter((t) => t !== tag) : [...ts, tag]))
  }

  const toggleSelect = (id: string) => {
    setResultMsg(null)
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    setResultMsg(null)
    setSelected((s) => {
      const next = new Set(s)
      matched.forEach((a) => next.add(a.id))
      return next
    })
  }

  const invertSelection = () => {
    setResultMsg(null)
    setSelected((s) => {
      const next = new Set(s)
      matched.forEach((a) => {
        if (next.has(a.id)) next.delete(a.id)
        else next.add(a.id)
      })
      return next
    })
  }

  /** 取消：丢弃本次操作草稿（预览随之消失），不改动任何数据 */
  const cancel = () => {
    setAddTags([])
    setRemoveTags([])
    setResultMsg(null)
  }

  const confirm = () => {
    if (!canConfirm) return
    const changed = plan.changes.length
    const unchanged = plan.unchangedIds.length
    props.onApply([...selectedIds], { kind: opKind, tags: [...opTags] })
    const tagText = plan.op.tags.map((t) => `#${t}`).join('、')
    setResultMsg(
      opKind === 'add'
        ? `已为 ${changed} 条标注添加标签 ${tagText}${unchanged > 0 ? `（${unchanged} 条已含全部标签，无需变化）` : ''}。`
        : `已从 ${changed} 条标注移除标签 ${tagText}${unchanged > 0 ? `（${unchanged} 条不含这些标签，无需变化）` : ''}。`,
    )
    // 操作完成后清空勾选与操作草稿；筛选条件保留，匹配数量随之刷新
    setSelected(new Set())
    setAddTags([])
    setRemoveTags([])
  }

  return (
    <section className="side-section">
      <h2 className="side-heading">批量操作</h2>
      <p className="side-hint">
        按<strong>状态、标签、引文关键词</strong>组合筛选后勾选标注，批量<strong>添加 / 移除标签</strong>。
        提交前逐条预览标签变化，确认后一次性更新（保留原标签顺序、自动去重）；取消不改动任何数据。
      </p>

      {/* ---------- 筛选 ---------- */}
      <div className="batch-block">
        <span className="form-label">标注状态</span>
        <div className="batch-pills">
          {STATUS_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.key}
              className={`batch-pill ${status === o.key ? 'batch-pill-on' : ''}`}
              aria-pressed={status === o.key}
              onClick={() => {
                setResultMsg(null)
                setStatus(o.key)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>

        <span className="form-label">标签（未选择时不过滤）</span>
        {allAnnotationTags.length === 0 ? (
          <p className="side-hint">还没有任何标签。</p>
        ) : (
          <>
            <div className="cov-tagpick">
              {allAnnotationTags.map((t) => (
                <button
                  type="button"
                  key={t}
                  className={`cov-tag ${filterTags.includes(t) ? 'cov-tag-on' : ''}`}
                  aria-pressed={filterTags.includes(t)}
                  onClick={() => toggleFilterTag(t)}
                >
                  #{t}
                </button>
              ))}
            </div>
            <div className="batch-pills">
              <button
                type="button"
                className={`batch-pill ${tagMode === 'all' ? 'batch-pill-on' : ''}`}
                aria-pressed={tagMode === 'all'}
                title="标注需同时包含全部所选标签"
                onClick={() => {
                  setResultMsg(null)
                  setTagMode('all')
                }}
              >
                全部
              </button>
              <button
                type="button"
                className={`batch-pill ${tagMode === 'any' ? 'batch-pill-on' : ''}`}
                aria-pressed={tagMode === 'any'}
                title="标注包含任一所选标签即可"
                onClick={() => {
                  setResultMsg(null)
                  setTagMode('any')
                }}
              >
                任一
              </button>
              <span className="batch-pill-hint">
                {tagMode === 'all' ? '需包含全部所选标签' : '包含任一所选标签即可'}
              </span>
            </div>
          </>
        )}

        <label className="form-label" htmlFor="batch-keyword">
          引文关键词
        </label>
        <input
          id="batch-keyword"
          className="rule-input"
          value={keyword}
          placeholder="引文包含…（大小写不敏感）"
          onChange={(e) => {
            setResultMsg(null)
            setKeyword(e.target.value)
          }}
        />
      </div>

      {/* ---------- 匹配与选择 ---------- */}
      <div className="batch-matchbar">
        <span className="batch-match-count">
          匹配 <strong>{matched.length}</strong> 条 · 已选{' '}
          <strong>{selectedMatched.length}</strong> 条
        </span>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          disabled={matched.length === 0}
          onClick={selectAll}
        >
          全选
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          disabled={matched.length === 0}
          onClick={invertSelection}
        >
          反选
        </button>
      </div>

      {matched.length === 0 ? (
        <p className="side-hint">当前筛选条件下没有匹配的标注，请调整状态、标签或关键词。</p>
      ) : (
        <div className="batch-list">
          {matched.map((a) => (
            <div
              key={a.id}
              className={`batch-row ${selected.has(a.id) ? 'batch-row-on' : ''} ${
                props.activeId === a.id ? 'batch-row-active' : ''
              }`}
            >
              <label className="batch-row-check">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggleSelect(a.id)}
                />
                <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
                <span className="batch-row-quote" title={a.quote}>
                  {a.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
                  {a.quote || <span className="ann-empty-quote">（空引文）</span>}
                </span>
              </label>
              {a.tags.length > 0 && (
                <span className="batch-row-tags">
                  {a.tags.map((t) => (
                    <span className="ann-tag" key={t}>
                      #{t}
                    </span>
                  ))}
                </span>
              )}
              {a.status === 'bound' && (
                <button
                  type="button"
                  className="btn btn-small btn-ghost batch-row-locate"
                  onClick={() => props.onFocus(a)}
                >
                  定位
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------- 操作 ---------- */}
      <div className="batch-block">
        <span className="form-label">操作</span>
        <div className="batch-pills">
          <button
            type="button"
            className={`batch-pill ${opKind === 'add' ? 'batch-pill-on' : ''}`}
            aria-pressed={opKind === 'add'}
            onClick={() => {
              setResultMsg(null)
              setOpKind('add')
            }}
          >
            添加标签
          </button>
          <button
            type="button"
            className={`batch-pill ${opKind === 'remove' ? 'batch-pill-on' : ''}`}
            aria-pressed={opKind === 'remove'}
            onClick={() => {
              setResultMsg(null)
              setOpKind('remove')
            }}
          >
            移除标签
          </button>
        </div>

        {opKind === 'add' ? (
          <TagEditor
            tags={addTags}
            onChange={(ts) => {
              setResultMsg(null)
              setAddTags(ts)
            }}
            suggestions={allAnnotationTags}
            placeholder="输入要添加的标签，回车或逗号分隔（可多个）"
          />
        ) : removableTags.length === 0 ? (
          <p className="side-hint">
            {selectedMatched.length === 0
              ? '请先勾选要操作的标注。'
              : '选中的标注上没有任何标签可移除。'}
          </p>
        ) : (
          <div className="cov-tagpick">
            {removableTags.map((t) => (
              <button
                type="button"
                key={t}
                className={`cov-tag ${removeTags.includes(t) ? 'cov-tag-on' : ''}`}
                aria-pressed={removeTags.includes(t)}
                title={removeTags.includes(t) ? '点击取消移除该标签' : '点击标记移除该标签'}
                onClick={() => {
                  setResultMsg(null)
                  setRemoveTags((ts) =>
                    ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t],
                  )
                }}
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ---------- 预览与确认 ---------- */}
      {showPreview && (
        <div className="rename-preview batch-preview">
          <p className="batch-preview-summary">
            预览：选中 <strong>{selectedMatched.length}</strong> 条 · 将更新{' '}
            <strong>{plan.changes.length}</strong> 条 · 无变化{' '}
            <strong>{plan.unchangedIds.length}</strong> 条
          </p>
          <ul className="rename-list batch-preview-list">
            {selectedMatched.map((a) => {
              const change = changeById.get(a.id)
              const before = change ? change.before : a.tags
              const after = change ? change.after : a.tags
              return (
                <li key={a.id} className="rename-ann-row">
                  <div className="rename-ann-quote" title={a.quote}>
                    {a.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
                    {a.quote || <span className="ann-empty-quote">（空引文）</span>}
                    {!change && (
                      <span className="batch-unchanged-flag">
                        {opKind === 'add' ? '已含全部标签' : '不含这些标签'}
                      </span>
                    )}
                  </div>
                  <div className="rename-tag-flow">
                    <span className="rename-tags">
                      <TagList tags={before} />
                    </span>
                    <span className="rename-arrow">→</span>
                    <span className="rename-tags">
                      <TagList tags={after} />
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
          {plan.changes.length === 0 && (
            <p className="rename-msg">选中标注的标签均无需变化，确认按钮不可用。</p>
          )}
          <div className="form-actions">
            <span className="form-spacer" />
            <button type="button" className="btn btn-small btn-ghost" onClick={cancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={!canConfirm}
              onClick={confirm}
            >
              确认更新{plan.changes.length > 0 ? `（${plan.changes.length} 条）` : ''}
            </button>
          </div>
        </div>
      )}

      {!showPreview && selectedMatched.length > 0 && (
        <p className="side-hint">
          {opKind === 'add'
            ? '输入要添加的标签后，这里会逐条预览标签变化。'
            : '选择要移除的标签后，这里会逐条预览标签变化。'}
        </p>
      )}

      {resultMsg && <p className="batch-result">{resultMsg}</p>}
    </section>
  )
}

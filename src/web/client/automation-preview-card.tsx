/**
 * 会话里的参数预览卡。
 *
 * 确认前把「这条任务到底是什么」摊开给用户看：触发方式、过滤条件、
 * 处理方式、归属项目、运行时。确认动作放在卡脚，不放在别处 ——
 * 用户点的那个按钮，必须和看到的那张卡是同一件事。
 */
import { Icon } from './icons.js'
import { MODE_LABEL, modeClass } from './automation-model.js'

/** 预览卡数据；与服务端的 `AutomationPreview` 同形。 */
export interface AutomationPreview {
  name: string
  source: string
  types: string[]
  params: Record<string, string>
  keywords: string[]
  semantic: string
  mode: string
  project: string
  skill: string
  runtimeId: string
  prompt: string
  trigger: string
}

/** 参数预览卡。 */
export function AutomationPreviewCard({ preview, busy, onConfirm, onAdjust }: {
  preview: AutomationPreview
  busy: boolean
  onConfirm: () => void
  onAdjust: () => void
}): JSX.Element {
  const keywords = preview.keywords.join('、')
  const params = Object.entries(preview.params)
  return (
    <div className="preview-card">
      <div className="preview-head">
        <strong>{preview.name || '未命名任务'}</strong>
        <span>{preview.trigger}</span>
      </div>
      <div className="preview-body">
        <dl>
          <div className="preview-row">
            <dt>触发方式</dt>
            <dd>
              {preview.source ? (
                <>
                  <span className="mono">{preview.source}</span>
                  {preview.types.length > 0 && <> · {preview.types.join('、')}</>}
                </>
              ) : (
                preview.trigger
              )}
            </dd>
          </div>
          {params.length > 0 && (
            <div className="preview-row">
              <dt>连接参数</dt>
              <dd>{params.map(([key, value]) => <span key={key} className="mono">{key}={value}</span>).join('，')}</dd>
            </div>
          )}
          <div className="preview-row">
            <dt>过滤条件</dt>
            <dd>{keywords || preview.semantic || '不过滤，全部命中'}</dd>
          </div>
          <div className="preview-row">
            <dt>处理方式</dt>
            <dd>
              <span className={modeClass(preview.mode === 'review' ? 'review' : preview.mode === 'notify' ? 'notify' : 'auto')}>
                <i />{MODE_LABEL[preview.mode === 'review' ? 'review' : preview.mode === 'notify' ? 'notify' : 'auto']}
              </span>
              {preview.skill && <span className="muted"> · {preview.skill}</span>}
            </dd>
          </div>
          <div className="preview-row">
            <dt>归属项目</dt>
            <dd>{preview.project || '（未定）'}</dd>
          </div>
          <div className="preview-row">
            <dt>运行时</dt>
            <dd>{preview.runtimeId || '跟随默认运行时'}</dd>
          </div>
        </dl>
      </div>
      <div className="preview-foot">
        <span className="muted">确认后才写进自动化任务</span>
        <button className="btn tiny ghost" onClick={onAdjust} disabled={busy}>再改改</button>
        <button className="btn tiny primary" onClick={onConfirm} disabled={busy}>
          <Icon name="check" size={11} />确认创建
        </button>
      </div>
    </div>
  )
}


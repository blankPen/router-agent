/**
 * 飞书渠道的描述与表单。
 *
 * 这是「渠道注册表」的第一个条目：页面只认 ChannelDescriptor，
 * 这里描述飞书自己的配置块（凭据、授权、接收范围、群绑定、消息处理）。
 * 以后接第二个渠道，只需要再加一个同类描述文件。
 */
import { FeishuBotPanel } from './feishu-panel.js'
import { ChatsEditor } from './chat-editor.js'
import { IdentityNotices } from './identity-notices.js'
import { FieldRow } from './field-row.js'
import { chatsIssue, type ChatDraft } from './config-shared.js'
import type { ChannelDescriptor, ChannelPanelProps } from './channels.js'
import { getByPath, type ConfigBlock, type FieldDef } from './fields.js'

const APP_ID_FIELD: FieldDef = {
  path: 'feishu.appId',
  label: '应用 App ID',
  kind: 'text',
  placeholder: '飞书开放平台 → 凭证与基础信息',
  hint: '机器人所属应用的 App ID；App Secret 写在下面，不落 config.yaml',
}

const DIRECT_MESSAGES_FIELD: FieldDef = {
  path: 'feishu.directMessages',
  label: '接收私聊',
  kind: 'switch',
  hint: '关掉后机器人只处理群消息',
}

const ALLOWED_FIELD: FieldDef = {
  path: 'feishu.allowed',
  label: '全局允许名单',
  kind: 'list',
  placeholder: 'alice@company.com, bob@company.com',
  hint: '推荐填邮箱；换应用后 open_id 会变，邮箱不会。名单外的消息一律不接',
}

const REACTION_FIELD: FieldDef = {
  path: 'feishu.reaction',
  label: '回执表情',
  kind: 'text',
  placeholder: '例如 Typing，留空 = 关闭',
  hint: '收到消息先回一个表情，回复发出后再撤掉',
}

const IMAGE_FIELDS: FieldDef[] = [
  { path: 'feishu.images.enabled', label: '图片转文本', kind: 'switch', hint: '下载 image_key 后交给多模态模型识别' },
  { path: 'feishu.images.maxChars', label: '单张图片最多字符', kind: 'number', min: 100, max: 20_000, unit: '字' },
  { path: 'feishu.images.timeoutMs', label: '单张图片识别超时', kind: 'number', min: 1_000, max: 300_000, unit: '毫秒', ms: true },
]

const ADVANCED_FIELDS: FieldDef[] = [
  { path: 'feishu.bots', label: '可引用的机器人', kind: 'list', placeholder: 'ou_xxx', hint: '允许在消息里 @ 的其它机器人' },
  { path: 'feishu.botOpenIds', label: '机器人自身 open_id', kind: 'list', placeholder: 'ou_xxx', hint: '留空 = 按 App ID 自动识别机器人' },
  { path: 'feishu.botNames', label: '机器人显示名', kind: 'list', placeholder: '阿罗', hint: '留空 = 按 App ID 自动识别机器人' },
]

export const feishuChannel: ChannelDescriptor = {
  id: 'feishu',
  kind: 'feishu',
  label: '飞书',
  summary: '飞书开放平台机器人：群消息与私聊进 Router，回复也发回飞书。',
  icon: 'radio',
  blocks: [
    {
      id: 'app',
      title: '应用凭据',
      description: '机器人在飞书开放平台上的应用标识。',
      fields: [APP_ID_FIELD],
    },
    {
      id: 'bot',
      title: '机器人与授权',
      description: 'App Secret 写入 lark-cli 加密存储，不落 config.yaml；授权后机器人才能被人 @。',
      render: 'custom',
      fields: [],
    },
    {
      id: 'receive',
      title: '接收范围',
      description: '私聊与全局允许名单：名单外的人发来的消息一律不接。',
      render: 'custom',
      fields: [DIRECT_MESSAGES_FIELD, ALLOWED_FIELD],
    },
    {
      id: 'chats',
      title: '群与绑定',
      description: '配置监控哪些群、收全部消息还是只收 @；绑定项目只能从当前后端的项目清单里选。',
      render: 'custom',
      fields: [],
      paths: ['feishu.chats'],
    },
    {
      id: 'message',
      title: '消息处理',
      description: '回执表情与图片转文本。',
      fields: [REACTION_FIELD, ...IMAGE_FIELDS],
    },
    {
      id: 'advanced',
      title: '高级',
      description: '机器人身份自动识别失败时的兜底配置，一般不需要改。',
      folded: true,
      fields: ADVANCED_FIELDS,
    },
  ],
  custom: {
    bot: props => <FeishuBotChannelBlock {...props} />,
    receive: props => <FeishuReceiveBlock {...props} />,
    chats: props => <FeishuChatsBlock {...props} />,
  },
  // 群列表不是普通字段：单独声明路径与校验规则。
  validate: (draft): Record<string, string> => {
    const message = chatsIssue(draft.feishu?.chats)
    return message ? { 'feishu.chats': message } : {}
  },
  identityPaths: ['feishu.allowed', 'feishu.chats'],
  status: (draft, identity) => {
    const appId = String(draft.feishu?.appId ?? '').trim()
    if (!appId) return { label: '未接入', tone: 'muted' }
    if (identity && !identity.bot.resolved) return { label: '待授权', tone: 'warn' }
    return { label: '已接入', tone: 'ok' }
  },
}

/** 机器人与授权：凭据写入 + 机器人 / 授权状态 + 机器人身份解析提示。 */
function FeishuBotChannelBlock(props: ChannelPanelProps & { block: ConfigBlock }): JSX.Element {
  const { draft, identity, staleIdentity, onConfigSaved } = props
  return (
    <>
      <IdentityNotices identity={identity} stale={staleIdentity} scope="bot" />
      <FeishuBotPanel
        appId={String(draft.feishu?.appId ?? '')}
        onConfigSaved={onConfigSaved}
      />
    </>
  )
}

/** 接收范围：私聊开关 + 全局允许名单 + 名单解析状态。 */
function FeishuReceiveBlock(props: ChannelPanelProps & { block: ConfigBlock }): JSX.Element {
  const { draft, defaults, setField, errors, identity, staleIdentity } = props
  return (
    <>
      <div className="settings-rows">
        {props.block.fields.map(field => (
          <FieldRow
            key={field.path}
            field={field}
            value={getByPath(draft, field.path)}
            defaultValue={getByPath(defaults, field.path)}
            error={errors.get(field.path)}
            onChange={value => setField(field.path, value)}
          />
        ))}
      </div>
      <IdentityNotices identity={identity} stale={staleIdentity} scope="allowlist" />
    </>
  )
}

/** 群与绑定：监控群列表 + 每个群的接收方式、绑定项目与群级名单。 */
function FeishuChatsBlock(props: ChannelPanelProps & { block: ConfigBlock }): JSX.Element {
  const { draft, setField, errors, projects } = props
  const chats = (draft.feishu?.chats ?? []) as ChatDraft[]
  return (
    <>
      <p className="editor-hint">
        群级名单推荐填邮箱（兼容 ou_xxx）：配了却解析不到人时，该群会拒绝所有人，不会退回全局名单。
      </p>
      <ChatsEditor
        chats={chats}
        projects={projects}
        error={errors.get('feishu.chats') ?? chatsIssue(draft.feishu?.chats) ?? undefined}
        onChange={value => setField('feishu.chats', value)}
      />
    </>
  )
}

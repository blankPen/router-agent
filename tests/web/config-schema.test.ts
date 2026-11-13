/**
 * 配置页层次与渠道注册表的展示逻辑。
 *
 * 这些是纯函数：分组顺序、生效方式推导、渠道合并规则。
 */
import { describe, expect, it } from 'vitest'
import {
  CONFIG_GROUPS,
  blockEffect,
  blockPaths,
  fieldPaths,
  groupEffect,
  groupFields,
  groupsFor,
} from '../../src/web/client/fields.js'
import {
  CHANNELS,
  channelById,
  channelFieldPaths,
  channelSetupBlocks,
  channelSetupExtraFields,
  channelSetupFields,
  channelSetupPaths,
  mergeChannels,
} from '../../src/web/client/channels.js'

const HOT = ['policy.', 'feishu.allowed']

describe('配置分组与块', () => {
  it('一级分组按「LLM Provider → 决策层 → 运行时 → 渠道 → 项目 → 消息准入 → 其他设置」排列', () => {
    expect(CONFIG_GROUPS.map(group => group.id)).toEqual([
      'llm',
      'decision',
      'runtime',
      'channels',
      'projects',
      'admission',
      'ops',
    ])
    expect(CONFIG_GROUPS.map(group => group.title)).toEqual([
      'LLM Provider',
      '决策层',
      '运行时配置',
      '渠道配置',
      '项目配置',
      '消息准入',
      '其他设置',
    ])
  })

  it('每个分组都有标题与说明', () => {
    for (const group of CONFIG_GROUPS) {
      expect(group.title.length).toBeGreaterThan(0)
      expect(group.description.length).toBeGreaterThan(0)
    }
  })

  it('低频项下沉为折叠块', () => {
    const folded = [
      ...CONFIG_GROUPS.flatMap(group => group.blocks),
      ...CHANNELS.flatMap(channel => channel.blocks),
    ].filter(block => block.folded)
    expect(folded.map(block => block.id)).toContain('session')
    expect(folded.map(block => block.id)).toContain('advanced')
  })

  it('渠道分组不带字段：内容由渠道注册表提供', () => {
    const channels = CONFIG_GROUPS.find(group => group.kind === 'channels')
    expect(channels).toBeDefined()
    expect(channels!.blocks).toEqual([])
  })

  it('运行时与项目各自成组，方便左侧导航定位', () => {
    const runtime = CONFIG_GROUPS.find(group => group.id === 'runtime')!
    const projects = CONFIG_GROUPS.find(group => group.id === 'projects')!
    expect(runtime.blocks.map(block => block.id)).toContain('runtime')
    expect(projects.blocks.map(block => block.id)).toContain('projects')
  })
})

describe('生效方式推导', () => {
  it('全部热路径的块标立即生效', () => {
    const block = { id: 'p', title: '策略', fields: [{ path: 'policy.acceptMode', label: '接单模式', kind: 'select' as const }], }
    expect(blockEffect(block, HOT)).toEqual({ label: '立即生效', tone: 'hot' })
  })

  it('没有热路径的块标重启生效', () => {
    const block = { id: 'r', title: '研判', fields: [{ path: 'router.timeoutMs', label: '超时', kind: 'number' as const }], }
    expect(blockEffect(block, HOT)).toEqual({ label: '重启生效', tone: 'cold' })
  })

  it('冷热混在一起的块标部分立即生效', () => {
    const block = {
      id: 'm',
      title: '混合',
      fields: [
        { path: 'feishu.allowed', label: '名单', kind: 'list' as const },
        { path: 'feishu.appId', label: 'App ID', kind: 'text' as const },
      ],
    }
    expect(blockEffect(block, HOT)).toEqual({ label: '部分立即生效', tone: 'mixed' })
  })

  it('分组只要有一项热配置就不能整体标重启生效', () => {
    const group = {
      id: 'g',
      title: '组',
      description: '',
      blocks: [
        { id: 'a', title: 'A', fields: [{ path: 'policy.maxWorkers', label: '并发', kind: 'number' as const }] },
        { id: 'b', title: 'B', fields: [{ path: 'router.timeoutMs', label: '超时', kind: 'number' as const }] },
      ],
    }
    expect(groupEffect(group, HOT).tone).toBe('mixed')
  })
})

describe('渠道注册表', () => {
  it('内置渠道只有飞书，且带完整表单', () => {
    expect(CHANNELS.map(channel => channel.id)).toEqual(['feishu'])
    const feishu = channelById('feishu')
    expect(feishu).toBeDefined()
    expect(feishu!.blocks.length).toBeGreaterThan(0)
    expect(feishu!.blocks.map(block => block.id)).toContain('chats')
  })

  it('渠道字段路径包含飞书的全部配置项', () => {
    const paths = channelFieldPaths(CHANNELS)
    expect(paths).toContain('feishu.appId')
    expect(paths).toContain('feishu.allowed')
    expect(paths).toContain('feishu.chats')
  })

  it('服务端没给渠道列表时退回前端描述表', () => {
    expect(mergeChannels([])).toEqual(CHANNELS)
  })

  it('服务端登记了没有描述的渠道时给出占位，不隐藏', () => {
    const merged = mergeChannels([{ id: 'feishu', kind: 'feishu' }, { id: 'slack', kind: 'slack' }])
    expect(merged.map(channel => channel.id)).toEqual(['feishu', 'slack'])
    const placeholder = merged[1]!
    expect(placeholder.label).toBe('slack')
    expect(placeholder.status({}, undefined)).toEqual({ label: '暂无配置项', tone: 'muted' })
  })
})

describe('渠道在初始化页的接入项', () => {
  it('初始化页展示的块来自渠道描述，不写死飞书', () => {
    const feishu = channelById('feishu')!
    expect(feishu.setup?.blocks).toEqual(['app', 'bot', 'chats'])
    const blocks = channelSetupBlocks(feishu)
    expect(blocks.map(block => block.id)).toEqual(['app', 'bot', 'chats'])
  })

  it('接入项的字段与路径覆盖凭据、私聊与群列表', () => {
    const feishu = channelById('feishu')!
    const fields = channelSetupFields(feishu)
    expect(fields.map(field => field.path)).toContain('feishu.appId')
    expect(fields.map(field => field.path)).toContain('feishu.directMessages')
    const paths = channelSetupPaths(feishu)
    expect(paths).toContain('feishu.chats')
    // 字段不重复：块内字段与额外字段合并后按路径去重。
    expect(new Set(fields.map(field => field.path)).size).toBe(fields.length)
  })

  it('额外字段单独渲染：不与块内字段重复', () => {
    const feishu = channelById('feishu')!
    const extra = channelSetupExtraFields(feishu)
    expect(extra.map(field => field.path)).toEqual(['feishu.directMessages'])
  })

  it('没有描述接入项的渠道不参与初始化', () => {
    const placeholder = mergeChannels([{ id: 'slack', kind: 'slack' }])[0]!
    expect(placeholder.setup).toBeUndefined()
    expect(channelSetupBlocks(placeholder)).toEqual([])
    expect(channelSetupPaths(placeholder)).toEqual([])
  })
})

describe('配置路径收集', () => {
  it('分组字段路径不重不漏地覆盖所有字段', () => {
    const paths = fieldPaths(groupFields(CONFIG_GROUPS))
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).toContain('policy.acceptMode')
    expect(paths).toContain('server.port')
  })

  it('块路径包含块自己声明的非字段路径', () => {
    const block = { id: 'chats', title: '群', fields: [], paths: ['feishu.chats'] }
    expect(blockPaths(block)).toEqual(['feishu.chats'])
  })

  it('注入探测结果后运行时下拉用真实选项', () => {
    const groups = groupsFor([{ id: 'orca', label: 'Orca', hint: '', status: 'ready' }])
    const runtime = groups.find(group => group.id === 'runtime')!.blocks
      .find(block => block.id === 'runtime')!
      .fields.find(field => field.path === 'runtime.default')!
    expect(runtime.options?.some(option => option.value === 'orca')).toBe(true)
  })
})

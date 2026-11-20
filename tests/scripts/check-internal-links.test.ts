import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_PATTERNS,
  FORBIDDEN_VALUES,
  findMatches,
  isScannable,
  scanRepository,
} from '../../scripts/check-internal-links.mjs'

/** 被禁字面量全部来自脚本本身，测试不再另抄一份。 */
const EMAIL_DOMAIN = FORBIDDEN_VALUES.companyEmailDomain
const ORG = FORBIDDEN_VALUES.orgName

/** 飞书租户子域：用占位以外的名字拼出来，避免测试自身引入真实租户字面量。 */
const TENANT = ['poi', 'zon'].join('')

/** 命中的规则名集合（不关心顺序：多条规则可能同时命中同一行）。 */
function rules(content: string): string[] {
  return [...new Set(findMatches(content).map(hit => hit.rule))]
}

/** 命中的行号（每行一行）。 */
function lines(content: string): number[] {
  return findMatches(content).map(hit => hit.line)
}

describe('内部链接检查', () => {
  it('命中公司邮箱域与飞书租户域名', () => {
    const content = `联系 someone@${EMAIL_DOMAIN} 或看 https://${TENANT}.feishu.cn/docx/abc`
    expect(rules(content)).toEqual(expect.arrayContaining(['飞书租户域名', '公司邮箱域']))
    // 所有命中都在同一行：命中行号唯一，说明没有扫到别的行
    expect([...new Set(lines(content))]).toEqual([1])
  })

  it('大小写变体与裸域名同样命中', () => {
    expect(rules(`${TENANT.toUpperCase()}.FEISHU.CN`)).toContain('飞书租户域名')
    expect(rules(`Someone@${EMAIL_DOMAIN.toUpperCase()}`)).toContain('公司邮箱域')
    expect(rules(`详见 ${TENANT}.feishu.cn/wiki/xxx`)).toContain('飞书租户域名')
  })

  it('URL 里带参数的写法也命中', () => {
    expect(rules(`https://${TENANT}.feishu.cn/docx/abc?from=chat`)).toContain('飞书租户域名')
  })

  it('URL 编码后的写法同样命中', () => {
    expect(rules(`https://${TENANT}%2efehisu%2ecn/docx/abc`)).toContain('飞书租户域名（URL 编码）')
    expect(rules(`user%40${EMAIL_DOMAIN.replace(/\./g, '%2e')}`)).toContain('公司邮箱域（URL 编码）')
    expect(rules(`user@${EMAIL_DOMAIN.replace(/\./g, '%2e')}`)).toContain('公司邮箱域（URL 编码）')
  })

  it('通用占位地址不命中', () => {
    expect(findMatches('https://example.feishu.cn/docx/abc')).toEqual([])
    expect(findMatches('alice@example.com')).toEqual([])
    expect(findMatches('https://github.com/blankPen/router-agent')).toEqual([])
    expect(findMatches('git@gitlab.example.com:acme/repo.git')).toEqual([])
  })

  it('内部组织标识命中，但普通单词不误报', () => {
    expect(rules(`name:${ORG}/router-agent`)).toContain('内部组织标识')
    expect(findMatches('the handshake succeeded')).toEqual([])
  })

  it('第三方技能目录不参与扫描', () => {
    expect(isScannable('.claude/skills/design-taste-frontend/SKILL.md')).toBe(false)
    expect(isScannable('.agents/skills/ponytail/SKILL.md')).toBe(false)
    expect(isScannable('node_modules/foo/index.js')).toBe(false)
    expect(isScannable('packages/core/dist/index.js')).toBe(false)
    expect(isScannable('src/config.ts')).toBe(true)
  })

  it('当前仓库自身没有残留的公司专属链接', () => {
    expect(scanRepository()).toEqual([])
  })

  it('规则集非空，避免脚本静默失效', () => {
    expect(FORBIDDEN_PATTERNS.length).toBeGreaterThan(0)
  })
})

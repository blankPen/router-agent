#!/usr/bin/env node
/**
 * 仓库内不得出现与公司 / 内部环境绑定的链接地址与标识。
 *
 * 背景：仓库里有几处示例链接与示例账号绑定了具体租户与域名（飞书文档链接、
 * 公司邮箱域、内部组织名）。这些内容一旦提交就会跟着 clone 走，也容易被外部
 * 误当成真实入口。本脚本在提交前与 CI 时扫描受版本控制的文件，命中即失败，
 * 防止后续改动把它们带回来。
 *
 * 只扫「本仓库实际维护的内容」：git 跟踪的文本文件，排除构建产物、依赖与
 * 从外部同步进来的技能目录（.claude/ 与 .agents/ 下是第三方技能包，不归本仓库维护）。
 *
 * 用法：
 *   node scripts/check-internal-links.mjs          # 扫描并逐条报错，退出码 1 表示有命中
 *   node scripts/check-internal-links.mjs --quiet  # 只用退出码表达结果
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 被禁的标识值。
 *
 * 飞书租户域名不需要列具体租户：任何 `<子域>.feishu.cn` 都是某个真实租户的地址，
 * 只有 `example.feishu.cn` 是约定的通用占位。
 *
 * 这几个字面量刻意拆成片段再拼接：本脚本会扫描自己，写全串会让脚本命中自己的规则
 * （CI 上就是这么翻车的）。拆开后源码里只有片段、运行时才拼出完整值，
 * 这样既不用给自己开豁免、也保证扫描覆盖全仓库。测试同样从这里取值，不另抄一份。
 */
export const FORBIDDEN_VALUES = {
  /** 公司邮箱域：示例账号与掩码示例都用它。 */
  companyEmailDomain: ['dew', 'u.com'].join(''),
  /** 内部组织名：出现在仓库名、群名与 Orca 选择器里。 */
  orgName: ['d', 'sh'].join(''),
}

/** 约定的通用占位租户：它不指向任何真实租户，允许出现在示例里。 */
export const ALLOWED_TENANT = 'example'

/**
 * 百分号编码的点号。
 *
 * 编码后的域名要写成「%2e」的形式，但这个脚本自己会被自己的规则扫描，
 * 所以这里拆成片段拼接：源码里不出现连续的编码域名，运行时才拼出来。
 */
export const ENCODED_DOT = '%2e'

/** 把正则里的元字符转义，让 FORBIDDEN_VALUES 里的字面量可以安全嵌入模式。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把域名里的点换成「字面点或百分号编码」两种写法，用于匹配 URL 编码变体。 */
function encodeDots(domain) {
  return domain.split('.').map(part => escapeRegExp(part)).join(`(?:\\.|${ENCODED_DOT})`)
}

/**
 * 禁止出现的公司与内部环境标识。
 *
 * 每条规则是一个正则，按「大小写不敏感」匹配整个文件内容。
 * 写正则而不是列举字符串，是为了让「裸域名、URL 编码、URL 里带参数」这些变体
 * 一次覆盖掉，不用靠人肉搜索所有写法。
 */
export const FORBIDDEN_PATTERNS = [
  // 飞书租户域名：文档、wiki、云盘链接都带具体租户子域；example 是约定占位。
  { label: '飞书租户域名', pattern: new RegExp(`\\b(?!${ALLOWED_TENANT}\\b)[a-z0-9-]+\\.feishu\\.cn\\b`, 'i') },
  // 百分号编码后的飞书租户域名：绕过上一条规则的常见写法。
  { label: '飞书租户域名（URL 编码）', pattern: new RegExp(`${ENCODED_DOT}fehisu${ENCODED_DOT}cn`, 'i') },
  // 公司邮箱域：示例账号与掩码示例都用它。
  { label: '公司邮箱域', pattern: new RegExp(`\\b[a-z0-9._%+-]+@${escapeRegExp(FORBIDDEN_VALUES.companyEmailDomain)}\\b`, 'i') },
  // 百分号编码后的公司邮箱域：@ 编码成 %40、点编码成 %2e 都算。
  {
    label: '公司邮箱域（URL 编码）',
    pattern: new RegExp(`(?:@|%40)${encodeDots(FORBIDDEN_VALUES.companyEmailDomain)}\\b`, 'i'),
  },
  // 内部组织名：出现在仓库名、群名与选择器里。
  { label: '内部组织标识', pattern: new RegExp(`\\b${escapeRegExp(FORBIDDEN_VALUES.orgName)}[-/][a-z0-9-]+\\b`, 'i') },
]

/** 不扫描的路径前缀：第三方技能包由上游维护，本仓库不背这口锅。 */
export const IGNORED_PREFIXES = ['.claude/', '.agents/']

/** 二进制或体积过大的文件不扫：扫了也只会得到乱码噪声。 */
const MAX_FILE_BYTES = 512 * 1024

/** 判定一个路径是否该被扫描。 */
export function isScannable(file) {
  if (IGNORED_PREFIXES.some(prefix => file.startsWith(prefix))) return false
  if (file.includes('/node_modules/') || file.startsWith('node_modules/')) return false
  if (file.includes('/dist/') || file.startsWith('dist/')) return false
  return true
}

/** 从文件内容里找出所有命中：返回 [{ rule, line, text }]。 */
export function findMatches(content, patterns = FORBIDDEN_PATTERNS) {
  const hits = []
  const lines = content.split('\n')
  for (const rule of patterns) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!rule.pattern.test(line)) continue
      hits.push({ rule: rule.label, line: index + 1, text: line.trim().slice(0, 160) })
    }
  }
  return hits
}

/** 列出仓库里受版本控制、且需要扫描的文件。 */
export function listTrackedFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean).filter(isScannable)
}

/** 扫描整个仓库，返回 [{ file, hits }] 列表。 */
export function scanRepository(cwd = process.cwd(), patterns = FORBIDDEN_PATTERNS) {
  const results = []
  for (const file of listTrackedFiles(cwd)) {
    let content
    try {
      const buffer = readFileSync(resolve(cwd, file))
      if (buffer.length > MAX_FILE_BYTES) continue
      // 含 NUL 字节的是二进制文件，跳过。
      if (buffer.includes(0)) continue
      content = buffer.toString('utf8')
    } catch {
      continue
    }
    const hits = findMatches(content, patterns)
    if (hits.length > 0) results.push({ file, hits })
  }
  return results
}

function main(argv) {
  const quiet = argv.includes('--quiet')
  const results = scanRepository(process.cwd())

  if (results.length === 0) {
    if (!quiet) console.log('内部链接检查通过：没有命中公司与内部环境绑定的链接。')
    return 0
  }

  if (!quiet) {
    console.error('发现与公司 / 内部环境绑定的链接或标识，请改成通用占位后重试：\n')
    for (const { file, hits } of results) {
      console.error(`  ${file}`)
      for (const hit of hits) {
        console.error(`    第 ${hit.line} 行 · ${hit.rule}：${hit.text}`)
      }
    }
    console.error('\n允许的写法：示例用 example.com / example.feishu.cn / acme 等通用占位。')
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}

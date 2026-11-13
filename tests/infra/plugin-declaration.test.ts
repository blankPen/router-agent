import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPluginDeclaration } from '#infra/plugin-loader.js'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ra-plugin-decl-'))
}

/** 在目录下放一个插件包（ESM），body 是包的默认导出源码。 */
function writePackage(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js' },
  }), 'utf8')
  writeFileSync(join(dir, 'index.js'), body, 'utf8')
}

describe('插件包声明读取', () => {
  it('从已安装的包里读出它声明的 id 与名字', async () => {
    const root = home()
    writePackage(join(root, 'node_modules', '@acme', 'whatever'), '@acme/whatever',
      'export default { kind: "runtime", meta: { id: "demo", name: "Demo" } }\n')
    const declaration = await readPluginDeclaration({ kind: 'runtime', home: root, specifier: '@acme/whatever' })
    expect(declaration).toMatchObject({ id: 'demo', name: 'Demo' })
  })

  it('包不是该 kind 的插件时报错', async () => {
    const root = home()
    writePackage(join(root, 'node_modules', '@acme', 'channel-x'), '@acme/channel-x',
      'export default { kind: "channel", meta: { id: "slack" } }\n')
    await expect(readPluginDeclaration({ kind: 'runtime', home: root, specifier: '@acme/channel-x' }))
      .rejects.toThrow(/kind=runtime/)
  })

  it('包没有声明 meta.id 时报错', async () => {
    const root = home()
    writePackage(join(root, 'node_modules', '@acme', 'no-id'), '@acme/no-id',
      'export default { kind: "runtime" }\n')
    await expect(readPluginDeclaration({ kind: 'runtime', home: root, specifier: '@acme/no-id' }))
      .rejects.toThrow(/meta\.id/)
  })

  it('本地路径插件也能读出声明的 id', async () => {
    const root = home()
    writePackage(join(root, 'plugins', 'my-runtime'), 'my-runtime',
      'export default { kind: "runtime", meta: { id: "my-runtime" } }\n')
    const declaration = await readPluginDeclaration({ kind: 'runtime', home: root, specifier: './plugins/my-runtime' })
    expect(declaration.id).toBe('my-runtime')
  })
})

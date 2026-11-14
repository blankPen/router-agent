import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dispatchProjectsOf, loadConfig, nodeProjectConfigs, publicConfig } from '../../src/config.js'

function homeWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra-home-'))
  writeFileSync(join(dir, 'config.yaml'), yaml, 'utf8')
  return dir
}

describe('多设备节点配置', () => {
  it('解析节点设备、设备项目与连通方式', () => {
    const home = homeWith(`
nodes:
  enabled: true
  mode: relay
  routerId: studio
  devices:
    - id: macbook-air
      name: MacBook Air
      token: "secret-air"
      projects:
        - name: router-agent
          key: router-agent
          defaultBranch: main
`)
    const config = loadConfig(home)
    expect(config.nodes.enabled).toBe(true)
    expect(config.nodes.mode).toBe('relay')
    expect(config.nodes.routerId).toBe('studio')
    expect(config.nodes.devices[0]!.projects[0]!.key).toBe('router-agent')
  })

  it('节点项目折算成派工项目并带上目标设备', () => {
    const home = homeWith(`
nodes:
  enabled: true
  devices:
    - id: macbook-air
      token: "secret-air"
      projects:
        - name: router-agent
          defaultBranch: main
`)
    const config = loadConfig(home)
    const projects = nodeProjectConfigs(config)
    expect(projects).toEqual([
      { name: 'router-agent', repo: 'router-agent', defaultBranch: 'main', node: 'macbook-air', nodeProject: 'router-agent' },
    ])
    expect(dispatchProjectsOf(config).map(project => project.name)).toContain('router-agent')
  })

  it('面板视图不下发节点密钥明文', () => {
    const home = homeWith(`
nodes:
  enabled: true
  token: "node-secret"
  devices:
    - id: macbook-air
      token: "secret-air"
`)
    const view = publicConfig(loadConfig(home)) as Record<string, any>
    expect(view.nodes.token).toBeUndefined()
    expect(view.nodes.tokenSet).toBe(true)
    expect(view.nodes.devices[0].token).toBeUndefined()
    expect(view.nodes.devices[0].tokenSet).toBe(true)
  })
})

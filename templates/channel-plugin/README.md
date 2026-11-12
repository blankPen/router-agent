# Channel 插件模板

1. 复制目录到仓库外，改 `package.json` 的包名（建议 `@your-scope/channel-<id>`）与依赖版本。
2. 实现 `ChannelPlugin`：`normalize()` 负责把平台事件转换成 `Trigger`，`send()` 负责发回复。
   `meta.id` 必须与配置里的插件 id 一致；`Trigger.channelId` 决定出站消息回到哪个通道实例。
3. `npm install && npm run build` 产出 `dist/index.js` 与 `dist/index.d.ts`。
4. 在 `config.yaml` 里声明入口：

```yaml
channels:
  example: "@your-scope/channel-example"
```

5. 让 Node 能解析到包：装进 RA 状态目录（`cd ~/.router-agent && npm i @your-scope/channel-example`）
   或全局安装；联调可直接填本地路径。重启后插件注册到 `ChannelRegistry`，宿主会调用它的
   `start(sink)`，出站按 `Trigger.channelId` 路由回去。

`/api/config` 的 `plugins` 字段会显示加载状态与失败原因；加载失败记 `plugin:load-failed`，
不影响其它通道启动。

仓库内联调同样可以把 `@router-agent/channel` / `@router-agent/core` 的
`paths` 指到本仓库对应 `packages/*/src/index.ts`。

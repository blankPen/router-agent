# Runtime 插件模板

1. 复制目录到仓库外，改 `package.json` 的包名与依赖版本；包名没有格式要求。
2. 在 `src/index.ts` 里实现 `RuntimePlugin`；`create()` 返回 `WorkerRuntime`，
   `meta.id` 是这个运行时的 id（ra 装好包后从这里读）。
3. `npm install && npm run build` 产出 `dist/index.js` 与 `dist/index.d.ts`。
4. 在 `config.yaml` 的 `runtime.plugins` 里声明入口（也可在面板「添加运行时」里只填包名）：

```yaml
runtime:
  default: example
  plugins:
    example: "@your-scope/runtime-example"
```

5. 重启 `ra`。面板「派工与服务」会多出「自定义插件」分组；`/api/config` 的 `plugins`
   字段也会返回加载结果、失败原因与实际尝试的包名 / 路径。

### 让 Node 能解析到你的包

加载器用宿主进程的模块解析器按包名加载，所以包必须能被解析到，三种方式任选：

- **推荐**：装进 RA 状态目录，`cd ~/.router-agent && npm i @your-scope/runtime-example`
  （`RA_HOME` 改过路径时用对应目录）；
- 全局安装到 `ra` 所在的 Node 环境（`npm i -g`），保证与 `ra` 使用同一套 global 路径；
- 联调时直接填本地路径：`example: ./plugins/local-runtime`（相对 `RA_HOME`）或绝对路径，
  配合 `entry: dist/index.js` 可指定目录内入口。

解析失败不会阻塞启动，日志会留下 `plugin:load-failed`，面板会显示失败原因。

仓库内联调可以直接把 `tsconfig.json` 的 paths 指到本仓库：

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@router-agent/runtime": ["/path/to/router-agent/packages/runtime/src/index.ts"] }
  }
}
```

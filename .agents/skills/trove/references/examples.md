# trove 典型调用链

## 1. 飞书文档编辑上次怎么做的？

```text
trove_lessons_search({ query: "飞书 编辑" })
  → top1 experiences/gotcha-feishu-edit-button-hit-testing.md
trove_lesson_get({ path: "experiences/gotcha-feishu-edit-button-hit-testing.md" })
```

## 2. 上次 COS 签名报错怎么解决的？

```text
trove_lessons_search({ query: "COS 签名 403" })
  → 当前知识库无命中
trove_sessions_search({ query: "SignatureDoesNotMatch", exact: true })
  → 命中若干历史会话
trove_session_get({ session_id, around: "SignatureDoesNotMatch", limit: 6 })
```

## 3. 我是谁 / 我最近在做什么？

```text
trove_whoami({ sections: ["profile", "recent"] })
需要偏好细节 → trove_lesson_get({ path: "preferences/coding_style.md" })
```

## 4. 帮我改一下这个函数

不调用 trove。这是当前仓库代码问题，直接读代码。

## 5. trove clean 之前踩过什么坑？

```text
trove_lessons_search({ query: "trove clean" })
trove_lessons_search({ query: "远端 孤儿对象", category: "experiences" })
必要时 trove_sessions_search({ query: "trove clean" })
```

## 6. 查无结果

```text
lessons 无命中 → sessions 无命中
回答：「没有找到相关记录；如果你记得大概时间/项目，我可以再缩小范围。」
不编造经验，不把通用知识说成用户历史。
```

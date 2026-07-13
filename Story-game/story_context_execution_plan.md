# Story-game + rag-agent 下一阶段执行计划

## 1. 阶段目标

把 `rag-agent` 作为小说数据库、角色记忆库和原著场景检索层，为 `Story-game` 的互动故事生成提供稳定上下文。

本阶段完成后，Story-game 在生成故事节点时应能获得：

- 选中小说的角色 profile
- 选中角色的性格、说话方式、处事风格、背景、关系、关键事件
- 与当前剧情相关的原著场景片段
- 章节摘要和人物关系约束
- 可降级的上下文缓存，避免 RAG 服务失败时故事生成完全中断

核心原则：

- `rag-agent` 负责小说数据、检索和上下文聚合
- `Story-game` 负责交互流程、玩家选择、prompt 编排和故事展示
- 生成阶段只调用一个聚合接口，避免多个小接口在前端互相拼装导致冗余

---

## 2. 当前项目分工

### 2.1 rag-agent

主要职责：

- 小说上传与入库
- 小说章节切分
- 章节摘要生成
- 角色关系分析
- 角色 profile 提取
- RAG 检索
- 为 Story-game 提供小说上下文 API

关键文件：

- `rag-agent/server.js`
- `rag-agent/rag/indexer.js`
- `rag-agent/rag/embedder.js`
- `rag-agent/rag/extractor.js`
- `rag-agent/rag/novelAnalyzer.js`
- `rag-agent/index.json`
- `rag-agent/chapters/*_profiles.json`

### 2.2 Story-game

主要职责：

- 小说选择 UI
- 角色选择 UI
- 世界观改造、新增角色、禁止项输入
- 互动故事节点生成
- 玩家选择推进剧情
- story bible 保存
- Writer prompt 注入角色和场景约束

关键文件：

- `Story-game/index.html`
- `Story-game/server.js`
- `Story-game/prompts.js`
- `Story-game/config.js`
- `Story-game/story_bible/`

---

## 3. API 边界设计

### 3.1 保留现有接口

#### `GET /api/novels`

用途：小说选择页展示。

返回内容：

```json
[
  {
    "id": "novel-id",
    "name": "小说名",
    "uploadedAt": 1780000000000,
    "analyzing": false,
    "hasCharacterProfiles": true
  }
]
```

使用位置：

- Story-game 小说列表页面

不承担：

- 不返回原文片段
- 不返回完整角色 profile
- 不参与 Writer prompt

#### `GET /api/novel-characters?novelId=xxx`

用途：角色选择页展示。

返回内容：

```json
{
  "novelId": "novel-id",
  "title": "小说名",
  "characters": [
    {
      "name": "角色名",
      "personality": "性格",
      "speech": "说话方式",
      "handlingStyle": "处事风格",
      "backstory": "背景",
      "relationships": "关键关系",
      "keyEvents": "重要事件"
    }
  ]
}
```

使用位置：

- Story-game 角色选择步骤
- 用户勾选主角/配角

不承担：

- 不做当前剧情相关检索
- 不返回原著场景片段

### 3.2 新增聚合接口

#### `POST /api/story-context`

用途：故事生成前获取 Writer 所需上下文。

调用时机：

- 生成第一章前
- 玩家选择后，生成下一章前
- 当 `nextHook`、剧情梗概或玩家选择发生明显变化时

请求格式：

```json
{
  "novelId": "novel-id",
  "characters": ["角色A", "角色B"],
  "query": "当前剧情梗概、玩家选择、下一幕方向",
  "topK": 5
}
```

返回格式：

```json
{
  "novelId": "novel-id",
  "title": "小说名",
  "characterProfiles": [],
  "relationships": [],
  "chapterSummaries": [],
  "relevantScenes": [
    {
      "chapterIndex": 1,
      "chapterTitle": "章节名",
      "text": "原著相关片段",
      "score": 0.82,
      "layer": "content"
    }
  ]
}
```

接口职责：

- 聚合角色 profile
- 根据当前剧情 query 检索原著片段
- 返回少量章节摘要作为背景参考
- 返回人物关系作为约束

不承担：

- 不调用 Writer LLM
- 不生成故事正文
- 不返回自然语言回答
- 不替代 `/query`

---

## 4. 调用链设计

### 4.1 小说选择阶段

```text
Story-game
  -> GET /api/novels
  <- 小说列表
```

### 4.2 角色选择阶段

```text
Story-game
  -> GET /api/novel-characters?novelId=xxx
  <- 角色 profile 列表
```

### 4.3 故事生成阶段

```text
Story-game
  -> POST /api/story-context
  <- characterProfiles + relevantScenes + summaries + relationships
  -> Writer LLM
  <- story node
```

### 4.4 后续章节推进

```text
玩家选择
  -> 更新 history / storyState / nextHook
  -> 根据 query 判断是否需要重新请求 story-context
  -> Writer LLM 生成下一章
```

---

## 5. 避免 API 冗余的规则

### 5.1 生成阶段只允许一个 RAG 聚合调用

不推荐：

```text
GET /characters
GET /summaries
POST /query
GET /relationships
前端自行拼接上下文
```

推荐：

```text
POST /api/story-context
后端统一返回结构化上下文
```

### 5.2 前端缓存 story-context

缓存 key：

```js
novelId + ':' + selectedCharacters.join(',') + ':' + normalizedQuery
```

缓存内容：

```js
{
  createdAt,
  context
}
```

缓存策略：

- 同一小说、同一角色、同一 query 不重复请求
- query 没明显变化时复用上次 context
- 缓存只在当前互动会话内有效

### 5.3 story-context 失败时降级

如果 `/api/story-context` 请求失败：

1. 使用已加载的 `charProfiles`
2. 不注入 `relevantScenes`
3. 继续生成故事
4. 在 debug log 中记录失败原因

不得因为 RAG 临时失败导致 Story-game 整体不可用。

---

## 6. Writer Prompt 改造方案

### 6.1 新增参数

`buildWriterPrompt()` 增加 `storyContext` 参数：

```js
function buildWriterPrompt(bible, history, step, pace, ending, nextHook, synopsis, storyContext) {
  // ...
}
```

### 6.2 注入内容

新增 prompt 区块：

```text
【原著相关场景参考】
以下片段来自原小说，只能作为人物行为、说话方式、关系氛围、场景细节参考。
不得照抄原文，但必须保持角色一致性。

[参考1：第X章 章节名]
...

【原著关系约束】
...
```

### 6.3 约束规则

Writer 必须遵守：

- 不得改写角色固定 profile
- 不得让角色做出违背 `personality` 的行为
- 不得让角色说出违背 `speech` 的台词
- 不得让角色用违背 `handlingStyle` 的方式处理冲突
- 可改造世界观，但角色内核不变
- 可新增情节，但不得与 `keyEvents` 和 `relationships` 矛盾
- 原文片段只作为参考，不得大段照抄

---

## 7. 任务拆分与进度跟踪

### 阶段 A：确认现有 rag-agent 能力

- [x] 确认 `GET /api/novels` 能返回小说列表
- [x] 确认 `GET /api/novel-characters` 能返回角色 profile
- [x] 确认 `indexer.getCharacterProfiles()` 可用
- [x] 确认 `embedder.search()` 支持按 `docId` 检索
- [x] 确认已有小说的 `chapterSummaries` 可用

验收标准：

- Story-game 能正常展示小说列表和角色卡片
- 至少一部小说有完整 character profile

### 阶段 B：实现 rag-agent `/api/story-context`

- [x] 在 `rag-agent/rag/indexer.js` 新增 `getStoryContext(options)`
- [x] 在 `getStoryContext()` 中读取 doc、profiles、relationships、summaries
- [x] 在 `getStoryContext()` 中调用 `embedder.search()`
- [x] 对 `relevantScenes` 做字段裁剪和长度限制
- [x] 在 `rag-agent/server.js` 新增 `POST /api/story-context`
- [x] 增加参数校验：`novelId` 必填，`query` 可选，`topK` 默认 5
- [x] 增加错误返回：小说不存在、分析中、无 profile

验收标准：

- 使用 curl 或浏览器请求能拿到结构化 context
- 返回中包含 `characterProfiles` 和 `relevantScenes`
- 请求不存在小说时返回 404
- 小说仍在分析时返回 202

### 阶段 C：Story-game 代理 story-context

- [ ] 在 `Story-game/server.js` 允许代理 `POST /api/story-context`
- [ ] 保持现有 `/api/novels` 和 `/api/novel-characters` 不变
- [ ] 代理失败时返回清晰错误信息

验收标准：

- Story-game 端请求 `/api/story-context` 能转发到 rag-agent
- rag-agent 未启动时，Story-game 返回 502，但前端可降级

### 阶段 D：Story-game 前端接入 story-context

- [ ] 在 `index.html` 增加 `storyContextCache`
- [ ] 新增 `buildStoryContextQuery()`，从 history、synopsis、nextHook、choice 生成 query
- [ ] 新增 `fetchStoryContext()`，带缓存和失败降级
- [ ] 在 `runStoryPipeline()` 生成第一章前调用 `fetchStoryContext()`
- [ ] 在 `makeChoice()` 生成下一章前调用 `fetchStoryContext()`
- [ ] 将 `storyContext` 传入 `generateStoryNode()`
- [ ] 将 `storyContext` 传入 `buildWriterPrompt()`

验收标准：

- 第一章 prompt 包含原著相关场景
- 后续章节根据玩家选择更新检索 query
- RAG 失败时仍能继续生成

### 阶段 E：prompts.js 注入原著场景

- [ ] 修改 `buildWriterPrompt()` 函数签名
- [ ] 增加 `buildStoryContextSection(storyContext)` helper
- [ ] 注入 `relevantScenes`
- [ ] 注入 `relationships`
- [ ] 注入 `chapterSummaries` 的少量摘要
- [ ] 控制 prompt 长度，避免上下文过长

验收标准：

- Writer prompt 中可以看到 `【原著相关场景参考】`
- 每个片段不超过约 500 字
- 最多注入 3-5 个片段

### 阶段 F：一致性检查增强

- [ ] 在 Reviewer prompt 中增加原著一致性检查项
- [ ] 检查角色说话方式是否违背 profile
- [ ] 检查角色处事风格是否违背 profile
- [ ] 检查是否改变原著关键关系
- [ ] 检查是否编造与原著矛盾的背景

验收标准：

- Reviewer 能指出明显人设偏离
- 不增加额外默认调用成本，先作为 prompt 规则保留

### 阶段 G：联调与回归

- [ ] 启动 rag-agent
- [ ] 启动 Story-game
- [ ] 上传或选择已有小说
- [ ] 选择 1-2 个主角和若干配角
- [ ] 填写世界观改造
- [ ] 生成第一章
- [ ] 连续选择 3 次
- [ ] 检查每章 storyContext 是否更新
- [ ] 检查 story_bible 是否保存
- [ ] 检查 debug log 是否记录上下文状态

验收标准：

- 端到端流程跑通
- 不出现重复 API 大量请求
- 生成内容保持角色设定
- 失败可降级

---

## 8. 文件修改清单

### rag-agent

| 文件 | 修改内容 |
|---|---|
| `rag-agent/server.js` | 新增 `POST /api/story-context` |
| `rag-agent/rag/indexer.js` | 新增 `getStoryContext()` |
| `rag-agent/rag/embedder.js` | 如需要，补充按 docId/topK 检索能力 |

### Story-game

| 文件 | 修改内容 |
|---|---|
| `Story-game/server.js` | 代理 `POST /api/story-context` |
| `Story-game/index.html` | 请求 story-context、缓存、降级、传入 Writer |
| `Story-game/prompts.js` | Writer prompt 注入原著场景和关系约束 |

---

## 9. 推荐执行顺序

1. 先实现 `rag-agent` 的 `/api/story-context`
2. 用 curl 或浏览器单独测试接口
3. 给 `Story-game/server.js` 加代理
4. 在 Story-game 前端接入首章 story-context
5. 修改 Writer prompt 注入原著片段
6. 跑通第一章生成
7. 再接入后续章节动态检索
8. 最后做缓存、降级和一致性检查

---

## 10. 风险与处理

### 风险 1：API 调用过多

处理：

- 生成阶段只调用 `/api/story-context`
- 前端会话级缓存
- query 不明显变化时复用上一次 context

### 风险 2：prompt 太长

处理：

- `relevantScenes` 最多 3-5 条
- 每条片段截断到 300-500 字
- chapter summaries 只传相关摘要，不全量注入

### 风险 3：RAG 服务失败导致故事不能生成

处理：

- story-context 是增强项，不是硬依赖
- 失败时使用已加载角色 profile 继续生成

### 风险 4：角色 profile 与原文片段冲突

处理：

- profile 优先级高于片段
- prompt 明确：角色硬约束不可违背，原文片段只作场景和关系氛围参考

### 风险 5：Story-game 前端承担太多拼接逻辑

处理：

- 上下文聚合放在 `rag-agent`
- 前端只负责传入 query 和接收结构化 context

---

## 11. 完成定义

本阶段完成需要满足：

- [ ] Story-game 可以选择 rag-agent 中已有小说
- [ ] Story-game 可以选择原著角色
- [ ] 生成故事节点前能获取 story-context
- [ ] Writer prompt 同时包含角色硬约束和原著场景参考
- [ ] 连续多章生成时能根据剧情更新检索上下文
- [ ] RAG 失败时可降级生成
- [ ] API 调用链清晰，无重复小接口拼装
- [ ] 代码中有清晰的错误处理和调试日志

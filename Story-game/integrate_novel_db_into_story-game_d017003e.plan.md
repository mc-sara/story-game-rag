# 方案：小说数据库 + 同人文生成

## 需求模型

### RAG 的定位：角色记忆库（硬约束来源）

RAG 存储每个角色的完整 profile，作为**不可修改的硬约束**注入生成流程。

### 锁定规则

| 角色类型 | 锁定范围 | 用户能否修改 |
|----------|----------|-------------|
| **主角** | 名字、性格、说话癖好、处事风格、背景、关系 | **不能改** |
| **配角** | 性格、说话方式、处事风格、背景、关系 | **不能改** |
| 世界观 | — | 可以改造（古代→现代等） |
| 新增角色 | — | 用户原创，不受约束 |
| 剧情走向 | — | 用户完全控制 |
| 【禁止】 | — | 用户设定剧情层限制 |

### 同人文创作的输入模型

| 步骤 | 内容 | 来源 |
|------|------|------|
| 1. 选择小说 | 选定哪本原著 | 用户点击 |
| 2. 勾选角色 | 从 RAG 角色列表中勾选主角 + 配角 | 用户勾选（角色本身不可改） |
| 3. 世界观改造 | 描述背景变化 | 用户手动输入 |
| 4. 新增角色 | 原著中没有的角色 | 用户手动输入 |
| 5. 禁止项 | 剧情/角色层限制 | 用户手动输入 |

---

## 架构图

```
上传小说
    │
    ▼
POST /api/upload
  ├─ 切分保存 chunks → chapters/{novelId}.json
  └─ 触发异步角色提取
              │
              ▼
extractCharacterProfiles(novelId)
  ├─ 阶段1: 各 chunk 提取角色片段
  ├─ 阶段2: 合并 → 每个角色一条完整 profile
  └─ 保存到 chapters/{novelId}_characters.json
              │
              ▼
用户选择小说 → 前端展示角色列表（不可编辑）
    │
    ▼
用户勾选主角 + 配角 + 输入世界观改造 + 新增角色
    │
    ▼
前端构建输入 → startStory()
    │
    ▼
Architect（受 RAG 角色 profile 硬约束）
  └─ storyBible 生成
              │
              ▼
Writer（受 RAG 角色 profile 硬约束）
  └─ 章节内容生成
```

---

## 一、后端：角色 profile 提取

**文件**: `/Users/sara/code/rag-agent/rag/extractor.js`（新建）

### 1.1 两阶段提取

```js
// 阶段1: 每批 chunks 提取角色片段
async function extractCharacterFragments(chunks, llm) {
  // 返回 [{character: "角色名", fragments: ["片段1", "片段2"]}]
}

// 阶段2: 合并片段，为每个角色生成一条完整 profile
async function buildCharacterProfiles(fragments, llm) {
  // 返回 [{name, personality, speech, handlingStyle, backstory, relationships, keyEvents}]
}

// 主入口
async function extractCharacterProfiles(novelId) {
  const data = JSON.parse(fs.readFileSync(`chapters/${novelId}.json`));
  const fragments = await extractCharacterFragments(data.chunks, llm);
  return await buildCharacterProfiles(fragments, llm);
}
```

### 1.2 character profile schema（关键）

```json
[{
  "name":           "逐玉",
  "personality":    "理性、慢热、嘴硬心软",
  "speech":         "说话直接、不擅长表达情感、常以技术语言掩饰情绪",
  "handlingStyle":  "遇到问题先自己扛，不愿求助他人",
  "backstory":      "某理工大学学生，编程竞赛选手，父亲早逝",
  "relationships":  "与林澈是亦敌亦友的竞争关系",
  "keyEvents":      "曾在区域赛中输给林澈，此后一直以此为动力"
}]
```

每个 profile 包含 7 个维度，涵盖性格、说话癖好、处事风格三个锁定层。

### 1.3 上传时自动触发

`POST /api/upload` 成功后异步调用，提取结果保存到 `chapters/{novelId}_characters.json`。

---

## 二、后端：API 端点

**文件**: `/Users/sara/code/rag-agent/server.js`

### 新增端点

- `GET /api/novel-characters?novelId=xxx` — 返回角色列表；如果文件不存在返回 404
- `GET /api/novels` — 返回已有小说列表（含 `hasCharacters: bool`）

导出函数供 Story-game server 调用。

---

## 三、前端：三步输入流程

**文件**: `/Users/sara/code/Story-game/index.html`

### 3.1 Tab 切换

```
[手动输入]  [选择已有小说]
```

- `manual` panel：现有 textarea（不变）
- `novel` panel：三步输入流程

### 3.2 第一步：选择小说

点击小说卡片 → 进入第二步。

### 3.3 第二步：角色选择器（只读展示 + 勾选）

```html
<div class="novel-step" id="stepCharacters" style="display:none;">
  <div class="section-label">请选择主角（必选 1~2 个）</div>
  <div id="characterList"></div>

  <div class="section-label">配角参考（来自原著，不可修改）</div>
  <div id="supportingList"></div>

  <button id="nextToWorld">下一步：设定世界观</button>
</div>
```

每个角色卡片为**只读展示**：

```html
<div class="char-card">
  <div class="char-name">逐玉</div>
  <div class="char-lock-badge">原著设定，不可修改</div>
  <div class="char-detail">
    <div>性格：理性、慢热、嘴硬心软</div>
    <div>说话癖好：说话直接、不擅长表达情感、常以技术语言掩饰情绪</div>
    <div>处事风格：遇到问题先自己扛，不愿求助他人</div>
    <div>背景：某理工大学学生，编程竞赛选手，父亲早逝</div>
  </div>
  <div class="char-select">
    <input type="checkbox" class="protagonist-check">
    <label>设为主角</label>
    <input type="checkbox" class="supporting-check" checked disabled>
    <label>保留为配角</label>
  </div>
</div>
```

- 主角选择：用户勾选（最多2个）
- 配角选择：默认全选，用户可取消（表示从同人文中去掉该角色）

### 3.4 第三步：世界观 + 新增角色 + 禁止项

```html
<div class="novel-step" id="stepWorld" style="display:none;">
  <div class="section-label">世界观改造（必填）</div>
  <textarea id="worldTransform" placeholder="保留所有角色的性格设定，将背景从理工竞赛改为现代都市职场..."></textarea>

  <div class="section-label">新增角色（可选）</div>
  <div id="newCharacters">
    <div class="new-char-row">
      <input placeholder="姓名" class="new-char-name">
      <input placeholder="性格/设定" class="new-char-desc">
    </div>
  </div>
  <button id="addNewChar">+ 添加角色</button>

  <div class="section-label">禁止项（可选）</div>
  <textarea id="forbiddenInput" placeholder="保持1v1；不要出现其他女性角色；结局必须是HE..."></textarea>

  <button id="startFromNovel">开始互动</button>
</div>
```

### 3.5 数据构建

```js
function buildInputFromNovel({ charProfiles, selectedProtagonists, selectedSupportings, worldTransform, newChars, forbidden, novelTitle }) {
  const protos = selectedProtagonists.map(name => {
    const p = charProfiles.find(c => c.name === name);
    return p ? `${p.name}：${p.personality}；说话癖好：${p.speech}；处事风格：${p.handlingStyle}；背景：${p.backstory}` : name;
  });

  const supports = selectedSupportings.map(name => {
    const p = charProfiles.find(c => c.name === name);
    return p ? `${p.name}：${p.personality}；说话癖好：${p.speech}；处事风格：${p.handlingStyle}；背景：${p.backstory}` : name;
  });

  const lines = [
    '【世界观】' + worldTransform,
    '【主角】' + protos.join('\n'),
    '【核心角色】' + supports.join('\n'),
  ];

  if (newChars.length) {
    lines.push('【新增角色】' + newChars.map(c => `${c.name}：${c.desc}`).join('\n'));
  }

  if (forbidden) {
    lines.push('【禁止】' + forbidden);
  }

  return lines.join('\n');
}
```

---

## 四、prompts.js 改造（关键：双向硬约束）

**文件**: `/Users/sara/code/Story-game/prompts.js`

### 4.1 Architect prompt：注入角色约束

`buildArchitectPrompt()` 的 prompt 末尾追加：

```js
if (charProfiles && charProfiles.length) {
  prompt += '\n【角色硬约束 — 必须遵守】\n';
  prompt += charProfiles.map(function(p) {
    return p.name + '：' +
      '性格=' + p.personality + '；' +
      '说话方式=' + p.speech + '；' +
      '处事风格=' + p.handlingStyle + '；' +
      '背景=' + p.backstory;
  }).join('\n');
  prompt += '\nArchitect 在规划故事时，必须确保每个角色的行为和对话符合上述设定，不得违背。\n';
}
```

### 4.2 Architect schema 新增 charProfiles

`buildArchitectPrompt()` 的 jsonSchema 新增：

```js
charProfiles: '角色 profile 数组，会在 Writer 阶段再次注入，严格约束角色行为'
```

### 4.3 Writer prompt：注入角色约束（双重保险）

`buildWriterPrompt()` 的 bibleSection 末尾追加：

```js
var charContext = '';
if (bible.charProfiles && bible.charProfiles.length) {
  charContext = '\n【角色硬约束 — 严格遵守】\n';
  charContext += bible.charProfiles.map(function(p) {
    return p.name + '：' +
      '性格=' + p.personality + '；' +
      '说话方式=' + p.speech + '；' +
      '处事风格=' + p.handlingStyle + '；' +
      '背景=' + p.backstory + '；' +
      '关键关系=' + p.relationships + '；' +
      '重要事件=' + p.keyEvents;
  }).join('\n');
  charContext += '\n写每一句对话时，必须符合角色的说话癖好；写每一个决策时，必须符合角色的处事风格。禁止任何角色做出与其性格/说话方式/处事风格不符的行为或对话。\n';
}
```

### 4.4 storyStatePatch 传递 charProfiles

`storyStatePatch` schema 包含 `charProfiles` 字段，多章生成时持续传递，保证后续章节同样受约束。

---

## 五、文件修改清单

| 文件 | 修改内容 |
|------|----------|
| `rag-agent/rag/extractor.js` | **新建**：两阶段角色 profile 提取（含 speech/handlingStyle 维度） |
| `rag-agent/server.js` | 导出函数 + 新增 `GET /api/novel-characters` + 上传时串联 |
| `Story-game/server.js` | import rag-agent 端点函数 |
| `Story-game/index.html` | Tab + 小说卡片 + 只读角色选择器（展示7维度）+ 世界观/新增角色/禁止表单 |
| `Story-game/index.html <style>` | Tab + 只读角色卡片 + 表单样式 |
| `Story-game/prompts.js` | Architect + Writer 双端注入角色硬约束；schema 新增 charProfiles |

---

## 六、实施顺序

1. **新建** `rag-agent/rag/extractor.js` — 角色提取逻辑（独立可测试）
2. **改造** `rag-agent/server.js` — 导出函数 + 新端点 + 上传串联
3. **改造** `Story-game/server.js` — import 挂载新端点
4. **改造** `Story-game/index.html` — Tab + 三步 UI + 只读角色卡片 + 表单
5. **改造** `Story-game/prompts.js` — 双端角色硬约束注入
6. 整体联调测试

# Story Game RAG

[English](README.md) | 中文

Story Game RAG 是一个面向同人文创作的互动故事游戏。用户可以上传或选择原著小说，挑选原著角色，改造世界观，并通过选项推进分支剧情。系统会结合小说分析、角色档案、章节摘要和相关场景参考，让生成内容更贴近原著人物关系与说话风格。

## 产品展示

### 小说库与原著选择

![小说库与原著选择](docs/screenshots/novel-library.png)

### 互动剧情章节

![互动剧情章节与选项](docs/screenshots/story-chapter.png)

### 手动输入设定

![手动输入角色与背景设定](docs/screenshots/manual-setup.png)

## 产品亮点

- 一个页面完成小说上传、小说选择、角色选择和同人文生成。
- 自动整理原著角色档案、人物关系、章节摘要和相关场景。
- 先生成 Story Bible，再生成正文，保证故事方向、冲突和伏笔更稳定。
- 每一章生成时注入原著上下文，减少人物 OOC 和关系冲突。
- RAG 检索失败时可以降级继续生成，避免页面白屏或流程中断。
- 本地保存 Story Bible 和 Story Run，方便测试、复盘和调试生成效果。

## 项目结构

本仓库包含两个协作运行的本地应用：

- `rag-agent/`：负责小说上传、编码处理、入库、角色档案提取、章节摘要、RAG 检索。
- `Story-game/`：负责互动故事页面、Story Bible 生成、正文生成、提示词编排和上传代理。

用户主要打开 `Story-game` 页面；`rag-agent` 作为后台小说分析服务运行。

## 本地启动

### 启动 rag-agent

```bash
cd rag-agent
cp .env.example .env
npm install
npm start
```

默认地址：

```text
http://localhost:3000
```

复制 `.env.example` 后，编辑 `rag-agent/.env`：

```bash
API_KEY=your_real_api_key
BASE_URL=https://your-openai-compatible-api.example.com/v1
MODEL=your_model_name
MAX_TOKENS=2048
TEMPERATURE=0.7
TOP_K_CHUNKS=3
CHUNK_SIZE=500
CHUNK_OVERLAP=50
PORT=3000
TIMEOUT=60000
INDEX_FILE=./index.json
```

### 启动 Story-game

```bash
cd Story-game
cp .env.example .env
npm install
npm start
```

默认地址：

```text
http://localhost:3002
```

复制 `.env.example` 后，编辑 `Story-game/.env`：

```bash
API_KEY=your_real_api_key
BASE_URL=https://your-openai-compatible-api.example.com/v1
MODEL=your_model_name
MAX_TOKENS=2048
TEMPERATURE=0.8
PORT=3002
RAG_AGENT_URL=http://localhost:3000
```

注意：当前 `Story-game` 前端仍会在浏览器加载 `Story-game/config.js`。本地测试可以使用临时测试配置，但不要把生产 API Key 放进浏览器代码。

## 启动顺序

先启动 `rag-agent`，再启动 `Story-game`。

第一个终端：

```bash
cd rag-agent
npm start
```

第二个终端：

```bash
cd Story-game
npm start
```

然后打开：

```text
http://localhost:3002
```

用户只需要使用 `Story-game` 页面；`rag-agent` 保持在后台运行即可。

## 生成文件

- `Story-game/story_bible/`：每次开局生成的 Story Bible 设定档。
- `Story-game/story_runs/`：测试时保存的每章正文、选项和游玩路径。
- `rag-agent/uploads/`：上传的原始小说文件和清洗后的文本。
- `rag-agent/chapters/`：提取出的角色档案文件。
- `rag-agent/index.json`：本地生成的索引文件。

## 注意事项

- 不要提交 `.env`、上传小说、生成索引、Story Bible 或 Story Run。
- `rag-agent/.env.example` 和 `Story-game/.env.example` 只是模板，需要复制为 `.env` 后再填入本地配置。
- 如果要部署生产环境，建议把 LLM 调用全部代理到服务端，不要在浏览器暴露 API Key。

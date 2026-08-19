# 上线部署方案：Railway + Supabase（双平台新人优惠）

> 项目构成：两个 Node.js 服务（无数据库，文件存储 + DeepSeek API）
> - `rag-agent/` — RAG 问答服务（Express，端口 3000，TF-IDF 检索，DeepSeek）
> - `Story-game/` — 互动故事生成器（原生 http，端口 3002，代理 DeepSeek + 调用 rag-agent）

---

## 一、两个平台的"新人优惠"是什么

| 平台 | 新人优惠 | 说明 |
| --- | --- | --- |
| Railway | 注册即送 **$5 一次性试用额度，30 天有效** | 试用期功能等同 Hobby，但限 1GB RAM / 5 个服务每项目 / **仅 1 个自定义域名**；30 天或 $5 用尽后回落到 **Free 计划（$1/月额度）**。**必须 GitHub 验证（Full Trial）**，否则 Limited Trial 出网受限，DeepSeek 调用会失败 |
| Supabase | **免费计划（$0，无需信用卡）** 本身就是新人福利 | 2 个项目、500MB Postgres、1GB Storage、5GB 带宽；项目 7 天无活动会被暂停 |

官方文档：
- Railway Free Trial: <https://docs.railway.com/pricing/free-trial>
- Railway 计划与价格: <https://docs.railway.com/pricing/plans>
- Supabase 价格: <https://supabase.com/pricing>

---

## 二、推荐架构（改动最小、两个平台都用上）

```
用户浏览器
   │
   └─► https://story.tongrentxt.bond   → Railway 服务：Story-game (Node, :3002)
            └─ 代理 /api/chat-completions → DeepSeek API
            └─ 调用 RAG_AGENT_URL → rag-agent（私有网络 ${{rag-agent.RAILWAY_PRIVATE_DOMAIN}}，免 egress 费）

rag-agent (Node, :3000) ── 不设公网自定义域名 ── 仅被 Story-game 经私有网络调用
   └─ DeepSeek API（TF-IDF 检索在本地，无需向量库）
   └─ 管理/上传小说时，临时用 Generate Domain 生成的 *.up.railway.app 即可（不占自定义域名额度）

Supabase（免费层）＝ 持久化数据层（可选接入，逐步迁移）：
   - Postgres：对话历史、故事存档、角色档案（替换 data/、story_runs/、chapters/ 的 JSON）
   - Storage：上传的小说原文（替换 uploads/ 与 index.json 的全文）
   - 进阶：pgvector 语义检索替换 TF-IDF；Auth 做用户登录
```

**第一天就能上线的组合**：Railway 托管两个服务（无需改代码）+ 绑定域名；Supabase 免费项目先建好、用 SQL Editor 建表，后续再把数据层迁过去（需要小幅改代码，用 supabase-js 或 REST）。

---

## 三、步骤

### Phase 0 — 代码准备（本地）

1. GitHub 仓库已建好（`mc-sara/story-game-rag`，含 `rag-agent/` 与 `Story-game/` 两个子目录），直接 push 即可。
2. ⚠️ **`Story-game/.gitignore` 尚未进入本 repo**（只在旧目录补过）：先把文件加进仓库再提交，保护 `.env` 里的真实 API Key。
3. **RAG 语料种子**：`rag-agent/.gitignore` 忽略了 `index.json`（7.6MB 索引）与 `uploads/`、`data/`，直接 push 后 RAG 是空库。
   二选一（**本 repo 已定：路线 1**）：
   - ✅ **路线 1（已选）**：部署后打开 rag-agent 页面重新上传小说，等索引重建（`index.json` 不进公网仓库，避免 7.6MB 全文入库）。
   - 或种子进仓库（开箱即用）：`git add -f rag-agent/index.json`
4. 本地确认 `npm start` 均可运行（已在本地跑通）。

### Phase 1 — Railway 部署两个服务（$5 试用）

1. 注册 <https://railway.com>（**用 GitHub 登录**，触发账户验证 → Full Trial）。
   - 若显示 Limited Trial：访问 <https://railway.com/verify> 完成验证。⚠️ 不验证则服务**无法访问外网，DeepSeek 调不通**。
2. New Project → Deploy from GitHub repo → 授权仓库。
3. 创建第一个服务：选 `rag-agent/` 目录（Service → Settings → Source → Root Directory 填 `rag-agent`）。Nixpacks 自动识别 Node。
4. **Variables**（把 `.env` 里的值填进去，不要把 `.env` 提交）：
   - `API_KEY`（DeepSeek Key）、`BASE_URL=https://api.deepseek.com`、`MODEL=deepseek-v4-flash`、`MAX_TOKENS`、`TEMPERATURE`
   - `PORT` 不用填，Railway 自动注入。
5. 同法创建第二个服务 `Story-game/`（Root Directory 填 `Story-game`）。
   - Variables：`API_KEY`、`BASE_URL=https://api.deepseek.com`、`MODEL=deepseek-v4-flash`（LLM 调用已走服务端代理，Key 不暴露给浏览器），再加：
   - `RAG_AGENT_URL=http://${{rag-agent.RAILWAY_PRIVATE_DOMAIN}}:8080`（**明文 HTTP + 显式端口，端口以 rag-agent 启动日志为准**；私有网络免 egress 费、不占公网自定义域名额度）
6. 验证：Story-game 用 `Generate Domain` 生成的 URL 打开首页、生成一次故事（验证 RAG_AGENT_URL 通）；rag-agent 用它的生成 URL 测 `GET /health`、上传/问答各一次（验证 DeepSeek 出网通）。生成的 `*.up.railway.app` 域名不占自定义域名额度，正式对外入口只有 `story.tongrentxt.bond`。
7. （可选）数据持久化：试用/免费计划自带 0.5GB Volume，挂载到服务，把 `INDEX_FILE`、`uploads/`、`story_runs/` 等指过去；否则重新部署会清空运行期数据（见"坑"）。

### Phase 2 — Supabase 免费项目（$0）

1. <https://supabase.com> → Start your project（GitHub 登录，无需信用卡）。
2. New project：填项目名 + 数据库密码，区域选离你/DeepSeek 近的（如 `ap-southeast-1` 新加坡或东京）。
3. 建表（SQL Editor 执行）——把运行期 JSON 迁到 Postgres，Railway 上就不依赖 Volume：
   - `story_runs`（故事存档：title, content, created_at）
   - `conversations`（对话历史）
   - `character_profiles`（角色档案）
   - `documents`（上传小说元数据），原文放 Storage bucket `novels/`
4. 连接 AI 编码工具（对应你贴的 Supabase AI Tools 页）：
   - 本地 `supabase login && supabase link --project-ref <ref>`（CLI）
   - 或安装 **Supabase Plugin**（Claude Code / Codex / Cursor / GitHub Copilot），一个命令打包 MCP + Skills
   - 或直接跑 **Supabase MCP server**，让 agent 实时查库、跑迁移、部署 Edge Functions
5. 注意：免费项目 7 天无 API 请求会自动暂停，Dashboard 里一键恢复。

### Phase 3 — 绑定你自己的域名（单域名方案）

> ⚠️ **Trial（$5 试用）只允许 1 个自定义域名**（Hobby 每服务 2 个）。本方案把唯一域名 `story.tongrentxt.bond` 给 Story-game；rag-agent 不设公网自定义域名，走私有网络。

**前提（阿里云侧，务必先做）**：
- 阿里云控制台 → 域名 → `tongrentxt.bond` → 完成**实名认证**。国际域名未实名会被阿里云暂停解析。
- **不需要 ICP 备案**：Railway 是境外服务器，不强制备案。仅当以后要上大陆 CDN（阿里云/腾讯云 CDN）时才需要备案（`.bond` 已获工信部许可，可在阿里云备案，审核约 1–3 周）。

**步骤**：
1. 在 Railway 中打开 Story-game 服务 Settings → Networking → `+ Custom Domain`，输入 `story.tongrentxt.bond`。
2. Railway 会给出**两条**记录，**两条都要加**（只加 CNAME 不加 TXT 会无法验证 / 404）：
   - **CNAME**：`story` → Railway 给的 CNAME 目标（形如 `g05ns7.up.railway.app`）
   - **TXT**：`story` → Railway 给的验证值
3. 在阿里云 DNS 解析设置添加以上两条记录（记录类型 CNAME / TXT，主机记录填 `story`）。
4. 等 Railway 验证通过（域名旁绿勾）→ TLS 证书自动签发，无需手动配置。
5. 国内访问提示：Railway 默认域名在中国大陆直连可能不稳；若直连不畅，可把 NS 换成 Cloudflare（免费），在 Cloudflare 加 CNAME（开橙色云朵代理）并设 SSL 模式为 **Full（不要 Full Strict）**，可改善可达性。参考 [Working with Domains](https://docs.railway.com/networking/domains/working-with-domains)。

**以后想给 rag-agent 也配公网域名**：升级 Hobby（$5/月）后，在 rag-agent 服务再加 `api.tongrentxt.bond`（同样 CNAME + TXT），Hobby 每服务允许 2 个自定义域名。

---

## 四、成本账

| 阶段 | 成本 |
| --- | --- |
| 试用期 30 天 | Railway $5 额度；两个小服务（各 0.25–0.5GB RAM / 0.05–0.1 vCPU）约 **$8–10/月** 用量 → $5 大约够跑 **2–3 周**。Supabase $0 |
| 试用结束后 | Railway 回落 Free（$1/月额度，只够一个极小的服务）→ 建议升 **Hobby $5/月（含 $5 用量，两个小服务基本覆盖）**。Supabase 继续 $0 |
| 长期 | 每月 Railway $5 + Supabase $0（免费层内），加上 DeepSeek API 按量 |

> Railway 按实际用量计费：RAM $10/GB/月、CPU $20/vCPU/月、egress $0.05/GB、Volume $0.15/GB/月。服务间走私有网络不产生 egress 费用。

---

## 五、坑清单（务必看）

1. **Limited Trial 出网受限** → DeepSeek 请求全部失败。先完成 GitHub 验证。
2. **试用数据保留策略**：Trial 账户的 Volume 在额度过期 30 天后被删除；要保数据需升级（Hobby $5）。
3. **运行期文件会丢**：`uploads/`、`data/`、`chapters/`、`story_runs/`、`index.json` 落在临时磁盘，重新部署即清空。要么挂 Volume，要么迁 Supabase。
4. **`index.json` 与 `uploads/` 被 gitignore**：首次部署后 RAG 空库，需 `git add -f` 种子或重新上传。
5. **Story-game 原本没有 .gitignore**：`.env` 里的真实 API Key 差点被提交，已补上。
6. **隐私**：rag-agent 用 `express.static(__dirname)` 暴露整个目录，`index.json` 含全部文档全文，公网可下载；若公开展示建议限制静态目录或加鉴权。
7. **Supabase 免费项目 1 周不活动自动暂停**；免费层限额 500MB DB / 1GB Storage / 5GB 带宽，超了要升级 Pro（$25/月）。
8. **试用量不要超**：Dashboard 里可设 Usage Limits 防止 $5 提前耗尽。
9. **Trial 只允许 1 个自定义域名**：`story.` 与 `rag.` 两个子域在 Trial 上行不通；单域名方案下 rag-agent 走私有网络（免 egress），升 Hobby（$5/月，每服务 2 个）后再补 `api.tongrentxt.bond`。
10. **自定义域名必须同时加 CNAME + TXT 两条记录**：Railway 用 TXT 验证所有权，缺 TXT 即使 CNAME 生效也会 404 / 无法验证。
11. **阿里云国际域名需实名认证**：`tongrentxt.bond` 未实名会被阿里云暂停解析；Railway 方案**不需要 ICP 备案**（`.bond` 已获工信部许可，将来上大陆 CDN 时再备）。
12. **小说分析慢**：角色提取是 43 批串行 DeepSeek 调用，`deepseek-v4-flash` 默认开启 thinking（reasoning token 被代码无视却拖慢速度）。已加 `thinking:{"type":"disabled"}`（本地实测 59→29.5 分钟）。Railway 上另有 ~9× 环境惩罚（CPU 空闲、疑似连接被重置重试），见 session 记录。

---

## 六、可选的 railway.json（两个服务各自一份，放子目录根）

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm start",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```
Nixpacks 默认也能自动识别 Node，此文件主要用于固定启动命令与重试策略。

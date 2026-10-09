# 素材库跨通道迁移工作台

将素材库平台一个通道（服务商标识）下的 AIGC 素材组与素材迁移到另一个通道。浏览器操作，中文界面，配置与任务状态均以文件形式持久化在服务端 `data/` 目录。

对接契约：《素材库对外接入文档 v1.2》（`POST {服务地址}/{服务商标识}/asset/v1/ark?Action={Action}`）。
配套文档：《素材库迁移工具解决方案.md》（设计决策与架构）、《用户手册》（本目录，md/docx/pdf 三格式，含界面截图与 FAQ）。

## 快速开始

**方式一：启动脚本（推荐）**

```bash
# Windows：双击 start.bat，或命令行执行
start.bat

# Linux / macOS
chmod +x start.sh
./start.sh
```

启动脚本优先使用项目内置运行时 `runtime/`（免安装模式），不存在时回退系统 Node ≥18 并自动安装缺失依赖；**服务就绪后会自动用默认浏览器打开页面**（`OPEN_BROWSER` 环境变量可关闭）。

**方式二：免安装部署（目标机器无需 Node.js）**

在装有 Node 的机器上双击 `install-runtime.bat`（或 `node install-runtime.cjs`），会把 node.exe 安装到 `runtime/`。之后**整个项目目录**（含 `runtime/` 与 `node_modules/`）拷贝到目标 Windows 机器，双击 `start.bat` 即可直接运行——源码目录本身就是绿色便携包。

**方式三：手动命令**

```bash
npm install
npm start          # 默认 http://localhost:8787，可用 PORT 环境变量修改
```

## 运行方式

```bash
PORT=9000 npm start                            # 指定端口
ASSET_MIGRATION_DATA_DIR=/var/lib/amta npm start   # 指定数据目录
npm test                                       # 端到端测试（39 项，内置模拟素材库）
npm run audit                                  # 静态一致性审计（类名/路由/函数/id）
node tests/demo.mjs                            # 演示模式：模拟素材库 + 预置数据，http://localhost:7899
```

演示模式数据持久化在 `data-demo/`（`DEMO_RESET=1 node tests/demo.mjs` 可清空重来），用于体验与验收，不访问真实平台。

服务器部署建议用进程守护，例如 systemd：

```ini
[Service]
WorkingDirectory=/opt/asset-migration-tool
ExecStart=/usr/bin/node src/server.js
Environment=PORT=8787
Restart=always
```

## 工作机制

- **URL 直传**：工具不落盘素材内容。迁移时从源通道 `GetAsset` 取最新签名 URL（约 12 小时有效），原样作为目标通道 `CreateAsset` 的 `URL` 参数；目标通道服务端自行拉取并异步处理（`Processing → Active / Failed`）。
- **校验语义**：目标素材 `Status=Active` 且类型（`AssetType`）与源一致即计成功。素材库不暴露内容指纹且上游会做审核/处理，无法做字节级比对。
- **组映射**：按组名精确匹配目标通道；不存在则自动创建（描述注明来源）。素材/组 ID 一律原样保存、原样回传。
- **防重**：默认跳过目标组内已存在同名素材（可关），保证任务可重复执行；同一任务内同组同名素材只迁一次。
- **断点续跑**：逐素材状态实时落盘（`data/jobs/<任务ID>.json`，原子写入）。进程重启后 `running` 任务回收在途素材并转「已暂停」，手动「启动」继续；已创建目标素材 ID 的素材重试时先轮询该 ID，不会重复上传。
- **自愈能力**：服务重启时页面经 bootId 检测自动刷新数据；连接中断有提示并在恢复后自动续刷；样式/脚本加载失败自动重试。
- **限流与重试**：502/网络错误按 1s→2s→4s 退避重试；并发、轮询间隔、单素材轮询上限均可在创建任务时调整（默认并发 3、3s 轮询、5 分钟上限，符合接入文档 §2.6 限流参考）。

## 限制

- 真人素材组（`LivenessFace`）不可迁移（须经 H5 活体认证产生，接口无法创建）。
- 只新增、不删除：源侧删除不会传播到目标侧（对回滚友好）。
- `skipExisting` 按素材名称判重：同组同名但内容不同的素材会被跳过。
- 访问令牌等同账号权限，明文保存在服务端 `data/config.json`：请仅在内网部署并做好机器访问控制；页面未内置登录，如需暴露请前置带认证的反向代理。

## 目录结构

```
asset-migration-tool/
├── start.bat / start.sh     启动脚本（内置运行时优先，自动装依赖，自动开浏览器）
├── install-runtime.bat/.cjs 把 node.exe 装入 runtime/（免安装部署的一次性准备）
├── runtime/                 内置 Node 运行时（可选，git 忽略）
├── src/
│   ├── server.js            Express 入口与 REST API
│   ├── config.js            配置管理（data/config.json，令牌掩码，单通道增删改）
│   ├── ark.js               素材库 API 客户端（Action 调用、退避重试、错误分类与链路详情）
│   ├── migrator.js          任务引擎（扫描/组映射/并发迁移/轮询校验/报告/断点恢复）
│   └── store.js             原子 JSON 文件读写
├── public/                  前端单页（原生 HTML/CSS/JS，零构建）
├── tests/
│   ├── mock-ark.js          模拟素材库（实现接入文档素材接口语义）
│   ├── e2e.mjs              端到端测试
│   ├── audit.mjs            静态一致性审计
│   └── demo.mjs             演示模式入口
├── docs/
│   ├── manual-images/       用户手册截图素材
│   └── manual-build/        手册 docx/pdf 生成脚本（node generate.cjs）
├── 用户手册.md / .docx / .pdf
└── data/                    运行时生成：config.json + jobs/*.json
```

> `data-demo/` 为演示模式的数据目录（运行 `tests/demo.mjs` 时生成，git 忽略），正式部署不使用。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config` | 读取配置（令牌掩码返回，响应携带 `X-Boot-Id`） |
| PUT | `/api/settings` | 更新全局设置 |
| POST / PUT / DELETE | `/api/channels`、`/api/channels/:id` | 通道增 / 改 / 删（单通道提交，令牌留空保持原值） |
| POST | `/api/channels/test` | 连通性测试（失败时返回完整请求链路详情） |
| GET | `/api/channels/:id/groups` | 浏览素材组（`page`/`pageSize`/`name`） |
| GET | `/api/channels/:id/groups/:gid/assets` | 组内素材列表（`status`/`name`） |
| GET | `/api/channels/:id/assets` | 通道级素材列表（跨组，参数同上） |
| GET | `/api/channels/:id/assets/:aid` | 素材详情（媒体预览取最新签名 URL） |
| POST | `/api/jobs` | 创建任务（`autoStart` 可选） |
| GET | `/api/jobs` · `/api/jobs/:id` · `/api/jobs/:id/items` | 列表 / 详情 / 素材明细 |
| POST | `/api/jobs/:id/start｜pause｜cancel｜retry-failed` | 任务控制 |
| GET | `/api/jobs/:id/report?format=md｜csv` | 迁移报告 |

# Math Reader 的 Claude 连接器（MCP）

让 claude.ai（网页、桌面端、手机端）读取你在 math-reader 里的书目、大纲和书页，在对话中写讲义；讲义里的图由 Claude 的内置可视化绘制。连接器只读，不修改 math-reader 的任何数据。

## 工作方式

- math-reader 把连接器需要的数据写到你的 Cloudflare R2（与 R2 云同步用同一个存储桶）：
  - `claude/index.json`：书目、大纲、讲义编号。每次 R2 同步后自动上传，内容没变时跳过。
  - `claude/docs/<书 id>/`：书页图片和清单。在书架长按书籍，选择“同步书页给 Claude”生成，中断后再次执行会从断点继续。
- 本目录是部署在 Cloudflare Workers 上的 MCP 服务，读取同一个存储桶，用 OAuth + 你设的密码保护。
- claude.ai 的单次工具结果约 15 万字符封顶，base64 图片也计入。所以每张书页图片不超过 12 万字符（超出时降低 JPEG 质量，仍超出就上下切成两张），`read_pages` 每次按大小挑页（通常 1–2 页，最多 8 页），结果末尾写明下一次从哪一页继续；Claude 可以在同一轮里并行读取多页。

## 工具与提示模板

| 名称 | 作用 |
|---|---|
| `list_documents` | 列出书籍和论文：id、页数、大纲节数、书页同步进度 |
| `get_outline` | 一本书的大纲：每节标题、主题、PDF 页码范围，以及是否已有 math-reader 讲义 |
| `read_pages` | 以图片返回书页（PDF 物理页码） |
| `read_lecture` | 读取 math-reader 此前生成的讲义正文 |
| `write_lecture`（提示模板） | 读完一节后按 math-reader 的讲义结构（预习、大纲、习题）写讲义，并用内置可视化配图 |

## 部署（一次性）

1. **Cloudflare API Token**：Cloudflare 控制台 → My Profile → API Tokens → Create Token → 选 “Edit Cloudflare Workers” 模板 → Account Resources 选你的账号，Zone Resources 选 All zones → 创建并复制。
2. **Account ID**：Cloudflare 控制台 → Workers & Pages，页面右侧的 Account ID。
3. **仓库 Secrets**：GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，添加四项：
   - `CLOUDFLARE_API_TOKEN`：第 1 步的 Token
   - `CLOUDFLARE_ACCOUNT_ID`：第 2 步的 Account ID
   - `R2_BUCKET_NAME`：math-reader 设置 → R2 云同步配置里的 Bucket 名称
   - `MCP_LOGIN_PASSWORD`：连接器登录密码，建议 16 位以上的随机字符
4. **部署**：`mcp/` 的改动合并到 main 后自动部署；也可以在 Actions → Deploy MCP server → Run workflow 手动运行。部署日志会打印 Worker 地址，形如 `https://math-reader-mcp.<子域名>.workers.dev`。
   - 第一次部署时 wrangler 自动创建存放 OAuth 令牌的 KV 命名空间，之后的部署沿用它。
   - 账号还没有 workers.dev 子域名时，部署会报错；先在 Cloudflare 控制台打开 Workers & Pages 设置子域名，再重新运行。

## 在 Claude 中使用

1. **添加连接器**：claude.ai → Customize → Connectors → Add custom connector。URL 填 `https://math-reader-mcp.<子域名>.workers.dev/mcp`。对话框若询问认证方式，选 Sign in now；询问 OAuth client，选 Use Claude's published identity 或 Register automatically 均可。点 Add，再点 Connect，在弹出的页面输入密码并点“允许”。
2. 网页版、桌面端和手机端登录同一个 Claude 账号即可使用这个连接器。
3. **准备数据**：在 math-reader 里配置好 R2 同步并同步一次（上传书目索引）；书架长按要用的书 → “同步书页给 Claude”，等到提示“已同步给 Claude：共 N 页”。
4. **写讲义**：在对话框点 **+** → Connectors，打开 Math Reader；然后提出要求，例如“用 Math Reader 为《书名》第 2 节写讲义”。

## 存储

书页图片存在 R2 的 `claude/docs/<书 id>/` 下，每页一到两个对象，每个不超过 12 万个 base64 字符（约 90 KB）。删除这个前缀即可清除，math-reader 下次执行“同步书页给 Claude”时会重新生成。

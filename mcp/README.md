# Math Reader 的 Claude 连接器（MCP）

让 claude.ai（网页、桌面端、手机端）读取你在 math-reader 里的书目、大纲和书页，在对话中写讲义；讲义里的图由 Claude 的内置可视化绘制。连接器只读，不修改 math-reader 的任何数据。

## 工作方式

- math-reader 把连接器需要的数据写到你的 Cloudflare R2（与 R2 云同步用同一个存储桶）：
  - `claude/index.json`：书目、大纲、讲义编号、书页同步进度。每次 R2 同步后自动上传，内容没变时跳过。
  - `claude/docs/<书 id>/`：书页图片和清单。在书架长按书籍，选择“同步书页给 Claude”生成，中断后再次执行会从断点继续。
  - **设置 → 数据管理 → 自动同步到 Claude**（开关只存在本机）：打开后，新上传的 PDF 在后台逐本同步书页；生成大纲后立即上传书目索引，书页没同步完的接着同步；应用重启后续传没完成的。打开开关时会询问是否把书库里已有、还没同步的 PDF 一并同步。关掉开关，正在同步的书在当前页完成后停下。
- 本目录是部署在 Cloudflare Workers 上的 MCP 服务，读取同一个存储桶，用 OAuth + 你设的密码保护。
- claude.ai 的单次工具结果约 15 万字符封顶，base64 图片也计入。所以每张书页图片不超过 12 万字符（超出时降低 JPEG 质量，仍超出就上下切成两张），`read_pages` 每次按大小挑页（通常 1–2 页，最多 8 页），结果末尾写明下一次从哪一页继续；Claude 可以在同一轮里并行读取多页。

## 工具与提示模板

| 名称 | 作用 |
|---|---|
| `show_library` | 在对话里显示书库卡片，点开是全屏选择器：左栏书目，右栏大纲（节标题、页码、主题），可搜索；点书、点节，再点“写讲义”发出写讲义请求 |
| `list_documents` | 列出书籍和论文：id、页数、大纲节数、书页同步进度 |
| `get_outline` | 一本书的大纲：每节标题、主题、PDF 页码范围，以及是否已有 math-reader 讲义 |
| `read_pages` | 以图片返回书页（PDF 物理页码） |
| `read_lecture` | 读取 math-reader 此前生成的讲义正文 |
| `open_library`（提示模板“打开书库”） | 不用填参数，发出后 Claude 调用 `show_library` 显示书库界面 |
| `write_lecture`（提示模板） | 读完一节后按 math-reader 的讲义结构（预习、大纲、习题）写讲义，并用内置可视化配图 |

`show_library` 的界面用 MCP Apps（`@modelcontextprotocol/ext-apps`）实现，在 claude.ai 网页版、桌面端和手机端的对话里显示，按 Claude 的界面规范：对话里只放一张不滚动的小卡片，长列表放在全屏里；界面脚本从 unpkg.com 加载（版本和完整性哈希固定），字体取自 assets.claude.ai。界面数据放在工具结果的 `structuredContent` 里，不占模型上下文；大纲总量较大时，其余书的大纲在界面里选中时再读取（`library_outline`，只供界面调用）。

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
3. **准备数据**：在 math-reader 里配置好 R2 同步并同步一次（上传书目索引）。书页可以逐本手动同步（书架长按要用的书 → “同步书页给 Claude”，等到提示“已同步给 Claude：共 N 页”），也可以打开 **设置 → 数据管理 → 自动同步到 Claude**。
4. **选章节**：在对话框点 **+** → Connectors，打开 Math Reader；然后说“打开 Math Reader 书库”，或在 **+** 菜单的 Math Reader 下选提示模板“打开书库”再发送。Claude 的回复里出现书库卡片，点 **选择书和章节** 进入全屏选择器：
   - 左栏点一本书，右栏列出它的大纲，点一节选中；没有大纲的书或论文在“按页码”一栏填页码范围。
   - 底栏显示选中的书、节和页码范围，点 **写讲义**，界面替你发出请求并回到对话。书页还没同步到这一节时，底栏写明已同步到第几页，按钮不可点；同步进行中可以点 **刷新**。
   - math-reader 已经写好讲义的节，底栏多一个 **为讲义配图**：Claude 用 `read_lecture` 读这份讲义，不重写，只按讲义顺序出配套的图，每张图写明对应讲义的哪一部分并引用一句原文。配图不要求书页已同步。
   - 选中的书和节也会告诉 Claude，选好后在对话框直接说“这一节……”也能对上。
   - 窄屏（手机）先列书目，点书后进入章节列表，左上角“← 全部书目”返回。
5. **直接提要求**也可以，例如“用 Math Reader 为《书名》第 2 节写讲义”。

## 存储

书页图片存在 R2 的 `claude/docs/<书 id>/` 下，每页一到两个对象，每个不超过 12 万个 base64 字符（约 90 KB）。删除这个前缀即可清除，math-reader 下次执行“同步书页给 Claude”时会重新生成。

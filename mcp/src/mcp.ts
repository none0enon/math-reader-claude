import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Env } from './env';
import {
  LibraryError, findDocument, loadIndex, loadManifest, readLectureText, readPagePart,
} from './library';
import {
  LIBRARY_UI_META, LIBRARY_UI_URI, buildLibraryView, chapterViews, libraryUiHtml,
} from './library-ui';
import { SERVER_INSTRUCTIONS, lecturePrompt } from './lecture';

// claude.ai 的工具结果约 15 万字符封顶，base64 图片计入。每次 read_pages 按清单记录的
// 字符数挑页，总量不超过 RESULT_CHAR_BUDGET；math-reader 导出时每张图不超过 12 万字符。
const RESULT_CHAR_BUDGET = 130_000;
const MAX_PAGES_PER_CALL = 8;
const LECTURE_CHAR_LIMIT = 140_000;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

type Content = CallToolResult['content'];

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

async function run(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof LibraryError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    throw error;
  }
}

function pagesLine(pages: { ready: number; total: number } | null): string {
  if (!pages) return '书页未同步';
  return pages.ready >= pages.total
    ? `书页已同步（${pages.total} 页）`
    : `书页已同步 ${pages.ready}/${pages.total} 页`;
}

function documentLine(doc: {
  id: string;
  kind: 'book' | 'paper';
  title: string;
  author: string;
  totalPages: number | null;
  chapterCount: number;
  pages: { ready: number; total: number } | null;
}): string {
  const kind = doc.kind === 'paper' ? '论文' : '书籍';
  const author = doc.author ? ` · ${doc.author}` : '';
  const pages = doc.totalPages ? ` · ${doc.totalPages} 页` : '';
  const outline = doc.chapterCount ? ` · 大纲 ${doc.chapterCount} 节` : ' · 无大纲';
  return `- 《${doc.title}》${author} · ${kind}${pages}${outline} · ${pagesLine(doc.pages)} · id: ${doc.id}`;
}

function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'math-reader', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  server.registerTool('list_documents', {
    title: '列出书目',
    description: '列出 Math Reader 书库里的 PDF 书籍和论文：id、书名、作者、页数、大纲节数、书页图片同步情况。',
    annotations: READ_ONLY,
  }, () => run(async () => {
    const index = await loadIndex(env);
    if (!index.documents.length) return textResult('书库里没有 PDF 书籍或论文。');
    const lines = index.documents.map((doc) => documentLine({ ...doc, chapterCount: doc.chapters.length }));
    return textResult(lines.join('\n'));
  }));

  registerAppTool(server, 'show_library', {
    title: '显示书库',
    description: '在对话中显示可点选的书库界面：用户用鼠标先点一本书，再点一节（或填页码范围），点“写讲义”后界面会发来带页码范围的写讲义请求；用户选中的书和节也会作为上下文告诉你。用户想浏览书库、找书、挑选章节时调用。',
    annotations: READ_ONLY,
    _meta: { ui: { resourceUri: LIBRARY_UI_URI } },
  }, () => run(async () => {
    const view = await buildLibraryView(env, await loadIndex(env));
    // 界面数据放在 structuredContent（不进入模型上下文）；文字部分给模型和不支持界面的客户端
    const text = view.documents.length
      ? `已在对话中显示书库界面，共 ${view.documents.length} 个 PDF；用户可以在界面里点书、点节，再点“写讲义”。\n` +
        view.documents.map(documentLine).join('\n')
      : '书库里没有 PDF 书籍或论文。';
    return { content: [{ type: 'text', text }], structuredContent: view };
  }));

  // 只供书库界面调用（visibility: app）：结果里没附带大纲的书，在界面里选中时读取
  registerAppTool(server, 'library_outline', {
    title: '书库界面：读取大纲',
    description: '供 show_library 界面选中一本书时读取它的大纲数据。',
    inputSchema: { document_id: z.string().describe('书的 id') },
    annotations: READ_ONLY,
    _meta: { ui: { visibility: ['app'] } },
  }, ({ document_id }) => run(async () => {
    const doc = findDocument(await loadIndex(env), document_id);
    const chapters = chapterViews(doc);
    return {
      content: [{ type: 'text', text: `《${doc.title}》大纲 ${chapters.length} 节` }],
      structuredContent: { id: doc.id, chapters },
    };
  }));

  registerAppResource(server, 'Math Reader 书库界面', LIBRARY_UI_URI, {
    description: 'show_library 显示的书目-大纲界面',
    _meta: LIBRARY_UI_META,
  }, () => ({
    contents: [{ uri: LIBRARY_UI_URI, mimeType: RESOURCE_MIME_TYPE, text: libraryUiHtml(), _meta: LIBRARY_UI_META }],
  }));

  server.registerTool('get_outline', {
    title: '读取大纲',
    description: '读取一本书在 math-reader 中生成的大纲：每一节的序号、标题、主题和 PDF 页码范围，以及该节是否已有 math-reader 讲义。页码是 PDF 的物理页码，与 read_pages 使用的页码一致。',
    inputSchema: { document: z.string().describe('书名（可只写一部分）或 list_documents 给出的 id') },
    annotations: READ_ONLY,
  }, ({ document }) => run(async () => {
    const doc = findDocument(await loadIndex(env), document);
    const header = `《${doc.title}》 id: ${doc.id} · ${pagesLine(doc.pages)}`;
    if (!doc.chapters.length) {
      return textResult(`${header}\n这本书还没有大纲。可以直接用 read_pages 读目录页确定章节页码。`);
    }
    const lines = doc.chapters.map((ch) => {
      const topics = ch.topics.length ? `  主题：${ch.topics.join('、')}` : '';
      const lecture = ch.lectureId ? '  [math-reader 已有讲义]' : '';
      return `${ch.index}. ${ch.title}  第 ${ch.startPage}–${ch.endPage} 页${topics}${lecture}`;
    });
    return textResult(`${header}\n${lines.join('\n')}`);
  }));

  server.registerTool('read_pages', {
    title: '读取书页',
    description: '以图片返回书的 PDF 页面（math-reader 同步到 R2 的页面截图）。单次结果受大小限制，通常返回 1–2 页；结果末尾说明下一次调用的 start_page。可以在同一轮里对不同页码并行调用（例如 start_page=end_page=12、13、14）。为讲义读一节时，从该节起始页读到结束页。',
    inputSchema: {
      document: z.string().describe('书名（可只写一部分）或 id'),
      start_page: z.number().int().min(1).describe('起始页（PDF 物理页码，从 1 开始）'),
      end_page: z.number().int().min(1).optional().describe('结束页（含），可省略'),
    },
    annotations: READ_ONLY,
  }, ({ document, start_page, end_page }) => run(async () => {
    const doc = findDocument(await loadIndex(env), document);
    const manifest = await loadManifest(env, doc.id);
    if (!manifest) {
      throw new LibraryError(`《${doc.title}》的书页还没有同步。请在 math-reader 书架长按这本书，选择“同步书页给 Claude”；或在设置 → 数据管理里打开“自动同步到 Claude”。`);
    }
    if (end_page !== undefined && end_page < start_page) {
      throw new LibraryError(`end_page（${end_page}）小于 start_page（${start_page}）。`);
    }
    if (start_page > manifest.totalPages) {
      throw new LibraryError(`起始页 ${start_page} 超出范围：这本书共 ${manifest.totalPages} 页。`);
    }
    const last = Math.min(end_page ?? manifest.totalPages, manifest.totalPages);

    // 先按清单里的字符数挑页，再并行读取
    const chosen: number[] = [];
    const missing: number[] = [];
    let used = 0;
    let next = start_page;
    for (; next <= last && chosen.length < MAX_PAGES_PER_CALL; next++) {
      const parts = manifest.pages[String(next)];
      if (!parts?.length) { missing.push(next); continue; }
      const size = parts.reduce((sum, part) => sum + part.chars, 0);
      if (chosen.length > 0 && used + size > RESULT_CHAR_BUDGET) break;
      chosen.push(next);
      used += size;
    }

    const content: Content = [];
    const images = await Promise.all(chosen.map((page) =>
      Promise.all(manifest.pages[String(page)].map((part) => readPagePart(env, part)))));
    chosen.forEach((page, i) => {
      const parts = manifest.pages[String(page)];
      content.push({ type: 'text', text: parts.length > 1 ? `第 ${page} 页（上下两张图）` : `第 ${page} 页` });
      parts.forEach((part, j) => content.push({ type: 'image', data: images[i][j], mimeType: part.mime }));
    });

    const notes: string[] = [];
    if (chosen.length) notes.push(`已返回第 ${chosen[0]}–${chosen[chosen.length - 1]} 页（全书 ${manifest.totalPages} 页）。`);
    if (missing.length) notes.push(`第 ${missing.join('、')} 页尚未同步，需要在 math-reader 里继续“同步书页给 Claude”。`);
    notes.push(next <= last
      ? `继续读取：read_pages(start_page=${next}${end_page ? `, end_page=${end_page}` : ''})。`
      : `第 ${start_page}–${last} 页已全部读完。`);
    content.push({ type: 'text', text: notes.join('\n') });
    return { content, isError: chosen.length === 0 };
  }));

  server.registerTool('read_lecture', {
    title: '读取 math-reader 讲义',
    description: '读取 math-reader 应用此前为某一节生成的讲义正文（Markdown + LaTeX）。get_outline 中标记“math-reader 已有讲义”的节才有。',
    inputSchema: {
      document: z.string().describe('书名（可只写一部分）或 id'),
      chapter_index: z.number().int().min(0).describe('get_outline 给出的节序号'),
    },
    annotations: READ_ONLY,
  }, ({ document, chapter_index }) => run(async () => {
    const doc = findDocument(await loadIndex(env), document);
    const chapter = doc.chapters.find((ch) => ch.index === chapter_index);
    if (!chapter) throw new LibraryError(`《${doc.title}》没有序号为 ${chapter_index} 的节。`);
    if (!chapter.lectureId) throw new LibraryError(`math-reader 还没有为“${chapter.title}”生成讲义。`);
    const text = await readLectureText(env, doc.id, chapter.lectureId);
    if (!text) throw new LibraryError(`R2 里找不到“${chapter.title}”的讲义正文。请在 math-reader 里同步一次。`);
    const body = text.length > LECTURE_CHAR_LIMIT
      ? text.slice(0, LECTURE_CHAR_LIMIT) + `\n\n（正文共 ${text.length} 字符，已截取前 ${LECTURE_CHAR_LIMIT} 字符）`
      : text;
    return textResult(`《${doc.title}》${chapter.title}\n\n${body}`);
  }));

  // claude.ai 的“+ → 连接器”菜单只列提示模板，书库界面从这里也能打开
  server.registerPrompt('open_library', {
    title: '打开书库',
    description: '在对话里显示 Math Reader 书库界面：书目和大纲，点某一节的“写讲义”即可开始。',
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: '打开 Math Reader 书库（调用 show_library）。' } }],
  }));

  server.registerPrompt('write_lecture', {
    title: '写可视化讲义',
    description: '读取一节的书页，按 math-reader 的讲义结构写讲义，并用 Claude 的内置可视化配图。',
    argsSchema: {
      document: z.string().describe('书名或 id'),
      chapter: z.string().describe('节的标题或 get_outline 中的序号'),
    },
  }, ({ document, chapter }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: lecturePrompt(document, chapter) } }],
  }));

  return server;
}

const methodNotAllowed = () => new Response(JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
}), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } });

// 无状态模式：每个请求新建 server 与 transport，结果以 JSON 直接返回。
// 无状态服务器不提供 GET 的 SSE 通道和 DELETE 会话结束，按规范回 405。
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed();
  const server = createServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

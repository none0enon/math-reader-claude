import type { Env } from './env';
import { loadManifest, syncedThrough, type LibraryDocument, type LibraryIndex } from './library';
import { lectureRequest } from './lecture';
import libraryHtml from './library.html';

// show_library 的界面（MCP Apps）：claude.ai 在对话里以沙箱 iframe 显示 library.html，
// 数据由工具结果的 structuredContent 传入（不进入模型上下文）。

export const LIBRARY_UI_URI = 'ui://math-reader/library.html';

// CSP 放行两个来源：unpkg 提供界面脚本（版本和完整性哈希固定在 library.html），
// assets.claude.ai 提供 Claude 的界面字体。不要宿主的边框，界面自己画卡片，背景透明。
export const LIBRARY_UI_META = {
  ui: { csp: { resourceDomains: ['https://unpkg.com', 'https://assets.claude.ai'] }, prefersBorder: false },
};

// 随结果附带的大纲总量上限（字符）；超出部分的书在界面里选中时用 library_outline 读取
const OUTLINE_INLINE_CHARS = 60_000;

export type PagesView = { ready: number; total: number; through: number };

export type ChapterView = {
  index: number;
  title: string;
  topics: string[];
  startPage: number;
  endPage: number;
  hasLecture: boolean;
};

export type DocumentView = {
  id: string;
  kind: 'book' | 'paper';
  title: string;
  author: string;
  subject: string;
  totalPages: number | null;
  pages: PagesView | null;
  chapterCount: number;
  lectureCount: number;
  chapters: ChapterView[] | null;
};

export type LibraryView = { updatedAt: string | null; documents: DocumentView[] };

// 大纲页码来自 AI 生成的大纲，不是正整数时记为 0（界面显示“缺少页码”）
function pageNumber(value: unknown): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 0;
}

export function chapterViews(doc: LibraryDocument): ChapterView[] {
  return doc.chapters.map((ch) => ({
    index: ch.index,
    title: ch.title,
    topics: Array.isArray(ch.topics) ? ch.topics.map(String) : [],
    startPage: pageNumber(ch.startPage),
    endPage: pageNumber(ch.endPage),
    hasLecture: !!ch.lectureId,
  }));
}

// math-reader 导出书页途中，索引里的进度可能落后；没同步完的书按清单核对
async function pagesView(env: Env, doc: LibraryDocument): Promise<PagesView | null> {
  const pages = doc.pages;
  if (!pages) return null;
  if (pages.ready >= pages.total) return { ready: pages.total, total: pages.total, through: pages.total };
  try {
    const manifest = await loadManifest(env, doc.id);
    if (!manifest) return null;
    return {
      ready: Object.keys(manifest.pages).length,
      total: manifest.totalPages,
      through: syncedThrough(manifest),
    };
  } catch {
    return { ready: pages.ready, total: pages.total, through: pages.ready };
  }
}

export async function buildLibraryView(env: Env, index: LibraryIndex): Promise<LibraryView> {
  const documents = await Promise.all(index.documents.map(async (doc): Promise<DocumentView> => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    author: doc.author,
    subject: doc.subject,
    totalPages: doc.totalPages,
    pages: await pagesView(env, doc),
    chapterCount: doc.chapters.length,
    lectureCount: doc.chapters.filter((ch) => ch.lectureId).length,
    chapters: chapterViews(doc),
  })));
  let budget = OUTLINE_INLINE_CHARS;
  for (const doc of documents) {
    const size = JSON.stringify(doc.chapters).length;
    if (size <= budget) budget -= size;
    else doc.chapters = null;
  }
  return { updatedAt: index.updatedAt ?? null, documents };
}

// 写讲义请求的模板随界面下发，界面填入书名、id、节和页码
const LECTURE_TEMPLATE = lectureRequest({
  document: '{{document}}',
  id: '{{id}}',
  part: '{{part}}',
  startPage: '{{start}}',
  endPage: '{{end}}',
});

export function libraryUiHtml(): string {
  // 转义 <，模板文字里出现 </script> 也不会提前结束脚本
  const json = JSON.stringify(LECTURE_TEMPLATE).replace(/</g, '\\u003c');
  return libraryHtml.replace('/*LECTURE_TEMPLATE*/""', () => json);
}

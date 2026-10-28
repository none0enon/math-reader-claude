import type { Env } from './env';

// math-reader 写入 R2 的数据（见 app/src/main/assets/www/index.html 的“Claude 连接器”一节）：
//   claude/index.json                    书目、大纲、讲义编号、书页同步进度
//   claude/docs/<docId>/manifest.json    每页图片的对象键
//   claude/docs/<docId>/p<页>[-<n>].b64  页面 JPEG 的 base64 文本
//   lectures/lecture_<bookId>_<chapterId> math-reader 生成的讲义正文

export interface LibraryChapter {
  index: number;
  title: string;
  topics: string[];
  startPage: number;
  endPage: number;
  lectureId: string | null;
}

export interface LibraryDocument {
  id: string;
  kind: 'book' | 'paper';
  title: string;
  author: string;
  subject: string;
  totalPages: number | null;
  chapters: LibraryChapter[];
  pages: { ready: number; total: number; updatedAt?: string } | null;
}

export interface LibraryIndex {
  version: number;
  updatedAt?: string;
  documents: LibraryDocument[];
}

export interface PagePart {
  key: string;
  mime: string;
  chars: number;
}

export interface PageManifest {
  version: number;
  docId: string;
  /** pdf.js 的文件指纹，换文件后 math-reader 会从头导出 */
  fingerprint?: string;
  totalPages: number;
  width: number;
  pages: Record<string, PagePart[]>;
  updatedAt?: string;
}

export class LibraryError extends Error {}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const object = await env.BUCKET.get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as T;
}

export async function loadIndex(env: Env): Promise<LibraryIndex> {
  const index = await readJson<LibraryIndex>(env, 'claude/index.json');
  if (!index) {
    throw new LibraryError(
      'R2 里还没有 claude/index.json。请在 math-reader 里配置 R2 同步并同步一次；' +
      '需要读书页时，在书架长按书籍选择“同步书页给 Claude”，或在设置 → 数据管理里打开“自动同步到 Claude”。',
    );
  }
  return index;
}

export function findDocument(index: LibraryIndex, query: string): LibraryDocument {
  const needle = query.trim();
  const byId = index.documents.find((doc) => doc.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const matches = index.documents.filter((doc) => doc.title.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new LibraryError(
      `有 ${matches.length} 本书的书名包含“${needle}”：` +
      matches.map((doc) => `${doc.title}（id: ${doc.id}）`).join('；') + '。请改用 id。',
    );
  }
  throw new LibraryError(`没有找到“${needle}”。先调用 list_documents 查看书目和 id。`);
}

export async function loadManifest(env: Env, docId: string): Promise<PageManifest | null> {
  return readJson<PageManifest>(env, `claude/docs/${docId}/manifest.json`);
}

/** 从第 1 页起连续同步到了第几页（math-reader 按页码顺序导出） */
export function syncedThrough(manifest: PageManifest): number {
  let page = 0;
  while (page < manifest.totalPages && manifest.pages[String(page + 1)]?.length) page++;
  return page;
}

export async function readPagePart(env: Env, part: PagePart): Promise<string> {
  const object = await env.BUCKET.get(part.key);
  if (!object) throw new LibraryError(`书页图片缺失：${part.key}。请在 math-reader 里重新同步书页。`);
  return object.text();
}

export async function readLectureText(env: Env, bookId: string, chapterId: string): Promise<string | null> {
  const object = await env.BUCKET.get(`lectures/lecture_${bookId}_${chapterId}`);
  return object ? object.text() : null;
}

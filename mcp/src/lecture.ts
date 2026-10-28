// 讲义结构沿用 math-reader 的 prompt_lecture_sys（index.html 的 i18n 中文条目），
// 配图部分改为使用 Claude 的内置可视化。

export const VISUALIZATION_RULES = `## 配图
用 Claude 的内置可视化在回复中直接画图（静态图或可交互的图），不用 ASCII 字符画，也不用代码块代替图。
- 几何构造、映射与变换、函数与曲线族、极限与收敛过程、证明中的构造步骤都配图；图放在它解释的文字旁边。
- 依赖数值的图（函数图像、参数曲线、隐函数、向量场与相图、迭代与收敛、复平面着色、共形映射、带参数的几何）由代码按讲义中的公式计算坐标，不手估坐标；尖峰和振荡处加密采样，间断处断开曲线。
- 几何图横纵同一比例尺；极值、交点、不动点等关键点按公式算出后再标注。
- 参数变化有助于理解时做成带滑块的交互图。
- 图中的标注、数值和比例与正文一致。`;

const AUDIENCE = '读者只学过基础数学分析和线性代数，总量按 1 小时学习安排。';
const FAITHFUL = '讲义内容与这些页面一致，不凭空发挥。';
const READ_ALL = '每次返回若干页，按结果末尾的提示继续，直到读完';

/** 讲义的结构、写作要求和配图要求。write_lecture 提示模板、书库界面的“写讲义”和服务器说明共用。 */
export const LECTURE_STRUCTURE = `## 一、预习
前置概念讲解。所有涉及的非初等概念（如线性泛函、流形、测度、分布等）都需要：
1. 给出严格的数学定义
2. 简明解释其数学含义
3. 给出具体例子
4. 介绍所有需要的数学记号

## 二、大纲
本节主要内容：
1. 核心定理的完整陈述
2. 重要引理
3. 完整的证明过程（不省略任何关键步骤）
4. 定理之间的逻辑关系

## 三、习题
5 道涉及核心概念的习题，难度递进：
- 第 1–2 题：基础概念理解
- 第 3–4 题：定理应用
- 第 5 题：综合应用或证明
在文末给出所有习题的详细解答。

写作要求：
- 使用严谨的数学语言，直接陈述数学内容
- 不使用“大家好”“我们将”“让我们”等口语
- 公式用 LaTeX

${VISUALIZATION_RULES}`;

export const SERVER_INSTRUCTIONS = [
  'Math Reader 连接器读取用户 math-reader 书库（Cloudflare R2）里的书目、大纲、书页图片和 math-reader 已生成的讲义，全部只读。',
  '用户想浏览书库、找书或挑选章节时调用 show_library：对话里会显示书库卡片，用户在全屏选择器里点书、点节后点“写讲义”，会发来带页码范围的请求；用户选中的书和节也会作为上下文告诉你。',
  `为某一节写讲义的流程：list_documents 找到书的 id → get_outline 得到这一节的页码范围 → read_pages 读完这一节的全部页面（${READ_ALL}）→ 按下面的结构写讲义。${AUDIENCE}`,
  '',
  LECTURE_STRUCTURE,
].join('\n');

export function lecturePrompt(document: string, chapter: string): string {
  return `为 Math Reader 书库中《${document}》的“${chapter}”写一份讲义。

步骤：
1. 用 list_documents 找到这本书的 id，用 get_outline 找到“${chapter}”的页码范围。
2. 用 read_pages 读完这一节的全部页面（${READ_ALL}）。${FAITHFUL}
3. 按下面的结构写讲义。${AUDIENCE}

${LECTURE_STRUCTURE}`;
}

/** 页码范围已知时的写讲义请求，书库界面点“写讲义”时发送。part 形如：第 3 节“全纯函数”、第 12–30 页。 */
export function lectureRequest(p: {
  document: string;
  id: string;
  part: string;
  startPage: string;
  endPage: string;
}): string {
  return `为 Math Reader 书库中《${p.document}》（id: ${p.id}）的${p.part}写一份讲义，对应 PDF 第 ${p.startPage}–${p.endPage} 页。

步骤：
1. 用 read_pages 读完第 ${p.startPage}–${p.endPage} 页（${READ_ALL}）。${FAITHFUL}
2. 按下面的结构写讲义。${AUDIENCE}

${LECTURE_STRUCTURE}`;
}

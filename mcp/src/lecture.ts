// 讲义要求逐字沿用 math-reader 的 prompt_lecture_sys（index.html 的 i18n 中文条目），
// 只把“附件 PDF”换成用 read_pages 读取书页。在此之上加两条：
// 证明中引用的定理在预习里先给出陈述；用 Claude 的内置可视化配图，配图只作补充，不替代文字。

const READ_ALL = '每次返回若干页，按结果末尾的提示继续，直到读完';

/** prompt_lecture_sys 的开头：讲师角色、读者和忠实于原文 */
const LECTURE_ROLE = '你是一个专业的数学讲师。请基于书页实际内容，为数学基础一般（仅学过基础数学分析和线性代数）的学生准备讲义。讲义应当与书页内容一致，不要凭空发挥。';

/** prompt_lecture_sys 的三部分结构和写作要求；预习里多一段“引用的定理先陈述” */
const LECTURE_STRUCTURE = `请严格按以下三个部分组织，每节按 1 小时学习效率把握总量：

## 一、预习

前置概念讲解。假设读者只有基础数学分析和线性代数水平，所有涉及的非初等概念（如线性泛函、流形、测度、分布等）都需要：
1. 给出严格的数学定义
2. 简明解释其数学含义
3. 给出具体例子
4. 介绍所有需要的数学记号

证明中引用的已知定理（本节之前的结果或其他课程中的定理）也在这里给出完整陈述和成立条件。

## 二、大纲

本节主要内容：
1. 核心定理的完整陈述
2. 重要引理
3. 完整的证明过程（不省略任何关键步骤）
4. 定理之间的逻辑关系

## 三、习题

5道涉及核心概念的习题，难度递进：
- 第1-2题：基础概念理解
- 第3-4题：定理应用
- 第5题：综合应用或证明

在文末给出所有习题的详细解答。

要求：
- 使用严谨的数学语言，不要口语化表达
- 不要使用"大家好"、"我们将"、"让我们"等口语
- 直接陈述数学内容
- 使用LaTeX格式：行内公式用 $...$ ，独立公式用 $$...$$`;

const VISUALIZATION_RULES = `## 配图

在以上三个部分完整写出的基础上配图。配图是补充：定义、定理陈述、证明步骤和习题都不因为有图而省略，去掉所有图后讲义仍然完整。
用 Claude 的内置可视化在回复中直接画图（静态图或可交互的图），不用 ASCII 字符画，也不用代码块代替图。
- 几何构造、映射与变换、函数与曲线族、极限与收敛过程、证明中的构造步骤配图；图放在它解释的文字之后。
- 依赖数值的图（函数图像、参数曲线、隐函数、向量场与相图、迭代与收敛、复平面着色、共形映射、带参数的几何）由代码按讲义中的公式计算坐标，不手估坐标；尖峰和振荡处加密采样，间断处断开曲线。
- 几何图横纵同一比例尺；极值、交点、不动点等关键点按公式算出后再标注。
- 参数变化有助于理解时做成带滑块的交互图。
- 图中的标注、数值和比例与正文一致。`;

/** 完整的讲义要求。write_lecture 提示模板、书库界面的“写讲义”和服务器说明共用。 */
const LECTURE_REQUIREMENTS = `${LECTURE_ROLE}\n\n${LECTURE_STRUCTURE}\n\n${VISUALIZATION_RULES}`;

export const SERVER_INSTRUCTIONS = [
  'Math Reader 连接器读取用户 math-reader 书库（Cloudflare R2）里的书目、大纲、书页图片和 math-reader 已生成的讲义，全部只读。',
  '用户想浏览书库、找书或挑选章节时调用 show_library：对话里会显示书库卡片，用户在全屏选择器里点书、点节后点“写讲义”，会发来带页码范围的请求；用户选中的书和节也会作为上下文告诉你。',
  `为某一节写讲义的流程：list_documents 找到书的 id → get_outline 得到这一节的页码范围和主题 → read_pages 读完这一节的全部页面（${READ_ALL}）→ 按下面的要求写讲义。`,
  '',
  LECTURE_REQUIREMENTS,
].join('\n');

export function lecturePrompt(document: string, chapter: string): string {
  return `为 Math Reader 书库中《${document}》的“${chapter}”写讲义。

先用 list_documents 找到这本书的 id，用 get_outline 找到“${chapter}”的页码范围和主题，再用 read_pages 读完这一节的全部页面（${READ_ALL}）。

${LECTURE_REQUIREMENTS}`;
}

/**
 * 页码范围已知时的写讲义请求，书库界面点“写讲义”时发送。
 * part 形如：第 3 节“全纯函数”、指定页码范围；topicsLine 为“涉及主题：…”加换行，或空串。
 */
export function lectureRequest(p: {
  document: string;
  id: string;
  part: string;
  startPage: string;
  endPage: string;
  topicsLine: string;
}): string {
  return `为 Math Reader 书库中的下面这一节写讲义。

书籍：《${p.document}》（id: ${p.id}）
章节：${p.part}
对应页码：第 ${p.startPage} - ${p.endPage} 页
${p.topicsLine}
先用 read_pages 读完第 ${p.startPage}–${p.endPage} 页（${READ_ALL}），再写讲义。

${LECTURE_REQUIREMENTS}`;
}

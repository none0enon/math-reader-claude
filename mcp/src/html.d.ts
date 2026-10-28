// wrangler 默认把 .html 作为文本模块打包，导入得到文件内容字符串
declare module '*.html' {
  const content: string;
  export default content;
}

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  /** OAuth 令牌、授权和客户端注册记录（@cloudflare/workers-oauth-provider 使用）。 */
  OAUTH_KV: KVNamespace;
  /** math-reader 同步用的 R2 存储桶。 */
  BUCKET: R2Bucket;
  /** 登录页密码，部署时由 GitHub Actions 写入 Worker Secret。 */
  MCP_LOGIN_PASSWORD?: string;
  /** OAuthProvider 注入给 defaultHandler 的授权辅助方法。 */
  OAUTH_PROVIDER: OAuthHelpers;
}

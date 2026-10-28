import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';
import { handleAuthorize } from './authorize';
import { handleMcpRequest } from './mcp';

const MCP_PATH = '/mcp';

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorize(request, env);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        `Math Reader MCP 服务正在运行。\n在 claude.ai 的 设置 → 连接器 → 添加自定义连接器 中填写：${url.origin}${MCP_PATH}\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
    return new Response('Not found', { status: 404 });
  },
};

const apiHandler = {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleMcpRequest(request, env);
  },
};

// OAuthProvider 需要固定的资源地址（https://<域名>/mcp）。workers.dev 子域名在部署后才确定，
// 所以按请求的 origin 各建一个实例；令牌绑定在各自的资源地址上。
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      // claude.ai 添加连接器时可选“Claude 公布的身份”（CIMD）或“自动注册”（DCR），两种都支持
      clientRegistrationEndpoint: '/register',
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: origin + MCP_PATH,
        authorization_servers: [origin],
        resource_name: 'Math Reader',
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

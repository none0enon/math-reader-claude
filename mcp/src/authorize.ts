import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';

// 这是单用户服务：密码就是唯一的登录凭据。连续输错 MAX_FAILURES 次后，该 IP 锁定 FAILURE_WINDOW_SECONDS 秒。
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 3600;
const USER_ID = 'owner';

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface PageInfo {
  handle: string;
  clientName: string;
  clientDomain: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  error?: string;
}

function loginPage(info: PageInfo): string {
  const name = escape(info.clientName);
  const domain = escape(info.clientDomain);
  const host = escape(info.redirectHost);
  const origin = domain
    ? `发布者：<strong>${domain}</strong>。`
    : '这个应用的名称由它自己注册，未经验证。';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Math Reader 授权</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1a1a1a;background:#fff}
h1{font-size:20px}p{line-height:1.6}input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:8px}
.row{display:flex;gap:12px;margin-top:16px}button{flex:1;padding:10px;font-size:16px;border-radius:8px;border:1px solid #1a1a1a;background:#fff}
button[value=approve]{background:#1a1a1a;color:#fff}.error{color:#b42318}.warn{color:#b54708}
</style></head><body>
<h1>允许 ${name} 读取你的 Math Reader 资料？</h1>
<p>${origin}授权后，令牌会发送到 <strong>${host}</strong>。</p>
${info.redirectIsLoopback ? '<p class="warn">令牌会发送到本机上的程序。只有你刚刚从本机发起连接时才继续。</p>' : ''}
<p>可读取：书目、大纲、已同步的书页图片和 math-reader 生成的讲义。不能修改任何内容。</p>
${info.error ? `<p class="error">${escape(info.error)}</p>` : ''}
<form method="post">
<input type="hidden" name="handle" value="${escape(info.handle)}">
<input type="hidden" name="client_name" value="${name}">
<input type="hidden" name="client_domain" value="${domain}">
<input type="hidden" name="redirect_host" value="${host}">
<input type="hidden" name="redirect_loopback" value="${info.redirectIsLoopback ? '1' : ''}">
<label for="password">密码</label>
<input type="password" id="password" name="password" autocomplete="current-password" autofocus>
<div class="row"><button name="decision" value="approve">允许</button><button name="decision" value="deny">拒绝</button></div>
</form>
</body></html>`;
}

function htmlResponse(body: string, status: number, headers?: Headers): Response {
  const responseHeaders = headers ?? new Headers();
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.set('X-Frame-Options', 'DENY');
  // 不限制 form-action：提交后要 302 跳回 Claude 的回调地址，Chrome 会对跳转链执行 form-action
  responseHeaders.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(body, { status, headers: responseHeaders });
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
  // 先各自取哈希，长度一致后再做常数时间比较
  const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function failureKey(request: Request): string {
  return 'mr-login-fail:' + (request.headers.get('CF-Connecting-IP') || 'unknown');
}

async function failureCount(env: Env, request: Request): Promise<number> {
  return Number(await env.OAUTH_KV.get(failureKey(request))) || 0;
}

async function recordFailure(env: Env, request: Request, count: number): Promise<void> {
  await env.OAUTH_KV.put(failureKey(request), String(count + 1), { expirationTtl: FAILURE_WINDOW_SECONDS });
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      // describeConsent 先于 beginConsent：查询失败时 KV 里不留下半成品
      const details: ConsentDescription = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return htmlResponse(loginPage({
        handle: consent.handle,
        clientName: details.clientName,
        clientDomain: details.clientDomain || '',
        redirectHost: details.redirectHost,
        redirectIsLoopback: details.redirectIsLoopback,
      }), 200, consent.headers);
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const form = await request.formData();
    const handle = String(form.get('handle') || '');
    // “允许”排在表单第一个，在密码框里按回车即提交“允许”
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    // 隐藏字段只用于重新显示页面；授权内容取自服务端保存的请求
    const page: PageInfo = {
      handle,
      clientName: String(form.get('client_name') || ''),
      clientDomain: String(form.get('client_domain') || ''),
      redirectHost: String(form.get('redirect_host') || ''),
      redirectIsLoopback: form.get('redirect_loopback') === '1',
    };
    if (!env.MCP_LOGIN_PASSWORD) {
      return htmlResponse(loginPage({ ...page, error: '服务器还没有设置密码（Worker Secret MCP_LOGIN_PASSWORD）。' }), 503);
    }
    const failures = await failureCount(env, request);
    if (failures >= MAX_FAILURES) {
      return htmlResponse(loginPage({ ...page, error: '密码错误次数过多，请一小时后再试。' }), 429);
    }
    if (!(await passwordMatches(String(form.get('password') || ''), env.MCP_LOGIN_PASSWORD))) {
      await recordFailure(env, request, failures);
      return htmlResponse(loginPage({ ...page, error: '密码不正确。' }), 401);
    }

    const approved = await oauth.approveConsent(request, handle, { scope: [] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: USER_ID,
      metadata: {},
      scope: approved.request.scope,
      props: { userId: USER_ID },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError
        ? error.description
        : 'This app could not be verified.';
      return new Response(`授权请求无效：${message}\n请回到 Claude 重新连接。`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
}

// netlify/edge-functions/proxy-handler.ts
import type { Context } from "@netlify/edge-functions";

// 定义允许代理的域名白名单（核心限制）
const ALLOWED_DOMAINS = new Set([
  "store.steampowered.com",
  "api.steamcmd.net",
  "cdn.tailwindcss.com",
  "m.bsddji.cn",
  "download2342.mediafire.com",
  "steam.ddxnb.cn"
]);

// 定义代理规则：路径前缀 => 目标基础 URL（仅保留允许的三个域名）
const PROXY_CONFIG = {
  "/steam": "https://store.steampowered.com",
  "/steamcmd": "https://api.steamcmd.net",
  "/tailwindcss": "https://cdn.tailwindcss.com",
  "/mediafire": "https://mediafire.com",
  "/vpn": "https://m.bsddji.cn/ssone/0f6daf12a8d5af2552055bb8a01dd9e8",
  "/steamd": "https://steam.ddxnb.cn"
};

// 需要修复路径的内容类型
const HTML_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml'
];

// 可能需要修复路径的 CSS 内容类型
const CSS_CONTENT_TYPES = [
  'text/css'
];

// JavaScript 内容类型
const JS_CONTENT_TYPES = [
  'application/javascript',
  'text/javascript',
  'application/x-javascript'
];

// 特定网站的替换规则 (仅保留允许域名的特殊处理，若无特殊需求可留空)
const SPECIAL_REPLACEMENTS: Record<string, Array<{pattern: RegExp, replacement: Function}>> = {
  // 可根据需要为允许的域名添加特殊路径替换规则，示例：
  // 'store.steampowered.com': [
  //   {
  //     pattern: /(src|href)=["'](\/[^"']*)["']/gi,
  //     replacement: (match: string, attr: string, path: string) => {
  //       return `${attr}="/steam-store${path}"`;
  //     }
  //   }
  // ]
};

export default async (request: Request, context: Context) => {
  // 处理 CORS 预检请求 (OPTIONS)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept, Origin, Range",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "public, max-age=86400"
      }
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // 特殊处理 /proxy/ 路径 - 用于代理任意URL（添加白名单限制）
  if (path.startsWith('/proxy/')) {
    try {
      // 从路径中提取目标URL
      let targetUrlString = path.substring('/proxy/'.length);
      
      // 解码URL（如果已编码）
      if (targetUrlString.startsWith('http%3A%2F%2F') || targetUrlString.startsWith('https%3A%2F%2F')) {
        targetUrlString = decodeURIComponent(targetUrlString);
      }
      
      // 确保URL以http开头
      if (!targetUrlString.startsWith('http://') && !targetUrlString.startsWith('https://')) {
        targetUrlString = 'https://' + targetUrlString;
      }
      
      const targetUrl = new URL(targetUrlString);
      
      // 核心限制：检查目标域名是否在白名单内
      if (!ALLOWED_DOMAINS.has(targetUrl.host)) {
        return new Response(`禁止代理该域名：${targetUrl.host}`, { 
          status: 403,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/plain;charset=UTF-8'
          }
        });
      }
      
      // 继承原始请求的查询参数
      if (url.search && !targetUrlString.includes('?')) {
        targetUrl.search = url.search;
      }
      
      context.log(`Proxying generic request to: ${targetUrl.toString()}`);
      
      // 构建代理请求
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
      });
      
      // 设置 Host 头
      proxyRequest.headers.set("Host", targetUrl.host);
      
      // 添加常用代理头
      const clientIp = context.ip || request.headers.get('x-nf-client-connection-ip') || "";
      proxyRequest.headers.set('X-Forwarded-For', clientIp);
      proxyRequest.headers.set('X-Forwarded-Host', url.host);
      proxyRequest.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
      
      // 移除 accept-encoding 避免压缩
      proxyRequest.headers.delete('accept-encoding');
      
      // 处理 referer
      const referer = request.headers.get('referer');
      if (referer) {
        try {
          const refUrl = new URL(referer);
          const newReferer = `${targetUrl.protocol}//${targetUrl.host}${refUrl.pathname}${refUrl.search}`;
          proxyRequest.headers.set('referer', newReferer);
        } catch(e) {}
      } else {
        proxyRequest.headers.set('referer', `${targetUrl.protocol}//${targetUrl.host}/`);
      }
      
      // 发起代理请求
      const response = await fetch(proxyRequest);
      
      // 创建新响应
      let newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      
      // 添加 CORS 头
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Range');
      
      // 移除安全头部
      newResponse.headers.delete('Content-Security-Policy');
      newResponse.headers.delete('Content-Security-Policy-Report-Only');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('X-Content-Type-Options');
      
      // 处理重定向（仅允许重定向到白名单内的域名）
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const location = response.headers.get('location')!;
        const redirectedUrl = new URL(location, targetUrl);
        
        // 检查重定向域名是否在白名单内
        if (ALLOWED_DOMAINS.has(redirectedUrl.host)) {
          const newLocation = `${url.origin}/proxy/${encodeURIComponent(redirectedUrl.toString())}`;
          newResponse.headers.set('Location', newLocation);
        } else {
          return new Response(`重定向目标域名 ${redirectedUrl.host} 不在允许列表内`, { 
            status: 403,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'text/plain;charset=UTF-8'
            }
          });
        }
      }
      
      return newResponse;
    } catch (error) {
      context.log(`Error proxying generic URL: ${error}`);
      return new Response(`代理请求失败: ${error}`, { 
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain;charset=UTF-8'
        }
      });
    }
  }

  // 查找匹配的代理配置（仅匹配允许的三个域名规则）
  let targetBaseUrl: string | null = null;
  let matchedPrefix: string | null = null;

  const prefixes = Object.keys(PROXY_CONFIG).sort().reverse();

  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix + '/')) {
      targetBaseUrl = PROXY_CONFIG[prefix as keyof typeof PROXY_CONFIG];
      matchedPrefix = prefix;
      break;
    }
  }

  // 如果找到了匹配的规则
  if (targetBaseUrl && matchedPrefix) {
    const remainingPath = path.substring(matchedPrefix.length);
    const targetUrlString = targetBaseUrl.replace(/\/$/, '') + remainingPath;
    const targetUrl = new URL(targetUrlString);

    // 二次验证：确保目标域名在白名单内（防止配置错误）
    if (!ALLOWED_DOMAINS.has(targetUrl.host)) {
      return new Response(`目标域名 ${targetUrl.host} 不在允许列表内`, { 
        status: 403,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain;charset=UTF-8'
        }
      });
    }

    targetUrl.search = url.search;

    context.log(`Proxying "${path}" to "${targetUrl.toString()}"`);

    try {
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
      });

      proxyRequest.headers.set("Host", targetUrl.host);
      
      const clientIp = context.ip || request.headers.get('x-nf-client-connection-ip') || "";
      proxyRequest.headers.set('X-Forwarded-For', clientIp);
      proxyRequest.headers.set('X-Forwarded-Host', url.host);
      proxyRequest.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
      
      proxyRequest.headers.delete('accept-encoding');
      
      const referer = request.headers.get('referer');
      if (referer) {
        try {
          const refUrl = new URL(referer);
          const newReferer = `${targetUrl.protocol}//${targetUrl.host}${refUrl.pathname}${refUrl.search}`;
          proxyRequest.headers.set('referer', newReferer);
        } catch(e) {}
      } else {
        proxyRequest.headers.set('referer', `${targetUrl.protocol}//${targetUrl.host}/`);
      }
      
      const response = await fetch(proxyRequest);
      
      const contentType = response.headers.get('content-type') || '';
      
      let newResponse: Response;
      
      const needsRewrite = HTML_CONTENT_TYPES.some(type => contentType.includes(type)) || 
                           CSS_CONTENT_TYPES.some(type => contentType.includes(type)) ||
                           JS_CONTENT_TYPES.some(type => contentType.includes(type));
                           
      if (needsRewrite) {
        const clonedResponse = response.clone();
        let content = await clonedResponse.text();
        
        const targetDomain = targetUrl.host;
        const targetOrigin = targetUrl.origin;
        const targetPathBase = targetUrl.pathname.substring(0, targetUrl.pathname.lastIndexOf('/') + 1);
        
        // HTML 路径替换逻辑（保留原有逻辑，适配新域名）
        if (HTML_CONTENT_TYPES.some(type => contentType.includes(type))) {
          content = content.replace(
            new RegExp(`(href|src|action|content)=["']https?://${targetDomain}(/[^"']*?)["']`, 'gi'),
            `$1="${url.origin}${matchedPrefix}$2"`
          );
          
          content = content.replace(
            new RegExp(`(href|src|action|content)=["']//${targetDomain}(/[^"']*?)["']`, 'gi'),
            `$1="${url.origin}${matchedPrefix}$2"`
          );
          
          content = content.replace(
            new RegExp(`(href|src|action|content)=["'](/[^"']*?)["']`, 'gi'),
            `$1="${url.origin}${matchedPrefix}$2"`
          );
          
          content = content.replace(
            new RegExp(`url\\(['"]?https?://${targetDomain}(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          content = content.replace(
            new RegExp(`url\\(['"]?//${targetDomain}(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          content = content.replace(
            new RegExp(`url\\(['"]?(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          content = content.replace(
            new RegExp(`<base[^>]*href=["']https?://${targetDomain}(?:/[^"']*?)?["'][^>]*>`, 'gi'),
            `<base href="${url.origin}${matchedPrefix}/">`
          );
          
          content = content.replace(
            /(href|src|action|data-src|data-href)=["']((?!https?:\/\/|\/\/|\/)[^"']+)["']/gi,
            `$1="${url.origin}${matchedPrefix}/${targetPathBase}$2"`
          );
          
          // 应用特定网站的替换规则
          if (SPECIAL_REPLACEMENTS[targetDomain as keyof typeof SPECIAL_REPLACEMENTS]) {
            const replacements = SPECIAL_REPLACEMENTS[targetDomain as keyof typeof SPECIAL_REPLACEMENTS];
            for (const replacement of replacements) {
              content = content.replace(replacement.pattern, replacement.replacement as any);
            }
          }
          
          // 动态修复脚本（适配新路径）
          const fixScript = `
          <script>
          (function() {
            const observer = new MutationObserver(function(mutations) {
              mutations.forEach(function(mutation) {
                if (mutation.type === 'childList') {
                  mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) {
                      const elements = node.querySelectorAll('script[src], link[href], img[src], a[href], [data-src], [data-href]');
                      elements.forEach(function(el) {
                        ['src', 'href', 'data-src', 'data-href'].forEach(function(attr) {
                          if (el.hasAttribute(attr)) {
                            let val = el.getAttribute(attr);
                            if (val && !val.match(/^(https?:|\/\/|${url.origin})/)) {
                              if (val.startsWith('/')) {
                                el.setAttribute(attr, '${url.origin}${matchedPrefix}' + val);
                              }
                            }
                          }
                        });
                      });
                      
                      const elementsWithStyle = node.querySelectorAll('[style*="url("]');
                      elementsWithStyle.forEach(function(el) {
                        let style = el.getAttribute('style');
                        if (style) {
                          style = style.replace(/url\\(['"]?(\\/[^)'"]*?)['"]?\\)/gi, 
                                               'url(${url.origin}${matchedPrefix}$1)');
                          el.setAttribute('style', style);
                        }
                      });
                    }
                  });
                }
              });
            });
            
            observer.observe(document.body, {
              childList: true,
              subtree: true
            });
          })();
          </script>
          `;
          
          const bodyCloseTagPos = content.lastIndexOf('</body>');
          if (bodyCloseTagPos !== -1) {
            content = content.substring(0, bodyCloseTagPos) + fixScript + content.substring(bodyCloseTagPos);
          } else {
            content += fixScript;
          }
        }
        
        // CSS 路径替换
        if (CSS_CONTENT_TYPES.some(type => contentType.includes(type))) {
          content = content.replace(
            new RegExp(`url\\(['"]?https?://${targetDomain}(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          content = content.replace(
            new RegExp(`url\\(['"]?//${targetDomain}(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          content = content.replace(
            new RegExp(`url\\(['"]?(/[^)'"]*?)['"]?\\)`, 'gi'),
            `url(${url.origin}${matchedPrefix}$1)`
          );
          
          const cssPath = targetUrl.pathname;
          const cssDir = cssPath.substring(0, cssPath.lastIndexOf('/') + 1);
          
          content = content.replace(
            /url\(['"]?(?!https?:\/\/|\/\/|\/|data:|\#)([^)'"]*)['"]?\)/gi,
            `url(${url.origin}${matchedPrefix}${cssDir}$1)`
          );
        }
        
        // JS 路径替换
        if (JS_CONTENT_TYPES.some(type => contentType.includes(type))) {
          content = content.replace(
            new RegExp(`(['"])https?://${targetDomain}(/[^'"]*?)(['"])`, 'gi'),
            `$1${url.origin}${matchedPrefix}$2$3`
          );
          
          content = content.replace(
            new RegExp(`(['"])//${targetDomain}(/[^'"]*?)(['"])`, 'gi'),
            `$1${url.origin}${matchedPrefix}$2$3`
          );
          
          content = content.replace(
            /(['"])(\/[^'"]*?\.(?:js|css|png|jpg|jpeg|gif|svg|webp|ico|mp3|mp4|webm|ogg|woff|woff2|ttf|eot))(['"])/gi,
            `$1${url.origin}${matchedPrefix}$2$3`
          );
        }
        
        newResponse = new Response(content, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } else {
        newResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
      
      // 添加 CORS 头
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Range');
      
      // 移除安全头部
      newResponse.headers.delete('Content-Security-Policy');
      newResponse.headers.delete('Content-Security-Policy-Report-Only');
      newResponse.headers.delete('X-Frame-Options');
      newResponse.headers.delete('X-Content-Type-Options');
      
      // 缓存控制
      if (HTML_CONTENT_TYPES.some(type => contentType.includes(type))) {
        newResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        newResponse.headers.set('Pragma', 'no-cache');
        newResponse.headers.set('Expires', '0');
      } else {
        newResponse.headers.set('Cache-Control', 'public, max-age=86400');
      }
      
      // 处理重定向（验证重定向域名）
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
          const location = response.headers.get('location')!;
          const redirectedUrl = new URL(location, targetUrl);

          if (!ALLOWED_DOMAINS.has(redirectedUrl.host)) {
            return new Response(`重定向目标域名 ${redirectedUrl.host} 不在允许列表内`, { 
              status: 403,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'text/plain;charset=UTF-8'
              }
            });
          }
          
          const newLocation = url.origin + matchedPrefix + redirectedUrl.pathname + redirectedUrl.search;
          newResponse.headers.set('Location', newLocation);
      }
      
      return newResponse;

    } catch (error) {
      context.log("Error fetching target URL:", error);
      return new Response("代理请求失败", { 
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain;charset=UTF-8'
        }
      });
    }
  }

  // 无匹配规则时返回
  return;
};

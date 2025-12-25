export const config = {
    runtime: 'edge', // 必须使用 Edge Runtime
};

const dockerHub = "https://registry-1.docker.io";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const MODE = process.env.MODE || "production";

// 路由映射表
const routes = {
    [`docker.${CUSTOM_DOMAIN}`]: dockerHub,
    [`quay.${CUSTOM_DOMAIN}`]: "https://quay.io",
    [`gcr.${CUSTOM_DOMAIN}`]: "https://gcr.io",
    [`k8s-gcr.${CUSTOM_DOMAIN}`]: "https://k8s.gcr.io",
    [`k8s.${CUSTOM_DOMAIN}`]: "https://registry.k8s.io",
    [`ghcr.${CUSTOM_DOMAIN}`]: "https://ghcr.io",
    [`cloudsmith.${CUSTOM_DOMAIN}`]: "https://docker.cloudsmith.io",
    [`ecr.${CUSTOM_DOMAIN}`]: "https://public.ecr.aws",
};

export default async function handler(request) {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const upstream = routes[hostname] || "";

    // 1. 检查目标后端是否存在
    if (!upstream) {
        return new Response(JSON.stringify({
            message: "Host Not Found",
            hostname,
            tip: "请检查环境变量 CUSTOM_DOMAIN 配置是否正确"
        }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 2. 首页重定向
    if (url.pathname === "/") {
        return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    // 3. 处理 Token 认证请求 (/v2/auth)
    if (url.pathname === "/v2/auth") {
        return await handleAuth(upstream, url, authorization, isDockerHub);
    }

    // 4. DockerHub Library 路径自动补全 (例如 nginx -> library/nginx)
    let currentPath = url.pathname;
    if (isDockerHub) {
        const pathParts = currentPath.split("/");
        // 匹配 /v2/xxxxx/manifests/... 或 /v2/xxxxx/blobs/...
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            const redirectUrl = new URL(url);
            pathParts.splice(2, 0, "library");
            redirectUrl.pathname = pathParts.join("/");
            return Response.redirect(redirectUrl, 301);
        }
    }

    // 5. 构造转发请求
    const targetUrl = new URL(upstream + currentPath + url.search);
    const newReq = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        redirect: "manual", // 手动处理重定向以控制 Header
    });

    const resp = await fetch(newReq);

    // 6. 处理后端重定向 (主要针对 DockerHub 的 Blob 下载地址)
    if ([301, 302, 307, 308].includes(resp.status)) {
        const location = resp.headers.get("Location");
        if (location) {
            const blobResp = await fetch(location, {
                method: request.method,
                headers: { "Authorization": authorization || "" },
                redirect: "follow"
            });
            return await fixResponse(blobResp, request.method);
        }
    }

    // 7. 处理 401 Unauthorized，引导客户端去我们的 /v2/auth 获取 Token
    if (resp.status === 401) {
        return responseUnauthorized(url);
    }

    // 8. 正常响应修复
    return await fixResponse(resp, request.method);
}

/**
 * 核心修复函数：解决 Docker 报错 Content-Length 缺失的问题
 */
async function fixResponse(resp, originalMethod) {
    const newHeaders = new Headers(resp.headers);

    // 注入 Docker 规范要求的版本头
    newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Expose-Headers", "Docker-Content-Digest, Content-Length");

    // 提取原始 Content-Length
    const contentLength = resp.headers.get("content-length");

    // 针对 Manifest (JSON) 文件：
    // 必须读取整个 body 为 ArrayBuffer 才能让 Vercel 知道确切长度，从而避免发送 chunked 编码
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("manifest")) {
        const body = await resp.arrayBuffer();
        const actualLength = body.byteLength.toString();

        newHeaders.set("Content-Length", actualLength);

        // 如果是 HEAD 请求，根据规范不返回 body，但必须带上 Content-Length
        if (originalMethod === "HEAD") {
            return new Response(null, { status: resp.status, headers: newHeaders });
        }
        return new Response(body, { status: resp.status, headers: newHeaders });
    }

    // 针对 Blob 或其他流数据
    if (contentLength) {
        newHeaders.set("Content-Length", contentLength);
    }

    if (originalMethod === "HEAD") {
        return new Response(null, { status: resp.status, headers: newHeaders });
    }

    return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

/**
 * 处理 Token 获取逻辑
 */
async function handleAuth(upstream, url, authorization, isDockerHub) {
    const checkUrl = new URL(upstream + "/v2/");
    const resp = await fetch(checkUrl.toString(), { method: "GET", redirect: "follow" });

    if (resp.status !== 401) return resp;

    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (!authenticateStr) return resp;

    // 正则解析 realm (认证服务器地址) 和 service
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (!matches || matches.length < 2) return resp;

    const realm = matches[0];
    const service = matches[1];

    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set("service", service);

    let scope = url.searchParams.get("scope");
    // DockerHub 范围修正
    if (scope && isDockerHub) {
        let scopeParts = scope.split(":");
        if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
            scopeParts[1] = "library/" + scopeParts[1];
            scope = scopeParts.join(":");
        }
    }
    if (scope) tokenUrl.searchParams.set("scope", scope);

    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);

    // 向真实的 Auth 服务器请求 Token
    return await fetch(tokenUrl.toString(), { method: "GET", headers });
}

/**
 * 构造 401 响应，指引 Docker 客户端访问我们的代理由此获取 Token
 */
function responseUnauthorized(url) {
    const headers = new Headers();
    const authRealm = `https://${url.hostname}/v2/auth`;
    headers.set("Www-Authenticate", `Bearer realm="${authRealm}",service="vercel-docker-proxy"`);
    headers.set("Content-Type", "application/json");

    return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
        status: 401,
        headers,
    });
}
export const config = {
    runtime: 'edge', // 必须使用 Edge Runtime
};

const dockerHub = "https://registry-1.docker.io";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;

// 路由映射
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
    const upstream = routes[url.hostname];

    // 1. 基础检查
    if (!upstream) {
        return new Response(JSON.stringify({ error: "Host Not Found", hostname: url.hostname }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 2. 首页
    if (url.pathname === "/") {
        return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    // 3. 认证处理 (/v2/auth)
    if (url.pathname === "/v2/auth") {
        return await handleAuth(upstream, url, authorization, isDockerHub);
    }

    // 4. DockerHub Library 补全 (nginx -> library/nginx)
    let currentPath = url.pathname;
    if (isDockerHub) {
        const pathParts = currentPath.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            pathParts.splice(2, 0, "library");
            currentPath = pathParts.join("/");
        }
    }

    // 5. 向上游发起请求
    // 核心黑科技：无论客户端发的是 HEAD 还是 GET，我们都发 GET 到上游
    // 只有这样我们才能拿到 Body 并计算出精确的 Content-Length
    const targetUrl = new URL(upstream + currentPath + url.search);
    const newReq = new Request(targetUrl, {
        method: "GET",
        headers: request.headers,
        redirect: "follow",
    });

    const resp = await fetch(newReq);

    // 6. 处理 401 状态
    if (resp.status === 401) {
        return responseUnauthorized(url);
    }

    // 7. 强制转换响应，注入 Content-Length
    return await forceContentLength(resp, request.method);
}

/**
 * 核心对抗逻辑：强制 Vercel 吐出 Content-Length
 */
async function forceContentLength(resp, originalMethod) {
    const newHeaders = new Headers(resp.headers);
    newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    // 将 Body 读取为二进制数组，这是为了获取确切的字节长度
    const body = await resp.arrayBuffer();
    const uint8Body = new Uint8Array(body);

    // 显式写入 Content-Length
    newHeaders.set("Content-Length", uint8Body.byteLength.toString());
    // 移除可能干扰的头
    newHeaders.delete("transfer-encoding");

    // 关键：即便原始请求是 HEAD，我们也给 Vercel 返回一个带 Body 的 Response。
    // Vercel 的边缘节点会自动根据 HEAD 请求剥离 Body，但会保留我们手动设置的 Content-Length。
    return new Response(uint8Body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
    });
}

/**
 * 针对 401 的特殊处理 (必须带 Content-Length)
 */
function responseUnauthorized(url) {
    const bodyText = JSON.stringify({ message: "UNAUTHORIZED" });
    const uint8Body = new TextEncoder().encode(bodyText);

    const headers = new Headers();
    headers.set("Www-Authenticate", `Bearer realm="https://${url.hostname}/v2/auth",service="vercel-docker-proxy"`);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Length", uint8Body.byteLength.toString());
    headers.set("Docker-Distribution-Api-Version", "registry/2.0");

    return new Response(uint8Body, {
        status: 401,
        headers: headers,
    });
}

/**
 * 处理 Token 获取
 */
async function handleAuth(upstream, url, authorization, isDockerHub) {
    const checkUrl = new URL(upstream + "/v2/");
    const resp = await fetch(checkUrl.toString(), { method: "GET", redirect: "follow" });
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (!authenticateStr) return resp;

    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (!matches || matches.length < 2) return resp;

    const tokenUrl = new URL(matches[0]);
    if (matches[1]) tokenUrl.searchParams.set("service", matches[1]);

    let scope = url.searchParams.get("scope");
    if (scope && isDockerHub) {
        let parts = scope.split(":");
        if (parts.length === 3 && !parts[1].includes("/")) {
            parts[1] = "library/" + parts[1];
            scope = parts.join(":");
        }
    }
    if (scope) tokenUrl.searchParams.set("scope", scope);

    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);

    return await fetch(tokenUrl.toString(), { method: "GET", headers });
}
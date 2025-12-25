export const config = {
    runtime: 'edge',
};

const dockerHub = "https://registry-1.docker.io";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;

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

    if (!upstream) {
        return new Response(JSON.stringify({ error: "Host Not Found" }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 1. 处理首页重定向 (301 本身不需要 Content-Length，但我们保证它规范)
    if (url.pathname === "/") {
        return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    // 2. 认证逻辑处理
    if (url.pathname === "/v2/auth") {
        const authResp = await handleAuth(upstream, url, authorization, isDockerHub);
        return await fixResponse(authResp, request.method);
    }

    // 3. DockerHub 路径补全
    let currentPath = url.pathname;
    if (isDockerHub) {
        const pathParts = currentPath.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            pathParts.splice(2, 0, "library");
            currentPath = pathParts.join("/");
        }
    }

    // 4. 发起上游请求 (强制 GET)
    const targetUrl = new URL(upstream + currentPath + url.search);
    const newReq = new Request(targetUrl, {
        method: "GET",
        headers: request.headers,
        redirect: "follow",
    });

    const resp = await fetch(newReq);

    // 5. 如果是 401，返回我们自己构造的、带长度的 401
    if (resp.status === 401) {
        return responseUnauthorized(url);
    }

    // 6. 所有响应都强制注入 Content-Length
    return await fixResponse(resp, request.method);
}

/**
 * 极其严格的响应头修复
 */
async function fixResponse(resp, originalMethod) {
    const newHeaders = new Headers(resp.headers);
    newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    // 必须读取为 ArrayBuffer，确保我们知道确切字节数
    const body = await resp.arrayBuffer();
    const uint8Body = new Uint8Array(body);

    newHeaders.set("Content-Length", uint8Body.byteLength.toString());
    // 强行删除分块传输标志
    newHeaders.delete("transfer-encoding");
    newHeaders.set("Connection", "keep-alive");

    // 即使是 HEAD，我们也给 Vercel 返回 Body，让它自己去剥离，但保留我们的 Header
    return new Response(uint8Body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: newHeaders,
    });
}

function responseUnauthorized(url) {
    const bodyText = JSON.stringify({ message: "UNAUTHORIZED" });
    const uint8Body = new TextEncoder().encode(bodyText);

    const headers = new Headers();
    headers.set("Www-Authenticate", `Bearer realm="https://${url.hostname}/v2/auth",service="vercel-docker-proxy"`);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Content-Length", uint8Body.byteLength.toString());
    headers.set("Docker-Distribution-Api-Version", "registry/2.0");

    return new Response(uint8Body, { status: 401, headers });
}

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
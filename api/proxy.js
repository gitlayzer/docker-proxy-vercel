export const config = {
    // 指定使用 Edge Runtime
    runtime: 'edge',
};

// 定义 Docker Hub 的 URL
const dockerHub = "https://registry-1.docker.io";

// 从环境变量获取配置
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const MODE = process.env.MODE || "production";
const TARGET_UPSTREAM = process.env.TARGET_UPSTREAM || "";

const routes = {
    [`docker.${CUSTOM_DOMAIN}`]: dockerHub,
    [`quay.${CUSTOM_DOMAIN}`]: "https://quay.io",
    [`gcr.${CUSTOM_DOMAIN}`]: "https://gcr.io",
    [`k8s-gcr.${CUSTOM_DOMAIN}`]: "https://k8s.gcr.io",
    [`k8s.${CUSTOM_DOMAIN}`]: "https://registry.k8s.io",
    [`ghcr.${CUSTOM_DOMAIN}`]: "https://ghcr.io",
    [`cloudsmith.${CUSTOM_DOMAIN}`]: "https://docker.cloudsmith.io",
    [`ecr.${CUSTOM_DOMAIN}`]: "https://public.ecr.aws",
    [`docker-staging.${CUSTOM_DOMAIN}`]: dockerHub,
};

export default async function handler(request) {
    const url = new URL(request.url);
    const upstream = routes[url.hostname] || "";

    if (!upstream) {
        return new Response(JSON.stringify({ message: "Host Not Found", routes }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 1. 处理 Auth 逻辑 (略，保持之前的逻辑)
    if (url.pathname === "/v2/auth") {
        return handleAuth(upstream, url, authorization, isDockerHub);
    }

    // 2. 构造转发请求
    let targetUrl = upstream + url.pathname + url.search;

    // DockerHub Library 补全逻辑
    if (isDockerHub) {
        const pathParts = url.pathname.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2") {
            const redirectUrl = new URL(url);
            pathParts.splice(2, 0, "library");
            redirectUrl.pathname = pathParts.join("/");
            return Response.redirect(redirectUrl, 301);
        }
    }

    const newReq = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        redirect: "manual", // 必须手动处理重定向以控制 Header
    });

    let resp = await fetch(newReq);

    // 3. 处理重定向 (特别是 DockerHub 的 Blob 重定向)
    if ([301, 302, 307, 308].includes(resp.status)) {
        const location = resp.headers.get("Location");
        if (location) {
            const blobResp = await fetch(location, {
                method: request.method,
                headers: { "Authorization": authorization || "" },
                redirect: "follow"
            });
            return fixResponse(blobResp);
        }
    }

    if (resp.status === 401) return responseUnauthorized(url);

    return fixResponse(resp);
}

/**
 * 核心修复函数：确保 Content-Length 和关键 Header 不丢失
 */
async function fixResponse(resp) {
    const newHeaders = new Headers(resp.headers);

    // 必须包含的版本头
    newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");
    // 允许跨域
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Expose-Headers", "Docker-Content-Digest, Content-Length");

    // 如果是 HEAD 请求，Vercel 可能会丢弃 Content-Length
    // 我们从原始响应中提取并强制写回
    const contentLength = resp.headers.get("content-length");
    if (contentLength) {
        newHeaders.set("Content-Length", contentLength);
    }

    // 针对 Manifest 请求 (通常是 JSON)，我们将其转为 ArrayBuffer
    // 这样 Vercel 就不再将其视为 Stream，从而自动加上正确的 Content-Length
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("manifest")) {
        const body = await resp.arrayBuffer();
        return new Response(body, {
            status: resp.status,
            headers: newHeaders,
        });
    }

    // 对于 Blob (大文件)，保持流式传输，但带上强制的 Content-Length
    return new Response(resp.body, {
        status: resp.status,
        headers: newHeaders,
    });
}

// 辅助函数 (保持逻辑一致)
function parseAuthenticate(authenticateStr) {
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (!matches || matches.length < 2) throw new Error("Invalid Www-Authenticate Header");
    return { realm: matches[0], service: matches[1] };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
    const url = new URL(wwwAuthenticate.realm);
    if (wwwAuthenticate.service) url.searchParams.set("service", wwwAuthenticate.service);
    if (scope) url.searchParams.set("scope", scope);

    const headers = new Headers();
    if (authorization) headers.set("Authorization", authorization);
    return await fetch(url.toString(), { method: "GET", headers });
}

function responseUnauthorized(url) {
    const headers = new Headers();
    const realm = `${MODE === "debug" ? "http" : "https"}://${url.host}/v2/auth`;
    headers.set("Www-Authenticate", `Bearer realm="${realm}",service="vercel-docker-proxy"`);

    return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
        status: 401,
        headers,
    });
}
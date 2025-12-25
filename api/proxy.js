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
    const hostname = url.hostname;
    const upstream = routes[hostname] || "";

    if (!upstream) {
        return new Response(JSON.stringify({ message: "Host Not Found", hostname, routes }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 1. 处理首页
    if (url.pathname === "/") {
        return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    // 2. 处理 Auth 逻辑 (修复 ReferenceError)
    if (url.pathname === "/v2/auth") {
        return await handleAuth(upstream, url, authorization, isDockerHub);
    }

    // 3. DockerHub Library 路径自动重定向 (针对没有 library/ 前缀的情况)
    if (isDockerHub) {
        const pathParts = url.pathname.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            const redirectUrl = new URL(url);
            pathParts.splice(2, 0, "library");
            redirectUrl.pathname = pathParts.join("/");
            return Response.redirect(redirectUrl, 301);
        }
    }

    // 4. 转发请求
    const targetUrl = new URL(upstream + url.pathname + url.search);
    const newReq = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
    });

    const resp = await fetch(newReq);

    // 5. 处理重定向 (特别是 DockerHub 的 Blob 下载地址)
    if ([301, 302, 307, 308].includes(resp.status)) {
        const location = resp.headers.get("Location");
        if (location) {
            const blobResp = await fetch(location, {
                method: "GET",
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
    newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");
    newHeaders.set("Access-Control-Allow-Origin", "*");

    // 关键：强制保留 Content-Length，防止 Vercel 转为 chunked 编码导致 Docker 报错
    const contentLength = resp.headers.get("content-length");
    if (contentLength) {
        newHeaders.set("Content-Length", contentLength);
    }

    // 针对 Manifest (JSON) 类型，读取 buffer 强制触发 Vercel 计算长度
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("manifest")) {
        const body = await resp.arrayBuffer();
        return new Response(body, { status: resp.status, headers: newHeaders });
    }

    return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

/**
 * 处理 Token 获取
 */
async function handleAuth(upstream, url, authorization, isDockerHub) {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), { method: "GET", redirect: "follow" });

    if (resp.status !== 401) return resp;

    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (!authenticateStr) return resp;

    // 解析 realm 和 service
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (!matches || matches.length < 2) return resp;

    const realm = matches[0];
    const service = matches[1];

    const tokenUrl = new URL(realm);
    if (service) tokenUrl.searchParams.set("service", service);

    let scope = url.searchParams.get("scope");
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

    return await fetch(tokenUrl.toString(), { method: "GET", headers });
}

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
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

// 根据 host 路由到不同的 upstream
function routeByHosts(host) {
    if (host in routes) return routes[host];
    if (MODE === "debug") return TARGET_UPSTREAM;
    return "";
}

// 核心处理函数
export default async function handler(request) {
    const url = new URL(request.url);

    // 首页重定向
    if (url.pathname === "/") {
        return Response.redirect(`${url.protocol}//${url.host}/v2/`, 301);
    }

    const upstream = routeByHosts(url.hostname);
    if (!upstream) {
        return new Response(JSON.stringify({ routes }), { status: 404 });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = request.headers.get("Authorization");

    // 1. 处理 /v2/ 根路径认证检查
    if (url.pathname === "/v2/") {
        const newUrl = new URL(upstream + "/v2/");
        const headers = new Headers();
        if (authorization) headers.set("Authorization", authorization);

        const resp = await fetch(newUrl.toString(), {
            method: "GET",
            headers: headers,
            redirect: "follow",
        });

        if (resp.status === 401) return responseUnauthorized(url);
        return resp;
    }

    // 2. 处理 Token 获取
    if (url.pathname === "/v2/auth") {
        const newUrl = new URL(upstream + "/v2/");
        const resp = await fetch(newUrl.toString(), { method: "GET", redirect: "follow" });

        if (resp.status !== 401) return resp;

        const authenticateStr = resp.headers.get("WWW-Authenticate");
        if (!authenticateStr) return resp;

        const wwwAuthenticate = parseAuthenticate(authenticateStr);
        let scope = url.searchParams.get("scope");

        // DockerHub library 镜像补全
        if (scope && isDockerHub) {
            let scopeParts = scope.split(":");
            if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
                scopeParts[1] = "library/" + scopeParts[1];
                scope = scopeParts.join(":");
            }
        }
        return await fetchToken(wwwAuthenticate, scope, authorization);
    }

    // 3. DockerHub library 镜像路径重定向
    if (isDockerHub) {
        const pathParts = url.pathname.split("/");
        if (pathParts.length === 5) {
            pathParts.splice(2, 0, "library");
            const redirectUrl = new URL(url);
            redirectUrl.pathname = pathParts.join("/");
            return Response.redirect(redirectUrl, 301);
        }
    }

    // 4. 转发普通请求
    const newUrl = new URL(upstream + url.pathname + url.search);
    const newReq = new Request(newUrl, {
        method: request.method,
        headers: request.headers,
        redirect: isDockerHub ? "manual" : "follow",
    });

    const resp = await fetch(newReq);

    if (resp.status === 401) {
        return responseUnauthorized(url);
    }

    // 5. 关键修复：手动处理 DockerHub Blob 重定向
    if (isDockerHub && (resp.status === 301 || resp.status === 302 || resp.status === 307)) {
        const location = resp.headers.get("Location");
        if (location) {
            const blobResp = await fetch(location, {
                method: "GET",
                redirect: "follow",
            });

            // 构造新的 Header，确保 Content-Length 等关键信息不丢失
            const newHeaders = new Headers(blobResp.headers);
            newHeaders.set("Access-Control-Allow-Origin", "*");

            // 必须确保 Docker-Distribution-Api-Version 存在
            newHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");

            return new Response(blobResp.body, {
                status: blobResp.status,
                statusText: blobResp.statusText,
                headers: newHeaders,
            });
        }
    }

    // 6. 普通响应也需要确保 Header 透传
    const finalHeaders = new Headers(resp.headers);
    finalHeaders.set("Docker-Distribution-Api-Version", "registry/2.0");

    return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: finalHeaders,
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
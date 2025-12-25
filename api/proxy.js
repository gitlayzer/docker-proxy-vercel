const fetch = require('node-fetch');

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

module.exports = async (req, res) => {
    const host = req.headers.host;
    const upstream = routes[host];

    if (!upstream) {
        return res.status(404).json({ error: "Host Not Found", host });
    }

    const isDockerHub = upstream === dockerHub;
    const authorization = req.headers.authorization;

    // 1. 处理首页跳转
    if (req.url === "/" || req.url === "") {
        res.setHeader('Location', '/v2/');
        return res.status(301).end();
    }

    // 2. 处理 Token 认证 (v2/auth)
    if (req.url.startsWith("/v2/auth")) {
        return await handleAuth(upstream, req, res, isDockerHub);
    }

    // 3. 构造上游路径
    let targetPath = req.url;
    if (isDockerHub) {
        const pathParts = targetPath.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            pathParts.splice(2, 0, "library");
            targetPath = pathParts.join("/");
        }
    }

    // 4. 转发请求到上游
    const targetUrl = upstream + targetPath;

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: filterHeaders(req.headers),
            redirect: 'manual'
        });

        // 处理重定向 (特别是 DockerHub 的 Blob 下载)
        if ([301, 302, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (location) {
                // 如果是重定向到存储桶，直接重定向让客户端自己下载，或者再次代理
                res.setHeader('Location', location);
                return res.status(response.status).end();
            }
        }

        // 处理 401
        if (response.status === 401) {
            return responseUnauthorized(res, host);
        }

        // 5. 核心修复：手动读取 Body 并设置 Content-Length
        const body = await response.buffer();

        // 复制所有上游 Header
        response.headers.forEach((value, key) => {
            // 跳过可能导致冲突的编码头
            if (['transfer-encoding', 'content-encoding', 'connection'].includes(key.toLowerCase())) return;
            res.setHeader(key, value);
        });

        // 强制设置关键 Header
        res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
        res.setHeader('Content-Length', body.length);
        res.setHeader('Access-Control-Allow-Origin', '*');

        // 发送响应
        return res.status(response.status).send(body);

    } catch (error) {
        console.error("Proxy Error:", error);
        return res.status(500).end("Internal Server Error");
    }
};

/**
 * 认证逻辑
 */
async function handleAuth(upstream, req, res, isDockerHub) {
    const resp = await fetch(upstream + "/v2/", { method: "GET" });
    const authHeader = resp.headers.get("www-authenticate");
    if (!authHeader) return res.status(resp.status).end();

    const matches = authHeader.match(/(?<=\=")(?:\\.|[^"\\])*(?=")/g);
    if (!matches || matches.length < 2) return res.status(401).end();

    const realm = matches[0];
    const service = matches[1];

    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenUrl = new URL(realm);
    tokenUrl.searchParams.set("service", service);

    let scope = url.searchParams.get("scope");
    if (scope && isDockerHub) {
        let parts = scope.split(":");
        if (parts.length === 3 && !parts[1].includes("/")) {
            parts[1] = "library/" + parts[1];
            scope = parts.join(":");
        }
    }
    if (scope) tokenUrl.searchParams.set("scope", scope);

    const tokenResp = await fetch(tokenUrl.toString(), {
        headers: req.headers.authorization ? { 'Authorization': req.headers.authorization } : {}
    });

    const body = await tokenResp.buffer();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', body.length);
    return res.status(tokenResp.status).send(body);
}

/**
 * 构造统一的 401 响应
 */
function responseUnauthorized(res, host) {
    const body = JSON.stringify({ message: "UNAUTHORIZED" });
    res.setHeader('Www-Authenticate', `Bearer realm="https://${host}/v2/auth",service="vercel-docker-proxy"`);
    res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    return res.status(401).send(body);
}

function filterHeaders(headers) {
    const out = {};
    Object.keys(headers).forEach(key => {
        if (['host', 'connection'].includes(key.toLowerCase())) return;
        out[key] = headers[key];
    });
    return out;
}
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

/**
 * 助手函数：过滤请求头
 */
function filterHeaders(headers) {
    const out = {};
    Object.keys(headers).forEach(key => {
        // 必须移除 host 头，否则上游服务器会报 404/403
        if (['host', 'connection', 'content-length'].includes(key.toLowerCase())) return;
        out[key] = headers[key];
    });
    return out;
}

/**
 * 助手函数：构造 401 响应
 */
function responseUnauthorized(res, host) {
    const body = JSON.stringify({ message: "UNAUTHORIZED" });
    res.setHeader('Www-Authenticate', `Bearer realm="https://${host}/v2/auth",service="vercel-docker-proxy"`);
    res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.statusCode = 401;
    return res.end(body);
}

/**
 * 助手函数：处理 Auth
 */
async function handleAuth(upstream, req, res, host, isDockerHub) {
    const checkUrl = upstream + "/v2/";
    const resp = await fetch(checkUrl, { method: "GET" });
    const authHeader = resp.headers.get("www-authenticate");
    if (!authHeader) {
        res.statusCode = resp.status;
        return res.end();
    }

    const matches = authHeader.match(/(?<=\=")(?:\\.|[^"\\])*(?=")/g);
    if (!matches || matches.length < 2) {
        res.statusCode = 401;
        return res.end();
    }

    const realm = matches[0];
    const service = matches[1];
    const url = new URL(req.url, `https://${host}`);
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

    const arrayBuffer = await tokenResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', buffer.length);
    res.statusCode = tokenResp.status;
    return res.end(buffer);
}

// 主处理函数
module.exports = async (req, res) => {
    const host = req.headers.host;
    const upstream = routes[host];

    if (!upstream) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Host Not Found", host }));
    }

    const isDockerHub = upstream === dockerHub;

    // 1. 处理首页跳转
    if (req.url === "/" || req.url === "") {
        res.setHeader('Location', '/v2/');
        res.statusCode = 301;
        return res.end();
    }

    // 2. 处理 Auth 路径
    if (req.url.startsWith("/v2/auth")) {
        return await handleAuth(upstream, req, res, host, isDockerHub);
    }

    // 3. 构造路径
    let targetPath = req.url;
    if (isDockerHub) {
        const pathParts = targetPath.split("/");
        if (pathParts.length === 5 && pathParts[1] === "v2" && !pathParts[2].includes("/")) {
            pathParts.splice(2, 0, "library");
            targetPath = pathParts.join("/");
        }
    }

    // 4. 转发请求
    const targetUrl = upstream + targetPath;
    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: filterHeaders(req.headers),
            redirect: 'manual'
        });

        // 拦截 401
        if (response.status === 401) {
            return responseUnauthorized(res, host);
        }

        // 处理重定向
        if ([301, 302, 307, 308].includes(response.status)) {
            res.setHeader('Location', response.headers.get('location'));
            res.statusCode = response.status;
            return res.end();
        }

        // 读取内容并强制注入 Content-Length
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        response.headers.forEach((value, key) => {
            if (['transfer-encoding', 'content-encoding', 'connection', 'content-length'].includes(key.toLowerCase())) return;
            res.setHeader(key, value);
        });

        res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
        res.setHeader('Content-Length', buffer.length);
        res.setHeader('Access-Control-Allow-Origin', '*');

        res.statusCode = response.status;
        return res.end(buffer);

    } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
    }
};
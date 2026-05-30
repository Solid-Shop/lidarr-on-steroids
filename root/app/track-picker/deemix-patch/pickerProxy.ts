// Forward /picker-api/* requests to the loopback-only track-picker sidecar.
// Inserted into Deemix's Express app at image build time by the Dockerfile.
// Re-serializes parsed JSON bodies (express.json() has already run by this
// point in main.ts), so streaming isn't possible — but our payloads are tiny.
//
// Types are intentionally loose (`any`) — this file lands in Deemix's source tree
// at build time and we don't want a stricter Deemix tsconfig refusing to compile it.

import { request as httpRequest } from "http";

const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_PORT = 7171;

export function pickerProxy(req: any, res: any): void {
    let payload: string | null = null;
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
        payload = JSON.stringify(req.body);
    }

    const headers: any = { ...(req.headers || {}) };
    delete headers["content-length"];
    delete headers["host"];
    if (payload !== null) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(payload).toString();
    }

    const proxied = httpRequest(
        {
            host: SIDECAR_HOST,
            port: SIDECAR_PORT,
            method: req.method,
            // req.url here is the path *after* the /picker-api mount prefix
            // (Express strips the mount path). The sidecar's routes live under /api/*.
            path: "/api" + req.url,
            headers: headers,
        },
        (proxiedRes: any) => {
            res.writeHead(proxiedRes.statusCode || 502, proxiedRes.headers);
            proxiedRes.pipe(res);
        }
    );

    proxied.on("error", (err: Error) => {
        if (!res.headersSent) {
            res.status(502).json({ error: "track-picker sidecar unreachable", detail: err.message });
        } else {
            res.end();
        }
    });

    if (payload !== null) proxied.write(payload);
    proxied.end();
}

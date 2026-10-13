require("dotenv").config();

const http = require("http");
const https = require("https");
const httpProxy = require("http-proxy");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const TARGET_URL = process.env.TARGET_URL;
const CHECK_TARGET_HEALTH =
  String(process.env.CHECK_TARGET_HEALTH || "true").toLowerCase() === "true";

if (!TARGET_URL) {
  console.error("Falta TARGET_URL. Copia .env.example a .env y configura el destino.");
  process.exit(1);
}

let target;
try {
  target = new URL(TARGET_URL);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("TARGET_URL debe usar http:// o https://");
  }
} catch (error) {
  console.error("TARGET_URL no es una URL válida:", error.message);
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({
  target: target.origin,
  changeOrigin: true,
  xfwd: true,
  secure: true,
  proxyTimeout: 30000,
  timeout: 30000
});

proxy.on("proxyReq", (proxyReq, req) => {
  if (req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
});

proxy.on("error", (error, req, res) => {
  console.error(`[proxy] ${req.method} ${req.url}: ${error.message}`);
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: "bad_gateway",
      message: "No se pudo conectar con el backend configurado."
    }));
  } else if (res && !res.writableEnded) {
    res.end();
  }
});

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    if (!CHECK_TARGET_HEALTH) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ status: "ok", proxy: "running" }));
    }

    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: "/",
      method: "GET",
      timeout: 5000
    }, (upstreamRes) => {
      upstreamRes.resume();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        status: "ok",
        proxy: "running",
        targetReachable: true,
        targetStatusCode: upstreamRes.statusCode
      }));
    });

    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        status: "degraded",
        proxy: "running",
        targetReachable: false,
        message: error.message
      }));
    });
    return request.end();
  }

  const basePath = target.pathname.replace(/\/+$/, "");
  const incomingPath = req.url || "/";
  req.url = `${basePath}${incomingPath.startsWith("/") ? incomingPath : `/${incomingPath}`}`;
  proxy.web(req, res, { target: target.origin });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy escuchando en http://localhost:${PORT}`);
  console.log(`Destino configurado: ${target.origin}`);
  console.log("Endpoint de estado: /health");
});

process.on("SIGINT", () => {
  console.log("\\nCerrando proxy...");
  server.close(() => process.exit(0));
});

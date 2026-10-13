require("dotenv").config();

const http = require("http");
const httpProxy = require("http-proxy");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const TUNNEL_URL = process.env.TUNNEL_URL;
const ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

if (!TUNNEL_URL) {
  console.error("Missing TUNNEL_URL. Set it in Railway Variables.");
  process.exit(1);
}

let tunnel;
try {
  tunnel = new URL(TUNNEL_URL);
  if (!["http:", "https:"].includes(tunnel.protocol)) {
    throw new Error("TUNNEL_URL must use http:// or https://");
  }
} catch (error) {
  console.error("TUNNEL_URL is invalid:", error.message);
  process.exit(1);
}

if ((ACCESS_CLIENT_ID && !ACCESS_CLIENT_SECRET) ||
    (!ACCESS_CLIENT_ID && ACCESS_CLIENT_SECRET)) {
  console.error("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({
  target: tunnel.origin,
  changeOrigin: true,
  xfwd: true,
  secure: true,
  proxyTimeout: 60000,
  timeout: 60000
});

proxy.on("proxyReq", (proxyReq, req) => {
  // Optional Cloudflare Access service-token authentication.
  if (ACCESS_CLIENT_ID && ACCESS_CLIENT_SECRET) {
    proxyReq.setHeader("CF-Access-Client-Id", ACCESS_CLIENT_ID);
    proxyReq.setHeader("CF-Access-Client-Secret", ACCESS_CLIENT_SECRET);
  }

  if (req.headers.host) {
    proxyReq.setHeader("x-forwarded-host", req.headers.host);
  }
});

proxy.on("proxyRes", (proxyRes, req) => {
  console.log(`[proxy] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
});

proxy.on("error", (error, req, res) => {
  console.error(`[proxy] ${req.method} ${req.url}: ${error.message}`);

  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: "bad_gateway",
      message: "Railway could not reach the Tomcat service through Cloudflare Tunnel."
    }));
  } else if (res && !res.writableEnded) {
    res.end();
  }
});

const server = http.createServer((req, res) => {
  if (req.url === "/_proxy-health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      status: "ok",
      service: "railway-to-cloudflare-tomcat-proxy",
      tunnelHost: tunnel.host
    }));
  }

  // Preserve the incoming path and query string when forwarding to Tomcat.
  // Example: /workflow/api/login?x=1 remains /workflow/api/login?x=1.
  proxy.web(req, res, { target: tunnel.origin });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Railway proxy listening on port ${PORT}`);
  console.log(`Forwarding requests to Cloudflare Tunnel host: ${tunnel.host}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received; closing server.");
  server.close(() => process.exit(0));
});

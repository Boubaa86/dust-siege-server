import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const MESHY_API_KEY = process.env.MESHY_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://threed-game-asset-studio.onrender.com";
const API_BASE = "https://api.meshy.ai/openapi/v2/text-to-3d";
const requests = new Map();

function send(res, status, data, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin || ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 12000) {
        reject(new Error("Requête trop volumineuse"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}
function rateLimited(ip) {
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 6) return true;
  recent.push(now);
  requests.set(ip, recent);
  return false;
}
async function meshy(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${MESHY_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || data.error || `Meshy a répondu ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || ALLOWED_ORIGIN;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    });
    return res.end();
  }
  const url = new URL(req.url, "http://localhost");
  if (origin !== ALLOWED_ORIGIN && origin !== "http://localhost:3000") {
    return send(res, 403, { error: "Origine non autorisée." }, ALLOWED_ORIGIN);
  }
  if (url.pathname === "/health" && req.method === "GET") {
    return send(res, 200, { ok: true, meshyConfigured: Boolean(MESHY_API_KEY) }, origin);
  }
  if (!MESHY_API_KEY) {
    return send(res, 503, { error: "La clé API Meshy n'est pas encore configurée dans les variables secrètes Render." }, origin);
  }
  try {
    if (url.pathname === "/api/generate" && req.method === "POST") {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
      if (rateLimited(ip)) return send(res, 429, { error: "Trop de demandes. Réessaie dans une minute." }, origin);
      const body = await readBody(req);
      const prompt = String(body.prompt || "").trim();
      if (prompt.length < 8 || prompt.length > 600) {
        return send(res, 400, { error: "La description doit contenir entre 8 et 600 caractères." }, origin);
      }
      const result = await meshy("", {
        method: "POST",
        body: JSON.stringify({
          mode: "preview",
          prompt,
          model_type: "smart-topology",
          ai_model: "meshy-t2.5",
          target_polycount: 8000,
          topology: "triangle",
          target_formats: ["glb", "fbx"],
          moderation: true
        })
      });
      return send(res, 202, { taskId: result.result, stage: "preview" }, origin);
    }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
    if (taskMatch && req.method === "GET") {
      const result = await meshy("/" + encodeURIComponent(taskMatch[1]), { method: "GET" });
      return send(res, 200, result, origin);
    }
    if (url.pathname === "/api/refine" && req.method === "POST") {
      const body = await readBody(req);
      const previewTaskId = String(body.previewTaskId || "");
      if (!/^[\w-]{12,80}$/.test(previewTaskId)) {
        return send(res, 400, { error: "Identifiant de prévisualisation invalide." }, origin);
      }
      const result = await meshy("", {
        method: "POST",
        body: JSON.stringify({
          mode: "refine",
          preview_task_id: previewTaskId,
          target_formats: ["glb", "fbx"],
          moderation: true
        })
      });
      return send(res, 202, { taskId: result.result, stage: "refine" }, origin);
    }
    return send(res, 404, { error: "Route introuvable." }, origin);
  } catch (error) {
    const status = error.status || 502;
    return send(res, status, { error: error.message || "Erreur pendant la demande Meshy." }, origin);
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`3D Studio API listening on ${PORT}`));

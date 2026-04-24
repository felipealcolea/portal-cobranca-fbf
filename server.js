const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const USERS_PATH = path.join(ROOT, "users.json");
const DATA_PATH = path.join(ROOT, "data", "titulos.json");
const PROGRESS_PATH = path.join(ROOT, "data", "progress.json");
const CURRENT_UPLOAD_DIR = path.join(ROOT, "storage", "current-pdfs");
const STAGING_UPLOAD_DIR = path.join(ROOT, "storage", "incoming-pdfs");
const PYTHON_EXE = "C:\\Users\\felip\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const EXTRACT_SCRIPT = path.join(ROOT, "scripts", "extract_pdfs.py");

const sessions = new Map();

ensureDir(path.dirname(DATA_PATH));
ensureDir(CURRENT_UPLOAD_DIR);
ensureDir(STAGING_UPLOAD_DIR);
ensureJsonFile(PROGRESS_PATH, {});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Metodo nao permitido" });
      return;
    }

    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Erro interno" });
  }
});

server.listen(3000, () => {
  console.log("Portal disponivel em http://localhost:3000");
});

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    const users = readJson(USERS_PATH, []);
    const user = users.find((item) => item.username === body.username && item.password === body.password);
    if (!user) {
      sendJson(res, 401, { error: "Usuario ou senha invalidos" });
      return;
    }

    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { username: user.username, createdAt: Date.now() });
    setCookie(res, token);
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = getSessionToken(req);
    if (token) {
      sessions.delete(token);
    }
    clearCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  const user = requireUser(req, res);
  if (!user) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const dashboard = buildDashboardForUser(user);
    sendJson(res, 200, dashboard);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/progress/")) {
    const clientCode = url.pathname.split("/").pop();
    const body = await readJsonBody(req);
    const progress = readJson(PROGRESS_PATH, {});
    const ownerUsername = resolveProgressOwner(user, body.vendedor);
    const key = `${ownerUsername}:${clientCode}`;
    progress[key] = {
      status: body.status || "pendente",
      note: body.note || "",
      updatedAt: new Date().toISOString(),
    };
    writeJson(PROGRESS_PATH, progress);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/upload-data") {
    if (user.role !== "financeiro") {
      sendJson(res, 403, { error: "Apenas o financeiro pode atualizar a base" });
      return;
    }

    const body = await readJsonBody(req);
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) {
      sendJson(res, 400, { error: "Envie os PDFs do dia para atualizar a base" });
      return;
    }

    const validation = validateUploadFiles(files);
    if (!validation.ok) {
      sendJson(res, 400, { error: validation.message, details: validation });
      return;
    }

    ensureCleanDir(STAGING_UPLOAD_DIR);
    for (const file of files) {
      if (!String(file.name || "").toLowerCase().endsWith(".pdf")) {
        continue;
      }
      fs.writeFileSync(path.join(STAGING_UPLOAD_DIR, path.basename(file.name)), Buffer.from(file.contentBase64, "base64"));
    }

    await runExtractor(STAGING_UPLOAD_DIR, DATA_PATH);
    ensureCleanDir(CURRENT_UPLOAD_DIR);
    moveAllFiles(STAGING_UPLOAD_DIR, CURRENT_UPLOAD_DIR);
    ensureCleanDir(STAGING_UPLOAD_DIR);
    sendJson(res, 200, { message: "Base atualizada com sucesso. A versao anterior foi substituida." });
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada" });
}

function buildDashboardForUser(user) {
  const dataset = readJson(DATA_PATH, { meta: {}, vendedores: [] });
  const users = readJson(USERS_PATH, []);
  const progressMap = readJson(PROGRESS_PATH, {});

  let vendedores = dataset.vendedores || [];
  if (user.role !== "financeiro") {
    vendedores = vendedores.filter((item) => normalize(item.vendedor) === normalize(user.vendedor));
  }

  const vendedoresComProgresso = vendedores.map((vendedor) => ({
    ...vendedor,
    clientes: vendedor.clientes.map((cliente) => {
      const owner = users.find((item) => item.role === "vendedor" && normalize(item.vendedor) === normalize(vendedor.vendedor));
      const ownerKey = owner ? `${owner.username}:${cliente.codigo}` : `${user.username}:${cliente.codigo}`;
      const financeKey = `financeiro:${cliente.codigo}`;
      return {
        ...cliente,
        progresso: progressMap[ownerKey] || progressMap[financeKey] || { status: "pendente", note: "" },
      };
    }),
  }));

  return {
    meta: dataset.meta || {},
    vendedores: vendedoresComProgresso,
  };
}

function requireUser(req, res) {
  const token = getSessionToken(req);
  if (!token || !sessions.has(token)) {
    sendJson(res, 401, { error: "Sessao expirada" });
    return null;
  }

  const session = sessions.get(token);
  const users = readJson(USERS_PATH, []);
  const user = users.find((item) => item.username === session.username);
  if (!user) {
    sessions.delete(token);
    sendJson(res, 401, { error: "Usuario nao encontrado" });
    return null;
  }
  return user;
}

function sanitizeUser(user) {
  return {
    username: user.username,
    nome: user.nome,
    role: user.role,
    vendedor: user.vendedor || null,
  };
}

function resolveProgressOwner(user, vendedor) {
  if (user.role !== "financeiro") {
    return user.username;
  }

  const users = readJson(USERS_PATH, []);
  const owner = users.find(
    (item) => item.role === "vendedor" && normalize(item.vendedor) === normalize(vendedor)
  );
  return owner ? owner.username : user.username;
}

function serveStatic(res, pathname) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT, target);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, "Arquivo nao encontrado", "text/plain; charset=utf-8");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    writeJson(filePath, defaultValue);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function moveAllFiles(fromDir, toDir) {
  const entries = fs.readdirSync(fromDir);
  for (const entry of entries) {
    fs.renameSync(path.join(fromDir, entry), path.join(toDir, entry));
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload, contentType) {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 50 * 1024 * 1024) {
        reject(new Error("Payload muito grande"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || "";
  const parts = cookieHeader.split(";").map((item) => item.trim());
  const tokenPart = parts.find((item) => item.startsWith("session="));
  return tokenPart ? tokenPart.slice("session=".length) : null;
}

function setCookie(res, token) {
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Strict; Path=/`);
}

function clearCookie(res) {
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

function runExtractor(inputDir, outputPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(PYTHON_EXE, [EXTRACT_SCRIPT, inputDir, outputPath], {
      cwd: ROOT,
      windowsHide: true,
    });

    let stderr = "";
    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || "Falha ao processar os PDFs"));
    });
  });
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function validateUploadFiles(files) {
  const users = readJson(USERS_PATH, []);
  const sellers = users
    .filter((item) => item.role === "vendedor" && item.vendedor)
    .map((item) => item.vendedor);

  const unifiedNames = sellers.map((seller) => `Titulos - ${seller}.pdf`);
  const legacyNames = [];
  for (const seller of sellers) {
    legacyNames.push(`Titulos vencidos - ${seller}.pdf`);
    legacyNames.push(`Titulos à vencer - ${seller}.pdf`);
  }

  const unifiedSet = new Set(unifiedNames.map((name) => normalizeFileName(name)));
  const legacySet = new Set(legacyNames.map((name) => normalizeFileName(name)));
  const expectedMap = new Map(
    [...unifiedNames, ...legacyNames].map((name) => [normalizeFileName(name), name])
  );
  const receivedMap = new Map();
  const duplicates = [];
  const invalid = [];

  for (const file of files) {
    const originalName = String(file.name || "").trim();
    const normalizedName = normalizeFileName(originalName);

    if (!expectedMap.has(normalizedName)) {
      invalid.push(originalName || "(sem nome)");
      continue;
    }

    if (receivedMap.has(normalizedName)) {
      duplicates.push(originalName);
      continue;
    }

    receivedMap.set(normalizedName, originalName);
  }

  const receivedSet = new Set(receivedMap.keys());
  const matchesUnified = setsEqual(receivedSet, unifiedSet);
  const matchesLegacy = setsEqual(receivedSet, legacySet);

  if (!invalid.length && !duplicates.length && (matchesUnified || matchesLegacy)) {
    return {
      ok: true,
      mode: matchesUnified ? "unificado" : "legado",
    };
  }

  const parts = [];
  if (invalid.length) {
    parts.push(`Arquivos fora do padrao: ${invalid.join(", ")}`);
  }
  if (duplicates.length) {
    parts.push(`Arquivos duplicados: ${duplicates.join(", ")}`);
  }
  if (!matchesUnified && !matchesLegacy) {
    const missingUnified = unifiedNames.filter((name) => !receivedSet.has(normalizeFileName(name)));
    const missingLegacy = legacyNames.filter((name) => !receivedSet.has(normalizeFileName(name)));
    parts.push(
      `Envie exatamente 4 arquivos no novo padrao ou 8 arquivos no padrao antigo.`
    );
    parts.push(`Novo padrao: ${unifiedNames.join(", ")}`);
    if (receivedSet.size <= unifiedSet.size) {
      parts.push(`Faltando no novo padrao: ${missingUnified.join(", ")}`);
    } else {
      parts.push(`Faltando no padrao antigo: ${missingLegacy.join(", ")}`);
    }
  }

  return {
    ok: false,
    invalid,
    duplicates,
    expectedUnified: unifiedNames,
    expectedLegacy: legacyNames,
    message: parts.join(" | "),
  };
}

function normalizeFileName(value) {
  return normalize(String(value || ""))
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*pdf$/i, ".pdf");
}

function setsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");

const root = __dirname;
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const uploadDir = path.join(dataDir, "uploads");
for (const dir of [dataDir, uploadDir]) fs.mkdirSync(dir, { recursive: true });
const maxUpload = 12 * 1024 * 1024;
const secretPattern =
  /pass(word)?|secret|token|api[_-]?key|private|credential|auth|database_url|connection/i;
const criticalPattern =
  /database|db_|url|host|port|secret|token|key|password|credential|auth|image|replica|timeout|memory|cpu|region|namespace|tls|ssl/i;
const requiredByEnv = ["APP_ENV"];

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function flatten(value, prefix = "", output = {}) {
  if (value && typeof value === "object" && !Array.isArray(value))
    Object.entries(value).forEach(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key, output),
    );
  else output[prefix] = value === null ? "" : String(value);
  return output;
}
function parseConfig(text) {
  text = String(text || "").trim();
  if (!text) return {};
  try {
    return flatten(JSON.parse(text));
  } catch (_) {}
  const result = {};
  text.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const match = line.match(/^\s*([^:=\s][^:=]*?)\s*(?:=|:)\s*(.*?)\s*$/);
    if (match)
      result[match[1].replace(/^['"]|['"]$/g, "")] = match[2].replace(
        /^['"]|['"]$/g,
        "",
      );
  });
  return result;
}
function mask(key, value) {
  return secretPattern.test(key) && value ? "••••••••" : value || "—";
}
function analyse(baselineText, candidateText) {
  const baseline = parseConfig(baselineText),
    candidate = parseConfig(candidateText);
  const keys = [
    ...new Set([...Object.keys(baseline), ...Object.keys(candidate)]),
  ].sort();
  const changes = keys.flatMap((key) => {
    let type;
    if (!(key in baseline)) type = "added";
    else if (!(key in candidate)) type = "removed";
    else if (baseline[key] !== candidate[key]) type = "changed";
    else return [];
    const critical = criticalPattern.test(key);
    let note = critical
      ? "Deployment-sensitive setting — verify against the target environment."
      : "Configuration value differs from the baseline.";
    if (type === "removed" && critical)
      note =
        "Critical setting removed — deployment may fail or use an unsafe default.";
    return [
      {
        key,
        type,
        old: mask(key, baseline[key]),
        next: mask(key, candidate[key]),
        critical,
        note,
      },
    ];
  });
  const validations = requiredByEnv
    .filter((key) => !candidate[key])
    .map((key) => ({
      level: "error",
      key,
      message: `Required deployment setting ${key} is missing.`,
    }));
  Object.entries(candidate).forEach(([key, value]) => {
    if (
      /port$/i.test(key) &&
      value &&
      (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
    )
      validations.push({
        level: "error",
        key,
        message: "Port must be a number between 1 and 65535.",
      });
    if (
      /replicas?$/i.test(key) &&
      value &&
      (!/^\d+$/.test(value) || +value < 1)
    )
      validations.push({
        level: "warning",
        key,
        message: "Replica count should be a positive integer.",
      });
  });
  return {
    changes,
    validations,
    summary: {
      total: changes.length,
      added: changes.filter((c) => c.type === "added").length,
      removed: changes.filter((c) => c.type === "removed").length,
      changed: changes.filter((c) => c.type === "changed").length,
      critical: changes.filter((c) => c.critical).length,
    },
    candidateKeys: Object.keys(candidate).length,
  };
}
function multipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Expected multipart/form-data.");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = {};
  let pos = body.indexOf(boundary) + boundary.length + 2;
  while (pos > boundary.length) {
    const next = body.indexOf(boundary, pos);
    if (next < 0) break;
    const part = body.subarray(pos, next - 2);
    const divider = part.indexOf(Buffer.from("\r\n\r\n"));
    if (divider > -1) {
      const headers = part.subarray(0, divider).toString();
      const name = (headers.match(/name="([^"]+)"/) || [])[1];
      const filename = (headers.match(/filename="([^"]*)"/) || [])[1];
      if (name) parts[name] = { filename, data: part.subarray(divider + 4) };
    }
    pos = next + boundary.length + 2;
  }
  return parts;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0,
      chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxUpload) {
        reject(new Error("Upload exceeds the 12 MB limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function saveSnapshot(record) {
  const snapshots = path.join(dataDir, "snapshots.json");
  const old = fs.existsSync(snapshots)
    ? JSON.parse(fs.readFileSync(snapshots, "utf8"))
    : [];
  old.unshift(record);
  fs.writeFileSync(snapshots, JSON.stringify(old.slice(0, 30), null, 2));
}
function contentType(file) {
  return file.endsWith(".html")
    ? "text/html"
    : file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "application/octet-stream";
}
function packet(payload, sequence) {
  const header = Buffer.alloc(4);
  header.writeUIntLE(payload.length, 0, 3);
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}
function mysqlToken(plugin, password, seed) {
  if (plugin === "mysql_native_password") {
    const a = crypto.createHash("sha1").update(password).digest(),
      b = crypto.createHash("sha1").update(a).digest(),
      c = crypto
        .createHash("sha1")
        .update(Buffer.concat([seed, b]))
        .digest();
    return Buffer.from(a.map((v, i) => v ^ c[i]));
  }
  const a = crypto.createHash("sha256").update(password).digest(),
    b = crypto.createHash("sha256").update(a).digest(),
    c = crypto
      .createHash("sha256")
      .update(Buffer.concat([b, seed]))
      .digest();
  return Buffer.from(a.map((v, i) => v ^ c[i]));
}
function mysqlConnect({ host = "127.0.0.1", port = 3306, username, password }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let state = "handshake",
      timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("MySQL connection timed out."));
      }, 6000);
    const done = (err, result) => {
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(result);
    };
    socket.once("error", () =>
      done(new Error(`Cannot reach MySQL at ${host}:${port}.`)),
    );
    socket.on("data", (data) => {
      const payload = data.subarray(4);
      if (state === "handshake") {
        try {
          let p = 1,
            end = data.indexOf(0, p);
          p = end + 1 + 4;
          const salt1 = data.subarray(p, p + 8);
          p += 9;
          const low = data.readUInt16LE(p);
          p += 2 + 1 + 2;
          const high = data.readUInt16LE(p);
          p += 2;
          const caps = low | (high << 16);
          const authLen = data[p];
          p += 1 + 10;
          const salt2 = data.subarray(p, p + Math.max(13, authLen - 8));
          p += Math.max(13, authLen - 8);
          const plugin =
            caps & 0x80000
              ? data.subarray(p).toString().replace(/\0.*$/, "")
              : "mysql_native_password";
          const seed = Buffer.concat([salt1, salt2]).subarray(0, 20);
          const auth = mysqlToken(plugin, password || "", seed);
          const clientCaps = 0x00000001 | 0x00000200 | 0x00008000 | 0x00080000;
          const head = Buffer.alloc(4 + 1 + 23);
          head.writeUInt32LE(clientCaps, 0);
          head[8] = 45;
          const response = Buffer.concat([
            head,
            Buffer.from(`${username}\0`),
            Buffer.from([auth.length]),
            auth,
            Buffer.from(`${plugin}\0`),
          ]);
          socket.write(packet(response, 1));
          state = "auth";
        } catch (_) {
          done(new Error("Unable to read the MySQL server handshake."));
        }
        return;
      }
      if (payload[0] === 0x00)
        return done(null, {
          ok: true,
          message: `Connected and authenticated as ${username} on ${host}:${port}.`,
        });
      if (payload[0] === 0xff) {
        const code = payload.readUInt16LE(1);
        return done(
          new Error(
            `MySQL rejected the login (error ${code}). Check username and password.`,
          ),
        );
      }
      if (payload[0] === 0x01 && payload[1] === 0x03) {
        state = "fast-auth";
        return;
      }
      if (payload[0] === 0x01 && payload[1] === 0x04)
        return done(
          new Error(
            "This MySQL server requires an encrypted password exchange. Configure TLS or use a service account with mysql_native_password for this local demo.",
          ),
        );
    });
  });
}

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/health")
        return send(res, 200, { ok: true });
      if (req.method === "GET" && req.url === "/api/history") {
        const p = path.join(dataDir, "snapshots.json");
        return send(
          res,
          200,
          fs.existsSync(p)
            ? JSON.parse(fs.readFileSync(p, "utf8")).map(
                ({ candidateText, baselineText, ...safe }) => safe,
              )
            : [],
        );
      }
      if (req.method === "POST" && req.url === "/api/mysql-test") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        if (!body.username || body.password === undefined)
          return send(res, 400, {
            error: "Username and password are required.",
          });
        const result = await mysqlConnect(body);
        return send(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/api/analyse") {
        const parts = multipart(req, await readBody(req));
        const baselineText = (
          parts.baselineText?.data ||
          parts.baselineFile?.data ||
          Buffer.alloc(0)
        ).toString("utf8");
        const candidateText = (
          parts.candidateText?.data ||
          parts.candidateFile?.data ||
          Buffer.alloc(0)
        ).toString("utf8");
        if (!candidateText.trim())
          return send(res, 400, {
            error:
              "Upload or paste the configuration for the deployment you want to check.",
          });
        const app = parts.application;
        let appInfo = null;
        if (app?.filename) {
          const safeName = path
            .basename(app.filename)
            .replace(/[^a-zA-Z0-9._-]/g, "_");
          const storedName = `${crypto.randomUUID()}-${safeName}`;
          fs.writeFileSync(path.join(uploadDir, storedName), app.data);
          appInfo = {
            originalName: safeName,
            size: app.data.length,
            storedName,
          };
        }
        const report = analyse(baselineText, candidateText);
        const record = {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          application: appInfo && {
            originalName: appInfo.originalName,
            size: appInfo.size,
          },
          summary: report.summary,
          baselineText,
          candidateText,
        };
        saveSnapshot(record);
        return send(res, 200, {
          ...report,
          id: record.id,
          application: appInfo && {
            originalName: appInfo.originalName,
            size: appInfo.size,
          },
          candidateText,
        });
      }
      if (req.method === "GET") {
        const requestPath =
          req.url === "/"
            ? "index.html"
            : decodeURIComponent(req.url).replace(/^\//, "");
        const file = path.resolve(publicDir, requestPath);
        if (
          !file.startsWith(publicDir) ||
          !fs.existsSync(file) ||
          fs.statSync(file).isDirectory()
        )
          return send(res, 404, { error: "Not found" });
        return send(res, 200, fs.readFileSync(file), contentType(file));
      }
      send(res, 405, { error: "Method not allowed" });
    } catch (error) {
      send(res, 400, {
        error: error.message || "Unable to process this request.",
      });
    }
  })
  .listen(process.env.PORT || 3000, () =>
    console.log("DeployDiff running at http://localhost:3000"),
  );

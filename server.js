const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "records.json");
const SESSION_COOKIE = "radio_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SALT = randomBytes(16);
const MIME_TYPES = {
  "/": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/logo.png": "image/png",
};
const sessions = new Map();
let store = { users: [], entries: [] };
let saveQueue = Promise.resolve();

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? ["", ""]
        : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([key]) => key),
  );
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function createToken() {
  const token = randomBytes(32).toString("hex");
  const signature = randomBytes(32).toString("hex");
  return `${token}.${signature}`;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.user;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error("البيانات كبيرة أكثر من اللازم."), { status: 413 });
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("صيغة البيانات غير صحيحة."), { status: 400 });
  }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validUsername(value) {
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(value);
}

async function hashPassword(password, salt = randomBytes(16)) {
  const hash = await scryptAsync(password, salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

async function verifyPassword(password, record) {
  const derived = await scryptAsync(password, Buffer.from(record.salt, "hex"), 64);
  const expected = Buffer.from(record.hash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

async function verifyAdminPassword(password) {
  const derived = await scryptAsync(password, ADMIN_SALT, 64);
  const expected = await scryptAsync(ADMIN_PASSWORD, ADMIN_SALT, 64);
  return timingSafeEqual(derived, expected);
}

async function persist() {
  const contents = JSON.stringify(store, null, 2);
  saveQueue = saveQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fs.writeFile(temporaryFile, contents, "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
  });
  await saveQueue;
}

function entryAmount(entry) {
  const hourlyRate = entry.type === "recorded"
    ? (entry.role === "sheikh" ? 150 : 100)
    : (entry.role === "sheikh" ? 75 : 40);
  return Math.round((hourlyRate * entry.durationMinutes / 60 + Number.EPSILON) * 100) / 100;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function entryForResponse(entry) {
  const user = store.users.find((person) => person.id === entry.userId);
  return {
    ...entry,
    name: user?.name || "حساب محذوف",
    username: user?.username || "",
    amount: entryAmount(entry),
  };
}

function requireAdmin(req, res) {
  const user = sessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "سجّل الدخول أولاً." });
    return false;
  }
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "هذه الصفحة للإدارة فقط." });
    return false;
  }
  return true;
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (["POST", "PATCH", "DELETE"].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        sendJson(res, 403, { error: "الطلب غير مسموح." });
        return;
      }
    } catch {
      sendJson(res, 403, { error: "الطلب غير مسموح." });
      return;
    }
  }

  if (req.method === "GET" && route === "/api/session") {
    sendJson(res, 200, { user: sessionUser(req) });
    return;
  }

  if (req.method === "GET" && route === "/api/config") {
    sendJson(res, 200, { adminUsername: ADMIN_USERNAME });
    return;
  }

  if (req.method === "POST" && route === "/api/register") {
    const body = await readJson(req);
    const name = cleanText(body.name, 80);
    const username = cleanText(body.username, 30).toLowerCase();
    const phone = cleanText(body.phone, 30);
    const role = body.role;
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !validUsername(username) || !phone || !["presenter", "sheikh"].includes(role) || password.length < 8 || password.length > 128) {
      sendJson(res, 400, { error: "راجع البيانات: الاسم والهاتف مطلوبان، اسم المستخدم 3 أحرف على الأقل، وكلمة المرور 8 أحرف على الأقل." });
      return;
    }
    if (username === ADMIN_USERNAME || store.users.some((user) => user.username === username)) {
      sendJson(res, 409, { error: "اسم المستخدم مستخدم بالفعل." });
      return;
    }
    const credentials = await hashPassword(password);
    const user = {
      id: randomBytes(16).toString("hex"),
      name,
      username,
      phone,
      role,
      ...credentials,
      createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    await persist();
    const token = createToken();
    sessions.set(token, {
      user: { id: user.id, name: user.name, username: user.username, role: user.role },
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    sendJson(res, 201, { user: sessionUser({ headers: { cookie: `${SESSION_COOKIE}=${token}` } }) }, {
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
    });
    return;
  }

  if (req.method === "POST" && route === "/api/login") {
    const body = await readJson(req);
    const username = cleanText(body.username, 30).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    let user;
    if (username === ADMIN_USERNAME && await verifyAdminPassword(password)) {
      user = { id: "admin", name: "الإدارة", username: ADMIN_USERNAME, role: "admin" };
    } else {
      const account = store.users.find((person) => person.username === username);
      if (account && await verifyPassword(password, account)) {
        user = { id: account.id, name: account.name, username: account.username, role: account.role };
      }
    }
    if (!user) {
      sendJson(res, 401, { error: "اسم المستخدم أو كلمة المرور غير صحيحة." });
      return;
    }
    const token = createToken();
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    sendJson(res, 200, { user });
    return;
  }

  if (req.method === "POST" && route === "/api/logout") {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && route === "/api/entries") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const entries = user.role === "admin"
      ? store.entries
      : store.entries.filter((entry) => entry.userId === user.id);
    sendJson(res, 200, { entries: entries.map(entryForResponse).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)) });
    return;
  }

  if (req.method === "POST" && route === "/api/entries") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    if (user.role === "admin") {
      sendJson(res, 403, { error: "استخدم حساب مقدم أو شيخ لإرسال طلب." });
      return;
    }
    const body = await readJson(req);
    const programName = cleanText(body.programName, 100);
    const coParticipant = cleanText(body.coParticipant, 80);
    const date = cleanText(body.date, 10);
    const durationMinutes = Number(body.durationMinutes);
    const type = body.type;
    if (!programName || !coParticipant || !isValidDate(date) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440 || !["live", "recorded"].includes(type)) {
      sendJson(res, 400, { error: "تحقق من اسم البرنامج، الطرف الآخر، التاريخ، نوع البرنامج والمدة بالدقائق (من 1 إلى 1440)." });
      return;
    }
    const entry = {
      id: randomBytes(16).toString("hex"),
      userId: user.id,
      role: user.role,
      programName,
      coParticipant,
      date,
      durationMinutes,
      type,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    store.entries.push(entry);
    await persist();
    sendJson(res, 201, { entry: entryForResponse(entry) });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/report") {
    if (!requireAdmin(req, res)) return;
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
      sendJson(res, 400, { error: "صيغة التاريخ غير صحيحة." });
      return;
    }
    const entries = store.entries
      .filter((entry) => entry.status === "approved")
      .filter((entry) => (!from || entry.date >= from) && (!to || entry.date <= to))
      .map(entryForResponse)
      .sort((a, b) => a.name.localeCompare(b.name, "ar") || a.date.localeCompare(b.date));
    const totals = new Map();
    for (const entry of entries) {
      const current = totals.get(entry.userId) || {
        userId: entry.userId,
        name: entry.name,
        username: entry.username,
        role: entry.role,
        count: 0,
        amount: 0,
      };
      current.count += 1;
      current.amount = Math.round((current.amount + entry.amount + Number.EPSILON) * 100) / 100;
      totals.set(entry.userId, current);
    }
    sendJson(res, 200, {
      entries,
      totals: [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, "ar")),
    });
    return;
  }

  const reviewMatch = route.match(/^\/api\/admin\/entries\/([a-f0-9]+)\/review$/);
  if (req.method === "PATCH" && reviewMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    if (!["approved", "rejected"].includes(body.status)) {
      sendJson(res, 400, { error: "حالة المراجعة غير صحيحة." });
      return;
    }
    const entry = store.entries.find((item) => item.id === reviewMatch[1]);
    if (!entry) {
      sendJson(res, 404, { error: "الطلب غير موجود." });
      return;
    }
    if (entry.status !== "pending") {
      sendJson(res, 409, { error: "تمت مراجعة هذا الطلب مسبقاً." });
      return;
    }
    entry.status = body.status;
    entry.reviewedAt = new Date().toISOString();
    await persist();
    sendJson(res, 200, { entry: entryForResponse(entry) });
    return;
  }

  sendJson(res, 404, { error: "المسار غير موجود." });
}

async function serveStatic(res, pathname) {
  const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!["index.html", "styles.css", "app.js", "logo.png"].includes(fileName)) {
    sendJson(res, 404, { error: "الصفحة غير موجودة." });
    return;
  }
  try {
    const contents = await fs.readFile(path.join(__dirname, fileName));
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[pathname] || MIME_TYPES["/"],
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    res.end(contents);
  } catch (error) {
    console.error("تعذر قراءة ملف الموقع:", error);
    sendJson(res, 500, { error: "تعذر تحميل الموقع." });
  }
}

async function start() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error("عيّن ADMIN_PASSWORD (8 أحرف على الأقل) قبل تشغيل الموقع.");
  }
  if (!validUsername(ADMIN_USERNAME)) {
    throw new Error("عيّن ADMIN_USERNAME من 3 إلى 30 حرفاً إنجليزياً أو رقماً.");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!Array.isArray(saved.users) || !Array.isArray(saved.entries)) throw new Error("صيغة ملف البيانات غير صحيحة.");
    store = saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt < now) sessions.delete(token);
    }
  }, 60 * 60 * 1000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else if (req.method === "GET") {
        await serveStatic(res, url.pathname);
      } else {
        sendJson(res, 405, { error: "طريقة الطلب غير مسموحة." });
      }
    } catch (error) {
      if (error.status) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error("خطأ في معالجة الطلب:", error);
      sendJson(res, 500, { error: "صار خطأ أثناء تنفيذ الطلب. حاول مرة ثانية." });
    }
  });
  server.listen(PORT, () => {
    console.log(`موقع مستحقات الراديو يعمل على http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

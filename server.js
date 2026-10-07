const http = require("node:http");
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream, constants: fsConstants } = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const {
  randomBytes,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");
const Busboy = require("busboy");
const nodemailer = require("nodemailer");
const archiver = require("archiver");
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "records.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const MAX_MEDIA_BYTES = 800 * 1024 * 1024;
const SESSION_COOKIE = "radio_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SALT = randomBytes(16);
const CHANNELS = ["radio", "visual"];
const PROGRAM_TYPES = ["live", "recorded"];
const PARTICIPANT_ROLES = ["presenter", "sheikh"];
const DEFAULT_RATES = {
  radio: {
    live: { presenter: 40, sheikh: 75 },
    recorded: { presenter: 100, sheikh: 150 },
  },
  visual: {
    live: { presenter: 40, sheikh: 75 },
    recorded: { presenter: 100, sheikh: 150 },
  },
};
const MIME_TYPES = {
  "/": "text/html; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/logo.png": "image/png",
};
const sessions = new Map();
let store = { users: [], entries: [], programs: [], bookings: [], episodes: [], auditEvents: [], archiveFiles: [], rates: null };
let saveQueue = Promise.resolve();
let bookingQueue = Promise.resolve();
let mailTransport;

function normalizedRates(savedRates = {}) {
  const rates = {};
  for (const channel of CHANNELS) {
    rates[channel] = {};
    for (const type of PROGRAM_TYPES) {
      rates[channel][type] = {};
      for (const role of PARTICIPANT_ROLES) {
        const savedRate = savedRates[channel]?.[type]?.[role];
        const rate = savedRate === undefined ? DEFAULT_RATES[channel][type][role] : savedRate;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 10000) {
          throw new Error(`سعر الساعة المخزن غير صحيح (${channel}/${type}/${role}).`);
        }
        rates[channel][type][role] = rate;
      }
    }
  }
  return rates;
}

function programChannel(program) {
  return CHANNELS.includes(program?.channel) ? program.channel : "radio";
}

function entryChannel(entry) {
  if (CHANNELS.includes(entry.channel)) return entry.channel;
  return programChannel(store.programs.find((program) => program.id === entry.programId));
}

function requestChannel(url, res) {
  const channel = url.searchParams.get("channel");
  if (!CHANNELS.includes(channel)) {
    sendJson(res, 400, { error: "اختر القناة أولاً." });
    return null;
  }
  return channel;
}

function requestBodyChannel(body, res) {
  if (!CHANNELS.includes(body.channel)) {
    sendJson(res, 400, { error: "اختر القناة أولاً." });
    return null;
  }
  return body.channel;
}

function hourlyRate(channel, type, role) {
  return store.rates?.[channel]?.[type]?.[role] ?? DEFAULT_RATES[channel][type][role];
}

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
  const credential = store.adminCredentials;
  const salt = credential ? Buffer.from(credential.salt, "hex") : ADMIN_SALT;
  const expected = credential
    ? Buffer.from(credential.hash, "hex")
    : await scryptAsync(ADMIN_PASSWORD, salt, 64);
  const derived = await scryptAsync(password, salt, 64);
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}

async function persist() {
  const contents = JSON.stringify(store, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const temporaryFile = `${DATA_FILE}.tmp`;
    await fs.writeFile(temporaryFile, contents, "utf8");
    await fs.rename(temporaryFile, DATA_FILE);
  });
  await saveQueue;
}

function dateInLibya(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function nextBookingDates() {
  const today = dateInLibya();
  return [addDays(today, 1), addDays(today, 2)];
}

function appendAudit(action, actor, details = {}) {
  store.auditEvents.push({
    id: randomBytes(16).toString("hex"),
    action,
    actorId: actor.id,
    actorName: actor.name,
    createdAt: new Date().toISOString(),
    ...details,
  });
}

function isDecisionEvent(event) {
  return /^(entry-approved|entry-rejected|booking-approved|booking-rejected|booking-no_show|correction-approved|correction-rejected|correction-needs_revision)$/.test(event.action);
}

function assignedProgram(program, userId) {
  return Array.isArray(program.userIds) && program.userIds.includes(userId);
}

function bookingForResponse(booking, user) {
  if (["admin", "monitor"].includes(user.role) || booking.userId === user.id) {
    return {
      ...booking,
      ownerName: store.users.find((person) => person.id === booking.userId)?.name || booking.ownerName,
      programName: store.programs.find((program) => program.id === booking.programId)?.name || booking.programName,
    };
  }
  return {
    id: booking.id,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    durationMinutes: booking.durationMinutes,
    status: booking.status,
  };
}

function episodeVisibleTo(episode, user) {
  const program = store.programs.find((item) => item.id === episode.programId);
  return ["admin", "monitor"].includes(user.role) || assignedProgram(program || {}, user.id);
}

function episodeForResponse(episode, user) {
  const fullReviewAccess = ["admin", "monitor"].includes(user.role);
  const channel = programChannel(store.programs.find((program) => program.id === episode.programId));
  return {
    id: episode.id,
    programId: episode.programId,
    channel,
    programName: episode.programName,
    episodeNumber: episode.episodeNumber,
    date: episode.date,
    sheikhIds: episode.sheikhIds,
    presenterIds: episode.presenterIds,
    sheikhNames: episode.sheikhNames,
    presenterNames: episode.presenterNames,
    uploadedAt: episode.uploadedAt,
    uploadedByName: episode.uploadedByName,
    originalFileName: episode.originalFileName,
    size: episode.size,
    mimeType: episode.mimeType,
    versions: episode.versions.map((version, index) => ({
      index,
      originalFileName: version.originalFileName,
      size: version.size,
      uploadedAt: version.uploadedAt,
      uploadedByName: version.uploadedByName,
      mediaUrl: `/api/episodes/${episode.id}/media?channel=${channel}&version=${index}`,
      downloadUrl: `/api/episodes/${episode.id}/media?channel=${channel}&version=${index}&download=1`,
    })),
    mediaUrl: `/api/episodes/${episode.id}/media?channel=${channel}`,
    corrections: episode.corrections
      .filter((item) => fullReviewAccess || item.authorId === user.id)
      .map((item) => ({
        ...item,
        revisions: item.revisions || [],
        documentUrl: item.documentId ? `/api/archive/${item.documentId}?channel=${channel}` : "",
      })),
  };
}

function sendMonitorEmail(subject, text, includeAdmin = false) {
  const recipients = store.users.filter((user) => user.role === "monitor" && user.email);
  if (includeAdmin && store.adminProfile?.email) {
    recipients.push({ email: store.adminProfile.email });
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASSWORD || !process.env.SMTP_FROM) {
    return Promise.resolve({ sent: false, warning: "إعداد البريد الإلكتروني غير مكتمل؛ تم حفظ العملية، لكن لم يُرسل الإشعار." });
  }
  if (!recipients.length) {
    return Promise.resolve({ sent: false, warning: "لا توجد عناوين بريد مسجلة للمراقبين؛ تم حفظ العملية دون إرسال الإشعار." });
  }
  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return mailTransport.sendMail({
    from: process.env.SMTP_FROM,
    to: recipients.map((user) => user.email).join(", "),
    subject,
    text,
  }).then(() => ({ sent: true })).catch((error) => {
    console.error("تعذر إرسال إشعار البريد للمراقبين:", error);
    return { sent: false, warning: "تم حفظ العملية، لكن تعذر إرسال إشعار البريد للمراقبين." };
  });
}

async function saveArchiveFile({ name, kind, month, buffer, details = {} }) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const id = randomBytes(16).toString("hex");
  const storedName = `${id}${path.extname(name)}`;
  const filePath = path.join(ARCHIVE_DIR, storedName);
  await fs.writeFile(filePath, buffer, { flag: "wx" });
  const item = { id, name, kind, month, path: filePath, createdAt: new Date().toISOString(), ...details };
  store.archiveFiles.push(item);
  await persist();
  return item;
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function currentAccount(user) {
  if (user.id === "admin") {
    const profile = store.adminProfile || {};
    return {
      id: "admin",
      name: profile.name || ADMIN_USERNAME.toUpperCase(),
      username: ADMIN_USERNAME,
      phone: profile.phone || "",
      email: profile.email || "",
      role: "admin",
    };
  }
  const account = store.users.find((person) => person.id === user.id);
  if (!account) return null;
  const { id, name, username, phone, email, role } = account;
  return { id, name, username, phone, email: email || "", role };
}

async function verifyAccountPassword(user, password) {
  if (typeof password !== "string") return Promise.resolve(false);
  if (user.id === "admin") return verifyAdminPassword(password);
  const account = store.users.find((person) => person.id === user.id);
  return Boolean(account && await verifyPassword(password, account));
}

function setAccountDisplay(userId, name) {
  for (const session of sessions.values()) {
    if (session.user.id === userId) session.user.name = name;
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csvBuffer(rows) {
  return Buffer.from(`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`, "utf8");
}

async function makeCorrectionDocument(episode, request) {
  const file = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: "دار الإفتاء الليبية", heading: HeadingLevel.HEADING_1, alignment: "right", bidirectional: true }),
        new Paragraph({ text: "محضر تعديل واعتماد حلقة", heading: HeadingLevel.HEADING_2, alignment: "right", bidirectional: true }),
        new Paragraph({ children: [new TextRun({ text: `البرنامج: ${episode.programName}`, bold: true })], alignment: "right", bidirectional: true }),
        new Paragraph({ text: `رقم الحلقة: ${episode.episodeNumber}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `تاريخ الحلقة: ${episode.date}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `الشيخ: ${episode.sheikhNames.join("، ")}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `المقدم: ${episode.presenterNames.join("، ")}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: "ملاحظة التعديل", heading: HeadingLevel.HEADING_3, alignment: "right", bidirectional: true }),
        new Paragraph({ text: request.text, alignment: "right", bidirectional: true }),
        new Paragraph({ text: "رد المراجع", heading: HeadingLevel.HEADING_3, alignment: "right", bidirectional: true }),
        new Paragraph({ text: request.reviewResponse || "تم الاعتماد.", alignment: "right", bidirectional: true }),
        new Paragraph({ text: `القرار: معتمد`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `اعتمدها: ${request.reviewedByName}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `تاريخ الاعتماد: ${new Date(request.reviewedAt).toLocaleString("ar-LY", { timeZone: "Africa/Tripoli" })}`, alignment: "right", bidirectional: true }),
        new Paragraph({ text: `ملف التسجيل: ${episode.originalFileName}`, alignment: "right", bidirectional: true }),
      ],
    }],
  });
  return Packer.toBuffer(file);
}

async function makeProgramProposalDocument(proposal) {
  const paragraph = (text, { bold = false, alignment = "right", size = 28 } = {}) => new Paragraph({
    children: [new TextRun({ text, bold, font: "Traditional Arabic", size })],
    alignment,
    bidirectional: true,
    spacing: { after: 180 },
  });
  const frequencyNames = {
    weekly: "أسبوعياً",
    biweekly: "كل أسبوعين",
    monthly: "شهرياً",
    other: "حسب الخطة المقترحة",
  };
  const hours = Math.floor(proposal.durationMinutes / 60);
  const remainingMinutes = proposal.durationMinutes % 60;
  const duration = hours === 0
    ? `${proposal.durationMinutes} دقيقة`
    : `${hours === 1 ? "ساعة واحدة" : "ساعتان"}${remainingMinutes ? ` و${remainingMinutes} دقيقة` : ""}`;
  const date = new Date().toLocaleDateString("ar-LY", { timeZone: "Africa/Tripoli" });
  const file = new Document({
    sections: [{
      properties: { page: { margin: { top: 1000, right: 1100, bottom: 1000, left: 1100 } } },
      children: [
        paragraph("بسم الله الرحمن الرحيم", { bold: true, alignment: "center", size: 32 }),
        paragraph(`التاريخ: ${date}`),
        paragraph("السيد مدير المحتوى بإذاعة وقناة دار الإفتاء الليبية", { bold: true }),
        paragraph("السلام عليكم ورحمة الله وبركاته،"),
        paragraph(`الموضوع: مقترح برنامج بعنوان «${proposal.programName}»`, { bold: true }),
        paragraph(`تحية طيبة وبعد، أتقدم أنا الشيخ ${proposal.authorName} بهذا المقترح للنظر في إنتاج برنامج ${proposal.channel === "radio" ? "إذاعي" : "مرئي"} جديد.`),
        paragraph("فكرة البرنامج ومواصفاته:", { bold: true }),
        paragraph(proposal.description),
        paragraph(`الهدف من البرنامج: ${proposal.objective}`),
        paragraph(`الفئة المستهدفة: ${proposal.audience}`),
        paragraph(`المدة المقترحة للحلقة: ${duration}`),
        paragraph(`وتيرة البث المقترحة: ${frequencyNames[proposal.frequency]}`),
        paragraph(proposal.needsPresenter
          ? `يحتاج البرنامج إلى مقدم، والمقترح: ${proposal.suggestedPresenter}.`
          : "لا يحتاج البرنامج إلى مقدم."),
        ...(proposal.additionalNotes ? [paragraph(`ملاحظات إضافية: ${proposal.additionalNotes}`)] : []),
        paragraph("نأمل التكرم بدراسة المقترح، وتفضلوا بقبول فائق الاحترام والتقدير."),
        paragraph("طلال الدريبي", { alignment: "left", bold: true, size: 30 }),
      ],
    }],
  });
  return Packer.toBuffer(file);
}

async function parseMediaUpload(req) {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const tempPath = path.join(MEDIA_DIR, `${randomBytes(16).toString("hex")}.upload`);
  let fileInfo = null;
  let uploadError = null;
  const fields = {};
  const tasks = [];
  await new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 10, fileSize: MAX_MEDIA_BYTES } });
    } catch (error) {
      reject(Object.assign(error, { status: 400 }));
      return;
    }
    parser.on("file", (fieldName, stream, info) => {
      const extension = path.extname(info.filename).toLowerCase();
      const allowed = new Set([".mp3", ".mp4"]);
      if (fieldName !== "media" || !allowed.has(extension)) {
        uploadError = Object.assign(new Error("ارفع ملفاً صوتياً بصيغة MP3 أو مرئياً بصيغة MP4 فقط."), { status: 400 });
        stream.resume();
        return;
      }
      fileInfo = {
        originalFileName: path.basename(info.filename).replace(/[\u0000-\u001f]/g, "").slice(0, 180),
        extension,
        mimeType: extension === ".mp3" ? "audio/mpeg" : "video/mp4",
      };
      stream.on("limit", () => {
        uploadError = Object.assign(new Error("حجم الملف أكبر من الحد الأقصى المسموح به وهو 800 ميغابايت."), { status: 413 });
      });
      tasks.push(pipeline(stream, createWriteStream(tempPath, { flags: "wx" })).catch((error) => {
        uploadError ||= error;
      }));
    });
    parser.on("field", (name, value) => {
      if (Object.hasOwn(fields, name)) {
        uploadError = Object.assign(new Error("تكرر أحد حقول نموذج رفع الحلقة."), { status: 400 });
        return;
      }
      fields[name] = value;
    });
    parser.on("filesLimit", () => { uploadError = Object.assign(new Error("ارفع ملف حلقة واحداً فقط."), { status: 400 }); });
    parser.on("fieldsLimit", () => { uploadError = Object.assign(new Error("حقول الطلب أكثر من المسموح."), { status: 400 }); });
    parser.on("error", reject);
    parser.on("close", resolve);
    req.pipe(parser);
  });
  await Promise.all(tasks);
  if (uploadError || !fileInfo) {
    await fs.rm(tempPath, { force: true });
    if (uploadError) throw uploadError;
    throw Object.assign(new Error("لم يصل ملف الحلقة."), { status: 400 });
  }
  try {
    const handle = await fs.open(tempPath, "r");
    const signature = Buffer.alloc(12);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    await handle.close();
    const validSignature = fileInfo.extension === ".mp3"
      ? signature.subarray(0, 3).toString() === "ID3" || (signature[0] === 0xff && (signature[1] & 0xe0) === 0xe0)
      : bytesRead >= 8 && signature.subarray(4, 8).toString() === "ftyp";
    if (!validSignature) throw Object.assign(new Error("محتوى الملف لا يطابق صيغة MP3 أو MP4 المسموح بها."), { status: 400 });
    return { tempPath, fields, ...fileInfo, size: (await fs.stat(tempPath)).size };
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function sendProtectedFile(req, res, filePath, mimeType, downloadName, download = false) {
  const stat = await fs.stat(filePath);
  const safeName = downloadName.replace(/[\r\n"]/g, "_");
  const disposition = download ? "attachment" : "inline";
  const headers = {
    "Content-Type": mimeType,
    "Content-Length": stat.size,
    "Content-Disposition": `${disposition}; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    let end = match[2] && match[1] ? Number(match[2]) : stat.size - 1;
    if (start > end || start >= stat.size || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    headers["Content-Length"] = end - start + 1;
    res.writeHead(206, headers);
    await pipeline(createReadStream(filePath, { start, end }), res);
    return;
  }
  res.writeHead(200, headers);
  await pipeline(createReadStream(filePath), res);
}

function entryAmount(entry) {
  const channel = entryChannel(entry);
  const rate = Number.isFinite(entry.hourlyRate)
    ? entry.hourlyRate
    : hourlyRate(channel, entry.type, entry.role);
  return Math.round((rate * entry.durationMinutes / 60 + Number.EPSILON) * 100) / 100;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function entryForResponse(entry) {
  const user = store.users.find((person) => person.id === entry.userId);
  const reviewer = store.users.find((person) => person.id === entry.reviewedBy);
  const channel = entryChannel(entry);
  const rate = Number.isFinite(entry.hourlyRate)
    ? entry.hourlyRate
    : hourlyRate(channel, entry.type, entry.role);
  return {
    ...entry,
    channel,
    name: user?.name || "حساب محذوف",
    username: user?.username || "",
    reviewerName: entry.reviewedByName || (entry.reviewedBy === "admin" ? "الإدارة العليا" : reviewer?.name || ""),
    amount: Number.isFinite(entry.amount) ? entry.amount : entryAmount(entry),
    hourlyRate: rate,
  };
}

function requireRole(req, res, roles) {
  const user = sessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "سجّل الدخول أولاً." });
    return false;
  }
  if (!roles.includes(user.role)) {
    sendJson(res, 403, { error: "ليست لديك صلاحية لتنفيذ هذا الإجراء." });
    return false;
  }
  return true;
}

const requireAdmin = (req, res) => requireRole(req, res, ["admin"]);
const requireReviewer = (req, res) => requireRole(req, res, ["admin", "monitor"]);

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
    sendJson(res, 200, {
      adminUsername: ADMIN_USERNAME,
    });
    return;
  }

  if (req.method === "GET" && route === "/api/rates") {
    if (!sessionUser(req)) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    sendJson(res, 200, { channel, rates: store.rates[channel] });
    return;
  }

  if (req.method === "PUT" && route === "/api/admin/rates") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const rateTable = body.rates;
    const valid = rateTable && typeof rateTable === "object"
      && PROGRAM_TYPES.every((type) => rateTable[type] && typeof rateTable[type] === "object"
        && PARTICIPANT_ROLES.every((role) => typeof rateTable[type][role] === "number"
          && Number.isFinite(rateTable[type][role]) && rateTable[type][role] >= 0 && rateTable[type][role] <= 10000));
    if (!valid) {
      sendJson(res, 400, { error: "أدخل أسعاراً صحيحة من صفر إلى 10000 دينار للساعة." });
      return;
    }
    store.rates[channel] = Object.fromEntries(PROGRAM_TYPES.map((type) => [
      type,
      Object.fromEntries(PARTICIPANT_ROLES.map((role) => [role, rateTable[type][role]])),
    ]));
    appendAudit("rates-updated", sessionUser(req), { channel, rates: store.rates[channel] });
    await persist();
    sendJson(res, 200, { channel, rates: store.rates[channel] });
    return;
  }

  if (req.method === "POST" && route === "/api/register") {
    const body = await readJson(req);
    const name = cleanText(body.name, 80);
    const username = cleanText(body.username, 30).toLowerCase();
    const phone = cleanText(body.phone, 30);
    const email = cleanText(body.email, 254).toLowerCase();
    const role = body.role;
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !validUsername(username) || !phone || (email && !validEmail(email)) || !["presenter", "sheikh"].includes(role) || password.length < 8 || password.length > 128) {
      sendJson(res, 400, { error: "راجع البيانات: الاسم والهاتف مطلوبان، والبريد الإلكتروني إن أُدخل يجب أن يكون صحيحاً." });
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
      email,
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
      user = { id: "admin", name: store.adminProfile?.name || ADMIN_USERNAME.toUpperCase(), username: ADMIN_USERNAME, role: "admin" };
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

  if (req.method === "GET" && route === "/api/account") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    sendJson(res, 200, { account: currentAccount(user) });
    return;
  }

  if (req.method === "PATCH" && route === "/api/account") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    const name = cleanText(body.name, 80);
    const phone = cleanText(body.phone, 30);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!await verifyAccountPassword(user, body.currentPassword || "")) {
      sendJson(res, 403, { error: "كلمة المرور الحالية غير صحيحة." });
      return;
    }
    if (!name || !phone || (email && !validEmail(email))) {
      sendJson(res, 400, { error: "تحقق من الاسم والهاتف والبريد الإلكتروني." });
      return;
    }
    if (user.id === "admin") {
      store.adminProfile = { name, phone, email };
    } else {
      const account = store.users.find((person) => person.id === user.id);
      if (!account) {
        sendJson(res, 404, { error: "الحساب غير موجود." });
        return;
      }
      Object.assign(account, { name, phone, email });
    }
    setAccountDisplay(user.id, name);
    user.name = name;
    await persist();
    sendJson(res, 200, { account: currentAccount(user) });
    return;
  }

  if (req.method === "POST" && route === "/api/account/password") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    if (!await verifyAccountPassword(user, body.currentPassword || "")) {
      sendJson(res, 403, { error: "كلمة المرور الحالية غير صحيحة." });
      return;
    }
    if (typeof body.newPassword !== "string" || body.newPassword.length < 8 || body.newPassword.length > 128) {
      sendJson(res, 400, { error: "كلمة المرور الجديدة يجب أن تكون من 8 إلى 128 حرفاً." });
      return;
    }
    if (user.id === "admin") {
      store.adminCredentials = await hashPassword(body.newPassword);
    } else {
      const account = store.users.find((person) => person.id === user.id);
      if (!account) {
        sendJson(res, 404, { error: "الحساب غير موجود." });
        return;
      }
      Object.assign(account, await hashPassword(body.newPassword));
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    for (const [sessionToken, session] of sessions) {
      if (session.user.id === user.id && sessionToken !== token) sessions.delete(sessionToken);
    }
    await persist();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && route === "/api/booking/programs") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programs = store.programs.filter((program) => program.active && program.type === "recorded"
      && programChannel(program) === channel
      && (["admin", "monitor"].includes(user.role) || assignedProgram(program, user.id)));
    sendJson(res, 200, { channel, programs: programs.map((program) => ({ id: program.id, name: program.name, type: program.type })) });
    return;
  }

  if (req.method === "POST" && route === "/api/program-proposals") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    if (user.role !== "sheikh") {
      sendJson(res, 403, { error: "اقتراح البرامج متاح لحسابات الشيوخ فقط." });
      return;
    }
    const body = await readJson(req);
    const proposal = {
      authorId: user.id,
      authorName: user.name,
      channel: body.channel,
      programName: cleanText(body.programName, 100),
      description: cleanText(body.description, 2000),
      objective: cleanText(body.objective, 800),
      audience: cleanText(body.audience, 300),
      durationMinutes: Number(body.durationMinutes),
      frequency: body.frequency,
      needsPresenter: body.needsPresenter === "yes",
      suggestedPresenter: cleanText(body.suggestedPresenter, 80),
      additionalNotes: cleanText(body.additionalNotes, 800),
    };
    if (!["radio", "visual"].includes(proposal.channel)
      || !proposal.programName || !proposal.description || !proposal.objective || !proposal.audience
      || ![15, 30, 45, 60, 75, 90, 105, 120].includes(proposal.durationMinutes)
      || !["weekly", "biweekly", "monthly", "other"].includes(proposal.frequency)
      || !["yes", "no"].includes(body.needsPresenter)
      || (proposal.needsPresenter && !proposal.suggestedPresenter)) {
      sendJson(res, 400, { error: "تحقق من القناة وبيانات المقترح والمدة المقترحة." });
      return;
    }
    const buffer = await makeProgramProposalDocument(proposal);
    const file = await saveArchiveFile({
      name: `مقترح-${proposal.channel === "radio" ? "إذاعي" : "مرئي"}-${randomBytes(4).toString("hex")}.docx`,
      kind: "word",
      month: dateInLibya().slice(0, 7),
      buffer,
      details: {
        category: "program-proposal",
        channel: proposal.channel,
        proposalTitle: proposal.programName,
        authorId: user.id,
        authorName: user.name,
      },
    });
    appendAudit("program-proposal-submitted", user, {
      channel: proposal.channel,
      proposalTitle: proposal.programName,
    });
    await persist();
    sendJson(res, 201, {
      file: { id: file.id, name: file.name, downloadUrl: `/api/archive/${file.id}?channel=${proposal.channel}` },
      message: "حُفظ المقترح في أرشيف القناة.",
    });
    return;
  }

  if (req.method === "GET" && route === "/api/bookings") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const dates = nextBookingDates();
    const bookings = store.bookings
      .filter((booking) => booking.channel === channel)
      .filter((booking) => dates.includes(booking.date) || booking.userId === user.id || ["admin", "monitor"].includes(user.role))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .map((booking) => bookingForResponse(booking, user));
    const programDailyMinutes = {};
    for (const booking of store.bookings.filter((item) => item.channel === channel && dates.includes(item.date) && item.status !== "cancelled")) {
      programDailyMinutes[booking.date] ||= {};
      programDailyMinutes[booking.date][booking.programId] = (programDailyMinutes[booking.date][booking.programId] || 0) + booking.durationMinutes;
    }
    sendJson(res, 200, { channel, dates: dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 5), bookings, programDailyMinutes });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/bookings") {
    if (!requireReviewer(req, res)) return;
    const channel = requestChannel(url, res);
    if (!channel) return;
    const now = new Date();
    const bookings = store.bookings
      .filter((booking) => booking.channel === channel && (booking.status === "completed_pending"
        || (booking.status === "booked" && new Date(`${booking.date}T${booking.endTime}:00+02:00`) <= now)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
    sendJson(res, 200, { bookings });
    return;
  }

  if (req.method === "POST" && route === "/api/bookings") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    if (!["presenter", "sheikh"].includes(user.role)) {
      sendJson(res, 403, { error: "حجز الاستوديو متاح للمقدمين والشيوخ فقط." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const bookingTask = bookingQueue.then(async () => {
      const program = store.programs.find((item) => item.id === body.programId && item.active
        && item.type === "recorded" && programChannel(item) === channel && assignedProgram(item, user.id));
      const date = cleanText(body.date, 10);
      const startTime = cleanText(body.startTime, 5);
      const durationMinutes = Number(body.durationMinutes);
      const episodeNumber = Number(body.episodeNumber);
      const coParticipant = cleanText(body.coParticipant, 80);
      const dates = nextBookingDates();
      if (!program || !dates.includes(date) || new Date(`${date}T00:00:00Z`).getUTCDay() === 5
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || Number(startTime.slice(3)) % 15 !== 0
        || ![15, 30, 45, 60, 75, 90, 105, 120].includes(durationMinutes)
        || !Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 99999 || !coParticipant) {
        sendJson(res, 400, { error: "تحقق من البرنامج، موعد اليومين القادمين، رقم الحلقة، المشارك الآخر والمدة." });
        return null;
      }
      const [hours, minutes] = startTime.split(":").map(Number);
      const startMinutes = hours * 60 + minutes;
      const endMinutes = startMinutes + durationMinutes;
      if (startMinutes < 13 * 60 || endMinutes > 19 * 60) {
        sendJson(res, 400, { error: "مواعيد التسجيل من 1 ظهراً إلى 7 مساءً، ويجب أن ينتهي الحجز قبل إغلاق الاستوديو." });
        return null;
      }
      const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
      const sameDay = store.bookings.filter((booking) => booking.channel === channel
        && booking.date === date && booking.status !== "cancelled");
      if (sameDay.some((booking) => startMinutes < booking.endMinutes && endMinutes > booking.startMinutes)) {
        sendJson(res, 409, { error: "هذا الوقت محجوز للاستوديو؛ اختر موعداً آخر." });
        return null;
      }
      const programMinutes = sameDay
        .filter((booking) => booking.programId === program.id)
        .reduce((sum, booking) => sum + booking.durationMinutes, 0);
      if (programMinutes + durationMinutes > 120) {
        sendJson(res, 409, { error: "اكتمل الحد اليومي للبرنامج؛ لا يتجاوز مجموع تسجيله ساعتين في اليوم." });
        return null;
      }
      const booking = {
        id: randomBytes(16).toString("hex"),
        userId: user.id,
        ownerName: user.name,
        channel,
        programId: program.id,
        programName: program.name,
        programType: "recorded",
        date,
        startTime,
        endTime,
        startMinutes,
        endMinutes,
        durationMinutes,
        episodeNumber,
        coParticipant,
        status: "booked",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.bookings.push(booking);
      appendAudit("booking-created", user, { bookingId: booking.id, channel, programName: program.name, date, startTime });
      await persist();
      return booking;
    });
    bookingQueue = bookingTask.catch(() => {});
    const result = await bookingTask;
    if (!result) return;
    const notification = await sendMonitorEmail("حجز جديد للاستوديو", `${user.name} حجز برنامج ${result.programName} يوم ${result.date} من ${result.startTime} إلى ${result.endTime}.`);
    sendJson(res, 201, { booking: bookingForResponse(result, user), notificationWarning: notification.warning || "" });
    return;
  }

  const bookingMatch = route.match(/^\/api\/bookings\/([a-f0-9]+)$/);
  if (req.method === "PATCH" && bookingMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const booking = store.bookings.find((item) => item.id === bookingMatch[1] && item.channel === channel);
    if (!booking) {
      sendJson(res, 404, { error: "الحجز غير موجود." });
      return;
    }
    if (booking.userId !== user.id || booking.status !== "booked" || new Date(`${booking.date}T${booking.startTime}:00+02:00`) <= new Date()) {
      sendJson(res, 403, { error: "لا يمكن تعديل أو إلغاء هذا الحجز." });
      return;
    }
    if (body.action === "cancel") {
      booking.status = "cancelled";
      booking.cancelledAt = new Date().toISOString();
      booking.updatedAt = booking.cancelledAt;
      appendAudit("booking-cancelled", user, { bookingId: booking.id, channel, programName: booking.programName, date: booking.date });
      await persist();
      const notification = await sendMonitorEmail("إلغاء حجز الاستوديو", `${user.name} ألغى حجز برنامج ${booking.programName} يوم ${booking.date} الساعة ${booking.startTime}.`);
      sendJson(res, 200, { booking, notificationWarning: notification.warning || "" });
      return;
    }
    if (body.action !== "edit") {
      sendJson(res, 400, { error: "الإجراء المطلوب غير صحيح." });
      return;
    }
    const updateTask = bookingQueue.then(async () => {
      const program = store.programs.find((item) => item.id === body.programId && item.active
        && item.type === "recorded" && programChannel(item) === channel && assignedProgram(item, user.id));
      const date = cleanText(body.date, 10);
      const startTime = cleanText(body.startTime, 5);
      const durationMinutes = Number(body.durationMinutes);
      const episodeNumber = Number(body.episodeNumber);
      const coParticipant = cleanText(body.coParticipant, 80);
      if (!program || !nextBookingDates().includes(date) || new Date(`${date}T00:00:00Z`).getUTCDay() === 5
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || Number(startTime.slice(3)) % 15 !== 0
        || ![15, 30, 45, 60, 75, 90, 105, 120].includes(durationMinutes)
        || !Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 99999 || !coParticipant) {
        sendJson(res, 400, { error: "تحقق من بيانات الموعد الجديد." });
        return null;
      }
      const [hours, minutes] = startTime.split(":").map(Number);
      const startMinutes = hours * 60 + minutes;
      const endMinutes = startMinutes + durationMinutes;
      if (startMinutes < 13 * 60 || endMinutes > 19 * 60) {
        sendJson(res, 400, { error: "مواعيد التسجيل من 1 ظهراً إلى 7 مساءً، ويجب أن ينتهي الحجز قبل إغلاق الاستوديو." });
        return null;
      }
      const sameDay = store.bookings.filter((item) => item.id !== booking.id && item.channel === channel
        && item.date === date && item.status !== "cancelled");
      if (sameDay.some((item) => startMinutes < item.endMinutes && endMinutes > item.startMinutes)) {
        sendJson(res, 409, { error: "هذا الوقت محجوز للاستوديو؛ اختر موعداً آخر." });
        return null;
      }
      const programMinutes = sameDay.filter((item) => item.programId === program.id)
        .reduce((sum, item) => sum + item.durationMinutes, 0);
      if (programMinutes + durationMinutes > 120) {
        sendJson(res, 409, { error: "اكتمل الحد اليومي للبرنامج؛ لا يتجاوز مجموع تسجيله ساعتين في اليوم." });
        return null;
      }
      Object.assign(booking, {
        channel,
        programId: program.id,
        programName: program.name,
        programType: "recorded",
        date,
        startTime,
        endTime: `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`,
        startMinutes,
        endMinutes,
        durationMinutes,
        episodeNumber,
        coParticipant,
        updatedAt: new Date().toISOString(),
      });
      appendAudit("booking-updated", user, { bookingId: booking.id, channel, programName: program.name, date, startTime });
      await persist();
      return booking;
    });
    bookingQueue = updateTask.catch(() => {});
    const updated = await updateTask;
    if (!updated) return;
    const notification = await sendMonitorEmail("تم تعديل حجز الاستوديو", `${user.name} عدّل موعد برنامج ${updated.programName} إلى ${updated.date} من ${updated.startTime} إلى ${updated.endTime}.`);
    sendJson(res, 200, { booking: bookingForResponse(updated, user), notificationWarning: notification.warning || "" });
    return;
  }

  const bookingCompleteMatch = route.match(/^\/api\/bookings\/([a-f0-9]+)\/complete$/);
  if (req.method === "POST" && bookingCompleteMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const booking = store.bookings.find((item) => item.id === bookingCompleteMatch[1]
      && item.channel === channel);
    if (!booking || booking.userId !== user.id) {
      sendJson(res, 404, { error: "الحجز غير موجود." });
      return;
    }
    if (booking.status !== "booked" || new Date(`${booking.date}T${booking.endTime}:00+02:00`) > new Date()) {
      sendJson(res, 409, { error: "يمكن تأكيد إتمام التسجيل بعد انتهاء الموعد فقط." });
      return;
    }
    booking.status = "completed_pending";
    booking.completedAt = new Date().toISOString();
    booking.updatedAt = booking.completedAt;
    appendAudit("booking-completed", user, { bookingId: booking.id, channel, programName: booking.programName, date: booking.date });
    await persist();
    const notification = await sendMonitorEmail("تأكيد إتمام تسجيل حلقة", `${user.name} أكد إتمام تسجيل الحلقة رقم ${booking.episodeNumber} لبرنامج ${booking.programName}.`);
    sendJson(res, 200, { booking, notificationWarning: notification.warning || "" });
    return;
  }

  if (req.method === "GET" && route === "/api/entries") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const month = url.searchParams.get("month") || "";
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(res, 400, { error: "صيغة الشهر غير صحيحة." });
      return;
    }
    const entries = ["admin", "monitor"].includes(user.role)
      ? store.entries.filter((entry) => entryChannel(entry) === channel)
      : store.entries.filter((entry) => entry.userId === user.id && entryChannel(entry) === channel);
    sendJson(res, 200, {
      channel,
      entries: entries
        .filter((entry) => !month || entry.date.startsWith(month))
        .map(entryForResponse)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    });
    return;
  }

  if (req.method === "GET" && route === "/api/programs") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programs = store.programs.filter((program) => program.active && programChannel(program) === channel);
    sendJson(res, 200, { channel, programs: programs.sort((a, b) => a.name.localeCompare(b.name, "ar")) });
    return;
  }

  if (req.method === "POST" && route === "/api/entries") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    if (!["presenter", "sheikh"].includes(user.role)) {
      sendJson(res, 403, { error: "تسجيل المشاركات متاح للمقدمين والشيوخ فقط." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const program = store.programs.find((item) => item.id === body.programId && item.active);
    const coParticipant = cleanText(body.coParticipant, 80);
    const episodeNumber = cleanText(String(body.episodeNumber ?? ""), 5);
    const date = cleanText(body.date, 10);
    const durationMinutes = Number(body.durationMinutes);
    const type = body.type;
    const allowedDurations = new Set([15, 30, 45, 60, 75, 90, 105, 120]);
    if (!program || programChannel(program) !== channel
      || !["both", type].includes(program.type || "both") || !coParticipant
      || !/^\d{1,5}$/.test(episodeNumber) || Number(episodeNumber) < 1
      || !isValidDate(date) || !allowedDurations.has(durationMinutes)
      || !["live", "recorded"].includes(type)) {
      sendJson(res, 400, { error: "تحقق من نوع البرنامج ورقمه والمشارك الآخر والتاريخ والمدة." });
      return;
    }
    const entry = {
      id: randomBytes(16).toString("hex"),
      userId: user.id,
      role: user.role,
      channel,
      programId: program.id,
      programName: program.name,
      episodeNumber: Number(episodeNumber),
      coParticipant,
      date,
      durationMinutes,
      type,
      status: "pending",
      createdAt: new Date().toISOString(),
      hourlyRate: hourlyRate(channel, type, user.role),
    };
    entry.amount = entryAmount(entry);
    store.entries.push(entry);
    await persist();
    sendJson(res, 201, { entry: entryForResponse(entry) });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/report") {
    if (!requireAdmin(req, res)) return;
    const channel = requestChannel(url, res);
    if (!channel) return;
    const month = url.searchParams.get("month") || "";
    const userId = url.searchParams.get("userId") || "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(res, 400, { error: "اختر شهراً صحيحاً للكشف." });
      return;
    }
    const entries = store.entries
      .filter((entry) => entryChannel(entry) === channel)
      .filter((entry) => entry.status === "approved")
      .filter((entry) => entry.date.startsWith(month))
      .filter((entry) => !userId || entry.userId === userId)
      .map(entryForResponse)
      .sort((a, b) => a.name.localeCompare(b.name, "ar") || a.date.localeCompare(b.date));
    const totals = new Map();
    const programTotals = new Map();
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
      const programKey = `${entry.userId}:${entry.programId || entry.programName}`;
      const programTotal = programTotals.get(programKey) || {
        userId: entry.userId,
        name: entry.name,
        role: entry.role,
        programName: entry.programName,
        count: 0,
        amount: 0,
      };
      programTotal.count += 1;
      programTotal.amount = Math.round((programTotal.amount + entry.amount + Number.EPSILON) * 100) / 100;
      programTotals.set(programKey, programTotal);
    }
    sendJson(res, 200, {
      channel,
      month,
      entries,
      totals: [...totals.values()].sort((a, b) => a.name.localeCompare(b.name, "ar")),
      programTotals: [...programTotals.values()].sort((a, b) => a.name.localeCompare(b.name, "ar") || a.programName.localeCompare(b.programName, "ar")),
    });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/users") {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, {
      users: store.users
        .map(({ id, name, username, phone, email, role, createdAt }) => ({ id, name, username, phone, email: email || "", role, createdAt }))
        .sort((a, b) => a.name.localeCompare(b.name, "ar")),
    });
    return;
  }

  if (req.method === "PATCH" && route === "/api/admin/users/role") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    if (!["presenter", "sheikh", "monitor"].includes(body.role)) {
      sendJson(res, 400, { error: "الدور المطلوب غير صحيح." });
      return;
    }
    const account = store.users.find((person) => person.id === body.userId);
    if (!account) {
      sendJson(res, 404, { error: "الحساب غير موجود." });
      return;
    }
    account.role = body.role;
    for (const session of sessions.values()) {
      if (session.user.id === account.id) session.user.role = account.role;
    }
    await persist();
    sendJson(res, 200, { user: { id: account.id, name: account.name, username: account.username, role: account.role } });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/programs") {
    if (!requireReviewer(req, res)) return;
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programs = store.programs.filter((program) => programChannel(program) === channel);
    sendJson(res, 200, { channel, programs: [...programs].sort((a, b) => a.name.localeCompare(b.name, "ar")) });
    return;
  }

  const programParticipantsMatch = route.match(/^\/api\/admin\/programs\/([a-f0-9]+)\/participants$/);
  if (programParticipantsMatch && req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const channel = requestChannel(url, res);
    if (!channel) return;
    const program = store.programs.find((item) => item.id === programParticipantsMatch[1]);
    if (!program || programChannel(program) !== channel) {
      sendJson(res, 404, { error: "البرنامج غير موجود." });
      return;
    }
    const users = (program.userIds || []).map((id) => store.users.find((user) => user.id === id)).filter(Boolean)
      .map(({ id, name, role }) => ({ id, name, role }));
    sendJson(res, 200, { users });
    return;
  }

  if (programParticipantsMatch && req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const program = store.programs.find((item) => item.id === programParticipantsMatch[1]);
    if (!program || programChannel(program) !== channel) {
      sendJson(res, 404, { error: "البرنامج غير موجود." });
      return;
    }
    if (!Array.isArray(body.userIds) || body.userIds.some((id) => typeof id !== "string")) {
      sendJson(res, 400, { error: "قائمة المشاركين غير صحيحة." });
      return;
    }
    const userIds = [...new Set(body.userIds)];
    const users = userIds.map((id) => store.users.find((user) => user.id === id));
    if (users.some((user) => !user || !["presenter", "sheikh"].includes(user.role))) {
      sendJson(res, 400, { error: "اختر حسابات مقدمي البرامج أو الشيوخ فقط." });
      return;
    }
    program.userIds = userIds;
    appendAudit("program-participants-updated", sessionUser(req), { programId: program.id, channel, programName: program.name });
    await persist();
    sendJson(res, 200, { users: users.map(({ id, name, role }) => ({ id, name, role })) });
    return;
  }

  if (req.method === "POST" && route === "/api/admin/programs") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const name = cleanText(body.name, 100);
    const type = body.type;
    if (!name || !["live", "recorded"].includes(type)) {
      sendJson(res, 400, { error: "اكتب اسم البرنامج واختر إذا كان مباشراً أو مسجلاً." });
      return;
    }
    if (store.programs.some((program) => programChannel(program) === channel && program.type === type
      && program.name.toLocaleLowerCase("ar") === name.toLocaleLowerCase("ar"))) {
      sendJson(res, 409, { error: "هذا الاسم موجود من قبل ضمن برامج النوع نفسه." });
      return;
    }
    const program = { id: randomBytes(16).toString("hex"), name, type, channel, active: true, userIds: [], createdAt: new Date().toISOString() };
    store.programs.push(program);
    await persist();
    sendJson(res, 201, { program });
    return;
  }

  const programMatch = route.match(/^\/api\/admin\/programs\/([a-f0-9]+)$/);
  if (req.method === "PATCH" && programMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    if (typeof body.active !== "boolean") {
      sendJson(res, 400, { error: "حالة البرنامج غير صحيحة." });
      return;
    }
    const program = store.programs.find((item) => item.id === programMatch[1] && programChannel(item) === channel);
    if (!program) {
      sendJson(res, 404, { error: "البرنامج غير موجود." });
      return;
    }
    program.active = body.active;
    await persist();
    sendJson(res, 200, { program });
    return;
  }

  const reviewMatch = route.match(/^\/api\/admin\/entries\/([a-f0-9]+)\/review$/);
  if (req.method === "PATCH" && reviewMatch) {
    if (!requireReviewer(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    if (!["approved", "rejected"].includes(body.status)) {
      sendJson(res, 400, { error: "حالة المراجعة غير صحيحة." });
      return;
    }
    const reason = cleanText(body.reason, 500);
    if (body.status === "rejected" && !reason) {
      sendJson(res, 400, { error: "اكتب سبب رفض المشاركة." });
      return;
    }
    const entry = store.entries.find((item) => item.id === reviewMatch[1] && entryChannel(item) === channel);
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
    const reviewer = sessionUser(req);
    entry.reviewedBy = reviewer.id;
    entry.reviewedByName = reviewer.name;
    entry.reviewReason = reason;
    appendAudit(`entry-${body.status}`, reviewer, {
      entryId: entry.id,
      channel,
      programName: entry.programName,
      date: entry.date,
      reason,
    });
    await persist();
    sendJson(res, 200, { entry: entryForResponse(entry) });
    return;
  }

  const bookingReviewMatch = route.match(/^\/api\/admin\/bookings\/([a-f0-9]+)\/review$/);
  if (req.method === "PATCH" && bookingReviewMatch) {
    if (!requireReviewer(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    if (!["approved", "rejected", "no_show"].includes(body.status)) {
      sendJson(res, 400, { error: "قرار مراجعة الحجز غير صحيح." });
      return;
    }
    const booking = store.bookings.find((item) => item.id === bookingReviewMatch[1] && item.channel === channel);
    if (!booking || !["completed_pending", "booked"].includes(booking.status)) {
      sendJson(res, 404, { error: "الحجز غير موجود أو تمت مراجعته." });
      return;
    }
    if (body.status === "approved" && booking.status !== "completed_pending") {
      sendJson(res, 409, { error: "لا يعتمد الحجز قبل أن يؤكد صاحبه إتمام التسجيل." });
      return;
    }
    if (booking.status === "booked" && new Date(`${booking.date}T${booking.endTime}:00+02:00`) > new Date()) {
      sendJson(res, 409, { error: "لا يمكن مراجعة حجز قبل انتهاء موعده." });
      return;
    }
    const reviewer = sessionUser(req);
    const reason = cleanText(body.reason, 500);
    if (body.status !== "approved" && !reason) {
      sendJson(res, 400, { error: "اكتب سبب الرفض أو عدم إتمام التسجيل." });
      return;
    }
    booking.status = body.status;
    booking.reviewedAt = new Date().toISOString();
    booking.reviewedBy = reviewer.id;
    booking.reviewedByName = reviewer.name;
    booking.reviewReason = reason;
    if (body.status === "approved") {
      const owner = store.users.find((person) => person.id === booking.userId);
      if (!owner) {
        sendJson(res, 409, { error: "صاحب الحجز غير موجود؛ تعذر إنشاء مشاركة المستحقات." });
        return;
      }
      const entry = {
        id: randomBytes(16).toString("hex"),
        userId: owner.id,
        role: owner.role,
        channel,
        programId: booking.programId,
        programName: booking.programName,
        episodeNumber: booking.episodeNumber,
        coParticipant: booking.coParticipant,
        date: booking.date,
        durationMinutes: booking.durationMinutes,
        type: booking.programType,
        status: "approved",
        createdAt: booking.completedAt,
        reviewedAt: booking.reviewedAt,
        reviewedBy: reviewer.id,
        reviewedByName: reviewer.name,
        bookingId: booking.id,
        hourlyRate: hourlyRate(channel, booking.programType, owner.role),
      };
      entry.amount = entryAmount(entry);
      store.entries.push(entry);
      booking.duesEntryId = entry.id;
    }
    appendAudit(`booking-${body.status}`, reviewer, {
      bookingId: booking.id,
      channel,
      programName: booking.programName,
      date: booking.date,
      reason,
    });
    await persist();
    sendJson(res, 200, { booking });
    return;
  }

  if (req.method === "GET" && route === "/api/episodes/programs") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programs = ["admin", "monitor"].includes(user.role)
      ? store.programs.filter((program) => programChannel(program) === channel)
      : store.programs.filter((program) => programChannel(program) === channel && assignedProgram(program, user.id));
    sendJson(res, 200, { channel, programs: programs.map((program) => ({ id: program.id, name: program.name })) });
    return;
  }

  if (req.method === "GET" && route === "/api/episodes/participants") {
    if (!requireReviewer(req, res)) return;
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programId = url.searchParams.get("programId") || "";
    const program = store.programs.find((item) => item.id === programId);
    if (!program || programChannel(program) !== channel) {
      sendJson(res, 404, { error: "البرنامج غير موجود." });
      return;
    }
    const users = (program.userIds || []).map((id) => store.users.find((person) => person.id === id)).filter(Boolean)
      .filter((person) => ["sheikh", "presenter"].includes(person.role))
      .map(({ id, name, role }) => ({ id, name, role }));
    sendJson(res, 200, { users });
    return;
  }

  if (req.method === "GET" && route === "/api/episodes") {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const programId = url.searchParams.get("programId") || "";
    const program = store.programs.find((item) => item.id === programId);
    if (!program || programChannel(program) !== channel
      || (!["admin", "monitor"].includes(user.role) && !assignedProgram(program, user.id))) {
      sendJson(res, 403, { error: "البرنامج غير موجود أو غير مرتبط بحسابك." });
      return;
    }
    const episodes = store.episodes
      .filter((episode) => episode.programId === programId && episodeVisibleTo(episode, user))
      .sort((a, b) => b.date.localeCompare(a.date) || b.episodeNumber - a.episodeNumber)
      .map((episode) => episodeForResponse(episode, user));
    sendJson(res, 200, { episodes });
    return;
  }

  const episodeMediaMatch = route.match(/^\/api\/episodes\/([a-f0-9]+)\/media$/);
  if (req.method === "GET" && episodeMediaMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const episode = store.episodes.find((item) => item.id === episodeMediaMatch[1]);
    if (!episode || programChannel(store.programs.find((program) => program.id === episode.programId)) !== channel
      || !episodeVisibleTo(episode, user)) {
      sendJson(res, 404, { error: "ملف الحلقة غير موجود أو ليست لديك صلاحية الوصول إليه." });
      return;
    }
    const versionIndex = Number(url.searchParams.get("version") || episode.versions.length - 1);
    const version = episode.versions[versionIndex];
    if (!Number.isInteger(versionIndex) || !version) {
      sendJson(res, 404, { error: "نسخة التسجيل غير موجودة." });
      return;
    }
    await sendProtectedFile(req, res, version.path, version.mimeType, version.originalFileName, url.searchParams.get("download") === "1");
    return;
  }

  if (req.method === "POST" && route === "/api/admin/episodes") {
    if (!requireReviewer(req, res)) return;
    const upload = await parseMediaUpload(req);
    const { programId, episodeNumber, date, channel } = upload.fields;
    let sheikhIds;
    let presenterIds;
    try {
      sheikhIds = JSON.parse(upload.fields.sheikhIds || "[]");
      presenterIds = JSON.parse(upload.fields.presenterIds || "[]");
    } catch {
      await fs.rm(upload.tempPath, { force: true });
      sendJson(res, 400, { error: "قائمة المشاركين غير صحيحة." });
      return;
    }
    const program = store.programs.find((item) => item.id === programId);
    const number = Number(episodeNumber);
    const eligibleIds = new Set((program?.userIds || []));
    const validParticipantList = (ids, role) => Array.isArray(ids) && ids.length > 0
      && ids.every((id) => typeof id === "string" && eligibleIds.has(id)
        && store.users.some((person) => person.id === id && person.role === role));
    if (!CHANNELS.includes(channel) || !program || programChannel(program) !== channel
      || !Number.isInteger(number) || number < 1 || number > 99999
      || !isValidDate(date) || !validParticipantList(sheikhIds, "sheikh")
      || !validParticipantList(presenterIds, "presenter")) {
      await fs.rm(upload.tempPath, { force: true });
      sendJson(res, 400, { error: "اختر برنامجاً، رقم حلقة، تاريخاً، وشيخاً ومقدماً مرتبطين به." });
      return;
    }
    const reviewer = sessionUser(req);
    const existing = store.episodes.find((item) => item.programId === program.id && item.episodeNumber === number);
    const episode = existing || {
      id: randomBytes(16).toString("hex"),
      programId: program.id,
      channel,
      programName: program.name,
      episodeNumber: number,
      corrections: [],
      versions: [],
      createdAt: new Date().toISOString(),
    };
    const mediaName = `${episode.id}-${randomBytes(8).toString("hex")}${upload.extension}`;
    const finalPath = path.join(MEDIA_DIR, mediaName);
    await fs.rename(upload.tempPath, finalPath);
    const version = {
      path: finalPath,
      originalFileName: upload.originalFileName,
      mimeType: upload.mimeType,
      size: upload.size,
      uploadedAt: new Date().toISOString(),
      uploadedById: reviewer.id,
      uploadedByName: reviewer.name,
    };
    episode.versions.push(version);
    episode.date = date;
    episode.channel = channel;
    episode.sheikhIds = sheikhIds;
    episode.presenterIds = presenterIds;
    episode.sheikhNames = sheikhIds.map((id) => store.users.find((person) => person.id === id).name);
    episode.presenterNames = presenterIds.map((id) => store.users.find((person) => person.id === id).name);
    episode.originalFileName = version.originalFileName;
    episode.mimeType = version.mimeType;
    episode.size = version.size;
    episode.uploadedAt = version.uploadedAt;
    episode.uploadedById = reviewer.id;
    episode.uploadedByName = reviewer.name;
    if (!existing) store.episodes.push(episode);
    appendAudit(existing ? "episode-media-replaced" : "episode-uploaded", reviewer, {
      episodeId: episode.id,
      channel,
      programName: program.name,
      episodeNumber: number,
    });
    await persist();
    sendJson(res, existing ? 200 : 201, { episode: episodeForResponse(episode, reviewer) });
    return;
  }

  const correctionCreateMatch = route.match(/^\/api\/episodes\/([a-f0-9]+)\/corrections$/);
  if (req.method === "POST" && correctionCreateMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const episode = store.episodes.find((item) => item.id === correctionCreateMatch[1]);
    if (!episode || programChannel(store.programs.find((program) => program.id === episode.programId)) !== channel
      || !episodeVisibleTo(episode, user) || user.role !== "sheikh") {
      sendJson(res, 403, { error: "إرسال ملاحظات التعديل متاح للشيوخ المرتبطين بالحلقة فقط." });
      return;
    }
    const text = cleanText(body.text, 5000);
    if (!text) {
      sendJson(res, 400, { error: "اكتب ملاحظة التعديل." });
      return;
    }
    const request = {
      id: randomBytes(16).toString("hex"),
      episodeId: episode.id,
      authorId: user.id,
      authorName: user.name,
      text,
      status: "pending",
      revisions: [],
      createdAt: new Date().toISOString(),
    };
    episode.corrections.push(request);
    appendAudit("correction-submitted", user, { episodeId: episode.id, correctionId: request.id, channel, programName: episode.programName });
    await persist();
    const notification = await sendMonitorEmail("ملاحظة تعديل على حلقة", `أرسل ${user.name} ملاحظة على الحلقة ${episode.episodeNumber} من برنامج ${episode.programName}.`, true);
    sendJson(res, 201, { correction: request, notificationWarning: notification.warning || "" });
    return;
  }

  const correctionResubmitMatch = route.match(/^\/api\/corrections\/([a-f0-9]+)$/);
  if (req.method === "PATCH" && correctionResubmitMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const episode = store.episodes.find((item) => programChannel(store.programs.find((program) => program.id === item.programId)) === channel
      && item.corrections.some((correction) => correction.id === correctionResubmitMatch[1]));
    const correction = episode?.corrections.find((item) => item.id === correctionResubmitMatch[1]);
    if (!correction || correction.authorId !== user.id || !["needs_revision", "rejected"].includes(correction.status)) {
      sendJson(res, 403, { error: "لا يمكن تعديل هذا الطلب." });
      return;
    }
    const text = cleanText(body.text, 5000);
    if (!text) {
      sendJson(res, 400, { error: "اكتب نص التعديل الجديد." });
      return;
    }
    correction.revisions.push({ text: correction.text, reviewResponse: correction.reviewResponse, submittedAt: correction.updatedAt });
    correction.text = text;
    correction.status = "pending";
    correction.reviewResponse = "";
    correction.updatedAt = new Date().toISOString();
    appendAudit("correction-resubmitted", user, { episodeId: correction.episodeId, correctionId: correction.id, channel });
    await persist();
    const notification = await sendMonitorEmail("إعادة إرسال ملاحظة تعديل", `أعاد ${user.name} إرسال ملاحظة تعديل بعد استكمال المطلوب.`, true);
    sendJson(res, 200, { correction, notificationWarning: notification.warning || "" });
    return;
  }

  const correctionReviewMatch = route.match(/^\/api\/admin\/corrections\/([a-f0-9]+)\/review$/);
  if (req.method === "PATCH" && correctionReviewMatch) {
    if (!requireReviewer(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    if (!["approved", "needs_revision", "rejected"].includes(body.status)) {
      sendJson(res, 400, { error: "قرار مراجعة التعديل غير صحيح." });
      return;
    }
    const episode = store.episodes.find((item) => programChannel(store.programs.find((program) => program.id === item.programId)) === channel
      && item.corrections.some((correction) => correction.id === correctionReviewMatch[1]));
    const correction = episode?.corrections.find((item) => item.id === correctionReviewMatch[1]);
    if (!episode || !correction || correction.status !== "pending") {
      sendJson(res, 404, { error: "طلب التعديل غير موجود أو تمت مراجعته." });
      return;
    }
    const reviewer = sessionUser(req);
    const response = cleanText(body.response, 2000);
    if (body.status !== "approved" && !response) {
      sendJson(res, 400, { error: "اكتب ملاحظات المراجع عند إعادة التعديل أو رفضه." });
      return;
    }
    correction.status = body.status;
    correction.reviewResponse = response || "تم اعتماد التعديل.";
    correction.reviewedAt = new Date().toISOString();
    correction.reviewedBy = reviewer.id;
    correction.reviewedByName = reviewer.name;
    correction.updatedAt = correction.reviewedAt;
    let documentId = "";
    if (body.status === "approved") {
      const buffer = await makeCorrectionDocument(episode, correction);
      await fs.mkdir(ARCHIVE_DIR, { recursive: true });
      documentId = randomBytes(16).toString("hex");
      const documentName = `محضر-تعديل-${episode.episodeNumber}-${documentId.slice(0, 8)}.docx`;
      const filePath = path.join(ARCHIVE_DIR, `${documentId}.docx`);
      await fs.writeFile(filePath, buffer, { flag: "wx" });
      store.archiveFiles.push({
        id: documentId,
        name: documentName,
        kind: "word",
        category: "episode-correction",
        channel,
        month: correction.reviewedAt.slice(0, 7),
        path: filePath,
        createdAt: correction.reviewedAt,
        episodeId: episode.id,
        correctionId: correction.id,
      });
      correction.documentId = documentId;
    }
    appendAudit(`correction-${body.status}`, reviewer, {
      episodeId: episode.id,
      correctionId: correction.id,
      channel,
      programName: episode.programName,
      reason: response,
    });
    await persist();
    sendJson(res, 200, { correction });
    return;
  }

  if (req.method === "GET" && route === "/api/admin/archive") {
    if (!requireAdmin(req, res)) return;
    const month = url.searchParams.get("month") || "";
    const channel = requestChannel(url, res);
    if (!channel) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      sendJson(res, 400, { error: "اختر شهراً صحيحاً للأرشيف." });
      return;
    }
    if (!["radio", "visual"].includes(channel)) {
      sendJson(res, 400, { error: "اختر قناة صحيحة للأرشيف." });
      return;
    }
    const files = store.archiveFiles.filter((item) => item.month === month && (item.channel || "radio") === channel)
      .map(({ id, name, kind, month: fileMonth, createdAt, episodeId, correctionId, category, channel: fileChannel, proposalTitle, authorName }) => ({
        id, name, kind, month: fileMonth, createdAt, episodeId, correctionId, category, channel: fileChannel || "radio",
        proposalTitle, authorName, downloadUrl: `/api/archive/${id}?channel=${channel}`,
      }));
    const decisions = store.auditEvents.filter((event) => event.createdAt.slice(0, 7) === month
      && (event.channel || "radio") === channel && isDecisionEvent(event));
    sendJson(res, 200, { month, channel, files, decisions });
    return;
  }

  const archiveDownloadMatch = route.match(/^\/api\/archive\/([a-f0-9]+)$/);
  if (req.method === "GET" && archiveDownloadMatch) {
    const user = sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "سجّل الدخول أولاً." });
      return;
    }
    const channel = requestChannel(url, res);
    if (!channel) return;
    const archiveFile = store.archiveFiles.find((item) => item.id === archiveDownloadMatch[1]);
    if (!archiveFile || (archiveFile.channel || "radio") !== channel) {
      sendJson(res, 404, { error: "الملف غير موجود في الأرشيف." });
      return;
    }
    const correction = archiveFile.correctionId
      ? store.episodes.flatMap((episode) => episode.corrections).find((item) => item.id === archiveFile.correctionId)
      : null;
    const mayDownload = user.role === "admin"
      || (archiveFile.category === "program-proposal" && archiveFile.authorId === user.id)
      || (archiveFile.kind === "word" && correction
        && (correction.authorId === user.id || ["monitor", "admin"].includes(user.role)));
    if (!mayDownload) {
      sendJson(res, 403, { error: "لا تملك صلاحية تنزيل هذا الملف." });
      return;
    }
    const mime = archiveFile.kind === "word"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "text/csv; charset=utf-8";
    await fs.access(archiveFile.path);
    await sendProtectedFile(req, res, archiveFile.path, mime, archiveFile.name, true);
    return;
  }

  const archiveZipMatch = route.match(/^\/api\/admin\/archive\/(\d{4}-(?:0[1-9]|1[0-2]))\.zip$/);
  if (req.method === "GET" && archiveZipMatch) {
    if (!requireAdmin(req, res)) return;
    const month = archiveZipMatch[1];
    const channel = requestChannel(url, res);
    if (!channel) return;
    const files = store.archiveFiles.filter((item) => item.month === month && (item.channel || "radio") === channel);
    await Promise.all(files.map((file) => fs.access(file.path)));
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="archive-${channel}-${month}.zip"`,
      "Cache-Control": "private, no-store",
    });
    const zip = archiver("zip", { zlib: { level: 6 } });
    zip.on("error", (error) => {
      console.error("تعذر إنشاء حزمة الأرشيف:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "تعذر إنشاء حزمة الأرشيف." });
      else res.destroy(error);
    });
    zip.pipe(res);
    for (const file of files) {
      zip.file(file.path, { name: file.name });
    }
    const decisions = store.auditEvents.filter((event) => event.createdAt.slice(0, 7) === month
      && (event.channel || "radio") === channel && isDecisionEvent(event));
    zip.append(csvBuffer([
      ["نوع القرار", "اسم المراجع", "التاريخ", "البرنامج", "السبب"],
      ...decisions.map((event) => [event.action, event.actorName, event.createdAt, event.programName || "", event.reason || ""]),
    ]), { name: `قرارات-المراجعة-${month}.csv` });
    await zip.finalize();
    return;
  }

  if (req.method === "POST" && route === "/api/admin/report/export") {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const channel = requestBodyChannel(body, res);
    if (!channel) return;
    const month = cleanText(body.month, 7);
    const type = body.type;
    const userId = cleanText(body.userId, 64);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !["summary", "details"].includes(type)) {
      sendJson(res, 400, { error: "بيانات التصدير غير صحيحة." });
      return;
    }
    const entries = store.entries.filter((entry) => entryChannel(entry) === channel && entry.status === "approved"
      && entry.date.startsWith(month) && (!userId || entry.userId === userId))
      .map(entryForResponse);
    if (!entries.length) {
      sendJson(res, 404, { error: "لا توجد بيانات معتمدة للتصدير." });
      return;
    }
    const rows = type === "details"
      ? [
        ["اسم المشارك", "الصفة", "البرنامج", "رقم الحلقة", "تاريخ البرنامج", "تاريخ التسجيل", "تاريخ المراجعة", "اعتمدها", "نوع البرنامج", "المدة بالدقائق", "سعر الساعة بالدينار", "المستحق بالدينار"],
        ...entries.map((entry) => [
          entry.name, entry.role === "sheikh" ? "شيخ" : "مقدم / مقدمة", entry.programName, entry.episodeNumber, entry.date, entry.createdAt,
          entry.reviewedAt, entry.reviewerName, entry.type === "recorded" ? "مسجل" : "مباشر", entry.durationMinutes, entry.hourlyRate.toFixed(2), entry.amount.toFixed(2),
        ]),
      ]
      : [
        ["اسم المشارك", "الصفة", "البرنامج", "عدد المشاركات", "إجمالي المستحق بالدينار"],
        ...(() => {
          const totals = new Map();
          for (const entry of entries) {
            const key = `${entry.userId}:${entry.programId}`;
            const item = totals.get(key) || { name: entry.name, role: entry.role, programName: entry.programName, count: 0, amount: 0 };
            item.count += 1;
            item.amount = Math.round((item.amount + entry.amount + Number.EPSILON) * 100) / 100;
            totals.set(key, item);
          }
          return [...totals.values()].map((item) => [item.name, item.role === "sheikh" ? "شيخ" : "مقدم / مقدمة", item.programName, item.count, item.amount.toFixed(2)]);
        })(),
      ];
    const name = `${channel}-${type === "details" ? "تفصيل-المستحقات" : "اجمالي-البرامج"}-${month}.csv`;
    const file = await saveArchiveFile({
      name, kind: "csv", month, buffer: csvBuffer(rows), details: { reportType: type, channel, category: "dues-report" },
    });
    sendJson(res, 200, { file: { id: file.id, name: file.name, downloadUrl: `/api/archive/${file.id}?channel=${channel}` } });
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
      "Cache-Control": "no-cache",
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
  if (!validUsername(ADMIN_USERNAME)) {
    throw new Error("عيّن ADMIN_USERNAME من 3 إلى 30 حرفاً إنجليزياً أو رقماً.");
  }
  await Promise.all([
    fs.mkdir(DATA_DIR, { recursive: true }),
    fs.mkdir(MEDIA_DIR, { recursive: true }),
    fs.mkdir(ARCHIVE_DIR, { recursive: true }),
  ]);
  const legacyDataFile = path.join(__dirname, "data", "records.json");
  if (process.env.NODE_ENV === "production" && path.resolve(legacyDataFile) !== path.resolve(DATA_FILE)) {
    try {
      await fs.copyFile(legacyDataFile, DATA_FILE, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
    }
  }
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (!Array.isArray(saved.users) || !Array.isArray(saved.entries)) throw new Error("صيغة ملف البيانات غير صحيحة.");
    store = {
      ...saved,
      programs: Array.isArray(saved.programs) ? saved.programs : [],
      bookings: Array.isArray(saved.bookings) ? saved.bookings : [],
      episodes: Array.isArray(saved.episodes) ? saved.episodes : [],
      auditEvents: Array.isArray(saved.auditEvents) ? saved.auditEvents : [],
      archiveFiles: Array.isArray(saved.archiveFiles) ? saved.archiveFiles : [],
      rates: normalizedRates(saved.rates),
    };
    for (const entry of store.entries) {
      if (!entry.programName) continue;
      let program = store.programs.find((item) => item.id === entry.programId)
        || store.programs.find((item) => item.name === entry.programName);
      if (!program) {
        program = {
          id: randomBytes(16).toString("hex"),
          name: entry.programName,
          type: "both",
          channel: CHANNELS.includes(entry.channel) ? entry.channel : "radio",
          active: true,
          createdAt: entry.createdAt || new Date().toISOString(),
        };
        store.programs.push(program);
      }
      entry.programId = program.id;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const program of store.programs) {
    if (!Array.isArray(program.userIds)) program.userIds = [];
    if (!CHANNELS.includes(program.channel)) program.channel = "radio";
  }
  for (const entry of store.entries) {
    const program = store.programs.find((item) => item.id === entry.programId);
    if (!CHANNELS.includes(entry.channel)) entry.channel = programChannel(program);
    if (!Number.isFinite(entry.hourlyRate)) entry.hourlyRate = hourlyRate(entry.channel, entry.type, entry.role);
    if (!Number.isFinite(entry.amount)) entry.amount = entryAmount(entry);
    if (!entry.reviewedAt || !["approved", "rejected"].includes(entry.status)
      || store.auditEvents.some((event) => event.entryId === entry.id)) continue;
    store.auditEvents.push({
      id: randomBytes(16).toString("hex"),
      action: `entry-${entry.status}`,
      actorId: entry.reviewedBy || "",
      actorName: entry.reviewedByName || (entry.reviewedBy === "admin" ? "الإدارة العليا" : "مراجع سابق"),
      createdAt: entry.reviewedAt,
      entryId: entry.id,
      channel: entry.channel,
      programName: entry.programName,
      date: entry.date,
      reason: entry.reviewReason || "",
    });
  }
  store.rates ||= normalizedRates();
  for (const booking of store.bookings) {
    const program = store.programs.find((item) => item.id === booking.programId);
    if (!CHANNELS.includes(booking.channel)) booking.channel = programChannel(program);
  }
  for (const episode of store.episodes) {
    const program = store.programs.find((item) => item.id === episode.programId);
    if (!CHANNELS.includes(episode.channel)) episode.channel = programChannel(program);
  }
  for (const event of store.auditEvents) {
    if (CHANNELS.includes(event.channel)) continue;
    const booking = store.bookings.find((item) => item.id === event.bookingId);
    const episode = store.episodes.find((item) => item.id === event.episodeId);
    const program = store.programs.find((item) => item.id === event.programId);
    event.channel = booking?.channel || episode?.channel || programChannel(program);
  }
  for (const file of store.archiveFiles) {
    if (!CHANNELS.includes(file.channel)) file.channel = "radio";
    if (file.correctionId && !file.category) file.category = "episode-correction";
  }
  if (!store.adminCredentials) {
    if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
      throw new Error("عيّن ADMIN_PASSWORD (8 أحرف على الأقل) عند أول تشغيل لإنشاء حساب الإدارة.");
    }
    store.adminCredentials = await hashPassword(ADMIN_PASSWORD, ADMIN_SALT);
  }
  await persist();
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
      if (res.headersSent) {
        console.error("تعذر إكمال إرسال الاستجابة:", error);
        res.destroy(error);
        return;
      }
      if (error.status) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error("خطأ في معالجة الطلب:", error);
      sendJson(res, 500, { error: "صار خطأ أثناء تنفيذ الطلب. حاول مرة ثانية." });
    }
  });
  server.requestTimeout = 20 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.listen(PORT, () => {
    console.log(`موقع مستحقات الراديو يعمل على http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

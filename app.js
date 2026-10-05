const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view");
const memberView = $("#member-view");
const adminView = $("#admin-view");
const authMessage = $("#auth-message");
let currentUser = null;
let latestReport = { month: "", entries: [], totals: [], programTotals: [] };
let adminUsername = "admin";
let activePrograms = [];
let workspaceUsers = [];

const roleNames = { presenter: "مقدم / مقدمة", sheikh: "شيخ", monitor: "مراقب", admin: "الإدارة العليا" };
const statusNames = { pending: "بانتظار المراجعة", approved: "معتمد", rejected: "مرفوض" };
const typeNames = { live: "مباشر", recorded: "مسجل" };
const money = (amount) => `${Number(amount).toLocaleString("ar-LY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} د.ل`;
const localDate = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};
const currentMonth = () => localDate().slice(0, 7);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const formatDate = (value) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("ar-LY") : "—";
const formatDateTime = (value) => value ? new Date(value).toLocaleString("ar-LY") : "—";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "تعذر تنفيذ الطلب.");
  return body;
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function showView(user) {
  currentUser = user;
  authView.hidden = Boolean(user);
  memberView.hidden = !user || !["presenter", "sheikh"].includes(user.role);
  adminView.hidden = !user || !["admin", "monitor"].includes(user.role);
  const header = $("#header-user");
  header.hidden = !user;
  header.replaceChildren();
  if (!user) return;

  const label = document.createElement("span");
  label.textContent = `${user.name} · ${roleNames[user.role]}`;
  const logout = document.createElement("button");
  logout.type = "button";
  logout.textContent = "تسجيل الخروج";
  logout.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      showView(null);
    } catch (error) {
      const message = user.role === "admin" || user.role === "monitor" ? $("#admin-message") : $("#entry-message");
      setMessage(message, error.message, true);
    }
  });
  header.append(label, logout);

  if (user.role === "admin" || user.role === "monitor") {
    const isAdmin = user.role === "admin";
    $("#workspace-title").textContent = isAdmin ? "مراجعة وإدارة المستحقات" : "مراجعة طلبات المشاركات";
    $("#workspace-description").textContent = isAdmin
      ? "راجع المشاركات المعتمدة، وأدر البرامج والحسابات، وأصدر الكشوف الشهرية."
      : "راجع المشاركات المسجلة واعتمدها أو أعدها بالرفض.";
    $("#workspace-role").textContent = roleNames[user.role];
    $("#reports-panel").hidden = !isAdmin;
    $("#admin-tools").hidden = !isAdmin;
    loadReviewerWorkspace().catch((error) => setMessage($("#admin-message"), error.message, true));
  } else {
    $("#member-name").textContent = user.name;
    $("#member-role").textContent = roleNames[user.role];
    $("#co-label").firstChild.textContent = user.role === "sheikh" ? "اسم المقدم" : "اسم الشيخ";
    loadMember().catch((error) => setMessage($("#entry-message"), error.message, true));
  }
}

function selectAuthTab(tab) {
  const login = tab === "login";
  $("#login-tab").classList.toggle("active", login);
  $("#register-tab").classList.toggle("active", !login);
  $("#login-tab").setAttribute("aria-selected", String(login));
  $("#register-tab").setAttribute("aria-selected", String(!login));
  $("#login-form").hidden = !login;
  $("#register-form").hidden = login;
  setMessage(authMessage, "");
}

$("#login-tab").addEventListener("click", () => selectAuthTab("login"));
$("#register-tab").addEventListener("click", () => selectAuthTab("register"));
$("#admin-hint").addEventListener("click", () => {
  $("#login-form").elements.username.value = adminUsername;
  $("#login-form").elements.password.focus();
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const { user } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    formElement.reset();
    setMessage(authMessage, "");
    showView(user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const { user } = await api("/api/register", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    formElement.reset();
    setMessage(authMessage, "");
    showView(user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

function hourlyRate(role, type) {
  if (type === "recorded") return role === "sheikh" ? 150 : 100;
  return role === "sheikh" ? 75 : 40;
}

function updateEstimate() {
  if (!currentUser || !["presenter", "sheikh"].includes(currentUser.role)) return;
  const form = $("#entry-form");
  const minutes = Number(form.elements.durationMinutes.value);
  const amount = Number.isInteger(minutes) && minutes > 0
    ? hourlyRate(currentUser.role, form.elements.type.value) * minutes / 60
    : 0;
  $("#entry-estimate").textContent = amount ? money(amount) : "— د.ل";
}

function renderProgramOptions() {
  const select = $("#program-select");
  if (!activePrograms.length) {
    select.innerHTML = '<option value="">لا توجد برامج متاحة حالياً؛ راجع الإدارة العليا.</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = `<option value="">اختر البرنامج</option>${activePrograms.map((program) =>
    `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("")}`;
}

$("#entry-form").elements.type.addEventListener("change", updateEstimate);
$("#entry-form").elements.durationMinutes.addEventListener("input", updateEstimate);

$("#entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const message = $("#entry-message");
  try {
    await api("/api/entries", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    formElement.reset();
    formElement.elements.date.value = localDate();
    updateEstimate();
    setMessage(message, "تم تسجيل المشاركة وإرسالها للمراجعة.");
    await loadMember();
  } catch (error) {
    setMessage(message, error.message, true);
  }
});

function renderMemberEntries(entries) {
  const container = $("#member-entries");
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  const approvedTotal = entries.filter((entry) => entry.status === "approved").reduce((sum, entry) => sum + entry.amount, 0);
  $("#member-summary").innerHTML = `
    <div class="summary-card"><span>كل المشاركات</span><strong>${entries.length.toLocaleString("ar-LY")}</strong></div>
    <div class="summary-card"><span>معتمد · ${counts.approved.toLocaleString("ar-LY")}</span><strong>${money(approvedTotal)}</strong></div>
    <div class="summary-card"><span>بانتظار المراجعة · ${counts.pending.toLocaleString("ar-LY")}</span><strong>${counts.pending.toLocaleString("ar-LY")}</strong></div>
    <div class="summary-card"><span>مرفوض · ${counts.rejected.toLocaleString("ar-LY")}</span><strong>${counts.rejected.toLocaleString("ar-LY")}</strong></div>`;
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">لا توجد مشاركات مسجلة خلال هذا الشهر.</div>';
    return;
  }
  container.innerHTML = entries.map((entry) => `
    <article class="entry-card">
      <strong>${escapeHtml(entry.programName)}</strong>
      <span class="status ${escapeHtml(entry.status)}">${statusNames[entry.status]}</span>
      <div class="entry-meta">
        تاريخ البرنامج: ${formatDate(entry.date)} · ${typeNames[entry.type]} · ${entry.durationMinutes} دقيقة<br>
        المشارك الآخر: ${escapeHtml(entry.coParticipant)}<br>
        التفاصيل المالية: ${entry.durationMinutes} ÷ 60 ساعة × ${money(entry.hourlyRate)} للساعة = ${money(entry.amount)}<br>
        تاريخ التسجيل: ${formatDateTime(entry.createdAt)}<br>
        ${entry.reviewedAt ? `تاريخ المراجعة: ${formatDateTime(entry.reviewedAt)} · راجعها: ${escapeHtml(entry.reviewerName || "الإدارة العليا")}` : "لم تتم المراجعة بعد."}
      </div>
      <span class="amount">${money(entry.amount)}</span>
    </article>
  `).join("");
}

async function loadMember() {
  const month = $("#member-month").value || currentMonth();
  const [{ entries }, { programs }] = await Promise.all([
    api(`/api/entries?month=${encodeURIComponent(month)}`),
    api("/api/programs"),
  ]);
  activePrograms = programs;
  renderProgramOptions();
  renderMemberEntries(entries);
}

$("#member-month").addEventListener("change", () => loadMember().catch((error) => setMessage($("#entry-message"), error.message, true)));
$("#refresh-member").addEventListener("click", () => loadMember().catch((error) => setMessage($("#entry-message"), error.message, true)));

function renderPending(entries) {
  const pending = entries.filter((entry) => entry.status === "pending");
  const container = $("#pending-entries");
  if (!pending.length) {
    container.innerHTML = '<div class="empty-state">لا توجد طلبات جديدة للمراجعة.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>الصفة</th><th>البرنامج</th><th>المشارك الآخر</th><th>تاريخ البرنامج</th><th>تاريخ التسجيل</th><th>النوع</th><th>المدة</th><th>المستحق</th><th>الإجراء</th></tr></thead><tbody>${pending.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.name)}</td><td>${roleNames[entry.role]}</td><td>${escapeHtml(entry.programName)}</td>
      <td>${escapeHtml(entry.coParticipant)}</td><td>${formatDate(entry.date)}</td><td>${formatDateTime(entry.createdAt)}</td>
      <td>${typeNames[entry.type]}</td><td>${entry.durationMinutes} دقيقة</td>
      <td>${money(entry.amount)}</td><td><div class="row-actions">
        <button class="button approve" data-review="${entry.id}" data-status="approved" type="button">اعتماد</button>
        <button class="button reject" data-review="${entry.id}" data-status="rejected" type="button">رفض</button>
      </div></td>
    </tr>`).join("")}</tbody></table>`;
  container.querySelectorAll("[data-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/entries/${button.dataset.review}/review`, {
          method: "PATCH",
          body: JSON.stringify({ status: button.dataset.status }),
        });
        await loadReviewerWorkspace();
        setMessage($("#admin-message"), "تم تسجيل قرار المراجعة.");
      } catch (error) {
        button.disabled = false;
        setMessage($("#admin-message"), error.message, true);
      }
    });
  });
}

function renderReport(report) {
  latestReport = report;
  const total = report.totals.reduce((sum, person) => sum + person.amount, 0);
  const userLabel = $("#report-user").selectedOptions[0]?.textContent || "كل المشاركين";
  $("#report-summary").innerHTML = `
    <div class="summary-card"><span>إجمالي المستحقات المعتمدة</span><strong>${money(total)}</strong></div>
    <div class="summary-card"><span>المشارك المحدد</span><strong class="summary-label">${escapeHtml(userLabel)}</strong></div>
    <div class="summary-card"><span>عدد المشاركات المعتمدة</span><strong>${report.entries.length.toLocaleString("ar-LY")}</strong></div>`;
  const container = $("#report-table");
  if (!report.programTotals.length) {
    container.innerHTML = '<div class="empty-state">لا توجد مستحقات معتمدة للشهر والمشارك المحددين.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>البرنامج</th><th>عدد المشاركات</th><th>الإجمالي</th></tr></thead><tbody>${report.programTotals.map((item) => `
    <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.programName)}</td><td>${item.count}</td><td><strong>${money(item.amount)}</strong></td></tr>
  `).join("")}</tbody></table>`;
}

function reportUrl() {
  const form = new FormData($("#report-filter"));
  const params = new URLSearchParams({ month: form.get("month") || currentMonth() });
  if (form.get("userId")) params.set("userId", form.get("userId"));
  return `/api/admin/report?${params}`;
}

async function loadReports() {
  const [{ users }, report] = await Promise.all([
    api("/api/admin/users"),
    api(reportUrl()),
  ]);
  workspaceUsers = users;
  const select = $("#report-user");
  const selected = select.value;
  select.innerHTML = `<option value="">كل المشاركين</option>${users.filter((user) => ["presenter", "sheikh"].includes(user.role) || report.totals.some((person) => person.userId === user.id)).map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${roleNames[user.role]}</option>`).join("")}`;
  select.value = selected;
  renderReport(report);
}

async function loadReviewerWorkspace() {
  const { entries } = await api("/api/entries");
  renderPending(entries);
  if (currentUser.role === "admin") {
    await Promise.all([loadReports(), loadProgramsAdmin(), loadUsersAdmin()]);
  }
}

$("#report-filter").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    renderReport(await api(reportUrl()));
    setMessage($("#admin-message"), "");
  } catch (error) {
    setMessage($("#admin-message"), error.message, true);
  }
});
$("#report-user").addEventListener("change", () => $("#report-filter").requestSubmit());
$("#refresh-admin").addEventListener("click", () => loadReviewerWorkspace().catch((error) => setMessage($("#admin-message"), error.message, true)));

function csvDownload(filename, rows) {
  const csv = `\uFEFF${rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function selectedPersonName() {
  const selected = $("#report-user").selectedOptions[0];
  return selected?.value ? selected.textContent.split(" · ")[0] : "";
}

function exportSummary() {
  if (!latestReport.programTotals.length) {
    setMessage($("#admin-message"), "لا توجد بيانات لتصديرها.", true);
    return;
  }
  csvDownload(`اجمالي-البرامج-${latestReport.month}.csv`, [
    ["اسم المشارك", "الصفة", "البرنامج", "عدد المشاركات", "إجمالي المستحق بالدينار"],
    ...latestReport.programTotals.map((item) => [item.name, roleNames[item.role], item.programName, item.count, item.amount.toFixed(2)]),
  ]);
}

function exportDetails() {
  if (!latestReport.entries.length) {
    setMessage($("#admin-message"), "لا توجد بيانات لتصديرها.", true);
    return;
  }
  csvDownload(`تفصيل-المستحقات-${latestReport.month}.csv`, [
    ["اسم المشارك", "الصفة", "البرنامج", "تاريخ البرنامج", "تاريخ التسجيل", "تاريخ المراجعة", "اعتمدها", "نوع البرنامج", "المدة بالدقائق", "سعر الساعة بالدينار", "المستحق بالدينار"],
    ...latestReport.entries.map((entry) => [
      entry.name, roleNames[entry.role], entry.programName, entry.date, formatDateTime(entry.createdAt),
      formatDateTime(entry.reviewedAt), entry.reviewerName, typeNames[entry.type], entry.durationMinutes,
      entry.hourlyRate.toFixed(2), entry.amount.toFixed(2),
    ]),
  ]);
}

function monthLabel(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString("ar-LY", { month: "long", year: "numeric" });
}

function printReport(detail) {
  const personName = selectedPersonName();
  if (!latestReport.entries.length || !personName) {
    setMessage($("#admin-message"), personName ? "لا توجد مشاركات معتمدة للطباعة." : "اختر مشاركاً محدداً لإعداد خطاب المستحقات.", true);
    return;
  }
  const programRows = latestReport.programTotals.map((item) =>
    `<tr><td>${escapeHtml(item.programName)}</td><td>${item.count.toLocaleString("ar-LY")}</td><td>${money(item.amount)}</td></tr>`).join("");
  const detailRows = latestReport.entries.map((entry, index) =>
    `<tr><td>${(index + 1).toLocaleString("ar-LY")}</td><td>${escapeHtml(entry.programName)}</td><td>${formatDate(entry.date)}</td><td>${formatDateTime(entry.createdAt)}</td><td>${typeNames[entry.type]}</td><td>${entry.durationMinutes.toLocaleString("ar-LY")} دقيقة × ${money(entry.hourlyRate)}</td><td>${formatDateTime(entry.reviewedAt)}</td><td>${escapeHtml(entry.reviewerName || "الإدارة العليا")}</td><td>${money(entry.amount)}</td></tr>`).join("");
  const total = latestReport.entries.reduce((sum, entry) => sum + entry.amount, 0);
  const printDocument = $("#print-document");
  printDocument.innerHTML = `
    <header class="print-heading">
      <div class="bismillah">بسم الله الرحمن الرحيم</div>
      <div>التاريخ: ${formatDate(localDate())}</div>
    </header>
    <p class="print-recipient">السيد مدير الشؤون الإدارية والمالية المحترم</p>
    <p class="print-greeting">تحية طيبة وبعد،<br>السلام عليكم ورحمة الله وبركاته،</p>
    <p class="print-body">نحيل إليكم كشف مستحقات برامج إذاعة دار الإفتاء الليبية عن شهر <strong>${escapeHtml(monthLabel(latestReport.month))}</strong>، والخاصة بـ<strong>${escapeHtml(personName)}</strong>، وذلك حسب المشاركات المعتمدة الموضحة أدناه.</p>
    <h2>إجمالي المستحقات حسب البرنامج</h2>
    <table><thead><tr><th>البرنامج</th><th>عدد المشاركات</th><th>الإجمالي</th></tr></thead><tbody>${programRows}<tr class="grand-total"><td colspan="2">الإجمالي العام</td><td>${money(total)}</td></tr></tbody></table>
    ${detail ? `<h2>التفصيل المالي وسجل المراجعة</h2><table class="print-detail-table"><thead><tr><th>م</th><th>البرنامج</th><th>تاريخ البرنامج</th><th>تاريخ التسجيل</th><th>النوع</th><th>المدة × سعر الساعة</th><th>تاريخ المراجعة</th><th>اعتمدها</th><th>المستحق</th></tr></thead><tbody>${detailRows}</tbody></table>` : ""}
    <p class="print-closing">وتفضلوا بقبول فائق الاحترام والتقدير.</p>
    <div class="signature">الاسم: ____________________<br>التوقيع: __________________</div>`;
  document.body.classList.add("printing");
  window.print();
  window.addEventListener("afterprint", () => document.body.classList.remove("printing"), { once: true });
}

$("#export-summary").addEventListener("click", exportSummary);
$("#export-details").addEventListener("click", exportDetails);
$("#print-summary").addEventListener("click", () => printReport(false));
$("#print-details").addEventListener("click", () => printReport(true));

async function loadProgramsAdmin() {
  const { programs } = await api("/api/admin/programs");
  $("#program-list").innerHTML = programs.length
    ? `<table><thead><tr><th>البرنامج</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>${programs.map((program) => `
      <tr><td>${escapeHtml(program.name)}</td><td>${program.active ? "متاح للتسجيل" : "موقوف"}</td><td><button class="button subtle" data-program="${program.id}" data-active="${!program.active}" type="button">${program.active ? "إيقاف التسجيل" : "إعادة التفعيل"}</button></td></tr>
    `).join("")}</tbody></table>`
    : '<div class="empty-state">أضف البرامج لتظهر للمقدمين والشيوخ في نموذج التسجيل.</div>';
  $("#program-list").querySelectorAll("[data-program]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/admin/programs/${button.dataset.program}`, { method: "PATCH", body: JSON.stringify({ active: button.dataset.active === "true" }) });
        await loadProgramsAdmin();
        setMessage($("#admin-message"), "تم تحديث قائمة البرامج.");
      } catch (error) {
        setMessage($("#admin-message"), error.message, true);
      }
    });
  });
}

$("#program-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/admin/programs", { method: "POST", body: JSON.stringify({ name: new FormData(form).get("name") }) });
    form.reset();
    await loadProgramsAdmin();
    setMessage($("#admin-message"), "تمت إضافة البرنامج.");
  } catch (error) {
    setMessage($("#admin-message"), error.message, true);
  }
});

async function loadUsersAdmin() {
  const { users } = await api("/api/admin/users");
  workspaceUsers = users;
  $("#user-list").innerHTML = users.length
    ? `<table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الهاتف</th><th>الصلاحية</th><th>تعديل</th></tr></thead><tbody>${users.map((user) => `
      <tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.phone)}</td>
      <td><select data-role="${user.id}" aria-label="صلاحية ${escapeHtml(user.name)}">
        <option value="presenter" ${user.role === "presenter" ? "selected" : ""}>مقدم / مقدمة</option>
        <option value="sheikh" ${user.role === "sheikh" ? "selected" : ""}>شيخ</option>
        <option value="monitor" ${user.role === "monitor" ? "selected" : ""}>مراقب</option>
      </select></td><td><button class="button subtle" data-save-role="${user.id}" type="button">حفظ الصلاحية</button></td></tr>
    `).join("")}</tbody></table>`
    : '<div class="empty-state">تظهر هنا الحسابات بعد إنشاء المستخدمين حساباتهم.</div>';
  $("#user-list").querySelectorAll("[data-save-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const role = $(`[data-role="${button.dataset.saveRole}"]`).value;
      try {
        await api("/api/admin/users/role", { method: "PATCH", body: JSON.stringify({ userId: button.dataset.saveRole, role }) });
        await loadUsersAdmin();
        setMessage($("#admin-message"), "تم تحديث صلاحية الحساب.");
      } catch (error) {
        setMessage($("#admin-message"), error.message, true);
      }
    });
  });
}

async function initialize() {
  const month = currentMonth();
  $("#entry-form").elements.date.value = localDate();
  $("#member-month").value = month;
  $("#report-month").value = month;
  try {
    const config = await api("/api/config");
    adminUsername = config.adminUsername;
    activePrograms = config.programs;
    renderProgramOptions();
    const { user } = await api("/api/session");
    if (user) showView(user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
}

initialize();

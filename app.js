const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view");
const memberView = $("#member-view");
const adminView = $("#admin-view");
const authMessage = $("#auth-message");
let currentUser = null;
let latestReport = { entries: [], totals: [] };
let adminUsername = "admin";

const roleNames = { presenter: "مقدم / مقدمة", sheikh: "شيخ", admin: "الإدارة" };
const statusNames = { pending: "بانتظار المراجعة", approved: "معتمد", rejected: "مرفوض" };
const money = (amount) => `${Number(amount).toLocaleString("ar-LY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} د.ل`;
const localDate = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

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
  memberView.hidden = !user || user.role === "admin";
  adminView.hidden = !user || user.role !== "admin";
  const header = $("#header-user");
  header.hidden = !user;
  header.replaceChildren();
  if (user) {
    if (user.role !== "admin") {
      $("#member-name").textContent = user.name;
      $("#member-role").textContent = roleNames[user.role];
      $("#co-label").firstChild.textContent = user.role === "sheikh" ? "اسم المقدم" : "اسم الشيخ";
    }
    const label = document.createElement("span");
    label.textContent = `${user.name} · ${roleNames[user.role]}`;
    const logout = document.createElement("button");
    logout.type = "button";
    logout.textContent = "تسجيل الخروج";
    logout.addEventListener("click", async () => {
      await api("/api/logout", { method: "POST", body: "{}" });
      showView(null);
    });
    header.append(label, logout);
    if (user.role === "admin") {
      loadAdmin().catch((error) => setMessage($("#admin-message"), error.message, true));
    } else {
      loadMember().catch((error) => setMessage($("#entry-message"), error.message, true));
    }
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
  if (!currentUser || currentUser.role === "admin") return;
  const form = $("#entry-form");
  const minutes = Number(form.elements.durationMinutes.value);
  const type = form.elements.type.value;
  const amount = Number.isInteger(minutes) && minutes > 0
    ? hourlyRate(currentUser.role, type) * minutes / 60
    : 0;
  $("#entry-estimate").textContent = amount ? money(amount) : "— د.ل";
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
    setMessage(message, "تم إرسال المشاركة للإدارة للمراجعة.");
    await loadMember();
  } catch (error) {
    setMessage(message, error.message, true);
  }
});

function renderMemberEntries(entries) {
  const container = $("#member-entries");
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">ما سجلتش أي مشاركة لحد الآن.</div>';
    return;
  }
  container.innerHTML = entries.map((entry) => `
    <article class="entry-card">
      <strong>${escapeHtml(entry.programName)}</strong>
      <span class="status ${escapeHtml(entry.status)}">${statusNames[entry.status]}</span>
      <div class="entry-meta">${escapeHtml(entry.date)} · ${entry.type === "live" ? "مباشر" : "مسجل"} · ${entry.durationMinutes} دقيقة<br>مع: ${escapeHtml(entry.coParticipant)}</div>
      <span class="amount">${money(entry.amount)}</span>
    </article>
  `).join("");
}

async function loadMember() {
  const { entries } = await api("/api/entries");
  renderMemberEntries(entries);
}
$("#refresh-member").addEventListener("click", () => loadMember().catch((error) => setMessage($("#entry-message"), error.message, true)));

function renderPending(entries) {
  const pending = entries.filter((entry) => entry.status === "pending");
  const container = $("#pending-entries");
  if (!pending.length) {
    container.innerHTML = '<div class="empty-state">ما فيش طلبات جديدة للمراجعة.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>الصفة</th><th>البرنامج</th><th>مع</th><th>التاريخ</th><th>النوع</th><th>المدة</th><th>المستحق</th><th>الإجراء</th></tr></thead><tbody>${pending.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.name)}</td><td>${roleNames[entry.role]}</td><td>${escapeHtml(entry.programName)}</td>
      <td>${escapeHtml(entry.coParticipant)}</td><td>${escapeHtml(entry.date)}</td>
      <td>${entry.type === "live" ? "مباشر" : "مسجل"}</td><td>${entry.durationMinutes} د</td>
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
        await loadAdmin();
        setMessage($("#admin-message"), "تم تحديث حالة الطلب.");
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
  const peopleCount = report.totals.length;
  $("#report-summary").innerHTML = `
    <div class="summary-card"><span>إجمالي المستحقات</span><strong>${money(total)}</strong></div>
    <div class="summary-card"><span>عدد المشاركين</span><strong>${peopleCount.toLocaleString("ar-LY")}</strong></div>
    <div class="summary-card"><span>عدد المشاركات</span><strong>${report.entries.length.toLocaleString("ar-LY")}</strong></div>`;
  const container = $("#report-table");
  if (!report.totals.length) {
    container.innerHTML = '<div class="empty-state">ما فيش مستحقات معتمدة في الفترة المختارة.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الصفة</th><th>عدد المشاركات</th><th>المستحق الإجمالي</th></tr></thead><tbody>${report.totals.map((person) => `
    <tr><td>${escapeHtml(person.name)}</td><td>${escapeHtml(person.username)}</td><td>${roleNames[person.role]}</td><td>${person.count}</td><td><strong>${money(person.amount)}</strong></td></tr>
  `).join("")}</tbody></table>`;
}

async function loadAdmin() {
  const [{ entries }, report] = await Promise.all([
    api("/api/entries"),
    api(reportUrl()),
  ]);
  renderPending(entries);
  renderReport(report);
}

function reportUrl() {
  const form = new FormData($("#report-filter"));
  const params = new URLSearchParams();
  if (form.get("from")) params.set("from", form.get("from"));
  if (form.get("to")) params.set("to", form.get("to"));
  return `/api/admin/report${params.size ? `?${params}` : ""}`;
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
$("#clear-filter").addEventListener("click", async () => {
  $("#report-filter").reset();
  try {
    renderReport(await api("/api/admin/report"));
    setMessage($("#admin-message"), "");
  } catch (error) {
    setMessage($("#admin-message"), error.message, true);
  }
});
$("#refresh-admin").addEventListener("click", () => loadAdmin().catch((error) => setMessage($("#admin-message"), error.message, true)));

$("#export-csv").addEventListener("click", () => {
  if (!latestReport.totals.length) {
    setMessage($("#admin-message"), "ما فيش بيانات لتصديرها.", true);
    return;
  }
  const rows = [
    ["الاسم", "اسم المستخدم", "الصفة", "عدد المشاركات", "إجمالي المستحق بالدينار"],
    ...latestReport.totals.map((person) => [
      person.name,
      person.username,
      roleNames[person.role],
      person.count,
      person.amount.toFixed(2),
    ]),
  ];
  const csv = `\uFEFF${rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "كشف-مستحقات-الراديو.csv";
  link.click();
  URL.revokeObjectURL(url);
});

$("#print-report").addEventListener("click", () => window.print());

async function initialize() {
  $("#entry-form").elements.date.value = localDate();
  try {
    const config = await api("/api/config");
    adminUsername = config.adminUsername;
    const { user } = await api("/api/session");
    if (user) {
      $("#member-name").textContent = user.name;
      $("#member-role").textContent = roleNames[user.role];
      $("#co-label").firstChild.textContent = user.role === "sheikh" ? "اسم المقدم" : "اسم الشيخ";
      showView(user);
    }
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
}

initialize();

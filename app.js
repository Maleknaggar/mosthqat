const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view");
const memberView = $("#member-view");
const adminView = $("#admin-view");
const authMessage = $("#auth-message");
let currentUser = null;
let currentChannel = null;
let channelRates = null;
let latestReport = { month: "", entries: [], totals: [], programTotals: [] };
let adminUsername = "admin";
let activePrograms = [];
let workspaceUsers = [];

const roleNames = { presenter: "مقدم / مقدمة", sheikh: "شيخ", monitor: "مراقب", admin: "الإدارة العليا" };
const channelNames = { radio: "إذاعة دار الإفتاء", visual: "القناة المرئية" };
const defaultChannelRates = {
  live: { presenter: 40, sheikh: 75 },
  recorded: { presenter: 100, sheikh: 150 },
};
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
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    ...options,
    headers,
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
  for (const id of ["channel-view", "member-view", "admin-view", "booking-view", "episodes-view", "archive-view", "settings-view"]) {
    $(`#${id}`).hidden = true;
  }
  const header = $("#header-user");
  header.hidden = !user;
  if (!user) {
    currentChannel = null;
    $("#app-nav").replaceChildren();
    return;
  }
  $("#header-label").textContent = `${user.name} · ${roleNames[user.role]}`;
  $("#channel-switcher").textContent = currentChannel ? `القناة: ${channelNames[currentChannel]} · تغيير` : "اختيار القناة";
  $("#channel-switcher").onclick = () => navigatePage("channel");
  const participant = ["presenter", "sheikh"].includes(user.role);
  const pages = participant
    ? [["member-view", "المستحقات"], ["booking-view", "حجز الاستوديو"], ["episodes-view", "متابعة الحلقات"]]
    : [["admin-view", "المراجعة"], ["episodes-view", "متابعة الحلقات"]];
  if (user.role === "admin") pages.push(["archive-view", "الأرشيف"]);
  pages.push(["settings-view", "إعدادات الحساب"]);
  $("#app-nav").innerHTML = pages.map(([id, title]) =>
    `<button type="button" data-page="${id.replace("-view", "")}">${title}</button>`).join("");
  $("#app-nav").querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigatePage(button.dataset.page));
  });
  $("#logout-button").onclick = async () => {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
      showView(null);
    } catch (error) {
      setMessage($("#account-message"), error.message, true);
    }
  };
  document.querySelectorAll(".settings-options [data-page]").forEach((button) => {
    button.onclick = () => {
      button.closest("details").open = false;
      navigatePage(button.dataset.page);
    };
  });
  if (user.role === "admin" || user.role === "monitor") {
    const isAdmin = user.role === "admin";
    $("#workspace-title").textContent = isAdmin ? "مراجعة وإدارة المستحقات" : "مراجعة طلبات المشاركات";
    $("#workspace-description").textContent = isAdmin
      ? "راجع المشاركات المعتمدة، وأدر البرامج والحسابات، وأصدر الكشوف الشهرية."
      : "راجع المشاركات المسجلة واعتمدها أو أعدها بالرفض.";
    $("#workspace-role").textContent = roleNames[user.role];
    $("#reports-panel").hidden = !isAdmin;
    $("#admin-tools").hidden = !isAdmin;
    navigatePage("channel");
  } else {
    $("#member-name").textContent = user.name;
    $("#member-role").textContent = roleNames[user.role];
    $("#entry-owner").value = user.name;
    $("#co-label").firstChild.textContent = user.role === "sheikh" ? "اسم المقدم" : "اسم الشيخ";
    navigatePage("channel");
  }
}

function navigatePage(page) {
  const viewId = page === "admin" ? "admin-view" : page === "channel" ? "channel-view" : `${page}-view`;
  const view = document.getElementById(viewId);
  if (!view || !currentUser) return;
  if (page !== "channel" && !currentChannel) {
    navigatePage("channel");
    return;
  }
  for (const id of ["channel-view", "member-view", "admin-view", "booking-view", "episodes-view", "archive-view", "settings-view"]) {
    $(`#${id}`).hidden = id !== viewId;
  }
  $("#app-nav").querySelectorAll("[data-page]").forEach((button) => {
    button.toggleAttribute("aria-current", button.dataset.page === page);
  });
  if (page === "booking") loadBookingPage().catch((error) => setMessage($("#booking-message"), error.message, true));
  if (page === "episodes") loadEpisodesPage().catch((error) => setMessage($("#episode-message"), error.message, true));
  if (page === "archive") loadArchive().catch((error) => setMessage($("#archive-message"), error.message, true));
  if (page === "settings") loadAccountSettings().catch((error) => setMessage($("#account-message"), error.message, true));
  if (page === "member") loadMember().catch((error) => setMessage($("#entry-message"), error.message, true));
  if (page === "admin") loadReviewerWorkspace().catch((error) => setMessage($("#admin-message"), error.message, true));
}

function enterChannel(channel) {
  if (!Object.hasOwn(channelNames, channel) || !currentUser) return;
  currentChannel = channel;
  $("#channel-switcher").textContent = `القناة: ${channelNames[channel]} · تغيير`;
  $("#workspace-eyebrow").textContent = channelNames[channel];
  $("#proposal-channel-label").value = channelNames[channel];
  $("#archive-channel-label").textContent = channelNames[channel];
  navigatePage(["admin", "monitor"].includes(currentUser.role) ? "admin" : "member");
}

document.querySelectorAll("[data-channel-select]").forEach((button) => {
  button.addEventListener("click", () => enterChannel(button.dataset.channelSelect));
});

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
  return channelRates?.[type]?.[role] ?? defaultChannelRates[type]?.[role] ?? 0;
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
  const type = $("#program-type").value;
  const programs = activePrograms.filter((program) => (program.type || "both") === type || program.type === "both");
  if (!type) {
    select.innerHTML = '<option value="">اختر نوع البرنامج أولاً</option>';
    select.disabled = true;
    $("#entry-details").hidden = true;
    $("#entry-details").disabled = true;
    return;
  }
  if (!programs.length) {
    select.innerHTML = '<option value="">لا توجد برامج من هذا النوع؛ راجع الإدارة العليا.</option>';
    select.disabled = true;
    $("#entry-details").hidden = true;
    $("#entry-details").disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = `<option value="">اختر البرنامج</option>${programs.map((program) =>
    `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("")}`;
  $("#entry-details").hidden = true;
  $("#entry-details").disabled = true;
}

function fillDurationOptions() {
  const select = $("#duration-select");
  for (let minutes = 15; minutes <= 120; minutes += 15) {
    const option = document.createElement("option");
    option.value = String(minutes);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    option.textContent = hours && remainingMinutes
      ? `${hours} ساعة و${remainingMinutes} دقيقة`
      : hours === 2 ? "ساعتان" : hours === 1 ? "ساعة واحدة" : `${minutes} دقيقة`;
    select.append(option);
  }
}

$("#program-type").addEventListener("change", () => {
  $("#program-select").value = "";
  renderProgramOptions();
  updateEstimate();
});
$("#program-select").addEventListener("change", () => {
  const hasProgram = Boolean($("#program-select").value);
  $("#entry-details").hidden = !hasProgram;
  $("#entry-details").disabled = !hasProgram;
});
$("#duration-select").addEventListener("change", updateEstimate);

$("#entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const message = $("#entry-message");
  try {
    await api("/api/entries", {
      method: "POST",
      body: JSON.stringify({ ...Object.fromEntries(form.entries()), channel: currentChannel }),
    });
    formElement.reset();
    $("#entry-details").hidden = true;
    $("#entry-details").disabled = true;
    $("#program-select").innerHTML = '<option value="">اختر نوع البرنامج أولاً</option>';
    $("#program-select").disabled = true;
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
        رقم الحلقة: ${entry.episodeNumber || "—"} · تاريخ البرنامج: ${formatDate(entry.date)} · ${typeNames[entry.type]} · ${entry.durationMinutes} دقيقة<br>
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
  const [{ entries }, { programs }, { rates }] = await Promise.all([
    api(`/api/entries?month=${encodeURIComponent(month)}&channel=${encodeURIComponent(currentChannel)}`),
    api(`/api/programs?channel=${encodeURIComponent(currentChannel)}`),
    api(`/api/rates?channel=${encodeURIComponent(currentChannel)}`),
  ]);
  channelRates = rates;
  activePrograms = programs;
  renderProgramOptions();
  updateEstimate();
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
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>الصفة</th><th>البرنامج</th><th>رقم الحلقة</th><th>المشارك الآخر</th><th>تاريخ البرنامج</th><th>تاريخ التسجيل</th><th>النوع</th><th>المدة</th><th>المستحق</th><th>الإجراء</th></tr></thead><tbody>${pending.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.name)}</td><td>${roleNames[entry.role]}</td><td>${escapeHtml(entry.programName)}</td>
      <td>${entry.episodeNumber || "—"}</td><td>${escapeHtml(entry.coParticipant)}</td><td>${formatDate(entry.date)}</td><td>${formatDateTime(entry.createdAt)}</td>
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
        const reason = button.dataset.status === "rejected" ? window.prompt("اكتب سبب رفض المشاركة:") : "";
        if (button.dataset.status === "rejected" && !reason?.trim()) {
          button.disabled = false;
          return;
        }
        await api(`/api/admin/entries/${button.dataset.review}/review`, {
          method: "PATCH",
          body: JSON.stringify({ status: button.dataset.status, reason, channel: currentChannel }),
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

async function renderPendingBookings() {
  const { bookings } = await api(`/api/admin/bookings?channel=${encodeURIComponent(currentChannel)}`);
  const container = $("#pending-bookings");
  const newRequests = bookings.filter((booking) => booking.status === "pending_approval").length;
  $("#pending-booking-count").textContent = `${newRequests.toLocaleString("ar-LY")} طلبات جديدة`;
  if (!bookings.length) {
    container.innerHTML = '<div class="empty-state">لا توجد طلبات حجز أو تسجيلات بانتظار المراجعة.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>البرنامج</th><th>الحلقة</th><th>التاريخ والوقت</th><th>المدة</th><th>الحالة</th><th>القرار</th></tr></thead><tbody>${bookings.map((booking) => `
    <tr><td>${escapeHtml(booking.ownerName)}</td><td>${escapeHtml(booking.programName)}</td><td>${booking.episodeNumber}</td>
      <td>${formatDate(booking.date)} · ${booking.startTime}–${booking.endTime}</td><td>${booking.durationMinutes} دقيقة</td>
      <td>${booking.status === "pending_approval" ? "طلب موعد جديد"
        : booking.status === "completed_pending" ? "أكد إتمام التسجيل" : "لم يؤكد إتمام التسجيل"}</td>
      <td><div class="row-actions">
        ${booking.status === "pending_approval" ? `<button class="button approve" data-booking-review="${booking.id}" data-status="approved" type="button">تأكيد الحجز</button>` : ""}
        ${booking.status === "completed_pending" ? `<button class="button approve" data-booking-review="${booking.id}" data-status="approved" type="button">اعتماد التسجيل</button>` : ""}
        <button class="button reject" data-booking-review="${booking.id}" data-status="rejected" type="button">رفض</button>
        ${booking.status === "booked" ? `<button class="button subtle" data-booking-review="${booking.id}" data-status="no_show" type="button">لم يحضر</button>` : ""}
      </div></td></tr>`).join("")}</tbody></table>`;
  container.querySelectorAll("[data-booking-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      let reason = "";
      if (button.dataset.status !== "approved") {
        reason = window.prompt(button.dataset.status === "no_show" ? "أضف ملاحظة عدم الحضور:" : "اكتب سبب رفض الحجز أو التسجيل:");
        if (!reason?.trim()) return;
      }
      button.disabled = true;
      try {
        await api(`/api/admin/bookings/${button.dataset.bookingReview}/review`, {
          method: "PATCH",
          body: JSON.stringify({ status: button.dataset.status, reason, channel: currentChannel }),
        });
        await loadReviewerWorkspace();
        setMessage($("#admin-message"), "تم حفظ قرار مراجعة الحجز.");
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
  updatePersonalReportButton();
  if (!report.programTotals.length) {
    container.innerHTML = '<div class="empty-state">لا توجد مستحقات معتمدة للشهر والمشارك المحددين.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>المشارك</th><th>البرنامج</th><th>عدد المشاركات</th><th>الإجمالي</th></tr></thead><tbody>${report.programTotals.map((item) => `
    <tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.programName)}</td><td>${item.count}</td><td><strong>${money(item.amount)}</strong></td></tr>
  `).join("")}</tbody></table>`;
}

function updatePersonalReportButton() {
  const participantId = $("#report-user").value;
  const hasApprovedEntries = Boolean(participantId && latestReport?.entries.some((entry) => entry.userId === participantId));
  $("#export-person-xlsx").disabled = !hasApprovedEntries;
}

function reportUrl() {
  const form = new FormData($("#report-filter"));
  const params = new URLSearchParams({ month: form.get("month") || currentMonth(), channel: currentChannel });
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
  const { entries } = await api(`/api/entries?channel=${encodeURIComponent(currentChannel)}`);
  renderPending(entries);
  await renderPendingBookings();
  if (currentUser.role === "admin") {
    await Promise.all([loadReports(), loadProgramsAdmin(), loadUsersAdmin(), loadChannelRates()]);
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

async function exportReport(type) {
  if (!latestReport.programTotals.length) {
    setMessage($("#admin-message"), "لا توجد بيانات لتصديرها.", true);
    return;
  }
  try {
    const { file } = await api("/api/admin/report/export", {
      method: "POST",
      body: JSON.stringify({
        month: latestReport.month, userId: $("#report-user").value, type, channel: currentChannel,
      }),
    });
    $("#archive-month").value = latestReport.month;
    const link = document.createElement("a");
    link.href = file.downloadUrl;
    link.download = file.name;
    link.click();
    setMessage($("#admin-message"), "تم حفظ التقرير في أرشيف هذا الشهر وبدء تنزيله.");
    if (currentUser?.role === "admin" && !$("#archive-view").hidden && $("#archive-month").value === latestReport.month) {
      await loadArchive();
    }
  } catch (error) {
    setMessage($("#admin-message"), error.message, true);
  }
}

function exportSummary() { return exportReport("summary"); }
function exportDetails() { return exportReport("details"); }

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
    `<tr><td>${(index + 1).toLocaleString("ar-LY")}</td><td>${escapeHtml(entry.programName)}</td><td>${entry.episodeNumber || "—"}</td><td>${formatDate(entry.date)}</td><td>${formatDateTime(entry.createdAt)}</td><td>${typeNames[entry.type]}</td><td>${entry.durationMinutes.toLocaleString("ar-LY")} ÷ 60 × ${money(entry.hourlyRate)}</td><td>${formatDateTime(entry.reviewedAt)}</td><td>${escapeHtml(entry.reviewerName || "الإدارة العليا")}</td><td>${money(entry.amount)}</td></tr>`).join("");
  const total = latestReport.entries.reduce((sum, entry) => sum + entry.amount, 0);
  const printDocument = $("#print-document");
  printDocument.innerHTML = `
    <header class="print-heading">
      <div class="bismillah">بسم الله الرحمن الرحيم</div>
      <div>التاريخ: ${formatDate(localDate())}</div>
    </header>
    <p class="print-recipient">السيد مدير الشؤون الإدارية والمالية المحترم</p>
    <p class="print-greeting">تحية طيبة وبعد،<br>السلام عليكم ورحمة الله وبركاته،</p>
    <p class="print-body">نحيل إليكم مستحقات السيد <strong>${escapeHtml(personName)}</strong> عن مشاركته في برامج ${escapeHtml(channelNames[currentChannel])} خلال شهر <strong>${escapeHtml(monthLabel(latestReport.month))}</strong>، وذلك وفق التفصيل المعتمد أدناه.</p>
    <h2>إجمالي المستحقات حسب البرنامج</h2>
    <table><thead><tr><th>البرنامج</th><th>عدد المشاركات</th><th>الإجمالي</th></tr></thead><tbody>${programRows}<tr class="grand-total"><td colspan="2">الإجمالي العام</td><td>${money(total)}</td></tr></tbody></table>
    ${detail ? `<h2>التفصيل المالي وسجل المراجعة</h2><table class="print-detail-table"><thead><tr><th>م</th><th>البرنامج</th><th>الحلقة</th><th>تاريخ البرنامج</th><th>تاريخ التسجيل</th><th>النوع</th><th>المدة ÷ 60 × سعر الساعة</th><th>تاريخ المراجعة</th><th>اعتمدها</th><th>المستحق</th></tr></thead><tbody>${detailRows}</tbody></table>` : ""}
    <p class="print-closing">وتفضلوا بقبول فائق الاحترام والتقدير.</p>
    <div class="signature"><strong>مدير قسم الإعلام</strong><span>مجدي قدمور</span></div>`;
  printDocument.classList.toggle("detailed", detail);
  document.body.classList.add("printing");
  document.body.classList.toggle("printing-detailed", detail);
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("printing", "printing-detailed");
    printDocument.classList.remove("detailed");
  }, { once: true });
  window.print();
}

$("#export-summary").addEventListener("click", exportSummary);
$("#export-details").addEventListener("click", exportDetails);
$("#export-person-xlsx").addEventListener("click", async () => {
  const userId = $("#report-user").value;
  if (!userId || !latestReport?.entries.some((entry) => entry.userId === userId)) {
    setMessage($("#admin-message"), "اختر مشاركاً لديه مستحقات معتمدة أولاً.", true);
    return;
  }
  const button = $("#export-person-xlsx");
  button.disabled = true;
  try {
    const { file } = await api("/api/admin/report/export-person", {
      method: "POST",
      body: JSON.stringify({ month: latestReport.month, userId, channel: currentChannel }),
    });
    $("#archive-month").value = latestReport.month;
    const link = document.createElement("a");
    link.href = file.downloadUrl;
    link.download = file.name;
    link.click();
    setMessage($("#admin-message"), "تم إنشاء كشف Excel بتنسيق رسمي وحفظه في أرشيف الشهر.");
  } catch (error) {
    setMessage($("#admin-message"), error.message, true);
  } finally {
    button.disabled = false;
  }
});
$("#print-summary").addEventListener("click", () => printReport(false));
$("#print-details").addEventListener("click", () => printReport(true));

async function loadProgramsAdmin() {
  const [{ programs }, { users }] = await Promise.all([
    api(`/api/admin/programs?channel=${encodeURIComponent(currentChannel)}`),
    api("/api/admin/users"),
  ]);
  $("#program-list").innerHTML = programs.length
    ? `<div class="assignment-grid">${programs.map((program) => `
      <article class="assignment-card">
        <strong>${escapeHtml(program.name)}</strong><p class="muted">${program.type === "recorded" ? "مسجل" : "مباشر"} · ${program.active ? "متاح" : "موقوف"}</p>
        <button class="button subtle" data-program="${program.id}" data-active="${!program.active}" type="button">${program.active ? "إيقاف التسجيل" : "إعادة التفعيل"}</button>
        <details><summary>ربط الشيوخ والمقدمين</summary>
          <div>${users.filter((user) => ["presenter", "sheikh"].includes(user.role)).map((user) => `
            <label><input type="checkbox" data-program-user="${program.id}" value="${escapeHtml(user.id)}" ${(program.userIds || []).includes(user.id) ? "checked" : ""}>
              ${escapeHtml(user.name)} · ${roleNames[user.role]}</label>`).join("") || '<p class="muted">لا توجد حسابات مقدمي برامج أو شيوخ.</p>'}
          </div>
          <button class="button primary" data-save-participants="${program.id}" type="button">حفظ المشاركين</button>
        </details>
      </article>`).join("")}</div>`
    : '<div class="empty-state">أضف البرامج لتظهر للمقدمين والشيوخ في نموذج التسجيل.</div>';
  $("#program-list").querySelectorAll("[data-program]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(`/api/admin/programs/${button.dataset.program}`, {
          method: "PATCH", body: JSON.stringify({ active: button.dataset.active === "true", channel: currentChannel }),
        });
        await loadProgramsAdmin();
        setMessage($("#admin-message"), "تم تحديث قائمة البرامج.");
      } catch (error) {
        setMessage($("#admin-message"), error.message, true);
      }
    });
  });
  $("#program-list").querySelectorAll("[data-save-participants]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userIds = [...$("#program-list").querySelectorAll(`[data-program-user="${button.dataset.saveParticipants}"]:checked`)]
        .map((checkbox) => checkbox.value);
      try {
        await api(`/api/admin/programs/${button.dataset.saveParticipants}/participants`, {
          method: "PUT",
          body: JSON.stringify({ userIds, channel: currentChannel }),
        });
        await loadProgramsAdmin();
        setMessage($("#admin-message"), "تم حفظ المشاركين المرتبطين بالبرنامج.");
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
    await api("/api/admin/programs", {
      method: "POST",
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form).entries()), channel: currentChannel }),
    });
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
    ? `<table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الهاتف</th><th>البريد</th><th>الصلاحية</th><th>تعديل</th></tr></thead><tbody>${users.map((user) => `
      <tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.phone)}</td><td>${escapeHtml(user.email || "—")}</td>
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

async function loadChannelRates() {
  const { rates } = await api(`/api/rates?channel=${encodeURIComponent(currentChannel)}`);
  channelRates = rates;
  $("#rates-heading").textContent = `أسعار الساعة · ${channelNames[currentChannel]}`;
  for (const type of ["live", "recorded"]) {
    for (const role of ["presenter", "sheikh"]) {
      const key = `${type}${role[0].toUpperCase()}${role.slice(1)}`;
      $("#rate-form").elements[key].value = rates[type][role];
    }
  }
  updateEstimate();
}

$("#rate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  const rates = {
    live: { presenter: Number(values.livePresenter), sheikh: Number(values.liveSheikh) },
    recorded: { presenter: Number(values.recordedPresenter), sheikh: Number(values.recordedSheikh) },
  };
  try {
    const result = await api("/api/admin/rates", {
      method: "PUT",
      body: JSON.stringify({ channel: currentChannel, rates }),
    });
    channelRates = result.rates;
    updateEstimate();
    setMessage($("#rate-message"), "تم حفظ أسعار القناة. لن تتغير المشاركات السابقة.");
  } catch (error) {
    setMessage($("#rate-message"), error.message, true);
  }
});

let bookingData = { dates: [], bookings: [], programs: [], programDailyMinutes: {} };
let editingBookingId = "";

function durationLabel(minutes) {
  if (minutes === 120) return "ساعتان";
  if (minutes === 60) return "ساعة واحدة";
  return minutes < 60 ? `${minutes} دقيقة` : `ساعة و${minutes - 60} دقيقة`;
}

function fillBookingDurations() {
  $("#booking-duration").innerHTML = '<option value="">اختر المدة</option>'
    + Array.from({ length: 8 }, (_, index) => (index + 1) * 15)
      .map((minutes) => `<option value="${minutes}">${durationLabel(minutes)}</option>`).join("");
}

function updateBookingSlots() {
  const date = $("#booking-date").value;
  const programId = $("#booking-program").value;
  const duration = Number($("#booking-duration").value);
  const editing = bookingData.bookings.find((booking) => booking.id === editingBookingId);
  const dailyMinutes = (bookingData.programDailyMinutes[date]?.[programId] || 0)
    - (editing?.date === date && editing.programId === programId ? editing.durationMinutes : 0);
  const options = [];
  for (let start = 13 * 60; start < 19 * 60; start += 15) {
    const end = start + duration;
    if (!duration || end > 19 * 60 || dailyMinutes + duration > 120) continue;
    const conflict = bookingData.bookings.some((booking) => booking.date === date
        && !["cancelled", "rejected", "no_show"].includes(booking.status) && booking.id !== editingBookingId
      && start < (booking.endMinutes ?? booking.startTime.split(":").reduce((sum, part, index) => sum + Number(part) * (index ? 1 : 60), 0) + booking.durationMinutes)
      && end > (booking.startMinutes ?? booking.startTime.split(":").reduce((sum, part, index) => sum + Number(part) * (index ? 1 : 60), 0)));
    if (!conflict) {
      const label = `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
      options.push(`<option value="${label}">${label}</option>`);
    }
  }
  $("#booking-time").innerHTML = options.length
    ? '<option value="">اختر وقت البداية</option>' + options.join("")
    : '<option value="">لا يوجد وقت متاح لهذه المدة</option>';
  $("#booking-time").disabled = !options.length;
  if (dailyMinutes + duration > 120) {
    setMessage($("#booking-message"), "اكتمل سقف الساعتين لهذا البرنامج في اليوم المحدد.", true);
  } else if ($("#booking-message").classList.contains("error")) {
    setMessage($("#booking-message"), "");
  }
}

function renderBookings() {
  const currentUserBookings = bookingData.bookings.filter((booking) => booking.userId === currentUser.id);
  const busy = bookingData.bookings.filter((booking) => booking.userId !== currentUser.id
    && !["cancelled", "rejected", "no_show"].includes(booking.status));
  const statusLabel = {
    pending_approval: "بانتظار تأكيد الإدارة",
    booked: "محجوز",
    completed_pending: "بانتظار مراجعة المراقب",
    approved: "تم التسجيل واعتماده",
    rejected: "مرفوض",
    no_show: "لم يتم الحضور",
    cancelled: "ملغي",
  };
  const cards = [
    ...currentUserBookings.map((booking) => {
      const ended = new Date(`${booking.date}T${booking.endTime}:00+02:00`) <= new Date();
      return `<article class="entry-card">
        <strong>${escapeHtml(booking.programName)} · الحلقة ${booking.episodeNumber}</strong>
        <span class="status ${booking.status === "approved" ? "approved" : booking.status === "rejected" || booking.status === "no_show" ? "rejected" : ""}">${statusLabel[booking.status] || booking.status}</span>
        <div class="entry-meta">${formatDate(booking.date)} · ${booking.startTime}–${booking.endTime} · ${durationLabel(booking.durationMinutes)}<br>المشارك الآخر: ${escapeHtml(booking.coParticipant)}</div>
        <div class="booking-actions">
          ${["pending_approval", "booked"].includes(booking.status) && !ended ? `${bookingData.dates.includes(booking.date) ? `<button class="button subtle" data-edit-booking="${booking.id}" type="button">تعديل</button>` : ""}<button class="button reject" data-cancel-booking="${booking.id}" type="button">إلغاء</button>` : ""}
          ${booking.status === "booked" && ended ? `<button class="button primary" data-complete-booking="${booking.id}" type="button">تأكيد إتمام التسجيل</button>` : ""}
          ${booking.reviewReason ? `<span class="muted">ملاحظة المراجع: ${escapeHtml(booking.reviewReason)}</span>` : ""}
        </div>
      </article>`;
    }),
    ...busy.map((booking) => `<article class="entry-card"><strong>وقت غير متاح</strong><span class="status">محجوز</span><div class="entry-meta">${formatDate(booking.date)} · ${booking.startTime}–${booking.endTime}</div></article>`),
  ];
  $("#booking-list").innerHTML = cards.length ? cards.join("") : '<div class="empty-state">لا توجد حجوزات في اليومين القادمين.</div>';
  $("#booking-list").querySelectorAll("[data-edit-booking]").forEach((button) => {
    button.addEventListener("click", () => {
      const booking = currentUserBookings.find((item) => item.id === button.dataset.editBooking);
      if (!booking) return;
      editingBookingId = booking.id;
      $("#booking-program").value = booking.programId;
      $("#booking-date").value = booking.date;
      $("#booking-duration").value = String(booking.durationMinutes);
      $("#booking-form").elements.episodeNumber.value = booking.episodeNumber;
      $("#booking-form").elements.coParticipant.value = booking.coParticipant;
      updateBookingSlots();
      $("#booking-time").value = booking.startTime;
      $("#booking-form").querySelector('[type="submit"]').textContent = "حفظ تعديل الحجز";
      $("#booking-form").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  $("#booking-list").querySelectorAll("[data-cancel-booking]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("هل تريد إلغاء هذا الموعد وإتاحة الوقت للآخرين؟")) return;
      try {
        const result = await api(`/api/bookings/${button.dataset.cancelBooking}`, {
          method: "PATCH", body: JSON.stringify({ action: "cancel", channel: currentChannel }),
        });
        setMessage($("#booking-message"), result.notificationWarning || "تم إلغاء الموعد وإتاحة الوقت.");
        await loadBookingPage();
      } catch (error) {
        setMessage($("#booking-message"), error.message, true);
      }
    });
  });
  $("#booking-list").querySelectorAll("[data-complete-booking]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api(`/api/bookings/${button.dataset.completeBooking}/complete`, {
          method: "POST", body: JSON.stringify({ channel: currentChannel }),
        });
        setMessage($("#booking-message"), result.notificationWarning || "تأكد إتمام التسجيل وأُرسل للمراقب للمراجعة.");
        await loadBookingPage();
      } catch (error) {
        setMessage($("#booking-message"), error.message, true);
      }
    });
  });
}

async function loadBookingPage() {
  const query = `?channel=${encodeURIComponent(currentChannel)}`;
  const [{ programs }, data] = await Promise.all([
    api(`/api/booking/programs${query}`),
    api(`/api/bookings${query}`),
  ]);
  bookingData = { ...data, programs };
  $("#proposal-panel").hidden = currentUser.role !== "sheikh";
  $("#proposal-author-name").value = currentUser.name;
  $("#proposal-channel-label").value = channelNames[currentChannel];
  const programSelect = $("#booking-program");
  const selectedProgram = programSelect.value;
  programSelect.innerHTML = programs.length
    ? `<option value="">اختر البرنامج</option>${programs.map((program) => `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("")}`
    : '<option value="">لا توجد برامج مرتبطة بحسابك؛ راجع الإدارة العليا</option>';
  if (programs.some((program) => program.id === selectedProgram)) programSelect.value = selectedProgram;
  const dateSelect = $("#booking-date");
  const selectedDate = dateSelect.value;
  dateSelect.innerHTML = data.dates.length
    ? data.dates.map((date) => `<option value="${date}">${formatDate(date)}</option>`).join("")
    : '<option value="">لا توجد أيام متاحة للحجز</option>';
  if (data.dates.includes(selectedDate)) dateSelect.value = selectedDate;
  $("#booking-co-label").firstChild.textContent = currentUser.role === "sheikh" ? "اسم المقدم" : "اسم الشيخ";
  updateBookingSlots();
  renderBookings();
}

$("#booking-program").addEventListener("change", updateBookingSlots);
$("#booking-date").addEventListener("change", updateBookingSlots);
$("#booking-duration").addEventListener("change", updateBookingSlots);
$("#refresh-bookings").addEventListener("click", () => loadBookingPage().catch((error) => setMessage($("#booking-message"), error.message, true)));
$("#refresh-booking-reviews").addEventListener("click", () => loadReviewerWorkspace().catch((error) => setMessage($("#admin-message"), error.message, true)));
window.setInterval(() => {
  if (["admin", "monitor"].includes(currentUser?.role) && currentChannel && !$("#admin-view").hidden
    && !$("#pending-bookings").contains(document.activeElement)) {
    renderPendingBookings().catch((error) => setMessage($("#admin-message"), error.message, true));
  }
}, 30000);
$("#booking-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const body = Object.fromEntries(form.entries());
  body.durationMinutes = Number(body.durationMinutes);
  try {
    const result = editingBookingId
      ? await api(`/api/bookings/${editingBookingId}`, {
        method: "PATCH", body: JSON.stringify({ ...body, action: "edit", channel: currentChannel }),
      })
      : await api("/api/bookings", { method: "POST", body: JSON.stringify({ ...body, channel: currentChannel }) });
    editingBookingId = "";
    formElement.reset();
    $("#booking-form").querySelector('[type="submit"]').textContent = "تأكيد الحجز";
    const confirmation = result.booking.status === "pending_approval"
      ? "تم إرسال الطلب؛ سيظهر للإدارة العليا بانتظار تأكيد الحجز."
      : result.booking.status === "booked" ? "تم تثبيت الحجز." : "تم تحديث الحجز.";
    setMessage($("#booking-message"), `${confirmation} ${result.notificationWarning || ""}`.trim());
    await loadBookingPage();
  } catch (error) {
    setMessage($("#booking-message"), error.message, true);
  }
});

$("#booking-back").addEventListener("click", () => navigatePage("member"));

$("#proposal-needs-presenter").addEventListener("change", (event) => {
  const label = $("#proposal-presenter-label");
  const required = event.currentTarget.value === "yes";
  label.hidden = !required;
  label.querySelector("input").required = required;
  if (!required) label.querySelector("input").value = "";
});

$("#proposal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const download = $("#proposal-download");
  download.replaceChildren();
  submit.disabled = true;
  setMessage($("#proposal-message"), "جارٍ إنشاء الخطاب وحفظه في الأرشيف...");
  const values = Object.fromEntries(new FormData(form).entries());
  values.durationMinutes = Number(values.durationMinutes);
  values.channel = currentChannel;
  try {
    const result = await api("/api/program-proposals", { method: "POST", body: JSON.stringify(values) });
    form.reset();
    $("#proposal-author-name").value = currentUser.name;
    $("#proposal-channel-label").value = channelNames[currentChannel];
    $("#proposal-presenter-label").hidden = true;
    $("#proposal-presenter-label input").required = false;
    setMessage($("#proposal-message"), "تم إنشاء الخطاب وحفظه في أرشيف القناة.");
    const link = document.createElement("a");
    link.className = "button subtle";
    link.href = result.file.downloadUrl;
    link.textContent = "تنزيل خطاب Word";
    download.append(link);
  } catch (error) {
    setMessage($("#proposal-message"), error.message, true);
  } finally {
    submit.disabled = false;
  }
});

async function loadEpisodesPage() {
  const channelQuery = `channel=${encodeURIComponent(currentChannel)}`;
  const { programs } = await api(`/api/episodes/programs?${channelQuery}`);
  const select = $("#episode-program");
  const selected = select.value;
  select.innerHTML = programs.length
    ? `<option value="">اختر البرنامج</option>${programs.map((program) => `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("")}`
    : '<option value="">لا توجد برامج مرتبطة بحسابك</option>';
  if (programs.some((program) => program.id === selected)) select.value = selected;
  $("#episode-upload-panel").hidden = !["admin", "monitor"].includes(currentUser.role);
  if (currentUser.role === "admin" || currentUser.role === "monitor") {
    const { programs: allPrograms } = await api(`/api/admin/programs?${channelQuery}`);
    $("#upload-program").innerHTML = allPrograms.length
      ? `<option value="">اختر البرنامج</option>${allPrograms.map((program) => `<option value="${escapeHtml(program.id)}">${escapeHtml(program.name)}</option>`).join("")}`
      : '<option value="">أضف برنامجاً أولاً</option>';
  }
  if (select.value) await loadEpisodesForProgram(select.value);
  else $("#episode-list").innerHTML = '<div class="empty-state">اختر برنامجاً لعرض الحلقات.</div>';
}

async function loadEpisodesForProgram(programId) {
  const { episodes } = await api(`/api/episodes?programId=${encodeURIComponent(programId)}&channel=${encodeURIComponent(currentChannel)}`);
  const container = $("#episode-list");
  if (!episodes.length) {
    container.innerHTML = '<div class="empty-state">لا توجد حلقات مرفوعة لهذا البرنامج بعد.</div>';
    return;
  }
  container.innerHTML = episodes.map((episode, index) => `
    <article class="episode-card">
      <h3>${escapeHtml(episode.programName)} · الحلقة ${episode.episodeNumber}${index === 0 ? " · الأحدث" : ""}</h3>
      <p class="episode-meta">تاريخ الحلقة: ${formatDate(episode.date)} · رفعها: ${escapeHtml(episode.uploadedByName)} · الملف: ${escapeHtml(episode.originalFileName)} · ${Math.ceil(episode.size / (1024 * 1024))} م.ب</p>
      <p class="episode-meta">الشيوخ: ${episode.sheikhNames.map(escapeHtml).join("، ")}<br>المقدمون: ${episode.presenterNames.map(escapeHtml).join("، ")}</p>
      ${episode.mimeType === "audio/mpeg"
        ? `<audio class="media-player" controls preload="none" src="${episode.mediaUrl}"></audio>`
        : `<video class="media-player" controls preload="none" src="${episode.mediaUrl}"></video>`}
      <div class="episode-controls"><a class="archive-download" href="${episode.mediaUrl}&download=1">تنزيل النسخة الحالية</a><span class="muted">عدد النسخ المحفوظة: ${episode.versions.length}</span></div>
      ${episode.versions.length > 1 ? `<details><summary>النسخ السابقة</summary><div class="entry-list">${episode.versions.slice(0, -1).reverse().map((version) =>
        `<div class="episode-meta">${formatDateTime(version.uploadedAt)} · ${escapeHtml(version.uploadedByName)} · ${escapeHtml(version.originalFileName)} · <a class="archive-download" href="${version.downloadUrl}">تنزيل النسخة</a></div>`).join("")}</div></details>` : ""}
      ${currentUser.role === "sheikh" && episode.sheikhIds.includes(currentUser.id) ? `
        <form class="episode-correction" data-correction-form="${episode.id}">
          <label>ملاحظة تعديل (يراها كاتبها والمراقبون والإدارة فقط)<textarea name="text" maxlength="5000" required></textarea></label>
          <button class="button subtle" type="submit">إرسال للمراجعة</button>
        </form>` : ""}
      ${episode.corrections.map((correction) => `
        <section class="episode-correction">
          <strong>ملاحظة ${escapeHtml(correction.authorName)} · ${statusNames[correction.status] || (correction.status === "needs_revision" ? "تحتاج تعديلاً" : correction.status)}</strong>
          <p>${escapeHtml(correction.text)}</p>
          ${correction.reviewResponse ? `<p class="episode-meta">رد المراجع: ${escapeHtml(correction.reviewResponse)} · ${escapeHtml(correction.reviewedByName || "")}</p>` : ""}
          ${correction.documentUrl ? `<a class="archive-download" href="${correction.documentUrl}">تنزيل محضر Word المعتمد</a>` : ""}
          ${currentUser.role === "sheikh" && correction.authorId === currentUser.id && ["needs_revision", "rejected"].includes(correction.status) ? `
            <form class="episode-correction" data-resubmit="${correction.id}">
              <label>تعديل الملاحظة وإعادة إرسالها<textarea name="text" maxlength="5000" required>${escapeHtml(correction.text)}</textarea></label>
              <button class="button subtle" type="submit">إعادة الإرسال للمراجعة</button>
            </form>` : ""}
          ${["admin", "monitor"].includes(currentUser.role) && correction.status === "pending" ? `
            <div class="episode-controls"><button class="button approve" data-correction-review="${correction.id}" data-status="approved" type="button">اعتماد وإنشاء Word</button>
              <button class="button reject" data-correction-review="${correction.id}" data-status="rejected" type="button">إرجاع للشيخ</button></div>` : ""}
        </section>`).join("")}
    </article>`).join("");
  container.querySelectorAll("[data-correction-form]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api(`/api/episodes/${form.dataset.correctionForm}/corrections`, {
        method: "POST",
        body: JSON.stringify({ text: new FormData(form).get("text"), channel: currentChannel }),
      });
      setMessage($("#episode-message"), result.notificationWarning || "وصلت الملاحظة إلى المراقبين.");
      await loadEpisodesForProgram(programId);
    } catch (error) {
      setMessage($("#episode-message"), error.message, true);
    }
  }));
  container.querySelectorAll("[data-resubmit]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api(`/api/corrections/${form.dataset.resubmit}`, {
        method: "PATCH",
        body: JSON.stringify({ text: new FormData(form).get("text"), channel: currentChannel }),
      });
      setMessage($("#episode-message"), result.notificationWarning || "أعيد إرسال الملاحظة للمراجعة.");
      await loadEpisodesForProgram(programId);
    } catch (error) {
      setMessage($("#episode-message"), error.message, true);
    }
  }));
  container.querySelectorAll("[data-correction-review]").forEach((button) => button.addEventListener("click", async () => {
    const approved = button.dataset.status === "approved";
    const response = approved ? "" : window.prompt("اكتب ملاحظات المراجعة أو سبب الإرجاع:");
    if (!approved && !response?.trim()) return;
    try {
      const result = await api(`/api/admin/corrections/${button.dataset.correctionReview}/review`, {
        method: "PATCH",
        body: JSON.stringify({ status: approved ? "approved" : "needs_revision", response, channel: currentChannel }),
      });
      setMessage($("#episode-message"), result.notificationWarning || (approved ? "اعتمد التعديل وحُفظ ملف Word." : "أعيدت الملاحظة للشيخ."));
      await loadEpisodesForProgram(programId);
    } catch (error) {
      setMessage($("#episode-message"), error.message, true);
    }
  }));
}

$("#episode-program").addEventListener("change", (event) => {
  if (event.currentTarget.value) loadEpisodesForProgram(event.currentTarget.value).catch((error) => setMessage($("#episode-message"), error.message, true));
});

async function loadUploadParticipants() {
  const programId = $("#upload-program").value;
  if (!programId) return;
  const { users } = await api(`/api/episodes/participants?programId=${encodeURIComponent(programId)}&channel=${encodeURIComponent(currentChannel)}`);
  for (const [role, selectId] of [["sheikh", "upload-sheikhs"], ["presenter", "upload-presenters"]]) {
    const usersForRole = users.filter((user) => user.role === role);
    $(`#${selectId}`).innerHTML = usersForRole.map((user) =>
      `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join("");
  }
}

$("#upload-program").addEventListener("change", () => loadUploadParticipants().catch((error) => setMessage($("#episode-upload-message"), error.message, true)));
$("#episode-upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = new FormData(form);
  body.set("sheikhIds", JSON.stringify([...$("#upload-sheikhs").selectedOptions].map((option) => option.value)));
  body.set("presenterIds", JSON.stringify([...$("#upload-presenters").selectedOptions].map((option) => option.value)));
  body.set("channel", currentChannel);
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  setMessage($("#episode-upload-message"), "جارٍ رفع الملف وحفظه...");
  try {
    await api("/api/admin/episodes", { method: "POST", body });
    form.reset();
    setMessage($("#episode-upload-message"), "تم رفع الحلقة. احتُفظ بالنسخ السابقة عند استبدال حلقة موجودة.");
    await loadEpisodesPage();
  } catch (error) {
    setMessage($("#episode-upload-message"), error.message, true);
  } finally {
    submit.disabled = false;
  }
});

async function loadArchive() {
  const month = $("#archive-month").value || currentMonth();
  const channel = currentChannel;
  $("#archive-month").value = month;
  $("#archive-channel-label").textContent = channelNames[channel];
  const { files, decisions } = await api(`/api/admin/archive?month=${encodeURIComponent(month)}&channel=${encodeURIComponent(channel)}`);
  const proposals = files.filter((file) => file.category === "program-proposal");
  const duesReports = files.filter((file) => file.category === "dues-report");
  const corrections = files.filter((file) => file.category === "episode-correction");
  const otherFiles = files.filter((file) => !["program-proposal", "dues-report", "episode-correction"].includes(file.category));
  const categoryCounts = {
    all: files.length || decisions.length,
    "program-proposal": proposals.length,
    "dues-report": duesReports.length,
    "episode-correction": corrections.length,
    other: otherFiles.length,
  };
  document.querySelectorAll("[data-archive-zip]").forEach((button) => {
    button.disabled = !categoryCounts[button.dataset.archiveZip];
  });
  $("#archive-dues-count").textContent = `${duesReports.length.toLocaleString("ar-LY")} ملفات`;
  $("#archive-corrections-count").textContent = `${corrections.length.toLocaleString("ar-LY")} ملفات`;
  $("#archive-proposals-count").textContent = `${proposals.length.toLocaleString("ar-LY")} ملفات`;
  $("#archive-other-count").textContent = `${otherFiles.length.toLocaleString("ar-LY")} ملفات`;
  $("#archive-decisions-count").textContent = `${decisions.length.toLocaleString("ar-LY")} قرارات`;
  $("#archive-proposals").innerHTML = proposals.length
    ? `<table><thead><tr><th>اسم البرنامج المقترح</th><th>مقدم المقترح</th><th>تاريخ الحفظ</th><th>الخطاب</th></tr></thead><tbody>${proposals.map((file) => `
      <tr><td>${escapeHtml(file.proposalTitle || file.name)}</td><td>${escapeHtml(file.authorName || "—")}</td><td>${formatDateTime(file.createdAt)}</td><td><a class="archive-download" href="${escapeHtml(file.downloadUrl)}">تنزيل Word</a></td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">لا توجد مقترحات محفوظة لهذه القناة في هذا الشهر.</div>';
  const renderArchiveFiles = (items, emptyMessage, typeLabel) => items.length
    ? `<table><thead><tr><th>المشارك / الملف</th><th>نوع الملف</th><th>تاريخ الحفظ</th><th>تنزيل</th></tr></thead><tbody>${items.map((file) => `
      <tr><td>${escapeHtml(file.reportPersonName || file.name)}</td><td>${typeLabel(file)}</td><td>${formatDateTime(file.createdAt)}</td><td><a class="archive-download" href="${escapeHtml(file.downloadUrl)}">تنزيل الملف</a></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty-state">${emptyMessage}</div>`;
  $("#archive-dues").innerHTML = renderArchiveFiles(duesReports, "لا توجد كشوف مستحقات محفوظة لهذا الشهر. أنشئ كشف Excel من صفحة التقارير وسيُحفظ هنا تلقائياً.", (file) => {
    if (file.kind === "xlsx") return "كشف مستحقات Excel منسق";
    return file.reportType === "details" ? "تفصيل CSV متوافق مع Excel" : "إجمالي CSV متوافق مع Excel";
  });
  $("#archive-corrections").innerHTML = renderArchiveFiles(corrections, "لا توجد محاضر تعديل محفوظة لهذا الشهر.", () => "محضر تعديل Word");
  $("#archive-other").innerHTML = renderArchiveFiles(otherFiles, "لا توجد ملفات أخرى لهذا الشهر.", (file) => file.kind === "word" ? "ملف Word" : file.kind === "xlsx" ? "ملف Excel" : "ملف CSV");
  $("#archive-decisions").innerHTML = decisions.length
    ? `<table><thead><tr><th>القرار</th><th>المراجع</th><th>التاريخ</th><th>البرنامج</th><th>السبب/الملاحظة</th></tr></thead><tbody>${decisions.map((decision) => `
      <tr><td>${escapeHtml(decision.action)}</td><td>${escapeHtml(decision.actorName)}</td><td>${formatDateTime(decision.createdAt)}</td><td>${escapeHtml(decision.programName || "—")}</td><td>${escapeHtml(decision.reason || "—")}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">لا توجد قرارات اعتماد أو رفض مسجلة لهذا الشهر.</div>';
}

$("#archive-filter").addEventListener("submit", (event) => {
  event.preventDefault();
  loadArchive().catch((error) => setMessage($("#archive-message"), error.message, true));
});
document.querySelectorAll("[data-archive-zip]").forEach((button) => button.addEventListener("click", () => {
  const month = $("#archive-month").value;
  if (month) window.location.href = `/api/admin/archive/${encodeURIComponent(month)}.zip?channel=${encodeURIComponent(currentChannel)}&category=${encodeURIComponent(button.dataset.archiveZip)}`;
}));

async function loadAccountSettings() {
  const { account } = await api("/api/account");
  const form = $("#account-form");
  form.elements.name.value = account.name;
  form.elements.phone.value = account.phone;
  form.elements.email.value = account.email || "";
  form.elements.currentPassword.value = "";
}

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const account = Object.fromEntries(new FormData(form).entries());
    const result = await api("/api/account", { method: "PATCH", body: JSON.stringify(account) });
    currentUser.name = result.account.name;
    $("#header-label").textContent = `${currentUser.name} · ${roleNames[currentUser.role]}`;
    form.elements.currentPassword.value = "";
    setMessage($("#account-message"), "تم تحديث بيانات الحساب.");
  } catch (error) {
    setMessage($("#account-message"), error.message, true);
  }
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form).entries());
  if (values.newPassword !== values.confirmPassword) {
    setMessage($("#password-message"), "تأكيد كلمة المرور غير مطابق.", true);
    return;
  }
  try {
    await api("/api/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }),
    });
    form.reset();
    setMessage($("#password-message"), "تم تغيير كلمة المرور. ستنتهي الجلسات الأخرى للحساب.");
  } catch (error) {
    setMessage($("#password-message"), error.message, true);
  }
});

async function initialize() {
  fillDurationOptions();
  fillBookingDurations();
  const month = currentMonth();
  $("#entry-form").elements.date.value = localDate();
  $("#member-month").value = month;
  $("#report-month").value = month;
  $("#archive-month").value = month;
  try {
    const config = await api("/api/config");
    adminUsername = config.adminUsername;
    const { user } = await api("/api/session");
    if (user) showView(user);
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
}

initialize();

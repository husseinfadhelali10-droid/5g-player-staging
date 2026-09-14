(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const esc = function (value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  const YT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.5 15.6V8.4l6.3 3.6-6.3 3.6z"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';
  const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';

  const APP_VERSION = "3.4.1-b4";
  const PUBLIC_USER_ID = "public-device";
  const SELECTED_COURSE_KEY = "selected-course";
  const SW_RELOAD_KEY = "sw-reloaded-" + APP_VERSION;
  let myCourses = [];
  let COURSE = null;
  let currentWeekId = null;
  let view = { screen: "loading", dayId: null, from: "home" };
  let toastTimer = null;
  let routeBusy = false;
  let bootFinished = false;
  let swRegistration = null;
  let rescueReloadStarted = false;
  const courseAssetCachingRequested = new Set();
  const offlineReadyNotified = new Set();
  let pendingCourseAssetCaching = null;

  const StorageAdapter = (function () {
    const prefix = "5g:";
    const memory = {};
    let available = false;
    try {
      localStorage.setItem(prefix + "test", "1");
      localStorage.removeItem(prefix + "test");
      available = true;
    } catch (_) {}

    return {
      get: async function (key) {
        try {
          return available ? JSON.parse(localStorage.getItem(prefix + key)) : (memory[key] || null);
        } catch (_) {
          return null;
        }
      },
      set: async function (key, value) {
        try {
          if (available) localStorage.setItem(prefix + key, JSON.stringify(value));
          else memory[key] = value;
        } catch (_) {
          memory[key] = value;
        }
        return value;
      }
    };
  })();

  const Progress = (function () {
    let key = "";
    let empty = null;
    let state = null;

    async function configure(userId, course) {
      key = "progress:" + userId + ":" + course.id;
      empty = {
        schema: 2,
        userId: userId,
        courseId: course.id,
        weekId: course.weeks[0] ? course.weeks[0].id : null,
        lastDayId: null,
        lastExerciseId: null,
        doneExercises: {},
        updatedAt: null
      };
      const saved = await StorageAdapter.get(key);
      state = saved && saved.schema === 2 && saved.userId === userId && saved.courseId === course.id
        ? Object.assign({}, empty, saved, { doneExercises: saved.doneExercises || {} })
        : Object.assign({}, empty, { doneExercises: {} });
      return state;
    }

    async function save() {
      if (!state || !key) return;
      state.updatedAt = Date.now();
      await StorageAdapter.set(key, state);
    }

    return {
      configure: configure,
      get: function () { return state || { doneExercises: {} }; },
      isDone: function (id) { return !!(state && state.doneExercises[id]); },
      toggle: async function (id) {
        if (!state) return;
        if (state.doneExercises[id]) delete state.doneExercises[id];
        else state.doneExercises[id] = Date.now();
        state.lastExerciseId = id;
        await save();
      },
      setPlace: async function (weekId, dayId, exerciseId) {
        if (!state) return;
        state.weekId = weekId || state.weekId;
        state.lastDayId = dayId || state.lastDayId;
        if (exerciseId) state.lastExerciseId = exerciseId;
        await save();
      },
      resetDay: async function (day) {
        if (!state) return;
        day.exercises.forEach(function (exercise) { delete state.doneExercises[exercise.id]; });
        await save();
      },
      resetAll: async function () {
        if (!empty) return;
        state = Object.assign({}, empty, { doneExercises: {} });
        await save();
      }
    };
  })();

  function showToast(message, buttonText, onButton) {
    $("toastMsg").textContent = message;
    const button = $("toastBtn");
    if (buttonText) {
      button.hidden = false;
      button.textContent = buttonText;
      button.onclick = function () {
        if (onButton) onButton();
        hideToast();
      };
    } else {
      button.hidden = true;
      button.onclick = null;
    }
    $("toast").classList.add("show");
    clearTimeout(toastTimer);
    if (!buttonText) toastTimer = setTimeout(hideToast, 3000);
  }

  function hideToast() {
    $("toast").classList.remove("show");
  }

  function collectCourseImageUrls(course) {
    const urls = new Set();
    if (!course || !Array.isArray(course.weeks)) return [];

    course.weeks.forEach(function (week) {
      if (!week || !Array.isArray(week.days)) return;
      week.days.forEach(function (day) {
        if (!day || !Array.isArray(day.exercises)) return;
        day.exercises.forEach(function (exercise) {
          if (!exercise || typeof exercise.image !== "string" || !exercise.image.trim()) return;
          try {
            const parsed = new URL(exercise.image.trim(), location.href);
            if (parsed.origin === location.origin && /\/assets\/courses\//i.test(parsed.pathname)) {
              urls.add(parsed.href);
            }
          } catch (_) {}
        });
      });
    });

    return Array.from(urls);
  }

  function postCourseAssetCaching(request) {
    const controller = navigator.serviceWorker.controller;
    if (!controller) {
      pendingCourseAssetCaching = request;
      return;
    }
    controller.postMessage({
      type: "CACHE_COURSE_ASSETS",
      courseId: request.courseId,
      urls: request.urls
    });
  }

  function requestCourseAssetCaching(courseId, urls) {
    if (!("serviceWorker" in navigator)) return;
    if (!Array.isArray(urls) || !urls.length) return;

    const id = String(courseId || "").trim();
    if (!id || courseAssetCachingRequested.has(id)) return;
    courseAssetCachingRequested.add(id);

    const request = { courseId: id, urls: urls.slice() };
    if (navigator.serviceWorker.controller) postCourseAssetCaching(request);
    else pendingCourseAssetCaching = request;
  }

  function flushPendingCourseAssetCaching() {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller || !pendingCourseAssetCaching) return;
    const request = pendingCourseAssetCaching;
    pendingCourseAssetCaching = null;
    postCourseAssetCaching(request);
  }

  async function handleCourseAssetsCached(data) {
    const courseId = String(data && data.courseId || "").trim();
    if (!courseId || !COURSE || COURSE.id !== courseId || offlineReadyNotified.has(courseId)) return;
    const total = Number(data && data.total);
    const cached = Number(data && data.cached);
    if (!Number.isFinite(total) || !Number.isFinite(cached) || total <= 0 || cached < total) return;
    offlineReadyNotified.add(courseId);

    const key = "offline-ready:" + courseId;
    if (await StorageAdapter.get(key)) return;
    await StorageAdapter.set(key, true);
    if (COURSE && COURSE.id === courseId) showToast("الكورس جاهز للاستخدام بدون إنترنت");
  }

  function setAuthenticatedHeader() {
    // Public PWA: no user/session controls are shown.
  }

  function activateScreen(screen) {
    document.querySelectorAll(".screen").forEach(function (element) {
      element.classList.remove("active");
    });
    const target = $("scr-" + screen);
    if (target) target.classList.add("active");
    view.screen = screen;
    setAuthenticatedHeader();
    window.scrollTo(0, 0);
  }

  function showLoading(message) {
    $("loadingMessage").textContent = message || "جارٍ تحميل التطبيق…";
    $("backBtn").hidden = true;
    $("brandSub").textContent = "الكورسات التدريبية";
    activateScreen("loading");
  }

  function renderRouteMessage(title, message, retry) {
    $("backBtn").hidden = true;
    $("brandSub").textContent = "5G Training";
    $("scr-courses").innerHTML = '<div class="security-message"><b>' + esc(title) + '</b>' +
      (message ? '<span>' + esc(message) + '</span>' : '') +
      (retry ? '<button class="cta ghost" id="retryApp" type="button">إعادة المحاولة</button>' : '') +
      '</div>';
    activateScreen("courses");
  }

  function courseById(courseId) {
    return myCourses.find(function (item) { return item.course_id === courseId; }) || null;
  }

  async function showNoCourseMessage() {
    renderRouteMessage("افتح رابط الكورس الخاص بك للمتابعة", "لا توجد قائمة كورسات عامة في هذا التطبيق.");
  }

  async function loadCourse(courseId) {
    if (routeBusy) return;
    routeBusy = true;
    showLoading("جارٍ فتح الكورس…");
    try {
      const selected = courseById(courseId);
      if (!selected || !selected.course) {
        COURSE = null;
        renderRouteMessage("هذا الكورس غير متاح أو الرابط غير صحيح", "تحقق من رابط الكورس ثم حاول مرة أخرى.");
        return;
      }
      await openCourseData(selected.course);
    } catch (_) {
      COURSE = null;
      renderRouteMessage("تعذر فتح الكورس", "تحقق من الاتصال ثم أعد المحاولة.", true);
    } finally {
      routeBusy = false;
    }
  }

  async function openCourseData(course) {
    if (!course || !Array.isArray(course.weeks)) throw new Error("INVALID_COURSE_DATA");

    COURSE = course;
    requestCourseAssetCaching(COURSE.id, collectCourseImageUrls(COURSE));
    await Progress.configure(PUBLIC_USER_ID, COURSE);
    await StorageAdapter.set(SELECTED_COURSE_KEY, COURSE.id);
    currentWeekId = Progress.get().weekId || (COURSE.weeks[0] ? COURSE.weeks[0].id : null);
    if (!COURSE.weeks.some(function (week) { return week.id === currentWeekId; })) {
      currentWeekId = COURSE.weeks[0] ? COURSE.weeks[0].id : null;
      await Progress.setPlace(currentWeekId, null, null);
    }

    const canonicalUrl = new URL(window.location.href);
    canonicalUrl.searchParams.set("course", COURSE.id);
    canonicalUrl.hash = "";
    history.replaceState({ courseId: COURSE.id }, "", canonicalUrl.pathname + canonicalUrl.search);
    showCourseScreen("home");
  }

  function legacyCourseIdFromHash() {
    const match = String(location.hash || "").match(/^#course\/([^/?#]+)$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); } catch (_) { return ""; }
  }

  function courseRoute() {
    const url = new URL(window.location.href);
    if (url.searchParams.has("course")) {
      return { source: "url", id: String(url.searchParams.get("course") || "").trim() };
    }
    const legacyId = legacyCourseIdFromHash();
    if (legacyId) return { source: "legacy", id: legacyId.trim() };
    return { source: "none", id: "" };
  }

  function currentWeek() {
    if (!COURSE) return null;
    return COURSE.weeks.find(function (week) { return week.id === currentWeekId; }) || COURSE.weeks[0] || null;
  }

  function dayStats(day) {
    const total = Array.isArray(day.exercises) ? day.exercises.length : 0;
    const done = total ? day.exercises.filter(function (exercise) { return Progress.isDone(exercise.id); }).length : 0;
    return {
      total: total,
      done: done,
      pct: total ? Math.round(done / total * 100) : 0,
      status: total === 0 ? "empty" : (done === 0 ? "new" : (done === total ? "completed" : "active"))
    };
  }

  function weekStats(week) {
    let total = 0;
    let done = 0;
    week.days.forEach(function (day) {
      const stats = dayStats(day);
      total += stats.total;
      done += stats.done;
    });
    return {
      total: total,
      done: done,
      pct: total ? Math.round(done / total * 100) : 0,
      status: total === 0 ? "locked" : (done === 0 ? "active" : (done === total ? "completed" : "active"))
    };
  }

  function ring(pct) {
    const radius = 33;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - pct / 100);
    return '<div class="ring"><svg width="78" height="78" viewBox="0 0 78 78" aria-hidden="true">' +
      '<circle cx="39" cy="39" r="' + radius + '" fill="none" stroke="#e8ebf0" stroke-width="7"/>' +
      '<circle cx="39" cy="39" r="' + radius + '" fill="none" stroke="#ffd400" stroke-width="7" stroke-linecap="round" stroke-dasharray="' +
      circumference.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '"/></svg>' +
      '<span class="val">' + pct + '%</span></div>';
  }

  function weeksHtml() {
    return COURSE.weeks.map(function (week) {
      const stats = weekStats(week);
      const selected = week.id === currentWeekId;
      const classes = selected ? "active-w" : (stats.status === "completed" ? "done" : "");
      return '<button class="week-item ' + classes + '" data-go-week="' + esc(week.id) + '">' +
        '<span class="ico">' + esc(week.name.replace(/[^0-9٠-٩]/g, "") || "✓") + '</span>' +
        '<span class="txt"><b>' + esc(week.name) + '</b><small>' + stats.done + ' من ' + stats.total + ' تمرين</small></span>' +
        '<span class="state ' + (selected ? "active-s" : (stats.status === "completed" ? "done-s" : "")) + '">' +
          (selected ? "الحالي" : (stats.status === "completed" ? "مكتمل" : "متاح")) +
        '</span>' +
      '</button>';
    }).join("");
  }

  function daysHtml(week) {
    return week.days.map(function (day) {
      const stats = dayStats(day);
      const locked = stats.total === 0;
      const classes = locked ? "locked" : (stats.status === "completed" ? "done" : "");
      return '<button class="day-card ' + classes + '" data-go-day="' + esc(day.id) + '">' +
        '<span class="day-head-row"><span class="day-badge">' + esc(day.code) + '</span>' +
        '<span class="day-info"><b>' + esc(day.name) + '</b><small>' + esc(day.goal) + '</small></span>' + CHEV + '</span>' +
        (locked
          ? '<div class="bar-lbl"><span>قيد الإضافة</span><span>—</span></div>'
          : '<div class="bar"><i style="width:' + stats.pct + '%"></i></div><div class="bar-lbl"><span>' + stats.done +
            ' من ' + stats.total + ' تمرين</span><span>' + stats.pct + '%</span></div>') +
      '</button>';
    }).join("");
  }

  function renderHome() {
    const week = currentWeek();
    if (!week) {
      $("scr-home").innerHTML = '<div class="empty"><b>لا يوجد محتوى</b>لم تُضف أسابيع لهذا الكورس بعد.</div>';
      return;
    }

    const stats = weekStats(week);
    const progress = Progress.get();
    const lastDay = week.days.find(function (day) { return day.id === progress.lastDayId; });
    const nextDay = lastDay && dayStats(lastDay).status !== "completed"
      ? lastDay
      : week.days.find(function (day) { return day.exercises.length && dayStats(day).status !== "completed"; }) || week.days[0];
    const ctaLabel = progress.lastDayId || stats.done > 0 ? "متابعة التدريب" : "ابدأ التدريب";

    $("scr-home").innerHTML = '<div class="hero">' +
      '<h1>' + esc(COURSE.title) + '</h1>' +
      (COURSE.audience ? '<div class="aud">' + esc(COURSE.audience) + '</div>' : '') +
      '<div class="sub">' + esc(COURSE.subtitle || "") + ' · ' + esc(week.name) + '</div>' +
      (COURSE.duration ? '<div class="dur-badge">مدة المرحلة: ' + esc(COURSE.duration) + '</div>' : '') +
      '<div class="hero-row">' + ring(stats.pct) + '<div class="hero-stats">' +
        '<div>التمارين المنجزة: <b>' + stats.done + ' من ' + stats.total + '</b></div>' +
        '<div>الأيام المكتملة: <b>' + week.days.filter(function (day) { return dayStats(day).status === "completed"; }).length +
          ' من ' + week.days.filter(function (day) { return day.exercises.length; }).length + '</b></div>' +
        (lastDay ? '<div>آخر جلسة: <b>' + esc(lastDay.name) + ' (' + esc(lastDay.code) + ')</b></div>' : '<div>لم تبدأ بعد</div>') +
      '</div></div>' +
      (nextDay ? '<button class="cta" data-go-day="' + esc(nextDay.id) + '">' + PLAY + ctaLabel + '</button>' : '') +
      '</div>' +
      (COURSE.weeks.length > 1 ? '<div class="sec-title">الأسابيع</div>' + weeksHtml() : '') +
      '<div class="sec-title">' + esc(week.name) + ' — أيام التدريب</div>' + daysHtml(week) +
      '<div class="sec-title">أدوات</div><button class="cta ghost" id="resetAll" type="button">تصفير كل التقدم</button>';
  }

  function renderDays() {
    const week = currentWeek();
    $("scr-days").innerHTML = week
      ? '<div class="sec-title">' + esc(week.name) + ' — أيام التدريب</div>' + daysHtml(week)
      : '<div class="empty"><b>لا يوجد أسبوع محدد</b></div>';
  }

  function safeVideoUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && ["youtube.com", "www.youtube.com", "youtu.be"].indexOf(host) !== -1 ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function safeImageUrl(value) {
    const url = String(value || "");
    if (!url) return "";
    if (/^data:image\/(?:webp|png|jpeg);base64,[a-z0-9+/=]+$/i.test(url)) return url;
    try {
      const parsed = new URL(url, window.location.href);
      const isSameSite = parsed.origin === window.location.origin;
      return isSameSite || (parsed.protocol === "https:" && /^https:\/\//i.test(url)) ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function exerciseHtml(exercise) {
    const done = Progress.isDone(exercise.id);
    const videoUrl = safeVideoUrl(exercise.youtubeUrl);
    const imageUrl = safeImageUrl(exercise.image);
    let videoButton = '<span class="yt none">' + YT + '<span>فيديو</span></span>';
    let videoNote = "";

    if (videoUrl && !navigator.onLine) {
      videoButton = '<button class="yt off" data-offline-video="1" type="button">' + YT + '<span>فيديو</span></button>';
      videoNote = '<div class="yt-note">مشاهدة الفيديو تحتاج اتصالاً بالإنترنت</div>';
    } else if (videoUrl) {
      videoButton = '<a class="yt" href="' + esc(videoUrl) + '" target="_blank" rel="noopener noreferrer">' + YT + '<span>فيديو</span></a>';
    }

    const details = (exercise.benefit ? '<div class="blk"><h6>الفائدة</h6><p>' + esc(exercise.benefit) + '</p></div>' : '') +
      (Array.isArray(exercise.howTo) && exercise.howTo.length
        ? '<div class="blk"><h6>كيفية التنفيذ</h6><ul>' + exercise.howTo.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join("") + '</ul></div>'
        : '') +
      (exercise.notes ? '<div class="blk"><h6>ملاحظات</h6><p>' + esc(exercise.notes) + '</p></div>' : '');

    return '<article class="ex' + (done ? " done" : "") + '" id="' + esc(exercise.id) + '">' +
      '<div class="ex-media">' +
        (imageUrl ? '<img class="ex-img" src="' + esc(imageUrl) + '" alt="' + esc(exercise.name) + '" loading="lazy" decoding="async">' : '') +
        '<span class="ex-n">' + Number(exercise.order || 0) + '</span>' +
        '<span class="media-bar"><span class="vol-tag">' + esc(exercise.volume) + '</span>' +
          (exercise.rest ? '<span class="rest-tag">راحة ' + esc(String(exercise.rest).replace(" ثانية", " ث")) + '</span>' : '') +
        '</span>' +
      '</div>' +
      '<div class="ex-h"><span class="ex-t"><span class="ar">' + esc(exercise.name) + '</span>' +
        (exercise.nameEn ? '<span class="en">' + esc(exercise.nameEn) + '</span>' : '') + '</span>' +
        '<button class="tick" data-tick="' + esc(exercise.id) + '" type="button" aria-label="تعليم كمنجز">' + CHECK + '</button></div>' +
      '<div class="ex-f">' + videoButton +
        (details ? '<details class="det"><summary>التفاصيل</summary><div class="det-body">' + details + '</div></details>' : '') +
      '</div>' + videoNote +
    '</article>';
  }

  function renderDay() {
    const week = currentWeek();
    const day = week ? week.days.find(function (item) { return item.id === view.dayId; }) : null;
    if (!day) {
      $("scr-day").innerHTML = '<div class="empty"><b>اليوم غير موجود</b></div>';
      return;
    }

    const stats = dayStats(day);
    let html = '<div class="day-hero"><h2>' + esc(day.name) + ' (' + esc(day.code) + ')</h2>' +
      '<div class="goal">' + esc(day.goal) + '</div><div class="meta-grid">' +
      '<div class="meta-pill"><small>بين المجموعات</small><b>' + esc(day.restSets) + '</b></div>' +
      '<div class="meta-pill"><small>بين التمارين</small><b>' + esc(day.restEx) + '</b></div>' +
      '<div class="meta-pill"><small>التمارين</small><b>' + stats.total + '</b></div>' +
      '<div class="meta-pill"><small>التقدم</small><b>' + stats.done + '/' + stats.total + ' · ' + stats.pct + '%</b></div>' +
      '</div>' + (stats.total ? '<div class="bar" style="margin-top:12px"><i style="width:' + stats.pct + '%"></i></div>' : '') + '</div>';

    if (day.order || (day.guidelines && day.guidelines.length) || (day.notes && day.notes.length)) {
      html += '<details class="acc"><summary>الإرشادات وملاحظات الجلسة</summary><div class="acc-body">' +
        (day.order ? '<div><h6>ترتيب التمارين</h6><p style="font-size:.8rem;color:var(--muted);direction:ltr;text-align:start">' + esc(day.order) + '</p></div>' : '') +
        (day.guidelines && day.guidelines.length ? '<div><h6>إرشادات مهمة</h6><ul>' + day.guidelines.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join("") + '</ul></div>' : '') +
        (day.notes && day.notes.length ? '<div><h6>ملاحظات عامة</h6><ul>' + day.notes.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join("") + '</ul></div>' : '') +
      '</div></details>';
    }

    if (stats.total) {
      html += day.exercises.map(exerciseHtml).join("");
      html += '<button class="cta ghost" data-reset-day="' + esc(day.id) + '" type="button">تصفير تقدم هذا اليوم</button>';
    } else {
      html += '<div class="empty"><b>لم تُضف تمارين هذا اليوم بعد</b>سيتم تعبئة اليوم ' + esc(day.code) + ' قريباً.</div>';
    }
    if (day.sessionLine) html += '<p class="footer">' + esc(day.sessionLine) + '</p>';
    $("scr-day").innerHTML = html;
  }

  function showCourseScreen(screen, dayId) {
    if (!COURSE) {
      renderRouteMessage("افتح رابط الكورس الخاص بك للمتابعة", "لا توجد قائمة كورسات عامة في هذا التطبيق.");
      return;
    }
    view.screen = screen;
    if (dayId) view.dayId = dayId;
    const week = currentWeek();

    $("backBtn").hidden = screen === "home";
    $("brandSub").textContent = screen === "home" ? COURSE.title :
      screen === "days" ? (week ? week.name : COURSE.title) :
      ((week && week.days.find(function (day) { return day.id === view.dayId; })) || {}).name || COURSE.title;

    if (screen === "home") renderHome();
    if (screen === "days") renderDays();
    if (screen === "day") renderDay();
    activateScreen(screen);
  }

  function handleBack() {
    if (view.screen === "day") showCourseScreen(view.from || "home");
    else if (view.screen === "days") showCourseScreen("home");
  }

  function netUI() {
    const offline = !navigator.onLine;
    $("netDot").classList.toggle("off", offline);
    $("netDot").title = offline ? "لا يوجد اتصال" : "متصل";
    if (view.screen === "day" && COURSE) renderDay();
  }

  async function boot() {
    netUI();
    $("verLbl").textContent = "v" + APP_VERSION;

    const data = window.COURSE_DATA || {};
    myCourses = Object.keys(data).map(function (courseId) {
      const course = data[courseId];
      return {
        course_id: courseId,
        course_name: course && course.title ? course.title : courseId,
        course: course
      };
    });

    if (!myCourses.length) {
      renderRouteMessage("تعذر تحميل بيانات الكورسات", "تحقق من الاتصال ثم أعد المحاولة.", true);
      return;
    }

    const route = courseRoute();
    if (route.source !== "none") {
      await loadCourse(route.id);
      return;
    }

    const savedCourseId = await StorageAdapter.get(SELECTED_COURSE_KEY);
    if (savedCourseId) {
      await loadCourse(String(savedCourseId));
      return;
    }

    await showNoCourseMessage();
  }

  $("backBtn").addEventListener("click", handleBack);

  document.addEventListener("click", async function (event) {
    if (event.target.closest("#retryApp")) {
      window.location.reload();
      return;
    }

    const openCourse = event.target.closest("[data-open-course]");
    if (openCourse) {
      await loadCourse(openCourse.dataset.openCourse);
      return;
    }


    const goWeek = event.target.closest("[data-go-week]");
    if (goWeek && COURSE) {
      const selected = COURSE.weeks.find(function (week) { return week.id === goWeek.dataset.goWeek; });
      if (selected) {
        currentWeekId = selected.id;
        await Progress.setPlace(currentWeekId, null, null);
        showCourseScreen("days");
      }
      return;
    }

    const goDay = event.target.closest("[data-go-day]");
    if (goDay && COURSE) {
      const week = currentWeek();
      const day = week && week.days.find(function (item) { return item.id === goDay.dataset.goDay; });
      if (!day || !day.exercises.length) {
        showToast("هذا اليوم قيد الإضافة");
        return;
      }
      view.from = view.screen === "day" ? (view.from || "home") : view.screen;
      await Progress.setPlace(currentWeekId, day.id, null);
      showCourseScreen("day", day.id);
      return;
    }

    const tick = event.target.closest("[data-tick]");
    if (tick && COURSE) {
      await Progress.toggle(tick.dataset.tick);
      await Progress.setPlace(currentWeekId, view.dayId, tick.dataset.tick);
      renderDay();
      return;
    }

    const media = event.target.closest(".ex-media");
    if (media) {
      const card = media.closest(".ex");
      const image = media.querySelector("img");
      if (image) {
        $("lbImg").src = image.src;
        $("lbCap").textContent = card && card.querySelector(".ex-t .ar") ? card.querySelector(".ex-t .ar").textContent : "";
        $("lightbox").classList.add("show");
        $("lightbox").setAttribute("aria-hidden", "false");
      }
      return;
    }

    if (event.target.closest("#lightbox")) {
      $("lightbox").classList.remove("show");
      $("lightbox").setAttribute("aria-hidden", "true");
      $("lbImg").src = "";
      return;
    }

    if (event.target.closest("[data-offline-video]")) {
      showToast("مشاهدة الفيديو تحتاج اتصالاً بالإنترنت");
      return;
    }

    const resetDay = event.target.closest("[data-reset-day]");
    if (resetDay && COURSE) {
      const week = currentWeek();
      const day = week && week.days.find(function (item) { return item.id === resetDay.dataset.resetDay; });
      if (day) {
        await Progress.resetDay(day);
        renderDay();
        showToast("تم تصفير تقدم هذا اليوم");
      }
      return;
    }

    if (event.target.id === "resetAll") {
      showToast("سيتم حذف كل تقدمك على هذا الجهاز. متأكد؟", "نعم، صفّر", async function () {
        await Progress.resetAll();
        showCourseScreen("home");
        showToast("تم التصفير");
      });
    }
  });

  window.addEventListener("online", function () {
    netUI();
    showToast("عاد الاتصال بالإنترنت");
  });
  window.addEventListener("offline", function () {
    netUI();
    showToast("لا يوجد اتصال — الفيديوهات تحتاج إنترنت، وباقي المحتوى يبقى متاحاً");
  });
  function handleRouteChange() {
    const route = courseRoute();
    if (route.source !== "none" && (!COURSE || COURSE.id !== route.id)) loadCourse(route.id);
  }

  window.addEventListener("hashchange", handleRouteChange);
  window.addEventListener("popstate", handleRouteChange);

  function isLoadingScreenActive() {
    const loadingScreen = $("scr-loading");
    return view.screen === "loading" && !!loadingScreen && loadingScreen.classList.contains("active");
  }

  function rescueReloadIfLoading() {
    if (!isLoadingScreenActive() || rescueReloadStarted) return false;
    rescueReloadStarted = true;

    try {
      if (sessionStorage.getItem(SW_RELOAD_KEY) === "1") return false;
      sessionStorage.setItem(SW_RELOAD_KEY, "1");
    } catch (_) {
      // Without sessionStorage there is no safe cross-reload guard, so do not
      // risk turning a storage failure into an automatic reload loop.
      return false;
    }

    window.location.reload();
    return true;
  }

  function requestServiceWorkerUpdate() {
    function updateRegistration(registration) {
      if (!registration) return;
      swRegistration = registration;
      function skipWaitingIfReady() {
        if (registration.waiting) registration.waiting.postMessage("SKIP_WAITING");
      }
      registration.update().then(skipWaitingIfReady).catch(function () {});
      skipWaitingIfReady();
    }

    if (swRegistration) {
      updateRegistration(swRegistration);
      return;
    }

    navigator.serviceWorker.getRegistration().then(updateRegistration).catch(function () {});
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (event.data && event.data.type === "SW_ACTIVATED" && isLoadingScreenActive()) {
        rescueReloadIfLoading();
      }
      if (event.data && event.data.type === "COURSE_ASSETS_CACHED") {
        handleCourseAssetsCached(event.data).catch(function () {});
      }
    });

    window.addEventListener("load", function () {
      let hadController = Boolean(navigator.serviceWorker.controller);

      navigator.serviceWorker.addEventListener("controllerchange", function () {
        flushPendingCourseAssetCaching();
        if (!hadController) {
          hadController = true;
          return;
        }
        if (isLoadingScreenActive()) rescueReloadIfLoading();
      });

      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(function (registration) {
        swRegistration = registration;
        flushPendingCourseAssetCaching();
        registration.update().catch(function () {});
        function skipWaitingWhenReady(worker) {
          if (!worker) return;
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage("SKIP_WAITING");
          }
          worker.addEventListener("statechange", function () {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage("SKIP_WAITING");
            }
          });
        }

        registration.addEventListener("updatefound", function () {
          skipWaitingWhenReady(registration.installing);
        });
        skipWaitingWhenReady(registration.waiting);
      }).catch(function () {});
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && swRegistration) {
        swRegistration.update().catch(function () {});
      }
    });
  }

  setTimeout(function () {
    if (isLoadingScreenActive()) {
      if ("serviceWorker" in navigator) requestServiceWorkerUpdate();
      else if (!bootFinished) {
      renderRouteMessage("تعذر تحميل التطبيق", "تحقق من الاتصال ثم أعد المحاولة.", true);
      }
    }
  }, 8000);

  boot().then(function () {
    bootFinished = true;
  }).catch(function () {
    bootFinished = true;
    renderRouteMessage("تعذر تحميل التطبيق", "تحقق من الاتصال ثم أعد المحاولة.", true);
  });
})();

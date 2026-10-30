/* ============================================================
   ملاحظاتي — منطق التطبيق
   قاعدة بيانات محلية (localStorage) + حساب مستقل لكل مستخدم
   ============================================================ */

(() => {
  'use strict';

  /* ---------- الثوابت ---------- */

  const STORAGE = {
    users: 'mulahazati.users.v1',
    session: 'mulahazati.session.v1',
    notes: (userId) => `mulahazati.notes.v1.${userId}`,
    theme: 'mulahazati.theme.v1',
    layout: 'mulahazati.layout.v1'
  };

  const SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30 يومًا
  const SESSION_TAB_MS = 12 * 60 * 60 * 1000;          // 12 ساعة
  const STORAGE_LIMIT = 5 * 1024 * 1024;               // تقدير 5 م.ب

  const NOTE_COLORS = ['default', 'blue', 'green', 'amber', 'rose', 'violet'];

  const VIEW_META = {
    all: {
      eyebrow: 'مساحتي',
      title: 'كل الملاحظات',
      subtitle: 'كل أفكارك وملاحظاتك في مكان واحد.'
    },
    favorites: {
      eyebrow: 'الملاحظات المميزة',
      title: 'المفضلة',
      subtitle: 'الملاحظات التي تريد العودة إليها دائمًا.'
    },
    trash: {
      eyebrow: 'سلة المحذوفات',
      title: 'المهملات',
      subtitle: 'الملاحظات المحذوفة يمكن استعادتها قبل حذفها نهائيًا.'
    }
  };

  const SORT_LABELS = {
    updated: 'آخر تعديل',
    created: 'تاريخ الإنشاء',
    title: 'العنوان'
  };

  /* ---------- الحالة ---------- */

  const state = {
    users: [],
    user: null,
    notes: [],
    view: 'all',
    query: '',
    sort: 'updated',
    layout: 'grid',
    theme: 'system',
    authMode: 'login',
    editingId: null,
    editorColor: 'default',
    editorPinned: false,
    editorFavorite: false,
    editorSnapshot: '',
    confirmCallback: null,
    searchTimer: null
  };

  let els = {};

  /* ---------- أدوات مساعدة ---------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn('تعذر قراءة البيانات المحلية:', error);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error('تعذر حفظ البيانات المحلية:', error);
      return false;
    }
  }

  function getNotesKey(userId) {
    return STORAGE.notes(userId);
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
  }

  function collapseSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 ك.ب';
    if (bytes < 1024) return `${bytes} بايت`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} م.ب`;
  }

  function relativeTime(timestamp) {
    if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return 'الآن';

    const diff = Number(timestamp) - Date.now();
    const abs = Math.abs(diff);

    if (abs < 60 * 1000) return 'الآن';

    try {
      const formatter = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
      if (abs < 60 * 60 * 1000) return formatter.format(Math.round(diff / (60 * 1000)), 'minute');
      if (abs < 24 * 60 * 60 * 1000) return formatter.format(Math.round(diff / (60 * 60 * 1000)), 'hour');
      if (abs < 7 * 24 * 60 * 60 * 1000) return formatter.format(Math.round(diff / (24 * 60 * 60 * 1000)), 'day');
    } catch (error) {
      // تجاهل عدم دعم المتصفح لصيغة الوقت النسبي
    }

    const date = new Date(timestamp);
    const options = { day: 'numeric', month: 'short' };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';

    try {
      return new Intl.DateTimeFormat('ar', options).format(date);
    } catch (error) {
      return date.toLocaleDateString();
    }
  }

  function formatFullDate(timestamp) {
    if (!timestamp) return 'الآن';
    try {
      return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function wordLabel(count) {
    if (count === 0) return '0 كلمة';
    if (count === 1) return 'كلمة واحدة';
    if (count === 2) return 'كلمتان';
    if (count <= 10) return `${count} كلمات`;
    return `${count} كلمة`;
  }

  function getInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'م';
    const first = Array.from(parts[0])[0] || '';
    const second = parts[1] ? Array.from(parts[1])[0] : '';
    return (first + second).slice(0, 2) || 'م';
  }

  function avatarGradient(seed) {
    let hash = 0;
    for (const char of String(seed || '')) {
      hash = ((hash * 31) + char.charCodeAt(0)) % 360;
    }
    return `linear-gradient(135deg, hsl(${hash} 76% 56%), hsl(${(hash + 58) % 360} 82% 62%))`;
  }

  function normalizeSearch(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- تشفير كلمات المرور ---------- */

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function randomHex(length = 16) {
    const bytes = new Uint8Array(length);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    return bytesToHex(bytes);
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.floor(Math.random() * 16);
      const value = char === 'x' ? random : ((random & 0x3) | 0x8);
      return value.toString(16);
    });
  }

  function utf8String(value) {
    const bytes = new TextEncoder().encode(String(value));
    let output = '';
    for (const byte of bytes) output += String.fromCharCode(byte);
    return output;
  }

  // تطبيق SHA-256 احتياطي للمتصفحات التي لا تدعم Web Crypto
  function sha256Fallback(ascii) {
    const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    const maxWord = 2 ** 32;
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    const constants = sha256Fallback.h = sha256Fallback.h || [];
    const k = sha256Fallback.k = sha256Fallback.k || [];
    let primeCounter = constants.length;
    const isComposite = {};

    for (let candidate = 2; primeCounter < 64; candidate += 1) {
      if (!isComposite[candidate]) {
        for (let multiple = 0; multiple < 313; multiple += candidate) {
          isComposite[multiple] = candidate;
        }
        constants[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
        primeCounter += 1;
      }
    }

    ascii += '\x80';
    while (ascii.length % 64 !== 56) ascii += '\x00';

    for (let index = 0; index < ascii.length; index += 1) {
      const code = ascii.charCodeAt(index);
      if (code >> 8) return '';
      words[index >> 2] |= code << (((3 - index) % 4) * 8);
    }

    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    let hash = constants.slice(0, 8);

    for (let blockStart = 0; blockStart < words.length;) {
      const w = words.slice(blockStart, (blockStart += 16));
      const oldHash = hash.slice(0, 8);
      const working = hash.slice(0, 8);

      for (let index = 0; index < 64; index += 1) {
        const w15 = w[index - 15];
        const w2 = w[index - 2];
        const a = working[0];
        const e = working[4];

        const temp1 = (
          working[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & working[5]) ^ (~e & working[6])) +
          k[index] +
          (w[index] = index < 16
            ? w[index]
            : (
              w[index - 16] +
              (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
              w[index - 7] +
              (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0)
        ) | 0;

        const temp2 = (
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))
        ) | 0;

        working.unshift((temp1 + temp2) | 0);
        working[4] = (working[4] + temp1) | 0;
        working.length = 8;
      }

      hash = working.map((value, index) => (value + oldHash[index]) | 0);
    }

    for (let index = 0; index < 8; index += 1) {
      for (let byteIndex = 3; byteIndex >= 0; byteIndex -= 1) {
        const byte = (hash[index] >> (byteIndex * 8)) & 255;
        result += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }

    return result;
  }

  async function hashPassword(password, saltHex) {
    if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.importKey === 'function') {
      try {
        const key = await window.crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(password),
          { name: 'PBKDF2' },
          false,
          ['deriveBits']
        );
        const bits = await window.crypto.subtle.deriveBits(
          {
            name: 'PBKDF2',
            salt: hexToBytes(saltHex),
            iterations: 120000,
            hash: 'SHA-256'
          },
          key,
          256
        );
        return bytesToHex(new Uint8Array(bits));
      } catch (error) {
        console.warn('تعذر استخدام Web Crypto، سيتم استخدام التشفير الاحتياطي.', error);
      }
    }

    let digest = sha256Fallback(utf8String(`${saltHex}:${password}`));
    for (let round = 0; round < 2500; round += 1) {
      digest = sha256Fallback(utf8String(`${digest}:${saltHex}`));
    }
    return digest;
  }

  function scorePassword(password) {
    if (!password) return 0;
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Za-z\u0600-\u06FF]/.test(password) && /\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9\u0600-\u06FF]/.test(password)) score += 1;
    return Math.min(score, 4);
  }

  function passwordStrengthLabel(score) {
    if (score === 0) return 'استخدم 8 أحرف على الأقل';
    if (score === 1) return 'كلمة مرور ضعيفة';
    if (score === 2) return 'كلمة مرور متوسطة';
    if (score === 3) return 'كلمة مرور جيدة';
    return 'كلمة مرور قوية';
  }

  /* ---------- الجلسة والمستخدمون ---------- */

  function loadUsers() {
    const users = readJSON(STORAGE.users, []);
    state.users = Array.isArray(users)
      ? users.filter((user) => (
        user
        && typeof user.id === 'string'
        && typeof user.email === 'string'
        && typeof user.salt === 'string'
        && typeof user.passwordHash === 'string'
      ))
      : [];
  }

  function saveUsers() {
    return writeJSON(STORAGE.users, state.users);
  }

  function setSession(userId, remember) {
    clearSession();
    const session = {
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + (remember ? SESSION_REMEMBER_MS : SESSION_TAB_MS)
    };
    try {
      const store = remember ? localStorage : sessionStorage;
      store.setItem(STORAGE.session, JSON.stringify(session));
    } catch (error) {
      console.error('تعذر إنشاء الجلسة:', error);
    }
  }

  function readSession() {
    const stores = [];

    // الوصول إلى التخزين قد يفشل في المتصفحات التي تمنع التخزين المحلي
    try {
      if (window.sessionStorage) stores.push(window.sessionStorage);
    } catch (error) {
      // تجاهل
    }

    try {
      if (window.localStorage) stores.push(window.localStorage);
    } catch (error) {
      // تجاهل
    }

    for (const store of stores) {
      try {
        const raw = store.getItem(STORAGE.session);
        if (!raw) continue;
        const session = JSON.parse(raw);
        if (!session || !session.userId) {
          store.removeItem(STORAGE.session);
          continue;
        }
        if (session.expiresAt && session.expiresAt < Date.now()) {
          store.removeItem(STORAGE.session);
          continue;
        }
        return session;
      } catch (error) {
        // تجاهل الجلسات التالفة
      }
    }
    return null;
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(STORAGE.session);
    } catch (error) {
      // تجاهل
    }

    try {
      localStorage.removeItem(STORAGE.session);
    } catch (error) {
      // تجاهل
    }
  }

  function loadNotes(userId) {
    const notes = readJSON(getNotesKey(userId), []);
    if (!Array.isArray(notes)) return [];

    return notes
      .filter((note) => note && typeof note === 'object')
      .map((note) => ({
        id: typeof note.id === 'string' ? note.id : uuid(),
        title: typeof note.title === 'string' ? note.title : '',
        content: typeof note.content === 'string' ? note.content : '',
        color: NOTE_COLORS.includes(note.color) ? note.color : 'default',
        pinned: Boolean(note.pinned),
        favorite: Boolean(note.favorite),
        trashed: Boolean(note.trashed),
        createdAt: Number(note.createdAt) || Date.now(),
        updatedAt: Number(note.updatedAt) || Number(note.createdAt) || Date.now(),
        deletedAt: note.deletedAt ? Number(note.deletedAt) : null
      }));
  }

  function persistNotes() {
    if (!state.user) return false;
    const saved = writeJSON(getNotesKey(state.user.id), state.notes);
    if (!saved) {
      toast('تعذر حفظ الملاحظات. قد تكون مساحة التخزين ممتلئة.', 'error', 5000);
      return false;
    }
    updateStorageMeter();
    return true;
  }

  function findNote(noteId) {
    return state.notes.find((note) => note.id === noteId) || null;
  }

  /* ---------- المظهر ---------- */

  function getStoredTheme() {
    try {
      const theme = localStorage.getItem(STORAGE.theme);
      return ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    } catch (error) {
      return 'system';
    }
  }

  function resolveTheme(theme) {
    if (theme === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return theme;
  }

  function applyTheme(theme, persist = true) {
    state.theme = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    const resolved = resolveTheme(state.theme);
    document.documentElement.dataset.theme = resolved;

    if (persist) {
      try {
        localStorage.setItem(STORAGE.theme, state.theme);
      } catch (error) {
        // تجاهل
      }
    }

    updateThemeOptions();
    updateThemeToggleLabel();
  }

  function updateThemeToggleLabel() {
    if (!els.themeToggle) return;
    const resolved = document.documentElement.dataset.theme;
    const label = resolved === 'dark' ? 'التبديل إلى المظهر الفاتح' : 'التبديل إلى المظهر الداكن';
    els.themeToggle.setAttribute('aria-label', label);
    els.themeToggle.setAttribute('title', label);
  }

  function updateThemeOptions() {
    $$('[data-theme-choice]').forEach((button) => {
      const active = button.dataset.themeChoice === state.theme;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  /* ---------- واجهة المصادقة ---------- */

  function showAuth() {
    els.app.hidden = true;
    els.authScreen.hidden = false;
    document.title = 'ملاحظاتي — مساحتك الخاصة';
    closeSidebar();
    setAuthMode('login');
  }

  function setAuthMode(mode) {
    state.authMode = mode === 'register' ? 'register' : 'login';

    $$('[data-auth-tab]').forEach((tab) => {
      const active = tab.dataset.authTab === state.authMode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    els.loginForm.hidden = state.authMode !== 'login';
    els.registerForm.hidden = state.authMode !== 'register';

    if (state.authMode === 'register') {
      els.authHeading.textContent = 'أنشئ مساحتك الخاصة';
      els.authSubheading.textContent = 'حساب واحد، وكل ملاحظاتك في مكان آمن خاص بك.';
    } else {
      els.authHeading.textContent = 'مرحبًا بعودتك';
      els.authSubheading.textContent = 'سجّل الدخول للوصول إلى ملاحظاتك الخاصة.';
    }

    hideAlert(els.loginAlert);
    hideAlert(els.registerAlert);
    clearFormErrors(els.loginForm);
    clearFormErrors(els.registerForm);
    resetPasswordVisibility();
  }

  function setFieldError(input, message) {
    if (!input) return;
    const field = input.closest('.field');
    if (!field) return;
    field.classList.toggle('has-error', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    const error = field.querySelector('.field-error');
    if (error) error.textContent = message || '';
  }

  function clearFormErrors(form) {
    if (!form) return;
    $$('.field', form).forEach((field) => {
      field.classList.remove('has-error');
      const input = field.querySelector('input');
      if (input) input.removeAttribute('aria-invalid');
      const error = field.querySelector('.field-error');
      if (error) error.textContent = '';
    });
  }

  function resetPasswordVisibility() {
    $$('input[data-password-input]').forEach((input) => {
      input.type = 'password';
    });

    $$('[data-toggle-password]').forEach((toggle) => {
      toggle.setAttribute('aria-label', 'إظهار كلمة المرور');
      const use = toggle.querySelector('use');
      if (use) use.setAttribute('href', '#i-eye');
    });
  }

  function showAlert(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
  }

  function hideAlert(element) {
    if (!element) return;
    element.hidden = true;
    element.textContent = '';
  }

  function setButtonLoading(button, loading, loadingText = 'جارٍ المعالجة...') {
    if (!button) return;
    if (loading) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(loadingText)}</span>`;
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  function updatePasswordStrength(password) {
    if (!els.passwordStrength) return;
    const score = scorePassword(password);
    els.passwordStrength.classList.remove('score-1', 'score-2', 'score-3', 'score-4');
    if (score > 0) els.passwordStrength.classList.add(`score-${score}`);
    els.passwordStrength.querySelector('.strength-label').textContent = passwordStrengthLabel(score);
  }

  async function handleLogin(event) {
    event.preventDefault();
    hideAlert(els.loginAlert);
    clearFormErrors(els.loginForm);

    const email = normalizeEmail(els.loginEmail.value);
    const password = els.loginPassword.value;
    let valid = true;

    if (!email) {
      setFieldError(els.loginEmail, 'يرجى إدخال البريد الإلكتروني.');
      valid = false;
    } else if (!isValidEmail(email)) {
      setFieldError(els.loginEmail, 'صيغة البريد الإلكتروني غير صحيحة.');
      valid = false;
    }

    if (!password) {
      setFieldError(els.loginPassword, 'يرجى إدخال كلمة المرور.');
      valid = false;
    }

    if (!valid) return;

    setButtonLoading(els.loginSubmit, true, 'جارٍ تسجيل الدخول...');

    try {
      const user = state.users.find((item) => item.email === email);

      if (!user) {
        showAlert(els.loginAlert, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
        els.loginPassword.value = '';
        els.loginPassword.focus();
        return;
      }

      const passwordHash = await hashPassword(password, user.salt);
      if (passwordHash !== user.passwordHash) {
        showAlert(els.loginAlert, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.');
        els.loginPassword.value = '';
        els.loginPassword.focus();
        return;
      }

      setSession(user.id, els.rememberMe.checked);
      state.user = user;
      state.notes = loadNotes(user.id);
      enterApp();
      toast(`مرحبًا بعودتك، ${user.name.split(/\s+/)[0] || 'صديقنا'}.`, 'success');
    } catch (error) {
      console.error(error);
      showAlert(els.loginAlert, 'حدث خطأ غير متوقع أثناء تسجيل الدخول. حاول مرة أخرى.');
    } finally {
      setButtonLoading(els.loginSubmit, false);
    }
  }

  async function handleRegister(event) {
    event.preventDefault();
    hideAlert(els.registerAlert);
    clearFormErrors(els.registerForm);

    const name = collapseSpaces(els.registerName.value);
    const email = normalizeEmail(els.registerEmail.value);
    const password = els.registerPassword.value;
    const confirm = els.registerConfirm.value;
    let valid = true;

    if (name.length < 2) {
      setFieldError(els.registerName, 'يرجى إدخال الاسم الكامل (حرفان على الأقل).');
      valid = false;
    }

    if (!email) {
      setFieldError(els.registerEmail, 'يرجى إدخال البريد الإلكتروني.');
      valid = false;
    } else if (!isValidEmail(email)) {
      setFieldError(els.registerEmail, 'صيغة البريد الإلكتروني غير صحيحة.');
      valid = false;
    } else if (state.users.some((user) => user.email === email)) {
      setFieldError(els.registerEmail, 'يوجد حساب مسجل بهذا البريد الإلكتروني بالفعل.');
      valid = false;
    }

    if (password.length < 8) {
      setFieldError(els.registerPassword, 'يجب أن تكون كلمة المرور 8 أحرف على الأقل.');
      valid = false;
    }

    if (!confirm) {
      setFieldError(els.registerConfirm, 'يرجى تأكيد كلمة المرور.');
      valid = false;
    } else if (confirm !== password) {
      setFieldError(els.registerConfirm, 'كلمتا المرور غير متطابقتين.');
      valid = false;
    }

    if (!valid) return;

    setButtonLoading(els.registerSubmit, true, 'جارٍ إنشاء الحساب...');

    try {
      const salt = randomHex(16);
      const passwordHash = await hashPassword(password, salt);

      const user = {
        id: uuid(),
        name,
        email,
        salt,
        passwordHash,
        createdAt: Date.now()
      };

      state.users.push(user);
      if (!saveUsers()) {
        state.users.pop();
        showAlert(els.registerAlert, 'تعذر حفظ الحساب على هذا الجهاز. تحقق من إعدادات التخزين في المتصفح.');
        return;
      }

      state.user = user;
      state.notes = [];
      setSession(user.id, true);
      els.registerForm.reset();
      updatePasswordStrength('');
      enterApp();
      toast(`تم إنشاء حسابك بنجاح، مرحبًا ${name.split(/\s+/)[0]}.`, 'success', 4500);
    } catch (error) {
      console.error(error);
      showAlert(els.registerAlert, 'حدث خطأ غير متوقع أثناء إنشاء الحساب. حاول مرة أخرى.');
    } finally {
      setButtonLoading(els.registerSubmit, false);
    }
  }

  /* ---------- الدخول إلى التطبيق ---------- */

  function enterApp() {
    if (!state.user) return;

    els.authScreen.hidden = true;
    els.app.hidden = false;
    document.title = `ملاحظاتي — ${state.user.name}`;

    els.loginPassword.value = '';
    els.registerPassword.value = '';
    els.registerConfirm.value = '';
    hideAlert(els.loginAlert);
    hideAlert(els.registerAlert);
    resetPasswordVisibility();

    state.view = 'all';
    state.query = '';
    state.sort = 'updated';
    state.layout = getStoredLayout();
    els.searchInput.value = '';
    els.sortSelect.value = 'updated';
    updateSearchUI();
    setActiveView('all');
    updateUserUI();
    renderAll();
    closeSidebar();
  }

  function getStoredLayout() {
    try {
      return localStorage.getItem(STORAGE.layout) === 'list' ? 'list' : 'grid';
    } catch (error) {
      return 'grid';
    }
  }

  function logout() {
    clearSession();
    state.user = null;
    state.notes = [];
    state.query = '';
    state.view = 'all';
    state.editingId = null;
    closeAllModals();
    els.loginForm.reset();
    els.registerForm.reset();
    updatePasswordStrength('');
    resetPasswordVisibility();
    showAuth();
    toast('تم تسجيل الخروج بأمان.', 'info');
  }

  function updateUserUI() {
    if (!state.user) return;
    const firstName = state.user.name.split(/\s+/)[0] || state.user.name;

    els.sidebarName.textContent = state.user.name;
    els.sidebarEmail.textContent = state.user.email;
    els.sidebarAvatar.textContent = getInitials(state.user.name);
    els.sidebarAvatar.style.background = avatarGradient(state.user.email);
    els.sidebarAvatar.title = state.user.name;

    if (els.profileName) els.profileName.value = state.user.name;
    if (els.profileEmail) els.profileEmail.value = state.user.email;

    document.title = `ملاحظاتي — ${firstName}`;
  }

  /* ---------- العرض ---------- */

  function setActiveView(view) {
    state.view = view;
    $$('[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  function getVisibleNotes() {
    let notes = state.notes.filter((note) => (
      state.view === 'trash' ? note.trashed : !note.trashed
    ));

    if (state.view === 'favorites') {
      notes = notes.filter((note) => note.favorite);
    }

    const query = normalizeSearch(state.query);
    if (query) {
      notes = notes.filter((note) => normalizeSearch(`${note.title} ${note.content}`).includes(query));
    }

    notes.sort((first, second) => {
      if (state.view !== 'trash' && first.pinned !== second.pinned) {
        return first.pinned ? -1 : 1;
      }

      if (state.sort === 'title') {
        const firstTitle = first.title || 'بدون عنوان';
        const secondTitle = second.title || 'بدون عنوان';
        return firstTitle.localeCompare(secondTitle, 'ar');
      }

      if (state.view === 'trash' && state.sort === 'updated') {
        return (second.deletedAt || second.updatedAt) - (first.deletedAt || first.updatedAt);
      }

      if (state.sort === 'created') {
        return second.createdAt - first.createdAt;
      }

      return second.updatedAt - first.updatedAt;
    });

    return notes;
  }

  function noteCardHTML(note) {
    const isTrash = state.view === 'trash';
    const title = note.title.trim();
    const content = note.content.trim();
    const displayTitle = title || 'بدون عنوان';
    const displayContent = content || 'لا يوجد محتوى إضافي.';
    const dateText = isTrash
      ? `حُذفت ${relativeTime(note.deletedAt || note.updatedAt)}`
      : relativeTime(note.updatedAt);
    const ariaLabel = isTrash
      ? `ملاحظة محذوفة: ${displayTitle}`
      : `فتح الملاحظة: ${displayTitle}`;

    return `
      <article
        class="note-card ${isTrash ? 'note-card--trash' : ''}"
        data-id="${escapeHtml(note.id)}"
        data-color="${escapeHtml(note.color)}"
      >
        ${isTrash ? '' : `<button class="note-card-open" type="button" aria-label="${escapeHtml(ariaLabel)}"></button>`}
        <div class="note-card-head">
          <span class="note-color-dot" aria-hidden="true"></span>
          ${isTrash ? '' : `
            <div class="note-card-tools">
              <button class="note-tool ${note.pinned ? 'is-active' : ''}" type="button" data-action="pin"
                aria-label="${note.pinned ? 'إلغاء تثبيت الملاحظة' : 'تثبيت الملاحظة'}"
                title="${note.pinned ? 'إلغاء التثبيت' : 'تثبيت'}">
                <svg class="icon"><use href="#i-pin"/></svg>
              </button>
              <button class="note-tool ${note.favorite ? 'is-active' : ''}" type="button" data-action="favorite"
                aria-label="${note.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}"
                title="${note.favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}">
                <svg class="icon"><use href="#i-star"/></svg>
              </button>
            </div>
          `}
        </div>

        <div class="note-card-main">
          <h3 class="${title ? '' : 'is-untitled'}">${escapeHtml(displayTitle)}</h3>
          <p class="${content ? '' : 'is-empty'}">${escapeHtml(displayContent)}</p>
        </div>

        <footer class="note-card-foot">
          <span class="note-date">
            <svg class="icon"><use href="#i-clock"/></svg>
            <span>${escapeHtml(dateText)}</span>
          </span>
          <div class="note-card-actions">
            ${isTrash ? `
              <button class="note-tool is-restore" type="button" data-action="restore" aria-label="استعادة الملاحظة" title="استعادة">
                <svg class="icon"><use href="#i-restore"/></svg>
              </button>
              <button class="note-tool is-danger" type="button" data-action="purge" aria-label="حذف الملاحظة نهائيًا" title="حذف نهائي">
                <svg class="icon"><use href="#i-trash"/></svg>
              </button>
            ` : `
              <button class="note-tool is-danger" type="button" data-action="trash" aria-label="نقل إلى المهملات" title="نقل إلى المهملات">
                <svg class="icon"><use href="#i-trash"/></svg>
              </button>
            `}
          </div>
        </footer>
      </article>
    `;
  }

  function renderNotes() {
    if (!state.user) return;

    const notes = getVisibleNotes();
    const hasNotes = notes.length > 0;

    els.notesGrid.hidden = !hasNotes;
    els.emptyState.hidden = hasNotes;
    els.notesGrid.classList.toggle('is-list', state.layout === 'list');
    els.notesGrid.innerHTML = notes.map(noteCardHTML).join('');

    els.visibleCount.textContent = String(notes.length);
    els.pageStat.querySelector('span').textContent = state.query ? 'نتيجة' : 'ملاحظة';

    updateToolbar();
    renderEmptyState(notes.length);
  }

  function renderEmptyState(resultCount) {
    if (resultCount > 0) return;

    const query = state.query.trim();
    let config;

    if (query) {
      config = {
        icon: '#i-search',
        title: 'لا توجد نتائج مطابقة',
        text: `لم نعثر على ملاحظات تطابق «${query}». جرّب كلمة أخرى أو امسح البحث.`,
        action: 'clear-search',
        actionText: 'مسح البحث'
      };
    } else if (state.view === 'favorites') {
      config = {
        icon: '#i-star',
        title: 'لا توجد ملاحظات في المفضلة',
        text: 'أضف الملاحظات المهمة إلى المفضلة لتجدها هنا بسرعة.',
        action: 'go-all',
        actionText: 'استعراض كل الملاحظات'
      };
    } else if (state.view === 'trash') {
      config = {
        icon: '#i-trash',
        title: 'المهملات فارغة',
        text: 'عند حذف أي ملاحظة ستظهر هنا، ويمكنك استعادتها قبل الحذف النهائي.',
        action: 'go-all',
        actionText: 'العودة إلى الملاحظات'
      };
    } else {
      config = {
        icon: '#i-notes',
        title: 'لا توجد ملاحظات بعد',
        text: 'ابدأ بتدوين فكرتك الأولى، وستجدها هنا دائمًا — خاصة بك وحدك.',
        action: 'new-note',
        actionText: 'إنشاء ملاحظة'
      };
    }

    els.emptyState.querySelector('use').setAttribute('href', config.icon);
    els.emptyTitle.textContent = config.title;
    els.emptyText.textContent = config.text;
    els.emptyAction.dataset.action = config.action;
    els.emptyAction.querySelector('span').textContent = config.actionText;
    els.emptyAction.querySelector('use').setAttribute('href', config.action === 'new-note' ? '#i-plus' : config.action === 'clear-search' ? '#i-close' : '#i-notes');
  }

  function updateToolbar() {
    els.sortSelect.value = state.sort;
    els.emptyTrashBtn.hidden = !(state.view === 'trash' && state.notes.some((note) => note.trashed));

    if (state.view === 'trash') {
      els.toolbarHint.textContent = 'الملاحظات المحذوفة';
    } else {
      els.toolbarHint.textContent = `مرتبة حسب ${SORT_LABELS[state.sort] || 'آخر تعديل'}`;
    }

    $$('[data-layout]').forEach((button) => {
      const active = button.dataset.layout === state.layout;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderCounts() {
    const activeNotes = state.notes.filter((note) => !note.trashed);
    els.countAll.textContent = String(activeNotes.length);
    els.countFavorites.textContent = String(activeNotes.filter((note) => note.favorite).length);
    els.countTrash.textContent = String(state.notes.filter((note) => note.trashed).length);
  }

  function renderHeader() {
    const meta = VIEW_META[state.view] || VIEW_META.all;
    els.viewEyebrow.textContent = meta.eyebrow;
    els.viewTitle.textContent = meta.title;
    els.viewSubtitle.textContent = meta.subtitle;
  }

  function renderAll() {
    renderCounts();
    renderHeader();
    renderNotes();
    updateStorageMeter();
    updateThemeOptions();
  }

  function updateStorageMeter() {
    if (!state.user) return;

    let bytes = 0;
    try {
      const serialized = JSON.stringify(state.notes);
      bytes = typeof Blob === 'function'
        ? new Blob([serialized]).size
        : new TextEncoder().encode(serialized).length;
    } catch (error) {
      bytes = 0;
    }

    const percent = Math.min(100, (bytes / STORAGE_LIMIT) * 100);
    els.storageBar.style.width = `${Math.max(percent, bytes > 0 ? 1.5 : 0)}%`;
    els.storageText.textContent = formatBytes(bytes);
  }

  function updateSearchUI() {
    const hasQuery = els.searchInput.value.length > 0;
    els.clearSearch.hidden = !hasQuery;
    els.searchInput.closest('.search-box').classList.toggle('has-query', hasQuery);
  }

  function clearSearch(focus = true) {
    els.searchInput.value = '';
    state.query = '';
    updateSearchUI();
    renderNotes();
    if (focus) els.searchInput.focus();
  }

  function switchView(view) {
    if (!VIEW_META[view]) return;
    setActiveView(view);
    state.query = '';
    els.searchInput.value = '';
    updateSearchUI();
    renderAll();
    closeSidebar();
  }

  /* ---------- محرر الملاحظات ---------- */

  function editorSnapshot() {
    return JSON.stringify({
      title: els.noteTitle.value,
      content: els.noteContent.value,
      color: state.editorColor,
      pinned: state.editorPinned,
      favorite: state.editorFavorite
    });
  }

  function isEditorDirty() {
    return state.editorSnapshot !== editorSnapshot();
  }

  function updateColorOptions() {
    $$('[data-color]', els.colorOptions).forEach((button) => {
      const active = button.dataset.color === state.editorColor;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateEditorToggles() {
    els.pinToggle.setAttribute('aria-pressed', state.editorPinned ? 'true' : 'false');
    els.favoriteToggle.setAttribute('aria-pressed', state.editorFavorite ? 'true' : 'false');
    els.pinToggle.querySelector('span').textContent = state.editorPinned ? 'مثبتة' : 'تثبيت';
    els.favoriteToggle.querySelector('span').textContent = state.editorFavorite ? 'في المفضلة' : 'مفضلة';
  }

  function updateWordCount() {
    const content = els.noteContent.value.trim();
    const words = content ? content.split(/\s+/).filter(Boolean).length : 0;
    els.noteWords.textContent = wordLabel(words);
  }

  function openEditor(noteId = null) {
    const note = noteId ? findNote(noteId) : null;
    if (noteId && (!note || note.trashed)) return;

    state.editingId = note ? note.id : null;
    state.editorColor = note ? note.color : 'default';
    state.editorPinned = note ? note.pinned : false;
    state.editorFavorite = note ? note.favorite : false;

    els.noteTitle.value = note ? note.title : '';
    els.noteContent.value = note ? note.content : '';
    els.noteContent.scrollTop = 0;

    els.editorKicker.textContent = note ? `آخر تعديل ${relativeTime(note.updatedAt)}` : 'ملاحظة جديدة';
    els.editorHeading.textContent = note ? 'تعديل الملاحظة' : 'تدوين فكرة جديدة';
    els.deleteNoteBtn.hidden = !note;
    els.noteDate.querySelector('span').textContent = note ? formatFullDate(note.updatedAt) : 'الآن';

    updateColorOptions();
    updateEditorToggles();
    updateWordCount();

    state.editorSnapshot = editorSnapshot();
    openModal(els.editorModal);
    setTimeout(() => els.noteTitle.focus(), 60);
  }

  function saveEditor() {
    if (!state.user) return;

    const title = els.noteTitle.value.trim();
    const content = els.noteContent.value.trim();

    if (!title && !content) {
      toast('اكتب عنوانًا أو محتوى للملاحظة قبل الحفظ.', 'info');
      els.noteTitle.focus();
      return;
    }

    const now = Date.now();

    if (state.editingId) {
      const note = findNote(state.editingId);
      if (!note) return;
      note.title = title;
      note.content = content;
      note.color = state.editorColor;
      note.pinned = state.editorPinned;
      note.favorite = state.editorFavorite;
      note.updatedAt = now;
    } else {
      state.notes.unshift({
        id: uuid(),
        title,
        content,
        color: state.editorColor,
        pinned: state.editorPinned,
        favorite: state.editorFavorite,
        trashed: false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      });
      setActiveView('all');
      state.query = '';
      els.searchInput.value = '';
      updateSearchUI();
    }

    if (!persistNotes()) return;

    state.editorSnapshot = editorSnapshot();
    closeModal(els.editorModal, false);
    renderAll();
    toast(state.editingId ? 'تم حفظ التعديلات.' : 'تمت إضافة الملاحظة.', 'success');
  }

  function requestCloseEditor() {
    if (isEditorDirty()) {
      confirmAction({
        title: 'تجاهل التغييرات؟',
        message: 'لديك تغييرات غير محفوظة في هذه الملاحظة. هل تريد إغلاق المحرر دون حفظها؟',
        confirmText: 'تجاهل التغييرات',
        onConfirm: () => closeModal(els.editorModal, false)
      });
      return;
    }
    closeModal(els.editorModal);
  }

  function deleteCurrentNote() {
    const note = findNote(state.editingId);
    if (!note) return;

    confirmAction({
      title: 'نقل الملاحظة إلى المهملات؟',
      message: 'يمكنك استعادة الملاحظة من المهملات قبل حذفها نهائيًا.',
      confirmText: 'نقل إلى المهملات',
      onConfirm: () => {
        note.trashed = true;
        note.deletedAt = Date.now();
        note.updatedAt = Date.now();
        if (!persistNotes()) return;
        closeModal(els.editorModal, false);
        renderAll();
        toast('تم نقل الملاحظة إلى المهملات.', 'info');
      }
    });
  }

  /* ---------- إعدادات الحساب ---------- */

  function openSettings() {
    if (!state.user) return;
    closeSidebar();
    els.profileName.value = state.user.name;
    els.profileEmail.value = state.user.email;
    els.currentPassword.value = '';
    els.newPassword.value = '';
    els.confirmPassword.value = '';
    updateThemeOptions();
    openModal(els.settingsModal);
    setTimeout(() => els.profileName.focus(), 60);
  }

  function saveProfile() {
    if (!state.user) return;

    const name = collapseSpaces(els.profileName.value);
    if (name.length < 2) {
      toast('يرجى إدخال اسم صحيح (حرفان على الأقل).', 'error');
      els.profileName.focus();
      return;
    }

    state.user.name = name;
    const userIndex = state.users.findIndex((user) => user.id === state.user.id);
    if (userIndex >= 0) state.users[userIndex] = { ...state.user };

    if (!saveUsers()) {
      toast('تعذر حفظ التغييرات على هذا الجهاز.', 'error');
      return;
    }

    updateUserUI();
    toast('تم تحديث الملف الشخصي.', 'success');
  }

  async function updatePassword() {
    if (!state.user) return;

    const current = els.currentPassword.value;
    const next = els.newPassword.value;
    const confirm = els.confirmPassword.value;

    if (!current) {
      toast('أدخل كلمة المرور الحالية أولًا.', 'error');
      els.currentPassword.focus();
      return;
    }

    if (next.length < 8) {
      toast('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.', 'error');
      els.newPassword.focus();
      return;
    }

    if (next !== confirm) {
      toast('كلمتا المرور الجديدتان غير متطابقتين.', 'error');
      els.confirmPassword.focus();
      return;
    }

    setButtonLoading(els.updatePasswordBtn, true, 'جارٍ التحديث...');

    try {
      const currentHash = await hashPassword(current, state.user.salt);
      if (currentHash !== state.user.passwordHash) {
        toast('كلمة المرور الحالية غير صحيحة.', 'error');
        els.currentPassword.focus();
        return;
      }

      const salt = randomHex(16);
      const passwordHash = await hashPassword(next, salt);
      state.user.salt = salt;
      state.user.passwordHash = passwordHash;

      const userIndex = state.users.findIndex((user) => user.id === state.user.id);
      if (userIndex >= 0) state.users[userIndex] = { ...state.user };

      if (!saveUsers()) {
        toast('تعذر حفظ كلمة المرور على هذا الجهاز.', 'error');
        return;
      }

      els.currentPassword.value = '';
      els.newPassword.value = '';
      els.confirmPassword.value = '';
      toast('تم تحديث كلمة المرور بنجاح.', 'success');
    } catch (error) {
      console.error(error);
      toast('حدث خطأ أثناء تحديث كلمة المرور.', 'error');
    } finally {
      setButtonLoading(els.updatePasswordBtn, false);
    }
  }

  function exportNotes() {
    if (!state.user) return;

    const payload = {
      app: 'ملاحظاتي',
      version: 1,
      exportedAt: new Date().toISOString(),
      user: {
        name: state.user.name,
        email: state.user.email
      },
      notes: state.notes
    };

    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ملاحظاتي-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
      toast('تم تصدير ملاحظاتك بنجاح.', 'success');
    } catch (error) {
      console.error(error);
      toast('تعذر تصدير الملاحظات.', 'error');
    }
  }

  function deleteAllNotes() {
    confirmAction({
      title: 'حذف كل الملاحظات؟',
      message: 'سيتم حذف جميع ملاحظاتك نهائيًا من هذا الجهاز. لا يمكن التراجع عن هذا الإجراء.',
      confirmText: 'حذف الكل',
      onConfirm: () => {
        state.notes = [];
        if (!persistNotes()) return;
        renderAll();
        toast('تم حذف جميع الملاحظات.', 'info');
      }
    });
  }

  function deleteAccount() {
    if (!state.user) return;
    const userId = state.user.id;
    const email = state.user.email;

    confirmAction({
      title: 'حذف الحساب نهائيًا؟',
      message: `سيتم حذف حساب «${email}» وجميع ملاحظاته من هذا الجهاز نهائيًا. لا يمكن التراجع.`,
      confirmText: 'حذف حسابي',
      onConfirm: () => {
        try {
          localStorage.removeItem(getNotesKey(userId));
        } catch (error) {
          // تجاهل
        }

        state.users = state.users.filter((user) => user.id !== userId);
        saveUsers();
        clearSession();
        state.user = null;
        state.notes = [];
        closeModal(els.settingsModal, false);
        els.loginForm.reset();
        els.registerForm.reset();
        updatePasswordStrength('');
        showAuth();
        toast('تم حذف حسابك وكل ملاحظاته.', 'info', 4500);
      }
    });
  }

  /* ---------- النوافذ ---------- */

  function syncBodyScroll() {
    const hasOpenModal = Boolean($('.modal:not([hidden])'));
    document.body.classList.toggle('modal-open', hasOpenModal);
  }

  function openModal(modal) {
    if (!modal) return;
    modal._returnFocus = document.activeElement;
    modal.hidden = false;
    syncBodyScroll();
  }

  function closeModal(modal, restoreFocus = true) {
    if (!modal) return;
    modal.hidden = true;
    syncBodyScroll();
    if (restoreFocus && modal._returnFocus && document.contains(modal._returnFocus)) {
      try {
        modal._returnFocus.focus();
      } catch (error) {
        // تجاهل
      }
    }
    modal._returnFocus = null;
  }

  function closeAllModals() {
    $$('.modal:not([hidden])').forEach((modal) => closeModal(modal, false));
    syncBodyScroll();
  }

  function confirmAction({ title, message, confirmText = 'تأكيد', onConfirm }) {
    state.confirmCallback = onConfirm || null;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = confirmText;
    openModal(els.confirmModal);
    setTimeout(() => els.confirmCancel.focus(), 40);
  }

  function resolveConfirm(confirmed) {
    const callback = state.confirmCallback;
    state.confirmCallback = null;
    closeModal(els.confirmModal, !confirmed);
    if (confirmed && typeof callback === 'function') callback();
  }

  /* ---------- التنبيهات ---------- */

  function toast(message, type = 'success', duration = 3600) {
    if (!els.toastStack) return;

    const iconId = type === 'error' ? '#i-alert' : type === 'info' ? '#i-info' : '#i-check';
    const element = document.createElement('div');
    element.className = `toast toast--${type}`;
    element.innerHTML = `
      <svg class="icon"><use href="${iconId}"/></svg>
      <span></span>
    `;
    element.querySelector('span').textContent = message;
    els.toastStack.appendChild(element);

    const toasts = $$('.toast', els.toastStack);
    if (toasts.length > 4) toasts[0].remove();

    const remove = () => {
      element.classList.add('is-leaving');
      setTimeout(() => element.remove(), 260);
    };

    setTimeout(remove, duration);
  }

  /* ---------- الشريط الجانبي ---------- */

  function openSidebar() {
    els.sidebar.classList.add('is-open');
    els.sidebarBackdrop.hidden = false;
    els.menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSidebar() {
    els.sidebar.classList.remove('is-open');
    els.sidebarBackdrop.hidden = true;
    if (els.menuBtn) els.menuBtn.setAttribute('aria-expanded', 'false');
  }

  /* ---------- ربط الأحداث ---------- */

  function cacheDom() {
    els = {
      authScreen: $('#authScreen'),
      app: $('#app'),
      authHeading: $('#authHeading'),
      authSubheading: $('#authSubheading'),
      loginForm: $('#loginForm'),
      registerForm: $('#registerForm'),
      loginAlert: $('#loginAlert'),
      registerAlert: $('#registerAlert'),
      loginEmail: $('#loginEmail'),
      loginPassword: $('#loginPassword'),
      rememberMe: $('#rememberMe'),
      loginSubmit: $('#loginSubmit'),
      registerName: $('#registerName'),
      registerEmail: $('#registerEmail'),
      registerPassword: $('#registerPassword'),
      registerConfirm: $('#registerConfirm'),
      registerSubmit: $('#registerSubmit'),
      passwordStrength: $('#passwordStrength'),
      forgotBtn: $('#forgotBtn'),

      sidebar: $('#sidebar'),
      sidebarBackdrop: $('#sidebarBackdrop'),
      sidebarClose: $('#sidebarClose'),
      sidebarName: $('#sidebarName'),
      sidebarEmail: $('#sidebarEmail'),
      sidebarAvatar: $('#sidebarAvatar'),
      logoutBtn: $('#logoutBtn'),
      openSettings: $('#openSettings'),
      countAll: $('#countAll'),
      countFavorites: $('#countFavorites'),
      countTrash: $('#countTrash'),
      storageBar: $('#storageBar'),
      storageText: $('#storageText'),

      menuBtn: $('#menuBtn'),
      themeToggle: $('#themeToggle'),
      searchInput: $('#searchInput'),
      clearSearch: $('#clearSearch'),
      newNoteTop: $('#newNoteTop'),

      viewEyebrow: $('#viewEyebrow'),
      viewTitle: $('#viewTitle'),
      viewSubtitle: $('#viewSubtitle'),
      pageStat: $('#pageStat'),
      visibleCount: $('#visibleCount'),
      toolbarHint: $('#toolbarHint'),
      sortSelect: $('#sortSelect'),
      emptyTrashBtn: $('#emptyTrashBtn'),
      notesGrid: $('#notesGrid'),
      emptyState: $('#emptyState'),
      emptyTitle: $('#emptyTitle'),
      emptyText: $('#emptyText'),
      emptyAction: $('#emptyAction'),

      editorModal: $('#editorModal'),
      editorClose: $('#editorClose'),
      editorKicker: $('#editorKicker'),
      editorHeading: $('#editorHeading'),
      noteTitle: $('#noteTitle'),
      noteContent: $('#noteContent'),
      noteDate: $('#noteDate'),
      noteWords: $('#noteWords'),
      colorOptions: $('#colorOptions'),
      pinToggle: $('#pinToggle'),
      favoriteToggle: $('#favoriteToggle'),
      deleteNoteBtn: $('#deleteNoteBtn'),
      cancelEdit: $('#cancelEdit'),
      saveNote: $('#saveNote'),

      settingsModal: $('#settingsModal'),
      settingsClose: $('#settingsClose'),
      profileName: $('#profileName'),
      profileEmail: $('#profileEmail'),
      saveProfile: $('#saveProfile'),
      currentPassword: $('#currentPassword'),
      newPassword: $('#newPassword'),
      confirmPassword: $('#confirmPassword'),
      updatePasswordBtn: $('#updatePassword'),
      exportNotes: $('#exportNotes'),
      deleteAllNotes: $('#deleteAllNotes'),
      deleteAccount: $('#deleteAccount'),

      confirmModal: $('#confirmModal'),
      confirmTitle: $('#confirmTitle'),
      confirmMessage: $('#confirmMessage'),
      confirmCancel: $('#confirmCancel'),
      confirmOk: $('#confirmOk'),
      toastStack: $('#toastStack')
    };
  }

  function bindEvents() {
    /* المصادقة */
    $$('[data-auth-tab]').forEach((tab) => {
      tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
    });

    els.loginForm.addEventListener('submit', handleLogin);
    els.registerForm.addEventListener('submit', handleRegister);

    els.authScreen.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-toggle-password]');
      if (!toggle) return;
      const input = document.getElementById(toggle.dataset.togglePassword);
      if (!input) return;
      const shouldShow = input.type === 'password';
      input.type = shouldShow ? 'text' : 'password';
      toggle.setAttribute('aria-label', shouldShow ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
      const use = toggle.querySelector('use');
      if (use) use.setAttribute('href', shouldShow ? '#i-eye-off' : '#i-eye');
    });

    [els.loginForm, els.registerForm].forEach((form) => {
      form.addEventListener('input', (event) => {
        const input = event.target.closest('input');
        if (!input) return;
        setFieldError(input, '');
        if (form === els.loginForm) hideAlert(els.loginAlert);
        else hideAlert(els.registerAlert);
      });
    });

    els.registerPassword.addEventListener('input', () => {
      updatePasswordStrength(els.registerPassword.value);
    });

    els.forgotBtn.addEventListener('click', () => {
      toast('لأن البيانات محفوظة محليًا، لا توجد خدمة بريد لاستعادة كلمة المرور. يمكنك إنشاء حساب جديد أو استخدام كلمة المرور التي تتذكرها.', 'info', 7000);
    });

    /* التنقل */
    $$('[data-view]').forEach((button) => {
      button.addEventListener('click', () => switchView(button.dataset.view));
    });

    els.logoutBtn.addEventListener('click', logout);
    els.openSettings.addEventListener('click', openSettings);
    els.menuBtn.addEventListener('click', openSidebar);
    els.sidebarClose.addEventListener('click', closeSidebar);
    els.sidebarBackdrop.addEventListener('click', closeSidebar);

    window.addEventListener('resize', () => {
      if (window.innerWidth > 1024) closeSidebar();
    });

    /* البحث والترتيب */
    els.searchInput.addEventListener('input', () => {
      updateSearchUI();
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => {
        state.query = els.searchInput.value.trim();
        renderNotes();
      }, 110);
    });

    els.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        clearSearch(false);
        els.searchInput.blur();
      }
    });

    els.clearSearch.addEventListener('click', () => clearSearch());

    els.sortSelect.addEventListener('change', () => {
      state.sort = els.sortSelect.value;
      renderNotes();
    });

    $$('[data-layout]').forEach((button) => {
      button.addEventListener('click', () => {
        state.layout = button.dataset.layout === 'list' ? 'list' : 'grid';
        try {
          localStorage.setItem(STORAGE.layout, state.layout);
        } catch (error) {
          // تجاهل
        }
        renderNotes();
      });
    });

    /* الملاحظات */
    els.newNoteTop.addEventListener('click', () => openEditor());
    els.emptyAction.addEventListener('click', () => {
      const action = els.emptyAction.dataset.action;
      if (action === 'clear-search') clearSearch();
      else if (action === 'go-all') switchView('all');
      else openEditor();
    });

    els.notesGrid.addEventListener('click', (event) => {
      const card = event.target.closest('.note-card');
      if (!card) return;

      const noteId = card.dataset.id;
      const actionButton = event.target.closest('[data-action]');

      if (actionButton) {
        const action = actionButton.dataset.action;
        const note = findNote(noteId);
        if (!note) return;

        if (action === 'pin') {
          note.pinned = !note.pinned;
          if (persistNotes()) {
            renderAll();
            toast(note.pinned ? 'تم تثبيت الملاحظة.' : 'تم إلغاء تثبيت الملاحظة.', 'success', 2400);
          }
        } else if (action === 'favorite') {
          note.favorite = !note.favorite;
          if (persistNotes()) {
            renderAll();
            toast(note.favorite ? 'أُضيفت الملاحظة إلى المفضلة.' : 'أُزيلت الملاحظة من المفضلة.', 'success', 2400);
          }
        } else if (action === 'trash') {
          note.trashed = true;
          note.deletedAt = Date.now();
          note.updatedAt = Date.now();
          if (persistNotes()) {
            renderAll();
            toast('تم نقل الملاحظة إلى المهملات.', 'info');
          }
        } else if (action === 'restore') {
          note.trashed = false;
          note.deletedAt = null;
          note.updatedAt = Date.now();
          if (persistNotes()) {
            renderAll();
            toast('تمت استعادة الملاحظة.', 'success');
          }
        } else if (action === 'purge') {
          confirmAction({
            title: 'حذف الملاحظة نهائيًا؟',
            message: 'لن تتمكن من استعادة هذه الملاحظة بعد حذفها نهائيًا.',
            confirmText: 'حذف نهائي',
            onConfirm: () => {
              state.notes = state.notes.filter((noteItem) => noteItem.id !== noteId);
              if (!persistNotes()) return;
              renderAll();
              toast('تم حذف الملاحظة نهائيًا.', 'info');
            }
          });
        }
        return;
      }

      if (state.view !== 'trash') openEditor(noteId);
    });

    els.notesGrid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button')) return;
      const card = event.target.closest('.note-card');
      if (!card) return;
      event.preventDefault();
      if (state.view !== 'trash') openEditor(card.dataset.id);
    });

    els.emptyTrashBtn.addEventListener('click', () => {
      const trashCount = state.notes.filter((note) => note.trashed).length;
      if (!trashCount) return;

      confirmAction({
        title: 'إفراغ المهملات؟',
        message: `سيتم حذف ${trashCount} ${trashCount === 1 ? 'ملاحظة' : 'ملاحظات'} نهائيًا. لا يمكن التراجع عن هذا الإجراء.`,
        confirmText: 'إفراغ المهملات',
        onConfirm: () => {
          state.notes = state.notes.filter((note) => !note.trashed);
          if (!persistNotes()) return;
          renderAll();
          toast('تم إفراغ المهملات.', 'info');
        }
      });
    });

    /* المحرر */
    els.editorClose.addEventListener('click', requestCloseEditor);
    els.cancelEdit.addEventListener('click', requestCloseEditor);
    els.saveNote.addEventListener('click', saveEditor);
    els.deleteNoteBtn.addEventListener('click', deleteCurrentNote);

    els.noteContent.addEventListener('input', updateWordCount);
    els.noteTitle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        els.noteContent.focus();
      }
    });

    els.colorOptions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-color]');
      if (!button) return;
      state.editorColor = button.dataset.color;
      updateColorOptions();
    });

    els.pinToggle.addEventListener('click', () => {
      state.editorPinned = !state.editorPinned;
      updateEditorToggles();
    });

    els.favoriteToggle.addEventListener('click', () => {
      state.editorFavorite = !state.editorFavorite;
      updateEditorToggles();
    });

    /* الإعدادات */
    els.settingsClose.addEventListener('click', () => closeModal(els.settingsModal));
    els.saveProfile.addEventListener('click', saveProfile);
    els.updatePasswordBtn.addEventListener('click', updatePassword);
    els.exportNotes.addEventListener('click', exportNotes);
    els.deleteAllNotes.addEventListener('click', deleteAllNotes);
    els.deleteAccount.addEventListener('click', deleteAccount);

    $$('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
    });

    /* المظهر */
    els.themeToggle.addEventListener('click', toggleTheme);

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => {
        if (state.theme === 'system') applyTheme('system', false);
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', handleChange);
      else if (typeof media.addListener === 'function') media.addListener(handleChange);
    }

    /* النوافذ */
    els.editorModal.addEventListener('click', (event) => {
      if (event.target === els.editorModal) requestCloseEditor();
    });

    els.settingsModal.addEventListener('click', (event) => {
      if (event.target === els.settingsModal) closeModal(els.settingsModal);
    });

    els.confirmModal.addEventListener('click', (event) => {
      if (event.target === els.confirmModal) resolveConfirm(false);
    });

    els.confirmCancel.addEventListener('click', () => resolveConfirm(false));
    els.confirmOk.addEventListener('click', () => resolveConfirm(true));

    /* اختصارات لوحة المفاتيح */
    document.addEventListener('keydown', (event) => {
      const isTyping = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (!els.app.hidden) {
          event.preventDefault();
          els.searchInput.focus();
          els.searchInput.select();
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !els.editorModal.hidden) {
        event.preventDefault();
        saveEditor();
        return;
      }

      if (event.key === 'Escape') {
        if (!els.confirmModal.hidden) {
          event.preventDefault();
          resolveConfirm(false);
        } else if (!els.editorModal.hidden) {
          event.preventDefault();
          requestCloseEditor();
        } else if (!els.settingsModal.hidden) {
          event.preventDefault();
          closeModal(els.settingsModal);
        } else if (els.sidebar.classList.contains('is-open')) {
          closeSidebar();
        } else if (isTyping && document.activeElement === els.searchInput && els.searchInput.value) {
          clearSearch(false);
        }
      }

      if (event.key === 'Tab') trapFocus(event);
    });

    /* المزامنة بين التبويبات */
    window.addEventListener('storage', (event) => {
      if (!state.user) {
        if (event.key === STORAGE.users) loadUsers();
        return;
      }

      if (event.key === STORAGE.users) {
        loadUsers();
        const current = state.users.find((user) => user.id === state.user.id);
        if (current) {
          state.user = current;
          updateUserUI();
        }
      }

      if (event.key === getNotesKey(state.user.id) && els.editorModal.hidden) {
        state.notes = loadNotes(state.user.id);
        renderAll();
      }
    });
  }

  function trapFocus(event) {
    const modals = $$('.modal:not([hidden])');
    if (!modals.length) return;

    const modal = modals[modals.length - 1];
    const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter((element) => element.offsetParent !== null);

    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------- الإقلاع ---------- */

  function init() {
    cacheDom();
    bindEvents();

    state.theme = getStoredTheme();
    applyTheme(state.theme, false);
    loadUsers();
    updatePasswordStrength('');

    const session = readSession();
    if (session) {
      const user = state.users.find((item) => item.id === session.userId);
      if (user) {
        state.user = user;
        state.notes = loadNotes(user.id);
        enterApp();
        return;
      }
      clearSession();
    }

    showAuth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

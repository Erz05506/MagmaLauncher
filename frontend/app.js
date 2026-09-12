// ============================================
// MagmaLauncher — frontend logic
// ============================================

// --- Supabase (общая база аккаунтов вместо localStorage) ---
const SUPABASE_URL = 'https://bjgpqlegoptegcbogncq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJqZ3BxbGVnb3B0ZWdjYm9nbmNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzOTY4ODEsImV4cCI6MjA5OTk3Mjg4MX0.3iMFvghcz-IaXuLqk5WLRnou_4bpwFFmGrWSNSmHMS0';

function fetchWithTimeout(url, options = {}, ms = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' })
    .finally(() => clearTimeout(timeoutId));
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    lock: async (name, acquireTimeout, fn) => {
      return await fn();
    },
  },
  global: {
    fetch: fetchWithTimeout,
  },
});

function isTimeoutError(err) {
  return !!err && (err.name === 'AbortError' || /timed out|aborted/i.test(err.message || ''));
}

function withTimeout(promise) {
  return promise;
}
function isMissingProfileError(error) {
  return !!error && error.code === 'PGRST116';
}

async function fetchProfileWithRetry(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabaseClient.from('profiles').select('nick').eq('id', userId).single();
    if (!error && data) return { profile: data, missing: false };
    if (isMissingProfileError(error)) return { profile: null, missing: true };
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
  }
  return { profile: null, missing: false };
}

// --- Переключение вкладок в левом рейле ---
const railButtons = document.querySelectorAll('.rail-btn[data-view]');
const views = document.querySelectorAll('.view[data-view]');
const contentEl = document.querySelector('.content');
const gameFolderBtnEl = document.getElementById('gameFolderBtn');
const versionRefreshBtnEl = document.getElementById('versionRefreshBtn');
let currentHomeSubtab = 'overview';

function updateGameFolderBtnVisibility() {
  const visible = currentActiveView === 'home' && currentHomeSubtab === 'overview';
  if (gameFolderBtnEl) gameFolderBtnEl.style.display = visible ? 'flex' : 'none';
  if (versionRefreshBtnEl) versionRefreshBtnEl.style.display = visible ? 'flex' : 'none';
}

function sanitizeGameDirPath(dir) {
  if (!dir) return dir;
  let cleaned = dir.replace(/[\\/]+$/, '');
  if (/[\\/]MagmaLauncher\.exe$/i.test(cleaned)) {
    cleaned = cleaned.replace(/[\\/]MagmaLauncher\.exe$/i, '\\MagmaLauncher');
  } else if (/\.exe$/i.test(cleaned)) {
    const lastSep = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
    if (lastSep > -1) cleaned = cleaned.substring(0, lastSep);
  }
  return cleaned;
}

function getGameDir() {
  return sanitizeGameDirPath(gameDirInputEl ? gameDirInputEl.value : '');
}

// ============================================
// Память прокрутки для каждой вкладки — храним в localStorage, чтобы позиция
// сохранялась не только при переключении вкладок внутри одной сессии, но и
// при полном перезапуске лаунчера. Раньше при заходе на "Моды" список всегда
// принудительно проматывался к самому списку модов (см. modList.scrollIntoView
// ниже) — это перекрывало любую сохранённую позицию и выглядело как "экран
// открывается чуть ниже, а не сверху". Теперь принудительная прокрутка
// убрана, а позиция восстанавливается из памяти (или, для первого визита,
// остаётся 0 — то есть ровно "самый верх", как и просили).
// ============================================
const VIEW_SCROLL_KEY = 'magma_view_scroll';
let viewScrollState = {};
try { viewScrollState = JSON.parse(sessionStorage.getItem(VIEW_SCROLL_KEY) || '{}'); } catch { viewScrollState = {}; }
let currentActiveView = 'home';

function saveViewScroll(view, top) {
  viewScrollState[view] = top;
  try { sessionStorage.setItem(VIEW_SCROLL_KEY, JSON.stringify(viewScrollState)); } catch {}
}

function restoreViewScroll(view) {
  if (!contentEl) return;
  cancelPendingSmoothScroll(contentEl);
  const savedTop = viewScrollState[view] || 0;
  contentEl.scrollTop = savedTop;
  syncSmoothScrollTarget(contentEl, savedTop);
}
// ============================================
// Единый тултип для всего приложения — один div с position:fixed в конце
// <body>, координаты которого считает JS по getBoundingClientRect() наведённого
// элемента. Раньше тултипы рисовались через CSS ::after прямо у элемента —
// внутри любого контейнера со скроллом (.content, узкие карточки модов и
// т.п.) такой тултип обрезался границей контейнера (overflow-y:auto
// заставляет браузер обрезать и по горизонтали тоже). Один тултип поверх
// всего окна такой проблемы в принципе не имеет.
// ============================================
const jsTooltipEl = document.createElement('div');
jsTooltipEl.className = 'js-tooltip';
document.body.appendChild(jsTooltipEl);
let tooltipShowTimer = null;
let tooltipCurrentAnchor = null;

function positionJsTooltip(anchor) {
  const text = anchor.getAttribute('data-tooltip');
  if (!text) return;
  jsTooltipEl.textContent = text;
  jsTooltipEl.classList.add('is-visible');

  const rect = anchor.getBoundingClientRect();
  const tw = jsTooltipEl.offsetWidth;
  const th = jsTooltipEl.offsetHeight;

  const isBottomNavBtn = document.querySelector('.app')?.classList.contains('nav-bottom') && anchor.closest('.rail');
  if (isBottomNavBtn) {
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = rect.top - th - 10;
    if (top < 8) top = rect.bottom + 10;
    jsTooltipEl.style.left = Math.round(left) + 'px';
    jsTooltipEl.style.top = Math.round(top) + 'px';
    return;
  }

  const preferLeft = anchor.getAttribute('data-tooltip-align') === 'left';
  let left = preferLeft ? (rect.left - tw - 10) : (rect.right + 10);
  if (left + tw > window.innerWidth - 8) left = rect.left - tw - 10;
  if (left < 8) left = Math.min(rect.right + 10, window.innerWidth - tw - 8);
  let top = rect.top + rect.height / 2 - th / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
  jsTooltipEl.style.left = Math.round(left) + 'px';
  jsTooltipEl.style.top = Math.round(top) + 'px';
}

function hideJsTooltip() {
  jsTooltipEl.classList.remove('is-visible');
  tooltipCurrentAnchor = null;
}

document.addEventListener('mouseover', (e) => {
  const anchor = e.target.closest && e.target.closest('[data-tooltip]');
  if (!anchor || anchor === tooltipCurrentAnchor) return;
  tooltipCurrentAnchor = anchor;
  clearTimeout(tooltipShowTimer);
  hideJsTooltip();
  tooltipCurrentAnchor = anchor;
  tooltipShowTimer = setTimeout(() => {
    if (tooltipCurrentAnchor === anchor) positionJsTooltip(anchor);
  }, 120);
});
document.addEventListener('mouseout', (e) => {
  const anchor = e.target.closest && e.target.closest('[data-tooltip]');
  if (!anchor || anchor !== tooltipCurrentAnchor) return;
  clearTimeout(tooltipShowTimer);
  hideJsTooltip();
});
document.addEventListener('scroll', hideJsTooltip, true);
window.addEventListener('blur', hideJsTooltip);

const debouncedSaveScroll = debounce(() => {
  saveViewScroll(currentActiveView, contentEl ? contentEl.scrollTop : 0);
}, 200);
contentEl?.addEventListener('scroll', debouncedSaveScroll);

async function switchToRailView(target) {
  railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === target));
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === target));
  currentActiveView = target;

  // Уходя с объединённого раздела "Сборки" на ЛЮБУЮ вкладку рейла (не
  // только на "Моды") — сбрасываем mergedInstancesOpen и возвращаем блок
  // категорий обратно в "Моды". Раньше сброс был только при переходе именно
  // на "Моды", и если игрок кликал сразу "Главная"/"Настройки", подсветка и
  // сам блок категорий оставались висеть привязанными к "Сборкам".
  if (mergedInstancesOpen) {
    mergedInstancesOpen = false;
    const modsView = document.querySelector('.view[data-view="mods"]');
    const modsViewHeader = modsView ? modsView.querySelector('.view-header') : null;
    if (modsCategoryTabsEl && modsView && modsViewHeader && modsCategoryTabsEl.parentElement !== modsView) {
      modsView.insertBefore(modsCategoryTabsEl, modsViewHeader.nextSibling);
    }
    // ВАЖНО: раньше пилюли категорий перерисовывались только при target==='mods'
    // — при уходе на любую другую вкладку "Сборки" оставалась подсвеченной
    // в своей разметке до следующего явного захода в "Моды".
    renderModsCategoryTabs();
    resetInstancesViewHeaderTitle();
  }

  updateGameFolderBtnVisibility();
  if (target === 'mods') {
    renderModsCategoryTabs();
    if (modFilterSourceModrinth) modFilterSourceModrinth.checked = modsActiveSource === 'modrinth';
    if (modFilterSourceCurseForge) modFilterSourceCurseForge.checked = modsActiveSource === 'curseforge';
  }
  if (target === 'instances') {
    renderInstances();
    const activeInstancesTab = document.querySelector('.mods-subtab[data-instances-subtab="catalog"].is-active');
    if (activeInstancesTab) runInstancesCatalogSearch(1);
  }

  if (target === 'mods') {
    await refreshModsTargetUI();
  }

  if (target === 'settings') {
    switchSettingsSubtab(document.querySelector('.mods-subtab[data-settings-subtab].is-active')?.dataset.settingsSubtab || 'account');
  }

  restoreViewScroll(target);
}

railButtons.forEach(btn => {
  btn.addEventListener('click', () => switchToRailView(btn.dataset.view));
});

const HIDE_NEWS_KEY = 'magma_hide_news';
function getHideNewsPref() { return localStorage.getItem(HIDE_NEWS_KEY) === '1'; }
function applyNewsVisibility() {
  document.querySelector('.view-grid')?.classList.toggle('news-hidden', getHideNewsPref());
  const toggle = document.getElementById('hideNewsToggle');
  if (toggle) toggle.checked = getHideNewsPref();
}
const REDUCE_MOTION_KEY = 'magma_reduce_motion';
function getReduceMotionPref() { return localStorage.getItem(REDUCE_MOTION_KEY) === '1'; }
function applyReduceMotion() {
  document.documentElement.setAttribute('data-reduce-motion', getReduceMotionPref() ? '1' : '0');
  const toggle = document.getElementById('reduceMotionToggle');
  if (toggle) toggle.checked = getReduceMotionPref();
}
document.getElementById('reduceMotionToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(REDUCE_MOTION_KEY, e.target.checked ? '1' : '0');
  applyReduceMotion();
});

const PAUSE_SKIN_UNFOCUSED_KEY = 'magma_pause_skin_unfocused';
function getPauseSkinUnfocusedPref() { return localStorage.getItem(PAUSE_SKIN_UNFOCUSED_KEY) !== '0'; }
function applyPauseSkinUnfocusedToggle() {
  const toggle = document.getElementById('pauseSkinUnfocusedToggle');
  if (toggle) toggle.checked = getPauseSkinUnfocusedPref();
}
document.getElementById('pauseSkinUnfocusedToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PAUSE_SKIN_UNFOCUSED_KEY, e.target.checked ? '1' : '0');
});
window.addEventListener('blur', () => {
  if (accountSkinViewer && getPauseSkinUnfocusedPref()) accountSkinViewer.renderPaused = true;
});
window.addEventListener('focus', () => {
  if (accountSkinViewer) accountSkinViewer.renderPaused = false;
});

const DISABLE_BLUR_KEY = 'magma_disable_blur';
function getDisableBlurPref() { return localStorage.getItem(DISABLE_BLUR_KEY) === '1'; }
function applyDisableBlur() {
  document.documentElement.setAttribute('data-disable-blur', getDisableBlurPref() ? '1' : '0');
  const toggle = document.getElementById('disableBlurToggle');
  if (toggle) toggle.checked = getDisableBlurPref();
}
document.getElementById('disableBlurToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(DISABLE_BLUR_KEY, e.target.checked ? '1' : '0');
  applyDisableBlur();
});

const DISABLE_GLOW_KEY = 'magma_disable_glow';
function getDisableGlowPref() { return localStorage.getItem(DISABLE_GLOW_KEY) === '1'; }
function applyDisableGlow() {
  document.documentElement.setAttribute('data-disable-glow', getDisableGlowPref() ? '1' : '0');
  const toggle = document.getElementById('disableGlowToggle');
  if (toggle) toggle.checked = getDisableGlowPref();
}
document.getElementById('disableGlowToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(DISABLE_GLOW_KEY, e.target.checked ? '1' : '0');
  applyDisableGlow();
});

const SIMPLE_BG_KEY = 'magma_simple_bg';
function getSimpleBgPref() { return localStorage.getItem(SIMPLE_BG_KEY) === '1'; }
function applySimpleBg() {
  document.documentElement.setAttribute('data-simple-bg', getSimpleBgPref() ? '1' : '0');
  const toggle = document.getElementById('simpleBgToggle');
  if (toggle) toggle.checked = getSimpleBgPref();
}
const PRIVACY_ANALYTICS_KEY = 'magma_privacy_analytics';
const PRIVACY_CRASH_REPORTS_KEY = 'magma_privacy_crash_reports';
const PRIVACY_BLOCK_TELEMETRY_KEY = 'magma_privacy_block_telemetry';
const PRIVACY_STREAMER_MODE_KEY = 'magma_privacy_streamer_mode';
const PRIVACY_LOCK_ENABLED_KEY = 'magma_privacy_lock_enabled';
const PRIVACY_LOCK_HASH_KEY = 'magma_privacy_lock_hash';
const PRIVACY_DISCORD_KEY = 'magma_privacy_discord_presence';
const PRIVACY_AUTO_DELETE_LOGS_KEY = 'magma_privacy_auto_delete_logs';

function getPrivacyPref(key, defaultOn) {
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultOn;
  return raw === '1';
}

function applyStreamerMode() {
  const on = getPrivacyPref(PRIVACY_STREAMER_MODE_KEY, false);
  document.documentElement.setAttribute('data-streamer-mode', on ? '1' : '0');
  const toggle = document.getElementById('privacyStreamerModeToggle');
  if (toggle) toggle.checked = on;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const launcherLockOverlay = document.getElementById('launcherLockOverlay');
const launcherLockInput = document.getElementById('launcherLockInput');
const launcherLockError = document.getElementById('launcherLockError');
const launcherLockSubmitBtn = document.getElementById('launcherLockSubmitBtn');
const launcherLockSetupOverlay = document.getElementById('launcherLockSetupOverlay');
const launcherLockSetupInput = document.getElementById('launcherLockSetupInput');
const launcherLockSetupError = document.getElementById('launcherLockSetupError');
const launcherLockSetupSaveBtn = document.getElementById('launcherLockSetupSaveBtn');
const launcherLockSetupClose = document.getElementById('launcherLockSetupClose');

function isLauncherLockEnabled() {
  return getPrivacyPref(PRIVACY_LOCK_ENABLED_KEY, false) && !!localStorage.getItem(PRIVACY_LOCK_HASH_KEY);
}

function showLauncherLockScreen() {
  return new Promise((resolve) => {
    hideError(launcherLockError);
    launcherLockInput.value = '';
    launcherLockOverlay.classList.add('is-open');

    const submit = async () => {
      const pin = launcherLockInput.value.trim();
      if (!pin) return;
      const hash = await sha256Hex(pin);
      if (hash === localStorage.getItem(PRIVACY_LOCK_HASH_KEY)) {
        launcherLockOverlay.classList.remove('is-open');
        launcherLockSubmitBtn.removeEventListener('click', submit);
        launcherLockInput.removeEventListener('keydown', onKeydown);
        resolve();
      } else {
        showError(launcherLockError, t('settings.privacy.launcherLock.wrongPin'));
      }
    };
    const onKeydown = (e) => { if (e.key === 'Enter') submit(); };
    launcherLockSubmitBtn.addEventListener('click', submit);
    launcherLockInput.addEventListener('keydown', onKeydown);
  });
}

document.getElementById('privacyLockSetupBtn')?.addEventListener('click', () => {
  launcherLockSetupInput.value = '';
  hideError(launcherLockSetupError);
  launcherLockSetupOverlay.classList.add('is-open');
});
launcherLockSetupClose?.addEventListener('click', () => launcherLockSetupOverlay.classList.remove('is-open'));
launcherLockSetupOverlay?.addEventListener('click', (e) => { if (e.target === launcherLockSetupOverlay) launcherLockSetupOverlay.classList.remove('is-open'); });

launcherLockSetupSaveBtn?.addEventListener('click', async () => {
  const pin = launcherLockSetupInput.value.trim();
  if (pin.length < 4) {
    showError(launcherLockSetupError, t('settings.privacy.launcherLock.weakPin'));
    return;
  }
  const hash = await sha256Hex(pin);
  localStorage.setItem(PRIVACY_LOCK_HASH_KEY, hash);
  localStorage.setItem(PRIVACY_LOCK_ENABLED_KEY, '1');
  const toggle = document.getElementById('privacyLockToggle');
  if (toggle) toggle.checked = true;
  launcherLockSetupOverlay.classList.remove('is-open');
});

document.getElementById('privacyLockToggle')?.addEventListener('change', (e) => {
  if (e.target.checked && !localStorage.getItem(PRIVACY_LOCK_HASH_KEY)) {
    e.target.checked = false;
    document.getElementById('privacyLockSetupBtn')?.click();
    return;
  }
  localStorage.setItem(PRIVACY_LOCK_ENABLED_KEY, e.target.checked ? '1' : '0');
});

document.getElementById('privacyAnalyticsToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_ANALYTICS_KEY, e.target.checked ? '1' : '0');
});
document.getElementById('privacyCrashReportsToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_CRASH_REPORTS_KEY, e.target.checked ? '1' : '0');
});
document.getElementById('privacyBlockTelemetryToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_BLOCK_TELEMETRY_KEY, e.target.checked ? '1' : '0');
});
document.getElementById('privacyAutoDeleteLogsToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_AUTO_DELETE_LOGS_KEY, e.target.checked ? '1' : '0');
});
document.getElementById('privacyStreamerModeToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_STREAMER_MODE_KEY, e.target.checked ? '1' : '0');
  applyStreamerMode();
});
document.getElementById('privacyDiscordPresenceToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(PRIVACY_DISCORD_KEY, e.target.checked ? '1' : '0');
  if (e.target.checked) startDiscordPresence();
  else stopDiscordPresence();
});

document.getElementById('privacySignOutAllBtn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('privacyStatusMsg');
  const acc = getAccounts().find(a => a.id === getActiveAccountId());
  if (!acc || acc.type !== 'magma') {
    if (statusEl) statusEl.textContent = t('account.notMagmaAccount');
    return;
  }
  if (statusEl) statusEl.textContent = t('account.changingPassword');
  try {
    await supabaseClient.auth.signOut({ scope: 'global' });
    const currentId = getActiveAccountId();
    saveAccounts(getAccounts().filter(a => a.id !== currentId));
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    if (statusEl) statusEl.textContent = '';
    await endSessionAndPickNext(currentId);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось завершить сессии на всех устройствах:', err);
    if (statusEl) statusEl.textContent = t('auth.magma.genericError');
  }
});

document.getElementById('privacyClearLogsBtn')?.addEventListener('click', () => {
  const statusEl = document.getElementById('privacyStatusMsg');
  try { sessionStorage.removeItem(VIEW_SCROLL_KEY); } catch {}
  try { localStorage.removeItem(MOD_GUESS_CACHE_KEY); } catch {}
  modSearchCache.clear();
  modGuessCache.clear();
  modDetailsCache.clear();
  modTitleCache.clear();
  if (statusEl) {
    statusEl.textContent = t('settings.privacy.clearLogs.done');
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  }
});

let lastCrashReportAt = 0;
async function saveCrashReport(text) {
  if (!getPrivacyPref(PRIVACY_CRASH_REPORTS_KEY, true)) return;
  if (typeof window.installLocalFile !== 'function') return;
  const now = Date.now();
  if (now - lastCrashReportAt < 5000) return;
  lastCrashReportAt = now;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base64 = btoa(unescape(encodeURIComponent(text)));
    await window.installLocalFile({
      filename: `launcher_${stamp}.txt`,
      dataBase64: base64,
      targetDir: `${getGameDir()}\\crashreports`,
    });
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось сохранить крэш-репорт:', err);
  }
}
window.addEventListener('error', (e) => saveCrashReport(String((e.error && e.error.stack) || e.message || e)));
window.addEventListener('unhandledrejection', (e) => saveCrashReport(String((e.reason && e.reason.stack) || e.reason || 'unhandledrejection')));

async function ensureTelemetryBlockHostsFile() {
  if (typeof window.installLocalFile !== 'function') return null;
  const content = '0.0.0.0 telemetry.mojang.com\n0.0.0.0 sentry.io\n0.0.0.0 o276006.ingest.sentry.io\n';
  try {
    const base64 = btoa(content);
    const raw = await window.installLocalFile({
      filename: 'blocked-hosts.txt',
      dataBase64: base64,
      targetDir: `${getGameDir()}\\privacy`,
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return null;
    return `${getGameDir()}\\privacy\\blocked-hosts.txt`;
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось подготовить блокировку телеметрии:', err);
    return null;
  }
}

const discordPresenceBootTime = Date.now();
let discordPresenceStarted = false;

async function startDiscordPresence() {
  if (typeof window.discordPresenceStart !== 'function' || discordPresenceStarted) return;
  try {
    const raw = await window.discordPresenceStart({ appId: '1545886388145229875' });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return;
    discordPresenceStarted = true;
    updateDiscordPresenceIdle();
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось подключиться к Discord:', err);
  }
}
function stopDiscordPresence() {
  discordPresenceStarted = false;
  if (typeof window.discordPresenceStop === 'function') window.discordPresenceStop().catch(() => {});
}
function updateDiscordPresenceIdle() {
  if (!discordPresenceStarted || typeof window.discordPresenceSetActivity !== 'function') return;
  window.discordPresenceSetActivity({
    details: t('discord.inLauncher'),
    state: selectedVersion || '',
    largeImageKey: 'magma_logo',
    largeImageText: 'MagmaLauncher',
    startTimestamp: Math.floor(discordPresenceBootTime / 1000),
  }).catch(() => {});
}
function updateDiscordPresencePlaying() {
  if (!discordPresenceStarted || typeof window.discordPresenceSetActivity !== 'function') return;
  window.discordPresenceSetActivity({
    details: t('discord.playing'),
    state: `${currentSelectedLoader} ${selectedVersion}`,
    largeImageKey: 'magma_logo',
    largeImageText: 'MagmaLauncher',
    startTimestamp: Math.floor(Date.now() / 1000),
  }).catch(() => {});
}

function initPrivacySettings() {
  const map = [
    ['privacyAnalyticsToggle', PRIVACY_ANALYTICS_KEY, true],
    ['privacyCrashReportsToggle', PRIVACY_CRASH_REPORTS_KEY, true],
    ['privacyBlockTelemetryToggle', PRIVACY_BLOCK_TELEMETRY_KEY, false],
    ['privacyAutoDeleteLogsToggle', PRIVACY_AUTO_DELETE_LOGS_KEY, false],
    ['privacyLockToggle', PRIVACY_LOCK_ENABLED_KEY, false],
    ['privacyDiscordPresenceToggle', PRIVACY_DISCORD_KEY, true],
  ];
  map.forEach(([id, key, def]) => {
    const el = document.getElementById(id);
    if (el) el.checked = getPrivacyPref(key, def);
  });
  applyStreamerMode();
}
document.getElementById('simpleBgToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(SIMPLE_BG_KEY, e.target.checked ? '1' : '0');
  applySimpleBg();
});
document.getElementById('hideNewsToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(HIDE_NEWS_KEY, e.target.checked ? '1' : '0');
  applyNewsVisibility();
});

const NAV_BOTTOM_KEY = 'magma_nav_bottom';
function getNavBottomPref() { return localStorage.getItem(NAV_BOTTOM_KEY) === '1'; }
function applyNavPosition() {
  document.querySelector('.app')?.classList.toggle('nav-bottom', getNavBottomPref());
  const toggle = document.getElementById('navBottomToggle');
  if (toggle) toggle.checked = getNavBottomPref();
}
document.getElementById('navBottomToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(NAV_BOTTOM_KEY, e.target.checked ? '1' : '0');
  applyNavPosition();
});

const NAV_ORDER_KEY = 'magma_nav_order';
function applySavedNavOrder() {
  const navEl = document.querySelector('.rail-nav');
  if (!navEl) return;
  let order;
  try { order = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || 'null'); } catch { order = null; }
  if (!Array.isArray(order)) return;
  order.forEach(view => {
    const btn = navEl.querySelector(`.rail-btn[data-view="${view}"]`);
    if (btn) navEl.appendChild(btn);
  });
}
function saveNavOrder() {
  const navEl = document.querySelector('.rail-nav');
  if (!navEl) return;
  const order = [...navEl.querySelectorAll('.rail-btn[data-view]')].map(b => b.dataset.view);
  localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
}
function enableNavDragReorder() {
  const navEl = document.querySelector('.rail-nav');
  if (!navEl) return;
  let draggedBtn = null;
  navEl.querySelectorAll('.rail-btn[data-view]').forEach(btn => {
    btn.setAttribute('draggable', 'true');
    btn.addEventListener('dragstart', () => {
      draggedBtn = btn;
      btn.classList.add('is-dragging');
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('is-dragging');
      draggedBtn = null;
      saveNavOrder();
    });
    btn.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedBtn || draggedBtn === btn) return;
      const rect = btn.getBoundingClientRect();
      const isBottomNav = document.querySelector('.app')?.classList.contains('nav-bottom');
      const before = isBottomNav
        ? (e.clientX - rect.left) < rect.width / 2
        : (e.clientY - rect.top) < rect.height / 2;
      navEl.insertBefore(draggedBtn, before ? btn : btn.nextSibling);
    });
  });
}

const MERGE_MODS_INSTANCES_KEY = 'magma_merge_mods_instances';
let mergedInstancesOpen = false;
function getMergeModsInstancesPref() { return localStorage.getItem(MERGE_MODS_INSTANCES_KEY) === '1'; }
function renderModsRailIcon() {
  const btn = document.getElementById('modsRailBtn');
  if (!btn) return;
  const icon = btn.querySelector('.mods-rail-icon');
  if (!icon) return;
  if (getMergeModsInstancesPref()) {
    icon.innerHTML = `
      <path class="mods-rail-stroke" d="M4.5 5.5h7v7h-7zM12.5 11.5h7v7h-7z"/>
      <path class="mods-rail-stroke" d="M15.5 4.5h4v4M19.5 4.5l-4.8 4.8"/>
    `;
  } else {
    icon.innerHTML = '<path d="M20 12a8 8 0 1 1-3.6-6.7l-2 2A5.5 5.5 0 1 0 17.5 12h-3l3.5-4 3.5 4h-1.5z"/>';
  }
}
function applyMergeModsInstances() {
  const merge = getMergeModsInstancesPref();
  const instancesBtn = document.querySelector('.rail-btn[data-view="instances"]');
  if (instancesBtn) instancesBtn.style.display = merge ? 'none' : '';
  const toggle = document.getElementById('mergeModsInstancesToggle');
  if (toggle) toggle.checked = merge;
  renderModsRailIcon();
  if (!merge) {
    mergedInstancesOpen = false;
    const modsView = document.querySelector('.view[data-view="mods"]');
    const modsViewHeader = modsView ? modsView.querySelector('.view-header') : null;
    if (modsCategoryTabsEl && modsView && modsViewHeader && modsCategoryTabsEl.parentElement !== modsView) {
      modsView.insertBefore(modsCategoryTabsEl, modsViewHeader.nextSibling);
    }
  }
  renderModsCategoryTabs();
}

document.getElementById('mergeModsInstancesToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(MERGE_MODS_INSTANCES_KEY, e.target.checked ? '1' : '0');
  applyMergeModsInstances();
});

// --- Кнопка ИГРАТЬ ---
const playBtn = document.querySelector('.play-btn');
const launchProgressEl = document.getElementById('launchProgress');
const launchProgressFillEl = document.getElementById('launchProgressFill');
const launchProgressLabelEl = document.getElementById('launchProgressLabel');
const launchPauseBtn = document.getElementById('launchPauseBtn');
const launchCancelBtn = document.getElementById('launchCancelBtn');
const launchDetailsBtn = document.getElementById('launchDetailsBtn');

// opts.showControls — показывать ли паузу/отмену. Раньше они оставались
// видимыми (и как будто рабочими) даже после того, как загрузка уже
// закончилась ошибкой — нажатие "Отмена" в этот момент ничего не отменяло,
// потому что отменять уже было нечего, и выглядело так, будто кнопка сломана.
// opts.fullError — если задано, показывается кнопка "Подробнее" с полным текстом.
function setLaunchProgress(visible, fraction, label, isError, opts = {}) {
  if (!launchProgressEl) return;
  launchProgressEl.style.display = visible ? 'flex' : 'none';
  launchProgressEl.classList.toggle('is-error', !!isError);
  if (launchProgressFillEl) launchProgressFillEl.style.width = Math.round((fraction || 0) * 100) + '%';
  if (launchProgressLabelEl) launchProgressLabelEl.textContent = label || '';

  const showControls = opts.showControls !== false;
  if (launchPauseBtn) launchPauseBtn.style.display = showControls ? 'flex' : 'none';
  if (launchCancelBtn) launchCancelBtn.style.display = showControls ? 'flex' : 'none';

  if (launchDetailsBtn) {
    if (opts.fullError) {
      launchDetailsBtn.style.display = 'flex';
      launchDetailsBtn.onclick = () => showErrorDetailsModal(opts.fullError);
    } else {
      launchDetailsBtn.style.display = 'none';
      launchDetailsBtn.onclick = null;
    }
  }
}

// ============================================
// Модалка "Подробности ошибки" — вместо системного alert() показывает
// полный текст в обычном окне лаунчера, который можно спокойно читать/копировать.
// ============================================
const errorDetailsOverlay = document.getElementById('errorDetailsOverlay');
const errorDetailsBody = document.getElementById('errorDetailsBody');
const errorDetailsClose = document.getElementById('errorDetailsClose');

function showErrorDetailsModal(fullText) {
  if (!errorDetailsOverlay || !errorDetailsBody) return;
  errorDetailsBody.textContent = fullText;
  errorDetailsOverlay.classList.add('is-open');
}
errorDetailsClose?.addEventListener('click', () => errorDetailsOverlay.classList.remove('is-open'));
errorDetailsOverlay?.addEventListener('click', (e) => { if (e.target === errorDetailsOverlay) errorDetailsOverlay.classList.remove('is-open'); });

// ============================================
// Пауза скачивания.
// ============================================
let isLaunchPaused = false;
let lastProgressLabelText = ''; // последний реальный текст стадии от бэкенда — нужен, чтобы
                                 // сразу восстановить его при снятии паузы (см. setPauseButtonState)

function setPauseButtonState(paused) {
  isLaunchPaused = paused;
  if (!launchPauseBtn) return;
  launchPauseBtn.classList.toggle('is-paused', paused);
  const pauseIcon = launchPauseBtn.querySelector('.pause-icon');
  const resumeIcon = launchPauseBtn.querySelector('.resume-icon');
  if (pauseIcon) pauseIcon.style.display = paused ? 'none' : 'block';
  if (resumeIcon) resumeIcon.style.display = paused ? 'block' : 'none';

  // Пока стоит пауза, бэкенд не шлёт новых __launchProgress событий (загрузка
  // реально остановлена — см. abortIfCancelledCallback в launcher_core.cpp),
  // так что строка прогресса просто замирает на последнем тексте и выглядит
  // так, будто ничего не произошло. Явно показываем, что это пауза, а не зависание.
  if (paused && launchProgressLabelEl) {
    launchProgressLabelEl.textContent = t('launch.paused');
  } else if (!paused && launchProgressLabelEl) {
    // При снятии паузы возвращаем последний реальный текст стадии СРАЗУ, а не
    // ждём следующего __launchProgress от бэкенда. Если пауза пришлась на
    // середину закачки одного большого файла (client.jar, крупная библиотека,
    // Java runtime), следующее обновление прогресса может прийти нескоро —
    // и надпись "На паузе" зависала бы на экране, хотя загрузка уже идёт.
    launchProgressLabelEl.textContent = lastProgressLabelText;
  }
}

launchPauseBtn?.addEventListener('click', async () => {
  const next = !isLaunchPaused;
  setPauseButtonState(next);

  if (typeof window.pauseLaunch !== 'function' || typeof window.resumeLaunch !== 'function') {
    return;
  }

  try {
    if (next) await window.pauseLaunch();
    else await window.resumeLaunch();
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка переключения паузы:', err);
  }
});

launchCancelBtn?.addEventListener('click', async () => {
  if (typeof window.cancelLaunch !== 'function') {
    // dev-режим без C++ бэкенда — просто прячем прогресс и возвращаем кнопку "Играть"
    setLaunchProgress(false, 0, '');
    playBtn.disabled = false;
    playBtn.querySelector('span').textContent = t('hero.play');
    setPauseButtonState(false);
    return;
  }

  launchCancelBtn.disabled = true;
  try {
    await window.cancelLaunch();
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка отмены загрузки:', err);
  } finally {
    launchCancelBtn.disabled = false;
  }
});

// Эти две функции дёргает C++ (w.eval(...)) из main.cpp по мере скачивания.
window.__launchProgress = function (data) {
  const stageLabels = {
    manifest: t('launch.stage.manifest'),
    java: t('launch.stage.java'),
    client: t('launch.stage.client'),
    libraries: t('launch.stage.libraries'),
    assets: t('launch.stage.assets'),
    launch: t('launch.stage.launch'),
  };
  const stageText = stageLabels[data.stage] || data.stage;
  const detail = data.detail ? ` — ${data.detail}` : '';
  const fullText = stageText + detail;
  lastProgressLabelText = fullText;
  setLaunchProgress(true, data.progress || 0, fullText, false);
};

window.__launchDone = function (data) {
  playBtn.disabled = false;
  playBtn.querySelector('span').textContent = t('hero.play');
  setPauseButtonState(false);

  if (data.success) {
    setLaunchProgress(true, 1, t('launch.success'), false, { showControls: false });
    updateDiscordPresencePlaying();
    setTimeout(() => setLaunchProgress(false, 0, ''), 3000);
  } else if (data.cancelled) {
    setLaunchProgress(true, 0, t('launch.cancelled'), false, { showControls: false });
    setTimeout(() => setLaunchProgress(false, 0, ''), 1500);
  } else {
    const fullError = data.error || t('auth.magma.genericError');
    const shortError = fullError.length > 90 ? fullError.slice(0, 90) + '…' : fullError;
    // Загрузка уже остановилась — прятать паузу/отмену (нечего ставить на паузу
    // и нечего отменять), но при длинной ошибке (например, лог Forge) даём
    // открыть полный текст в модалке вместо системного alert().
    setLaunchProgress(true, 0, shortError, true, {
      showControls: false,
      fullError: fullError.length > 90 ? fullError : null,
    });
    // Ошибку больше не прячем через setTimeout — пусть человек спокойно
    // прочитает её или откроет "Подробнее", а не гонится за текстом до того,
    // как он исчезнет сам.
  }
};

playBtn.addEventListener('click', async () => {
  const SUPPORTED_LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];
  if (!SUPPORTED_LOADERS.includes(currentSelectedLoader)) {
    setLaunchProgress(true, 0, t('launch.loaderNotSupported'), true);
    setTimeout(() => setLaunchProgress(false, 0, ''), 4000);
    return;
  }

  playBtn.disabled = true;
  const label = playBtn.querySelector('span');
  const original = label.textContent;
  label.textContent = t('hero.launching');
  setPauseButtonState(false);
  lastProgressLabelText = t('launch.starting');
  setLaunchProgress(true, 0, t('launch.starting'), false);

  const javaPathInput = document.getElementById('javaPathInput');
  const gameDirInput = document.getElementById('gameDirInput');
  const launchRes = getLaunchResolution();

  let extraJvmArgsFinal = jvmArgsInputEl ? jvmArgsInputEl.value.trim() : '';
  if (getPrivacyPref(PRIVACY_BLOCK_TELEMETRY_KEY, false)) {
    const hostsPath = await ensureTelemetryBlockHostsFile();
    if (hostsPath) extraJvmArgsFinal = (extraJvmArgsFinal + ' -Djdk.net.hosts.file=' + hostsPath).trim();
  }

  const params = {
    version: selectedVersion,
    loader: currentSelectedLoader,
    username: (accountName && accountName.textContent) || 'Player',
    gameDir: getGameDir(),
    javaPath: javaPathInput ? javaPathInput.value : '',
    ramMb: (ramSlider ? Number(ramSlider.value) : 4) * 1024,
    authUuid: (window.msAuthState && window.msAuthState.uuid) || '',
    authAccessToken: (window.msAuthState && window.msAuthState.accessToken) || '',
    instanceName: selectedInstanceName || '',
    quickPlayServer: '',
    extraJvmArgs: extraJvmArgsFinal,
    fullscreen: !!(fullscreenToggleEl && fullscreenToggleEl.checked),
    windowWidth: launchRes.width,
    windowHeight: launchRes.height,
  };

  const skinInstanceRoot = selectedInstanceName ? `${params.gameDir}\\instances\\${selectedInstanceName}` : params.gameDir;
  await ensureCustomSkinLoaderInstalled(currentSelectedLoader, selectedVersion, skinInstanceRoot + '\\mods', skinInstanceRoot);

  if (typeof window.launchGame !== 'function') {
    console.log('[MagmaLauncher] (dev-режим, бэкенд не подключен) launchGame недоступен');
    label.textContent = original;
    playBtn.disabled = false;
    setLaunchProgress(true, 0, t('launch.devOnlyExe'), true);
    setTimeout(() => setLaunchProgress(false, 0, ''), 4000);
    return;
  }

  try {
    const raw = await window.launchGame(params);
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.started) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка запуска игры:', err);
    label.textContent = original;
    playBtn.disabled = false;
    setLaunchProgress(true, 0, String(err.message || err), true);
  }
});

// ============================================
// Локализация (RU / EN)
// ============================================
const I18N = {
  ru: {
    'nav.home': 'Главная', 'nav.instances': 'Сборки', 'nav.mods': 'Моды', 'nav.settings': 'Настройки',
    'hero.eyebrow': 'Готово к запуску', 'hero.title': 'Твой мир ждёт', 'hero.buildLabel': 'Сборка',
    'hero.play': 'ИГРАТЬ', 'hero.launching': 'ЗАПУСК...', 'hero.searchVersion': 'Поиск версии...','hero.snapshots': 'Снапшоты',
    'launch.stage.manifest': 'Проверка версии', 'launch.stage.java': 'Загрузка Java',
    'launch.stage.client': 'Загрузка игры',
    'launch.stage.libraries': 'Загрузка библиотек', 'launch.stage.assets': 'Загрузка ресурсов',
    'launch.stage.launch': 'Запуск', 'launch.starting': 'Подготовка...', 'launch.success': 'Игра запущена',
    'launch.loaderNotSupported': 'Этот загрузчик пока не поддерживается — скоро добавим',
    'launch.pauseTooltip': 'Пауза / продолжить загрузку',
    'launch.cancelTooltip': 'Отменить загрузку',
    'launch.cancelled': 'Отменено',
    'launch.paused': 'На паузе — нажмите ⏸, чтобы продолжить',
    'launch.cancelBtn': 'Отмена',
    'launch.detailsBtn': 'Подробнее',
    'launch.errorDetailsTitle': 'Что пошло не так',
    'launch.devOnlyExe': 'Запуск игры работает только из собранного .exe',
    'loader.comingSoon': 'Скоро будет доступно',
    'news.title': 'Новости',
    'news.tag.update': 'Обновление', 'news.item1.title': 'Magma 1.4 вышла', 'news.item1.desc': 'Новый менеджер модов и ускоренная загрузка сборок.',
    'news.tag.build': 'Сборка', 'news.item2.title': 'Tectonic Craft добавлена', 'news.item2.desc': 'Технический модпак недели уже в каталоге.',
    'news.tag.server': 'Сервер', 'news.item3.title': 'Плановые работы', 'news.item3.desc': 'Профили синхронизации будут недоступны 2 часа.',
    'instances.title': 'Сборки', 'instances.new': '+ Новая сборка', 'instances.newCard': 'Новая сборка',
    'instances.tab.mine': 'Мои сборки',
    'instances.tab.catalog': 'Каталог',
    'instances.searchCatalog': 'Поиск сборок...',
    'instances.none': 'У вас пока нет установленных сборок',
    'mods.title': 'Моды', 'mods.search': 'Поиск модов...', 'mods.install': 'Установить',
    'mods.installTarget': 'Ставим моды под:',
    'mods.scope.vanilla': 'Обычная игра',
    'mods.scope.modpack': 'Модпак',
    'mods.createModpack': '+ Создать модпак', 'mods.name': 'Название модпака',
    'mods.version': 'Версия Minecraft', 'mods.loader': 'Загрузчик',
    'mods.recommended': 'Рекомендуемые моды', 'mods.addMore': 'Добавить ещё моды',
    'mods.createBtn': 'Создать модпак', 'mods.creating': 'Создаём...',
    'mods.addBtn': 'Добавить', 'mods.added': 'Добавлено',
    'mods.installing': 'Устанавливаем...', 'mods.searching': 'Ищем моды...',
    'mods.notFound': 'Ничего не найдено', 'mods.modsCount': 'модов',
    'mods.devModeHint': 'Поиск модов работает только из собранного .exe',
    'mods.downloadsLabel': 'скачиваний', 'mods.followersLabel': 'подписчиков',
    'mods.loadingDetails': 'Загружаем описание...',
    'mods.nameRequired': 'Придумайте название модпака',
    'mods.nameTaken': 'Модпак с таким названием уже есть',
    'mods.duplicateNameError': 'Мод с таким названием уже установлен из другого источника для этой версии',
    'mods.devOnlyExe': 'Создание модпака работает только из собранного .exe',
    'settings.title': 'Настройки',
    'settings.java.label': 'Путь к Java', 'settings.java.hint': 'Исполняемый файл java.exe. Оставьте как есть, если хотите, чтобы лаунчер сам нашёл или скачал нужную версию Java',
    'settings.dir.label': 'Папка игры', 'settings.dir.hint': 'Где хранятся сборки, моды и сохранения',
    'settings.ram.label': 'Выделено ОЗУ', 'settings.ram.hint': 'Объём памяти, доступный игре',
    'settings.lang.label': 'Язык', 'settings.lang.hint': 'Язык интерфейса лаунчера',
    'ram.unit': 'ГБ', 'version.notFound': 'Ничего не найдено',
    'account.tooltip': 'Аккаунт',
    'auth.tab.guest': 'Гость', 'auth.tab.magma': 'Magma Аккаунт', 'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Никнейм', 'auth.guest.continue': 'Продолжить как гость',
    'auth.magma.emailLabel': 'Почта или ник', 'auth.magma.passwordLabel': 'Пароль', 'auth.magma.signIn': 'Войти',
    'auth.magma.signingIn': 'Входим...',
    'auth.magma.noAccount': 'Нет аккаунта?', 'auth.magma.createLink': 'Создать',
    'auth.magma.registerEmail': 'Почта', 'auth.magma.registerNick': 'Никнейм (логин)',
    'auth.magma.registerPassword': 'Пароль', 'auth.magma.registerConfirm': 'Повторите пароль',
    'auth.magma.createBtn': 'Создать аккаунт', 'auth.magma.haveAccount': 'Уже есть аккаунт?', 'auth.magma.loginLink': 'Войти',
    'auth.ms.desc': 'Войдите через аккаунт Microsoft, привязанный к Minecraft, — как в официальном лаунчере.',
    'auth.ms.button': 'Войти через Microsoft',
    'auth.tab.comingSoonBadge': 'Скоро',
    'auth.ms.comingSoonDesc': 'Вход через Microsoft/Xbox пока в разработке — Microsoft требует отдельного одобрения приложения для доступа к Minecraft API. Как только доступ будет открыт, эта вкладка заработает автоматически.',
    'auth.ms.comingSoonButton': 'Скоро будет доступно',
    'auth.ms.devOnlyExe': 'Вход через Microsoft работает только из собранного .exe',
    'auth.magma.notFound': 'Аккаунт с такой почтой или логином не найден',
    'auth.magma.wrongPassword': 'Неверный пароль',
    'auth.magma.emailTaken': 'Этот email уже зарегистрирован',
    'auth.magma.nickTaken': 'Этот никнейм уже занят',
    'auth.magma.passwordMismatch': 'Пароли не совпадают',
    'auth.magma.fillAll': 'Заполните все поля',
    'auth.magma.nickRules': '3–16 символов: латинские буквы, цифры и _',
    'auth.magma.invalidNick': 'Никнейм: 3–16 символов, только латинские буквы, цифры и _',
    'auth.magma.invalidEmail': 'Введите корректный email',
    'auth.magma.weakPassword': 'Пароль должен быть не короче 6 символов',
    'auth.magma.genericError': 'Что-то пошло не так. Попробуйте ещё раз.',
    'auth.google.or': 'или',
    'auth.google.button': 'Войти через Google',
    'auth.google.registerButton': 'Зарегистрироваться через Google',
    'auth.google.registerDesc': 'Аккаунт Magma создаётся через ваш Google-аккаунт. Это займёт 10 секунд — почту подтверждать не нужно.',
    'auth.google.setPassword': 'Придумайте пароль',
    'auth.google.finishButton': 'Завершить регистрацию',
    'auth.google.setupDesc': 'Вы вошли как {email}. Осталось придумать никнейм.',
    'auth.google.repairDesc': 'Пароль верный, но никнейм для этого аккаунта в прошлый раз не сохранился. Просто придумайте его сейчас.',
    'auth.google.cancelled': 'Вход через Google отменён',
    'auth.google.failed': 'Не удалось войти через Google. Проверьте подключение к интернету и попробуйте снова.',
    'auth.google.accountExists': 'Аккаунт с этой почтой уже существует. Введите пароль, чтобы войти.',
    'auth.google.waitingBrowser': 'Ждём подтверждения в браузере...',
    'auth.google.checking': 'Проверяем аккаунт...',
    'auth.google.creatingAccount': 'Создаём аккаунт...',
    'auth.magma.invalidCredentials': 'Неверная почта или пароль',
    'auth.google.devOnlyExe': 'Вход через Google работает только из собранного .exe',
    'modpacks.none': 'Вы ещё не создали ни одного модпака',
    'mods.tab.browse': 'Каталог',
    'mods.tab.installed': 'Мои моды',
    'mods.installed.empty': 'В папке mods пока нет модов',
    'mods.installed.disable': 'Отключить',
    'mods.installed.enable': 'Включить',
    'mods.installed.delete': 'Удалить',
    'mods.installed.disabled': 'Отключён',
    'mods.installed.confirmDelete': 'Удалить этот мод насовсем?',
    'mods.installed.loadError': 'Не удалось прочитать папку mods',
    'mods.filter.sortBy': 'Сортировка',
    'mods.filter.sources': 'Источники',
    'mods.filter.sort.relevance': 'Актуальность',
    'mods.filter.sort.downloads': 'По скачиваниям',
    'mods.filter.sort.followers': 'По подписчикам',
    'mods.filter.sort.datePublished': 'Дата публикации',
    'mods.filter.sort.dateUpdated': 'Дата обновления',
    'mods.category.mods': 'Моды',
    'mods.category.resourcepacks': 'Ресурс-паки',
    'mods.category.datapacks': 'Дата-паки',
    'mods.category.shaders': 'Шейдеры',
    'mods.category.servers': 'Серверы',
    'mods.category.maps': 'Карты',
    'mods.datapackHint': 'Дата-паки ставятся не в общую папку игры, а внутрь конкретного мира. Скачанный файл появится в папке datapacks_downloads — перенесите его в папку datapacks вашего мира вручную.',
    'servers.licenseRequired': 'Нужна лицензия Minecraft',
    'servers.licenseFree': 'Без лицензии (можно зайти гостем)',
    'servers.magmaSurvival.desc': 'Ванильное выживание с плавным экономическим прогрессом и без доната в силу.',
    'servers.magmaCreative.desc': 'Творческий хаб для стройки — плоский мир, WorldEdit и общие города игроков.',
    'servers.tectonicNetwork.desc': 'Технический Forge-сервер с автоматизацией и промышленными модами.',
    'settings.updates.autoCheck.label': 'Проверять обновления при запуске',
    'settings.updates.autoCheck.hint': 'Лаунчер сам проверит, есть ли новая версия',
    'settings.updates.current.label': 'Текущая версия',
    'settings.updates.checkBtn': 'Проверить обновления',
    'settings.updates.installBtn': 'Скачать и установить',
    'settings.updates.newVersion': 'Доступна версия',
    'settings.updates.upToDate': 'У вас последняя версия',
  },
  en: {
    'nav.home': 'Home', 'nav.instances': 'Instances', 'nav.mods': 'Mods', 'nav.settings': 'Settings',
    'hero.eyebrow': 'Ready to launch', 'hero.title': 'Your world awaits', 'hero.buildLabel': 'Instance',
    'hero.play': 'PLAY', 'hero.launching': 'LAUNCHING...', 'hero.searchVersion': 'Search version...','hero.snapshots': 'Snapshots',
    'launch.stage.manifest': 'Checking version', 'launch.stage.java': 'Downloading Java',
    'launch.stage.client': 'Downloading game',
    'launch.stage.libraries': 'Downloading libraries', 'launch.stage.assets': 'Downloading assets',
    'launch.stage.launch': 'Launching', 'launch.starting': 'Preparing...', 'launch.success': 'Game launched',
    'launch.loaderNotSupported': "This loader isn't supported yet — coming soon",
    'launch.pauseTooltip': 'Pause / resume download',
    'launch.cancelTooltip': 'Cancel download',
    'launch.cancelled': 'Cancelled',
    'launch.paused': 'Paused — click ⏸ to resume',
    'launch.cancelBtn': 'Cancel',
    'launch.detailsBtn': 'Details',
    'launch.errorDetailsTitle': 'Something went wrong',
    'launch.devOnlyExe': 'Launching the game only works from the built .exe',
    'loader.comingSoon': 'Coming soon',
    'news.title': 'News',
    'news.tag.update': 'Update', 'news.item1.title': 'Magma 1.4 is out', 'news.item1.desc': 'New mod manager and faster instance loading.',
    'news.tag.build': 'Instance', 'news.item2.title': 'Tectonic Craft added', 'news.item2.desc': "This week's technical modpack is now in the catalog.",
    'news.tag.server': 'Server', 'news.item3.title': 'Scheduled maintenance', 'news.item3.desc': 'Profile sync will be unavailable for 2 hours.',
    'instances.title': 'Instances', 'instances.new': '+ New instance', 'instances.newCard': 'New instance',
    'instances.tab.mine': 'My Instances',
    'instances.tab.catalog': 'Catalog',
    'instances.searchCatalog': 'Search modpacks...',
    'instances.none': "You haven't installed any instances yet",
    'mods.title': 'Mods', 'mods.search': 'Search mods...', 'mods.install': 'Install',
    'mods.installTarget': 'Installing mods for:',
    'mods.scope.vanilla': 'Vanilla game',
    'mods.scope.modpack': 'Modpack',
    'mods.createModpack': '+ Create modpack', 'mods.name': 'Modpack name',
    'mods.version': 'Minecraft version', 'mods.loader': 'Loader',
    'mods.recommended': 'Recommended mods', 'mods.addMore': 'Add more mods',
    'mods.createBtn': 'Create modpack', 'mods.creating': 'Creating...',
    'mods.addBtn': 'Add', 'mods.added': 'Added',
    'mods.installing': 'Installing...', 'mods.searching': 'Searching mods...',
    'mods.notFound': 'Nothing found', 'mods.modsCount': 'mods',
    'mods.devModeHint': 'Mod search only works from the built .exe',
    'mods.downloadsLabel': 'downloads', 'mods.followersLabel': 'followers',
    'mods.loadingDetails': 'Loading description...',
    'mods.nameRequired': 'Pick a modpack name',
    'mods.nameTaken': 'A modpack with this name already exists',
    'mods.duplicateNameError': 'A mod with this name is already installed from a different source for this version',
    'mods.devOnlyExe': 'Creating a modpack only works from the built .exe',
    'settings.title': 'Settings',
    'settings.java.label': 'Java path', 'settings.java.hint': 'The java.exe executable. Leave as-is if you want the launcher to auto-detect or download the right Java version',
    'settings.dir.label': 'Game folder', 'settings.dir.hint': 'Where instances, mods and saves are stored',
    'settings.ram.label': 'Allocated RAM', 'settings.ram.hint': 'Amount of memory available to the game',
    'settings.lang.label': 'Language', 'settings.lang.hint': 'Launcher interface language',
    'ram.unit': 'GB', 'version.notFound': 'Nothing found',
    'account.tooltip': 'Account',
    'auth.tab.guest': 'Guest', 'auth.tab.magma': 'Magma Account', 'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Nickname', 'auth.guest.continue': 'Continue as guest',
    'auth.magma.emailLabel': 'Email or nickname', 'auth.magma.passwordLabel': 'Password', 'auth.magma.signIn': 'Sign in',
    'auth.magma.signingIn': 'Signing in...',
    'auth.magma.noAccount': "Don't have an account?", 'auth.magma.createLink': 'Create one',
    'auth.magma.registerEmail': 'Email', 'auth.magma.registerNick': 'Nickname (login)',
    'auth.magma.registerPassword': 'Password', 'auth.magma.registerConfirm': 'Confirm password',
    'auth.magma.createBtn': 'Create account', 'auth.magma.haveAccount': 'Already have an account?', 'auth.magma.loginLink': 'Sign in',
    'auth.ms.desc': 'Sign in with the Microsoft account linked to Minecraft — just like in the official launcher.',
    'auth.ms.button': 'Sign in with Microsoft',
    'auth.tab.comingSoonBadge': 'Soon',
    'auth.ms.comingSoonDesc': "Microsoft/Xbox sign-in is still in progress — Microsoft requires separate app approval to access the Minecraft API. This tab will start working automatically once access is granted.",
    'auth.ms.comingSoonButton': 'Coming soon',
    'auth.ms.devOnlyExe': 'Signing in with Microsoft only works from the built .exe',
    'auth.magma.notFound': 'No account found with this email or login',
    'auth.magma.wrongPassword': 'Incorrect password',
    'auth.magma.emailTaken': 'This email is already registered',
    'auth.magma.nickTaken': 'This nickname is already taken',
    'auth.magma.passwordMismatch': 'Passwords do not match',
    'auth.magma.fillAll': 'Please fill in all fields',
    'auth.magma.nickRules': '3–16 characters: latin letters, numbers and _',
    'auth.magma.invalidNick': 'Nickname: 3–16 characters, latin letters, numbers and _ only',
    'auth.magma.invalidEmail': 'Enter a valid email address',
    'auth.magma.weakPassword': 'Password must be at least 6 characters',
    'auth.magma.genericError': 'Something went wrong. Please try again.',
    'auth.google.or': 'or',
    'auth.google.button': 'Sign in with Google',
    'auth.google.registerButton': 'Sign up with Google',
    'auth.google.registerDesc': 'Your Magma account is created through Google. Takes 10 seconds — no email confirmation needed.',
    'auth.google.setPassword': 'Set a password',
    'auth.google.finishButton': 'Finish setup',
    'auth.google.setupDesc': "You're signed in as {email}. Just pick a nickname to finish.",
    'auth.google.repairDesc': "Your password is correct, but a nickname was never saved for this account last time. Just pick one now.",
    'auth.google.cancelled': 'Google sign-in was cancelled',
    'auth.google.failed': 'Could not sign in with Google. Check your internet connection and try again.',
    'auth.google.accountExists': 'An account with this email already exists — enter your password to sign in.',
    'auth.google.waitingBrowser': 'Waiting for browser confirmation...',
    'auth.google.checking': 'Checking account...',
    'auth.google.creatingAccount': 'Creating account...',
    'auth.magma.invalidCredentials': 'Incorrect email or password',
    'auth.google.devOnlyExe': 'Signing in with Google only works from the built .exe',
    'modpacks.none': "You haven't created any modpacks yet",
    'mods.tab.browse': 'Browse',
    'mods.tab.installed': 'My Mods',
    'mods.installed.empty': 'The mods folder is empty',
    'mods.installed.disable': 'Disable',
    'mods.installed.enable': 'Enable',
    'mods.installed.delete': 'Delete',
    'mods.installed.disabled': 'Disabled',
    'mods.installed.confirmDelete': 'Delete this mod for good?',
    'mods.installed.loadError': 'Could not read the mods folder',
    'mods.filter.sortBy': 'Sort by',
    'mods.filter.sources': 'Sources',
    'mods.filter.sort.relevance': 'Relevance',
    'mods.filter.sort.downloads': 'Downloads',
    'mods.filter.sort.followers': 'Followers',
    'mods.filter.sort.datePublished': 'Date published',
    'mods.filter.sort.dateUpdated': 'Date updated',
    'mods.category.mods': 'Mods',
    'mods.category.resourcepacks': 'Resource Packs',
    'mods.category.datapacks': 'Data Packs',
    'mods.category.shaders': 'Shaders',
    'mods.category.servers': 'Servers',
    'mods.category.maps': 'Maps',
    'mods.datapackHint': "Data packs install into a specific world, not the shared game folder. The downloaded file lands in the datapacks_downloads folder — move it into your world's datapacks folder yourself.",
    'servers.licenseRequired': 'Requires a Minecraft license',
    'servers.licenseFree': 'No license needed (join as guest)',
    'servers.magmaSurvival.desc': 'Vanilla survival with a smooth economy and no pay-to-win.',
    'servers.magmaCreative.desc': 'A creative building hub — flat world, WorldEdit and shared player cities.',
    'servers.tectonicNetwork.desc': 'A technical Forge server with automation and industrial mods.',
  },
  uk: {
    'nav.home': 'Головна',
    'nav.instances': 'Збірки',
    'nav.mods': 'Моди',
    'nav.settings': 'Налаштування',
    'hero.eyebrow': 'Готово до запуску',
    'hero.title': 'Твій світ чекає',
    'hero.buildLabel': 'Збірка',
    'hero.play': 'ГРАТИ',
    'hero.launching': 'ЗАПУСК...',
    'hero.searchVersion': 'Пошук версії...','hero.snapshots': 'Снепшоти',
    'launch.stage.manifest': 'Перевірка версії',
    'launch.stage.java': 'Завантаження Java',
    'launch.stage.client': 'Завантаження гри',
    'launch.stage.libraries': 'Завантаження бібліотек',
    'launch.stage.assets': 'Завантаження ресурсів',
    'launch.stage.launch': 'Запуск',
    'launch.starting': 'Підготовка...',
    'launch.success': 'Гру запущено',
    'launch.loaderNotSupported': 'Цей завантажувач поки не підтримується — скоро додамо',
    'launch.pauseTooltip': 'Пауза / продовжити завантаження',
    'launch.cancelTooltip': 'Скасувати завантаження',
    'launch.cancelled': 'Скасовано',
    'launch.paused': 'На паузі — натисніть ⏸, щоб продовжити',
    'launch.cancelBtn': 'Скасувати',
    'launch.detailsBtn': 'Детальніше',
    'launch.errorDetailsTitle': 'Що пішло не так',
    'launch.devOnlyExe': 'Запуск гри працює лише зі зібраного .exe',
    'loader.comingSoon': 'Скоро буде доступно',
    'news.title': 'Новини',
    'news.tag.update': 'Оновлення',
    'news.item1.title': 'Magma 1.4 вийшла',
    'news.item1.desc': 'Новий менеджер модів і швидше завантаження збірок.',
    'news.tag.build': 'Збірка',
    'news.item2.title': 'Додано Tectonic Craft',
    'news.item2.desc': 'Технічний модпак тижня вже в каталозі.',
    'news.tag.server': 'Сервер',
    'news.item3.title': 'Планові роботи',
    'news.item3.desc': 'Синхронізація профілів буде недоступна 2 години.',
    'instances.title': 'Збірки',
    'instances.new': '+ Нова збірка',
    'instances.newCard': 'Нова збірка',
    'instances.tab.mine': 'Мої збірки',
    'instances.tab.catalog': 'Каталог',
    'instances.searchCatalog': 'Пошук збірок...',
    'instances.none': 'У вас ще немає встановлених збірок',
    'mods.title': 'Моди',
    'mods.search': 'Пошук модів...',
    'mods.install': 'Встановити',
    'mods.installTarget': 'Ставимо моди під:',
    'mods.createModpack': '+ Створити модпак',
    'mods.name': 'Назва модпака',
    'mods.version': 'Версія Minecraft',
    'mods.loader': 'Завантажувач',
    'mods.recommended': 'Рекомендовані моди',
    'mods.addMore': 'Додати ще моди',
    'mods.createBtn': 'Створити модпак',
    'mods.creating': 'Створюємо...',
    'mods.addBtn': 'Додати',
    'mods.added': 'Додано',
    'mods.installing': 'Встановлюємо...',
    'mods.searching': 'Шукаємо моди...',
    'mods.notFound': 'Нічого не знайдено',
    'mods.modsCount': 'модів',
    'mods.devModeHint': 'Пошук модів працює лише зі зібраного .exe',
    'mods.devOnlyExe': 'Створення модпака працює лише зі зібраного .exe',
    'mods.downloadsLabel': 'завантажень',
    'mods.followersLabel': 'підписників',
    'mods.loadingDetails': 'Завантажуємо опис...',
    'mods.nameRequired': 'Придумайте назву модпака',
    'mods.nameTaken': 'Модпак з такою назвою вже є',
    'settings.title': 'Налаштування',
    'settings.java.label': 'Шлях до Java',
    'settings.java.hint': 'Виконуваний файл java.exe. Залиште як є, якщо хочете, щоб лаунчер сам знайшов або завантажив потрібну версію Java',
    'settings.dir.label': 'Папка гри',
    'settings.dir.hint': 'Де зберігаються збірки, моди та збереження',
    'settings.ram.label': 'Виділено ОЗП',
    'settings.ram.hint': 'Обсяг пам\'яті, доступний грі',
    'settings.lang.label': 'Мова',
    'settings.lang.hint': 'Мова інтерфейсу лаунчера',
    'ram.unit': 'ГБ',
    'version.notFound': 'Нічого не знайдено',
    'account.tooltip': 'Акаунт',
    'auth.tab.guest': 'Гість',
    'auth.tab.magma': 'Magma Акаунт',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Нікнейм',
    'auth.guest.continue': 'Продовжити як гість',
    'auth.magma.emailLabel': 'Пошта або нік',
    'auth.magma.passwordLabel': 'Пароль',
    'auth.magma.signIn': 'Увійти',
    'auth.magma.signingIn': 'Входимо...',
    'auth.magma.noAccount': 'Немає акаунта?',
    'auth.magma.createLink': 'Створити',
    'auth.magma.registerEmail': 'Пошта',
    'auth.magma.registerNick': 'Нікнейм (логін)',
    'auth.magma.registerPassword': 'Пароль',
    'auth.magma.registerConfirm': 'Повторіть пароль',
    'auth.magma.createBtn': 'Створити акаунт',
    'auth.magma.haveAccount': 'Вже є акаунт?',
    'auth.magma.loginLink': 'Увійти',
    'auth.ms.desc': 'Увійдіть через акаунт Microsoft, пов\'язаний з Minecraft — як в офіційному лаунчері.',
    'auth.ms.button': 'Увійти через Microsoft',
    'auth.tab.comingSoonBadge': 'Скоро',
    'auth.ms.comingSoonDesc': 'Вхід через Microsoft/Xbox поки в розробці — Microsoft вимагає окремого схвалення застосунку для доступу до Minecraft API. Щойно доступ буде відкрито, ця вкладка запрацює автоматично.',
    'auth.ms.comingSoonButton': 'Скоро буде доступно',
    'auth.ms.devOnlyExe': 'Вхід через Microsoft працює лише зі зібраного .exe',
    'auth.magma.notFound': 'Акаунт з такою поштою або логіном не знайдено',
    'auth.magma.wrongPassword': 'Невірний пароль',
    'auth.magma.emailTaken': 'Ця пошта вже зареєстрована',
    'auth.magma.nickTaken': 'Цей нікнейм вже зайнятий',
    'auth.magma.passwordMismatch': 'Паролі не збігаються',
    'auth.magma.fillAll': 'Заповніть усі поля',
    'auth.magma.nickRules': '3–16 символів: латинські літери, цифри та _',
    'auth.magma.invalidNick': 'Нікнейм: 3–16 символів, лише латинські літери, цифри та _',
    'auth.magma.invalidEmail': 'Введіть коректну email-адресу',
    'auth.magma.weakPassword': 'Пароль має бути не коротшим за 6 символів',
    'auth.magma.genericError': 'Щось пішло не так. Спробуйте ще раз.',
    'auth.google.or': 'або',
    'auth.google.button': 'Увійти через Google',
    'auth.google.registerButton': 'Зареєструватися через Google',
    'auth.google.registerDesc': 'Акаунт Magma створюється через ваш Google-акаунт. Це займе 10 секунд — пошту підтверджувати не потрібно.',
    'auth.google.setPassword': 'Придумайте пароль',
    'auth.google.finishButton': 'Завершити реєстрацію',
    'auth.google.setupDesc': 'Ви увійшли як {email}. Залишилось придумати нікнейм.',
    'auth.google.repairDesc': 'Пароль вірний, але нікнейм для цього акаунта минулого разу не зберігся. Просто придумайте його зараз.',
    'auth.google.cancelled': 'Вхід через Google скасовано',
    'auth.google.failed': 'Не вдалося увійти через Google. Перевірте підключення до інтернету і спробуйте ще раз.',
    'auth.google.accountExists': 'Акаунт з такою поштою вже існує. Введіть пароль, щоб увійти.',
    'auth.google.waitingBrowser': 'Чекаємо підтвердження в браузері...',
    'auth.google.checking': 'Перевіряємо акаунт...',
    'auth.google.creatingAccount': 'Створюємо акаунт...',
    'auth.google.devOnlyExe': 'Вхід через Google працює лише зі зібраного .exe',
    'auth.magma.invalidCredentials': 'Невірна пошта або пароль',
    'modpacks.none': 'Ви ще не створили жодного модпака',
    'mods.tab.browse': 'Каталог',
    'mods.tab.installed': 'Мої моди',
    'mods.installed.empty': 'У папці mods поки немає модів',
    'mods.installed.disable': 'Вимкнути',
    'mods.installed.enable': 'Увімкнути',
    'mods.installed.delete': 'Видалити',
    'mods.installed.disabled': 'Вимкнено',
    'mods.installed.confirmDelete': 'Видалити цей мод назавжди?',
    'mods.installed.loadError': 'Не вдалося прочитати папку mods',
    'mods.filter.sortBy': 'Сортування',
    'mods.filter.sources': 'Джерела',
    'mods.filter.sort.relevance': 'Актуальність',
    'mods.filter.sort.downloads': 'За завантаженнями',
    'mods.filter.sort.followers': 'За підписниками',
    'mods.filter.sort.datePublished': 'Дата публікації',
    'mods.filter.sort.dateUpdated': 'Дата оновлення',
    'mods.category.mods': 'Моди',
    'mods.category.resourcepacks': 'Ресурс-паки',
    'mods.category.shaders': 'Шейдери',
    'mods.category.maps': 'Карти',
  },
  fr: {
    'nav.home': 'Accueil',
    'nav.instances': 'Instances',
    'nav.mods': 'Mods',
    'nav.settings': 'Paramètres',
    'hero.eyebrow': 'Prêt à jouer',
    'hero.title': 'Votre monde vous attend',
    'hero.buildLabel': 'Instance',
    'hero.play': 'JOUER',
    'hero.launching': 'LANCEMENT...',
    'hero.searchVersion': 'Rechercher une version...','hero.snapshots': 'Snapshots',
    'launch.stage.manifest': 'Vérification de la version',
    'launch.stage.java': 'Téléchargement de Java',
    'launch.stage.client': 'Téléchargement du jeu',
    'launch.stage.libraries': 'Téléchargement des bibliothèques',
    'launch.stage.assets': 'Téléchargement des ressources',
    'launch.stage.launch': 'Lancement',
    'launch.starting': 'Préparation...',
    'launch.success': 'Jeu lancé',
    'launch.loaderNotSupported': 'Ce loader n\'est pas encore pris en charge — bientôt disponible',
    'launch.pauseTooltip': 'Pause / reprendre le téléchargement',
    'launch.cancelTooltip': 'Annuler le téléchargement',
    'launch.cancelled': 'Annulé',
    'launch.paused': 'En pause — cliquez sur ⏸ pour reprendre',
    'launch.cancelBtn': 'Annuler',
    'launch.detailsBtn': 'Détails',
    'launch.errorDetailsTitle': 'Un problème est survenu',
    'launch.devOnlyExe': 'Le lancement du jeu ne fonctionne que depuis l\'.exe compilé',
    'loader.comingSoon': 'Bientôt disponible',
    'news.title': 'Actualités',
    'news.tag.update': 'Mise à jour',
    'news.item1.title': 'Magma 1.4 est sortie',
    'news.item1.desc': 'Nouveau gestionnaire de mods et chargement des instances plus rapide.',
    'news.tag.build': 'Instance',
    'news.item2.title': 'Tectonic Craft ajouté',
    'news.item2.desc': 'Le modpack technique de la semaine est désormais dans le catalogue.',
    'news.tag.server': 'Serveur',
    'news.item3.title': 'Maintenance planifiée',
    'news.item3.desc': 'La synchronisation des profils sera indisponible pendant 2 heures.',
    'instances.title': 'Instances',
    'instances.new': '+ Nouvelle instance',
    'instances.newCard': 'Nouvelle instance',
    'instances.tab.mine': 'Mes instances',
    'instances.tab.catalog': 'Catalogue',
    'instances.searchCatalog': 'Rechercher des modpacks...',
    'instances.none': "Vous n'avez pas encore d'instance installée",
    'mods.title': 'Mods',
    'mods.search': 'Rechercher des mods...',
    'mods.install': 'Installer',
    'mods.installTarget': 'Installation des mods pour :',
    'mods.createModpack': '+ Créer un modpack',
    'mods.name': 'Nom du modpack',
    'mods.version': 'Version de Minecraft',
    'mods.loader': 'Loader',
    'mods.recommended': 'Mods recommandés',
    'mods.addMore': 'Ajouter d\'autres mods',
    'mods.createBtn': 'Créer le modpack',
    'mods.creating': 'Création...',
    'mods.addBtn': 'Ajouter',
    'mods.added': 'Ajouté',
    'mods.installing': 'Installation...',
    'mods.searching': 'Recherche de mods...',
    'mods.notFound': 'Aucun résultat',
    'mods.modsCount': 'mods',
    'mods.devModeHint': 'La recherche de mods ne fonctionne que depuis l\'.exe compilé',
    'mods.devOnlyExe': 'La création de modpack ne fonctionne que depuis l\'.exe compilé',
    'mods.downloadsLabel': 'téléchargements',
    'mods.followersLabel': 'abonnés',
    'mods.loadingDetails': 'Chargement de la description...',
    'mods.nameRequired': 'Choisissez un nom de modpack',
    'mods.nameTaken': 'Un modpack porte déjà ce nom',
    'settings.title': 'Paramètres',
    'settings.java.label': 'Chemin de Java',
    'settings.java.hint': 'L\'exécutable java.exe. Laissez tel quel si vous voulez que le launcher détecte ou télécharge lui-même la bonne version de Java',
    'settings.dir.label': 'Dossier du jeu',
    'settings.dir.hint': 'Où sont stockés instances, mods et sauvegardes',
    'settings.ram.label': 'RAM allouée',
    'settings.ram.hint': 'Quantité de mémoire disponible pour le jeu',
    'settings.lang.label': 'Langue',
    'settings.lang.hint': 'Langue de l\'interface du launcher',
    'ram.unit': 'Go',
    'version.notFound': 'Aucun résultat',
    'account.tooltip': 'Compte',
    'auth.tab.guest': 'Invité',
    'auth.tab.magma': 'Compte Magma',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Pseudo',
    'auth.guest.continue': 'Continuer en tant qu\'invité',
    'auth.magma.emailLabel': 'Email ou pseudo',
    'auth.magma.passwordLabel': 'Mot de passe',
    'auth.magma.signIn': 'Se connecter',
    'auth.magma.signingIn': 'Connexion...',
    'auth.magma.noAccount': 'Pas de compte ?',
    'auth.magma.createLink': 'En créer un',
    'auth.magma.registerEmail': 'Email',
    'auth.magma.registerNick': 'Pseudo (identifiant)',
    'auth.magma.registerPassword': 'Mot de passe',
    'auth.magma.registerConfirm': 'Confirmer le mot de passe',
    'auth.magma.createBtn': 'Créer un compte',
    'auth.magma.haveAccount': 'Vous avez déjà un compte ?',
    'auth.magma.loginLink': 'Se connecter',
    'auth.ms.desc': 'Connectez-vous avec le compte Microsoft lié à Minecraft — comme dans le launcher officiel.',
    'auth.ms.button': 'Se connecter avec Microsoft',
    'auth.tab.comingSoonBadge': 'Bientôt',
    'auth.ms.comingSoonDesc': 'La connexion Microsoft/Xbox est encore en développement — Microsoft exige une validation d\'application distincte pour accéder à l\'API Minecraft. Cet onglet fonctionnera automatiquement dès que l\'accès sera accordé.',
    'auth.ms.comingSoonButton': 'Bientôt disponible',
    'auth.ms.devOnlyExe': 'La connexion Microsoft ne fonctionne que depuis l\'.exe compilé',
    'auth.magma.notFound': 'Aucun compte trouvé avec cet email ou cet identifiant',
    'auth.magma.wrongPassword': 'Mot de passe incorrect',
    'auth.magma.emailTaken': 'Cet email est déjà enregistré',
    'auth.magma.nickTaken': 'Ce pseudo est déjà pris',
    'auth.magma.passwordMismatch': 'Les mots de passe ne correspondent pas',
    'auth.magma.fillAll': 'Veuillez remplir tous les champs',
    'auth.magma.nickRules': '3 à 16 caractères : lettres latines, chiffres et _',
    'auth.magma.invalidNick': 'Pseudo : 3 à 16 caractères, lettres latines, chiffres et _ uniquement',
    'auth.magma.invalidEmail': 'Saisissez une adresse email valide',
    'auth.magma.weakPassword': 'Le mot de passe doit contenir au moins 6 caractères',
    'auth.magma.genericError': 'Une erreur est survenue. Veuillez réessayer.',
    'auth.google.or': 'ou',
    'auth.google.button': 'Se connecter avec Google',
    'auth.google.registerButton': 'S\'inscrire avec Google',
    'auth.google.registerDesc': 'Votre compte Magma est créé via Google. Cela prend 10 secondes — aucune confirmation par email nécessaire.',
    'auth.google.setPassword': 'Choisissez un mot de passe',
    'auth.google.finishButton': 'Terminer l\'inscription',
    'auth.google.setupDesc': 'Vous êtes connecté en tant que {email}. Il ne reste qu\'à choisir un pseudo.',
    'auth.google.repairDesc': 'Le mot de passe est correct, mais aucun pseudo n\'avait été enregistré pour ce compte. Choisissez-en un maintenant.',
    'auth.google.cancelled': 'Connexion Google annulée',
    'auth.google.failed': 'Impossible de se connecter avec Google. Vérifiez votre connexion internet et réessayez.',
    'auth.google.accountExists': 'Un compte existe déjà avec cet email — saisissez votre mot de passe pour vous connecter.',
    'auth.google.waitingBrowser': 'En attente de confirmation dans le navigateur...',
    'auth.google.checking': 'Vérification du compte...',
    'auth.google.creatingAccount': 'Création du compte...',
    'auth.google.devOnlyExe': 'La connexion Google ne fonctionne que depuis l\'.exe compilé',
    'auth.magma.invalidCredentials': 'Email ou mot de passe incorrect',
    'modpacks.none': 'Vous n\'avez encore créé aucun modpack',
    'mods.tab.browse': 'Parcourir',
    'mods.tab.installed': 'Mes mods',
    'mods.installed.empty': 'Le dossier mods est vide',
    'mods.installed.disable': 'Désactiver',
    'mods.installed.enable': 'Activer',
    'mods.installed.delete': 'Supprimer',
    'mods.installed.disabled': 'Désactivé',
    'mods.installed.confirmDelete': 'Supprimer définitivement ce mod ?',
    'mods.installed.loadError': 'Impossible de lire le dossier mods',
    'mods.filter.sortBy': 'Trier par',
    'mods.filter.sources': 'Sources',
    'mods.filter.sort.relevance': 'Pertinence',
    'mods.filter.sort.downloads': 'Téléchargements',
    'mods.filter.sort.followers': 'Abonnés',
    'mods.filter.sort.datePublished': 'Date de publication',
    'mods.filter.sort.dateUpdated': 'Date de mise à jour',
    'mods.category.mods': 'Mods',
    'mods.category.resourcepacks': 'Packs de ressources',
    'mods.category.shaders': 'Shaders',
    'mods.category.maps': 'Cartes',
  },
  de: {
    'nav.home': 'Start',
    'nav.instances': 'Instanzen',
    'nav.mods': 'Mods',
    'nav.settings': 'Einstellungen',
    'hero.eyebrow': 'Bereit zum Start',
    'hero.title': 'Deine Welt wartet',
    'hero.buildLabel': 'Instanz',
    'hero.play': 'SPIELEN',
    'hero.launching': 'STARTET...',
    'hero.searchVersion': 'Version suchen...','hero.snapshots': 'Snapshots',
    'launch.stage.manifest': 'Version wird geprüft',
    'launch.stage.java': 'Java wird heruntergeladen',
    'launch.stage.client': 'Spiel wird heruntergeladen',
    'launch.stage.libraries': 'Bibliotheken werden heruntergeladen',
    'launch.stage.assets': 'Assets werden heruntergeladen',
    'launch.stage.launch': 'Starten',
    'launch.starting': 'Vorbereitung...',
    'launch.success': 'Spiel gestartet',
    'launch.loaderNotSupported': 'Dieser Loader wird noch nicht unterstützt — kommt bald',
    'launch.pauseTooltip': 'Download pausieren / fortsetzen',
    'launch.cancelTooltip': 'Download abbrechen',
    'launch.cancelled': 'Abgebrochen',
    'launch.paused': 'Pausiert — ⏸ zum Fortsetzen klicken',
    'launch.cancelBtn': 'Abbrechen',
    'launch.detailsBtn': 'Details',
    'launch.errorDetailsTitle': 'Etwas ist schiefgelaufen',
    'launch.devOnlyExe': 'Der Spielstart funktioniert nur aus der kompilierten .exe',
    'loader.comingSoon': 'Demnächst verfügbar',
    'news.title': 'Neuigkeiten',
    'news.tag.update': 'Update',
    'news.item1.title': 'Magma 1.4 ist da',
    'news.item1.desc': 'Neuer Mod-Manager und schnelleres Laden von Instanzen.',
    'news.tag.build': 'Instanz',
    'news.item2.title': 'Tectonic Craft hinzugefügt',
    'news.item2.desc': 'Das technische Modpack der Woche ist jetzt im Katalog.',
    'news.tag.server': 'Server',
    'news.item3.title': 'Geplante Wartung',
    'news.item3.desc': 'Die Profilsynchronisierung ist 2 Stunden lang nicht verfügbar.',
    'instances.title': 'Instanzen',
    'instances.new': '+ Neue Instanz',
    'instances.newCard': 'Neue Instanz',
    'instances.tab.mine': 'Meine Instanzen',
    'instances.tab.catalog': 'Katalog',
    'instances.searchCatalog': 'Modpacks suchen...',
    'instances.none': 'Du hast noch keine Instanz installiert',
    'mods.title': 'Mods',
    'mods.search': 'Mods suchen...',
    'mods.install': 'Installieren',
    'mods.installTarget': 'Mods installieren für:',
    'mods.createModpack': '+ Modpack erstellen',
    'mods.name': 'Modpack-Name',
    'mods.version': 'Minecraft-Version',
    'mods.loader': 'Loader',
    'mods.recommended': 'Empfohlene Mods',
    'mods.addMore': 'Weitere Mods hinzufügen',
    'mods.createBtn': 'Modpack erstellen',
    'mods.creating': 'Erstelle...',
    'mods.addBtn': 'Hinzufügen',
    'mods.added': 'Hinzugefügt',
    'mods.installing': 'Installiere...',
    'mods.searching': 'Suche Mods...',
    'mods.notFound': 'Nichts gefunden',
    'mods.modsCount': 'Mods',
    'mods.devModeHint': 'Modsuche funktioniert nur aus der kompilierten .exe',
    'mods.devOnlyExe': 'Modpack-Erstellung funktioniert nur aus der kompilierten .exe',
    'mods.downloadsLabel': 'Downloads',
    'mods.followersLabel': 'Follower',
    'mods.loadingDetails': 'Beschreibung wird geladen...',
    'mods.nameRequired': 'Wähle einen Modpack-Namen',
    'mods.nameTaken': 'Ein Modpack mit diesem Namen existiert bereits',
    'settings.title': 'Einstellungen',
    'settings.java.label': 'Java-Pfad',
    'settings.java.hint': 'Die java.exe. So lassen, wenn der Launcher die passende Java-Version selbst finden oder herunterladen soll',
    'settings.dir.label': 'Spielordner',
    'settings.dir.hint': 'Wo Instanzen, Mods und Spielstände gespeichert werden',
    'settings.ram.label': 'Zugewiesener RAM',
    'settings.ram.hint': 'Für das Spiel verfügbarer Arbeitsspeicher',
    'settings.lang.label': 'Sprache',
    'settings.lang.hint': 'Sprache der Launcher-Oberfläche',
    'ram.unit': 'GB',
    'version.notFound': 'Nichts gefunden',
    'account.tooltip': 'Konto',
    'auth.tab.guest': 'Gast',
    'auth.tab.magma': 'Magma-Konto',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Nickname',
    'auth.guest.continue': 'Als Gast fortfahren',
    'auth.magma.emailLabel': 'E-Mail oder Nickname',
    'auth.magma.passwordLabel': 'Passwort',
    'auth.magma.signIn': 'Anmelden',
    'auth.magma.signingIn': 'Anmeldung läuft...',
    'auth.magma.noAccount': 'Kein Konto?',
    'auth.magma.createLink': 'Konto erstellen',
    'auth.magma.registerEmail': 'E-Mail',
    'auth.magma.registerNick': 'Nickname (Login)',
    'auth.magma.registerPassword': 'Passwort',
    'auth.magma.registerConfirm': 'Passwort bestätigen',
    'auth.magma.createBtn': 'Konto erstellen',
    'auth.magma.haveAccount': 'Bereits ein Konto?',
    'auth.magma.loginLink': 'Anmelden',
    'auth.ms.desc': 'Melde dich mit dem mit Minecraft verknüpften Microsoft-Konto an — genau wie im offiziellen Launcher.',
    'auth.ms.button': 'Mit Microsoft anmelden',
    'auth.tab.comingSoonBadge': 'Bald',
    'auth.ms.comingSoonDesc': 'Die Microsoft/Xbox-Anmeldung ist noch in Arbeit — Microsoft verlangt eine separate App-Freigabe für den Zugriff auf die Minecraft-API. Dieser Tab funktioniert automatisch, sobald der Zugriff gewährt wird.',
    'auth.ms.comingSoonButton': 'Demnächst verfügbar',
    'auth.ms.devOnlyExe': 'Die Microsoft-Anmeldung funktioniert nur aus der kompilierten .exe',
    'auth.magma.notFound': 'Kein Konto mit dieser E-Mail oder diesem Login gefunden',
    'auth.magma.wrongPassword': 'Falsches Passwort',
    'auth.magma.emailTaken': 'Diese E-Mail ist bereits registriert',
    'auth.magma.nickTaken': 'Dieser Nickname ist bereits vergeben',
    'auth.magma.passwordMismatch': 'Passwörter stimmen nicht überein',
    'auth.magma.fillAll': 'Bitte alle Felder ausfüllen',
    'auth.magma.nickRules': '3–16 Zeichen: lateinische Buchstaben, Zahlen und _',
    'auth.magma.invalidNick': 'Nickname: 3–16 Zeichen, nur lateinische Buchstaben, Zahlen und _',
    'auth.magma.invalidEmail': 'Gib eine gültige E-Mail-Adresse ein',
    'auth.magma.weakPassword': 'Das Passwort muss mindestens 6 Zeichen lang sein',
    'auth.magma.genericError': 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    'auth.google.or': 'oder',
    'auth.google.button': 'Mit Google anmelden',
    'auth.google.registerButton': 'Mit Google registrieren',
    'auth.google.registerDesc': 'Dein Magma-Konto wird über Google erstellt. Dauert 10 Sekunden — keine E-Mail-Bestätigung nötig.',
    'auth.google.setPassword': 'Passwort festlegen',
    'auth.google.finishButton': 'Einrichtung abschließen',
    'auth.google.setupDesc': 'Du bist als {email} angemeldet. Wähle nur noch einen Nickname.',
    'auth.google.repairDesc': 'Das Passwort ist richtig, aber es wurde bisher kein Nickname für dieses Konto gespeichert. Wähle jetzt einfach einen.',
    'auth.google.cancelled': 'Google-Anmeldung abgebrochen',
    'auth.google.failed': 'Anmeldung mit Google fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.',
    'auth.google.accountExists': 'Ein Konto mit dieser E-Mail existiert bereits — gib dein Passwort ein, um dich anzumelden.',
    'auth.google.waitingBrowser': 'Warte auf Bestätigung im Browser...',
    'auth.google.checking': 'Konto wird geprüft...',
    'auth.google.creatingAccount': 'Konto wird erstellt...',
    'auth.google.devOnlyExe': 'Die Google-Anmeldung funktioniert nur aus der kompilierten .exe',
    'auth.magma.invalidCredentials': 'Falsche E-Mail oder falsches Passwort',
    'modpacks.none': 'Du hast noch keine Modpacks erstellt',
    'mods.tab.browse': 'Durchsuchen',
    'mods.tab.installed': 'Meine Mods',
    'mods.installed.empty': 'Der mods-Ordner ist leer',
    'mods.installed.disable': 'Deaktivieren',
    'mods.installed.enable': 'Aktivieren',
    'mods.installed.delete': 'Löschen',
    'mods.installed.disabled': 'Deaktiviert',
    'mods.installed.confirmDelete': 'Diesen Mod endgültig löschen?',
    'mods.installed.loadError': 'Der mods-Ordner konnte nicht gelesen werden',
    'mods.filter.sortBy': 'Sortieren nach',
    'mods.filter.sources': 'Quellen',
    'mods.filter.sort.relevance': 'Relevanz',
    'mods.filter.sort.downloads': 'Downloads',
    'mods.filter.sort.followers': 'Follower',
    'mods.filter.sort.datePublished': 'Veröffentlichungsdatum',
    'mods.filter.sort.dateUpdated': 'Aktualisierungsdatum',
    'mods.category.mods': 'Mods',
    'mods.category.resourcepacks': 'Texturenpakete',
    'mods.category.shaders': 'Shader',
    'mods.category.maps': 'Karten',
  },
  es: {
    'nav.home': 'Inicio',
    'nav.instances': 'Instancias',
    'nav.mods': 'Mods',
    'nav.settings': 'Ajustes',
    'hero.eyebrow': 'Listo para jugar',
    'hero.title': 'Tu mundo te espera',
    'hero.buildLabel': 'Instancia',
    'hero.play': 'JUGAR',
    'hero.launching': 'INICIANDO...',
    'hero.searchVersion': 'Buscar versión...','hero.snapshots': 'Snapshots',
    'launch.stage.manifest': 'Comprobando versión',
    'launch.stage.java': 'Descargando Java',
    'launch.stage.client': 'Descargando el juego',
    'launch.stage.libraries': 'Descargando bibliotecas',
    'launch.stage.assets': 'Descargando recursos',
    'launch.stage.launch': 'Iniciando',
    'launch.starting': 'Preparando...',
    'launch.success': 'Juego iniciado',
    'launch.loaderNotSupported': 'Este loader aún no es compatible — próximamente',
    'launch.pauseTooltip': 'Pausar / reanudar descarga',
    'launch.cancelTooltip': 'Cancelar descarga',
    'launch.cancelled': 'Cancelado',
    'launch.paused': 'En pausa — haz clic en ⏸ para continuar',
    'launch.cancelBtn': 'Cancelar',
    'launch.detailsBtn': 'Detalles',
    'launch.errorDetailsTitle': 'Algo salió mal',
    'launch.devOnlyExe': 'Iniciar el juego solo funciona desde el .exe compilado',
    'loader.comingSoon': 'Próximamente',
    'news.title': 'Noticias',
    'news.tag.update': 'Actualización',
    'news.item1.title': 'Ya está disponible Magma 1.4',
    'news.item1.desc': 'Nuevo gestor de mods y carga de instancias más rápida.',
    'news.tag.build': 'Instancia',
    'news.item2.title': 'Se añadió Tectonic Craft',
    'news.item2.desc': 'El modpack técnico de la semana ya está en el catálogo.',
    'news.tag.server': 'Servidor',
    'news.item3.title': 'Mantenimiento programado',
    'news.item3.desc': 'La sincronización de perfiles no estará disponible durante 2 horas.',
    'instances.title': 'Instancias',
    'instances.new': '+ Nueva instancia',
    'instances.newCard': 'Nueva instancia',
    'instances.tab.mine': 'Mis instancias',
    'instances.tab.catalog': 'Catálogo',
    'instances.searchCatalog': 'Buscar modpacks...',
    'instances.none': 'Todavía no has instalado ninguna instancia',
    'mods.title': 'Mods',
    'mods.search': 'Buscar mods...',
    'mods.install': 'Instalar',
    'mods.installTarget': 'Instalando mods para:',
    'mods.createModpack': '+ Crear modpack',
    'mods.name': 'Nombre del modpack',
    'mods.version': 'Versión de Minecraft',
    'mods.loader': 'Loader',
    'mods.recommended': 'Mods recomendados',
    'mods.addMore': 'Añadir más mods',
    'mods.createBtn': 'Crear modpack',
    'mods.creating': 'Creando...',
    'mods.addBtn': 'Añadir',
    'mods.added': 'Añadido',
    'mods.installing': 'Instalando...',
    'mods.searching': 'Buscando mods...',
    'mods.notFound': 'No se encontró nada',
    'mods.modsCount': 'mods',
    'mods.devModeHint': 'La búsqueda de mods solo funciona desde el .exe compilado',
    'mods.devOnlyExe': 'La creación de modpacks solo funciona desde el .exe compilado',
    'mods.downloadsLabel': 'descargas',
    'mods.followersLabel': 'seguidores',
    'mods.loadingDetails': 'Cargando descripción...',
    'mods.nameRequired': 'Elige un nombre para el modpack',
    'mods.nameTaken': 'Ya existe un modpack con este nombre',
    'settings.title': 'Ajustes',
    'settings.java.label': 'Ruta de Java',
    'settings.java.hint': 'El ejecutable java.exe. Déjalo así si quieres que el launcher detecte o descargue la versión de Java correcta',
    'settings.dir.label': 'Carpeta del juego',
    'settings.dir.hint': 'Dónde se guardan instancias, mods y partidas',
    'settings.ram.label': 'RAM asignada',
    'settings.ram.hint': 'Cantidad de memoria disponible para el juego',
    'settings.lang.label': 'Idioma',
    'settings.lang.hint': 'Idioma de la interfaz del launcher',
    'ram.unit': 'GB',
    'version.notFound': 'No se encontró nada',
    'account.tooltip': 'Cuenta',
    'auth.tab.guest': 'Invitado',
    'auth.tab.magma': 'Cuenta Magma',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Apodo',
    'auth.guest.continue': 'Continuar como invitado',
    'auth.magma.emailLabel': 'Correo o apodo',
    'auth.magma.passwordLabel': 'Contraseña',
    'auth.magma.signIn': 'Iniciar sesión',
    'auth.magma.signingIn': 'Iniciando sesión...',
    'auth.magma.noAccount': '¿No tienes cuenta?',
    'auth.magma.createLink': 'Crear una',
    'auth.magma.registerEmail': 'Correo',
    'auth.magma.registerNick': 'Apodo (usuario)',
    'auth.magma.registerPassword': 'Contraseña',
    'auth.magma.registerConfirm': 'Confirmar contraseña',
    'auth.magma.createBtn': 'Crear cuenta',
    'auth.magma.haveAccount': '¿Ya tienes cuenta?',
    'auth.magma.loginLink': 'Iniciar sesión',
    'auth.ms.desc': 'Inicia sesión con la cuenta de Microsoft vinculada a Minecraft — igual que en el launcher oficial.',
    'auth.ms.button': 'Iniciar sesión con Microsoft',
    'auth.tab.comingSoonBadge': 'Pronto',
    'auth.ms.comingSoonDesc': 'El inicio de sesión con Microsoft/Xbox aún está en desarrollo — Microsoft exige una aprobación de app independiente para acceder a la API de Minecraft. Esta pestaña funcionará automáticamente en cuanto se conceda el acceso.',
    'auth.ms.comingSoonButton': 'Próximamente',
    'auth.ms.devOnlyExe': 'El inicio de sesión con Microsoft solo funciona desde el .exe compilado',
    'auth.magma.notFound': 'No se encontró ninguna cuenta con ese correo o usuario',
    'auth.magma.wrongPassword': 'Contraseña incorrecta',
    'auth.magma.emailTaken': 'Este correo ya está registrado',
    'auth.magma.nickTaken': 'Este apodo ya está en uso',
    'auth.magma.passwordMismatch': 'Las contraseñas no coinciden',
    'auth.magma.fillAll': 'Completa todos los campos',
    'auth.magma.nickRules': '3–16 caracteres: letras latinas, números y _',
    'auth.magma.invalidNick': 'Apodo: 3–16 caracteres, solo letras latinas, números y _',
    'auth.magma.invalidEmail': 'Introduce un correo electrónico válido',
    'auth.magma.weakPassword': 'La contraseña debe tener al menos 6 caracteres',
    'auth.magma.genericError': 'Algo salió mal. Inténtalo de nuevo.',
    'auth.google.or': 'o',
    'auth.google.button': 'Iniciar sesión con Google',
    'auth.google.registerButton': 'Registrarse con Google',
    'auth.google.registerDesc': 'Tu cuenta Magma se crea a través de Google. Tarda 10 segundos — no necesitas confirmar el correo.',
    'auth.google.setPassword': 'Elige una contraseña',
    'auth.google.finishButton': 'Finalizar registro',
    'auth.google.setupDesc': 'Has iniciado sesión como {email}. Solo falta elegir un apodo.',
    'auth.google.repairDesc': 'La contraseña es correcta, pero la última vez no se guardó ningún apodo para esta cuenta. Elige uno ahora.',
    'auth.google.cancelled': 'Se canceló el inicio de sesión con Google',
    'auth.google.failed': 'No se pudo iniciar sesión con Google. Comprueba tu conexión a internet e inténtalo de nuevo.',
    'auth.google.accountExists': 'Ya existe una cuenta con este correo — introduce tu contraseña para iniciar sesión.',
    'auth.google.waitingBrowser': 'Esperando confirmación en el navegador...',
    'auth.google.checking': 'Comprobando cuenta...',
    'auth.google.creatingAccount': 'Creando cuenta...',
    'auth.google.devOnlyExe': 'El inicio de sesión con Google solo funciona desde el .exe compilado',
    'auth.magma.invalidCredentials': 'Correo o contraseña incorrectos',
    'modpacks.none': 'Todavía no has creado ningún modpack',
    'mods.tab.browse': 'Explorar',
    'mods.tab.installed': 'Mis mods',
    'mods.installed.empty': 'La carpeta mods está vacía',
    'mods.installed.disable': 'Desactivar',
    'mods.installed.enable': 'Activar',
    'mods.installed.delete': 'Eliminar',
    'mods.installed.disabled': 'Desactivado',
    'mods.installed.confirmDelete': '¿Eliminar este mod definitivamente?',
    'mods.installed.loadError': 'No se pudo leer la carpeta mods',
    'mods.filter.sortBy': 'Ordenar por',
    'mods.filter.sources': 'Fuentes',
    'mods.filter.sort.relevance': 'Relevancia',
    'mods.filter.sort.downloads': 'Descargas',
    'mods.filter.sort.followers': 'Seguidores',
    'mods.filter.sort.datePublished': 'Fecha de publicación',
    'mods.filter.sort.dateUpdated': 'Fecha de actualización',
    'mods.category.mods': 'Mods',
    'mods.category.resourcepacks': 'Paquetes de recursos',
    'mods.category.shaders': 'Shaders',
    'mods.category.maps': 'Mapas',
  },
  it: {
    'nav.home': 'Home',
    'nav.instances': 'Istanze',
    'nav.mods': 'Mod',
    'nav.settings': 'Impostazioni',
    'hero.eyebrow': 'Pronto per giocare',
    'hero.title': 'Il tuo mondo ti aspetta',
    'hero.buildLabel': 'Istanza',
    'hero.play': 'GIOCA',
    'hero.launching': 'AVVIO...',
    'hero.searchVersion': 'Cerca versione...','hero.snapshots': 'Snapshot',
    'launch.stage.manifest': 'Verifica versione',
    'launch.stage.java': 'Download di Java',
    'launch.stage.client': 'Download del gioco',
    'launch.stage.libraries': 'Download delle librerie',
    'launch.stage.assets': 'Download delle risorse',
    'launch.stage.launch': 'Avvio',
    'launch.starting': 'Preparazione...',
    'launch.success': 'Gioco avviato',
    'launch.loaderNotSupported': 'Questo loader non è ancora supportato — presto disponibile',
    'launch.pauseTooltip': 'Pausa / riprendi download',
    'launch.cancelTooltip': 'Annulla download',
    'launch.cancelled': 'Annullato',
    'launch.paused': 'In pausa — clicca ⏸ per riprendere',
    'launch.cancelBtn': 'Annulla',
    'launch.detailsBtn': 'Dettagli',
    'launch.errorDetailsTitle': 'Qualcosa è andato storto',
    'launch.devOnlyExe': 'L\'avvio del gioco funziona solo dall\'.exe compilato',
    'loader.comingSoon': 'Presto disponibile',
    'news.title': 'Novità',
    'news.tag.update': 'Aggiornamento',
    'news.item1.title': 'Magma 1.4 è uscita',
    'news.item1.desc': 'Nuovo gestore mod e caricamento istanze più veloce.',
    'news.tag.build': 'Istanza',
    'news.item2.title': 'Aggiunta Tectonic Craft',
    'news.item2.desc': 'Il modpack tecnico della settimana è ora nel catalogo.',
    'news.tag.server': 'Server',
    'news.item3.title': 'Manutenzione programmata',
    'news.item3.desc': 'La sincronizzazione dei profili non sarà disponibile per 2 ore.',
    'instances.title': 'Istanze',
    'instances.new': '+ Nuova istanza',
    'instances.newCard': 'Nuova istanza',
    'instances.tab.mine': 'Le mie istanze',
    'instances.tab.catalog': 'Catalogo',
    'instances.searchCatalog': 'Cerca modpack...',
    'instances.none': 'Non hai ancora installato nessuna istanza',
    'mods.title': 'Mod',
    'mods.search': 'Cerca mod...',
    'mods.install': 'Installa',
    'mods.installTarget': 'Installazione mod per:',
    'mods.createModpack': '+ Crea modpack',
    'mods.name': 'Nome del modpack',
    'mods.version': 'Versione di Minecraft',
    'mods.loader': 'Loader',
    'mods.recommended': 'Mod consigliate',
    'mods.addMore': 'Aggiungi altre mod',
    'mods.createBtn': 'Crea modpack',
    'mods.creating': 'Creazione...',
    'mods.addBtn': 'Aggiungi',
    'mods.added': 'Aggiunta',
    'mods.installing': 'Installazione...',
    'mods.searching': 'Ricerca mod...',
    'mods.notFound': 'Nessun risultato',
    'mods.modsCount': 'mod',
    'mods.devModeHint': 'La ricerca mod funziona solo dall\'.exe compilato',
    'mods.devOnlyExe': 'La creazione di modpack funziona solo dall\'.exe compilato',
    'mods.downloadsLabel': 'download',
    'mods.followersLabel': 'follower',
    'mods.loadingDetails': 'Caricamento descrizione...',
    'mods.nameRequired': 'Scegli un nome per il modpack',
    'mods.nameTaken': 'Esiste già un modpack con questo nome',
    'settings.title': 'Impostazioni',
    'settings.java.label': 'Percorso Java',
    'settings.java.hint': 'L\'eseguibile java.exe. Lascia così se vuoi che il launcher rilevi o scarichi automaticamente la versione giusta di Java',
    'settings.dir.label': 'Cartella di gioco',
    'settings.dir.hint': 'Dove sono salvate istanze, mod e salvataggi',
    'settings.ram.label': 'RAM allocata',
    'settings.ram.hint': 'Quantità di memoria disponibile per il gioco',
    'settings.lang.label': 'Lingua',
    'settings.lang.hint': 'Lingua dell\'interfaccia del launcher',
    'ram.unit': 'GB',
    'version.notFound': 'Nessun risultato',
    'account.tooltip': 'Account',
    'auth.tab.guest': 'Ospite',
    'auth.tab.magma': 'Account Magma',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Nickname',
    'auth.guest.continue': 'Continua come ospite',
    'auth.magma.emailLabel': 'Email o nickname',
    'auth.magma.passwordLabel': 'Password',
    'auth.magma.signIn': 'Accedi',
    'auth.magma.signingIn': 'Accesso in corso...',
    'auth.magma.noAccount': 'Non hai un account?',
    'auth.magma.createLink': 'Creane uno',
    'auth.magma.registerEmail': 'Email',
    'auth.magma.registerNick': 'Nickname (login)',
    'auth.magma.registerPassword': 'Password',
    'auth.magma.registerConfirm': 'Conferma password',
    'auth.magma.createBtn': 'Crea account',
    'auth.magma.haveAccount': 'Hai già un account?',
    'auth.magma.loginLink': 'Accedi',
    'auth.ms.desc': 'Accedi con l\'account Microsoft collegato a Minecraft — proprio come nel launcher ufficiale.',
    'auth.ms.button': 'Accedi con Microsoft',
    'auth.tab.comingSoonBadge': 'Presto',
    'auth.ms.comingSoonDesc': 'L\'accesso Microsoft/Xbox è ancora in sviluppo — Microsoft richiede un\'approvazione separata dell\'app per accedere alle API di Minecraft. Questa scheda funzionerà automaticamente non appena l\'accesso sarà concesso.',
    'auth.ms.comingSoonButton': 'Presto disponibile',
    'auth.ms.devOnlyExe': 'L\'accesso con Microsoft funziona solo dall\'.exe compilato',
    'auth.magma.notFound': 'Nessun account trovato con questa email o login',
    'auth.magma.wrongPassword': 'Password errata',
    'auth.magma.emailTaken': 'Questa email è già registrata',
    'auth.magma.nickTaken': 'Questo nickname è già in uso',
    'auth.magma.passwordMismatch': 'Le password non coincidono',
    'auth.magma.fillAll': 'Compila tutti i campi',
    'auth.magma.nickRules': '3–16 caratteri: lettere latine, numeri e _',
    'auth.magma.invalidNick': 'Nickname: 3–16 caratteri, solo lettere latine, numeri e _',
    'auth.magma.invalidEmail': 'Inserisci un indirizzo email valido',
    'auth.magma.weakPassword': 'La password deve contenere almeno 6 caratteri',
    'auth.magma.genericError': 'Qualcosa è andato storto. Riprova.',
    'auth.google.or': 'o',
    'auth.google.button': 'Accedi con Google',
    'auth.google.registerButton': 'Registrati con Google',
    'auth.google.registerDesc': 'Il tuo account Magma viene creato tramite Google. Richiede 10 secondi — nessuna conferma email necessaria.',
    'auth.google.setPassword': 'Imposta una password',
    'auth.google.finishButton': 'Completa la registrazione',
    'auth.google.setupDesc': 'Hai effettuato l\'accesso come {email}. Non resta che scegliere un nickname.',
    'auth.google.repairDesc': 'La password è corretta, ma l\'ultima volta non è stato salvato alcun nickname per questo account. Sceglilo ora.',
    'auth.google.cancelled': 'Accesso con Google annullato',
    'auth.google.failed': 'Impossibile accedere con Google. Controlla la connessione a internet e riprova.',
    'auth.google.accountExists': 'Esiste già un account con questa email — inserisci la password per accedere.',
    'auth.google.waitingBrowser': 'In attesa di conferma nel browser...',
    'auth.google.checking': 'Verifica account...',
    'auth.google.creatingAccount': 'Creazione account...',
    'auth.google.devOnlyExe': 'L\'accesso con Google funziona solo dall\'.exe compilato',
    'auth.magma.invalidCredentials': 'Email o password errati',
    'modpacks.none': 'Non hai ancora creato nessun modpack',
    'mods.tab.browse': 'Catalogo',
    'mods.tab.installed': 'Le mie mod',
    'mods.installed.empty': 'La cartella mods è vuota',
    'mods.installed.disable': 'Disattiva',
    'mods.installed.enable': 'Attiva',
    'mods.installed.delete': 'Elimina',
    'mods.installed.disabled': 'Disattivata',
    'mods.installed.confirmDelete': 'Eliminare questa mod definitivamente?',
    'mods.installed.loadError': 'Impossibile leggere la cartella mods',
    'mods.filter.sortBy': 'Ordina per',
    'mods.filter.sources': 'Fonti',
    'mods.filter.sort.relevance': 'Rilevanza',
    'mods.filter.sort.downloads': 'Download',
    'mods.filter.sort.followers': 'Follower',
    'mods.filter.sort.datePublished': 'Data di pubblicazione',
    'mods.filter.sort.dateUpdated': 'Data di aggiornamento',
    'mods.category.mods': 'Mod',
    'mods.category.resourcepacks': 'Resource Pack',
    'mods.category.shaders': 'Shader',
    'mods.category.maps': 'Mappe',
  },
  pt: {
    'nav.home': 'Início',
    'nav.instances': 'Instâncias',
    'nav.mods': 'Mods',
    'nav.settings': 'Configurações',
    'hero.eyebrow': 'Pronto para jogar',
    'hero.title': 'Seu mundo espera',
    'hero.buildLabel': 'Instância',
    'hero.play': 'JOGAR',
    'hero.launching': 'INICIANDO...',
    'hero.searchVersion': 'Buscar versão...','hero.snapshots': 'Snapshots',
    'launch.stage.manifest': 'Verificando versão',
    'launch.stage.java': 'Baixando Java',
    'launch.stage.client': 'Baixando o jogo',
    'launch.stage.libraries': 'Baixando bibliotecas',
    'launch.stage.assets': 'Baixando recursos',
    'launch.stage.launch': 'Iniciando',
    'launch.starting': 'Preparando...',
    'launch.success': 'Jogo iniciado',
    'launch.loaderNotSupported': 'Esse loader ainda não é suportado — em breve',
    'launch.pauseTooltip': 'Pausar / retomar download',
    'launch.cancelTooltip': 'Cancelar download',
    'launch.cancelled': 'Cancelado',
    'launch.paused': 'Pausado — clique em ⏸ para continuar',
    'launch.cancelBtn': 'Cancelar',
    'launch.detailsBtn': 'Detalhes',
    'launch.errorDetailsTitle': 'Algo deu errado',
    'launch.devOnlyExe': 'Iniciar o jogo só funciona a partir do .exe compilado',
    'loader.comingSoon': 'Em breve',
    'news.title': 'Notícias',
    'news.tag.update': 'Atualização',
    'news.item1.title': 'Magma 1.4 foi lançada',
    'news.item1.desc': 'Novo gerenciador de mods e carregamento de instâncias mais rápido.',
    'news.tag.build': 'Instância',
    'news.item2.title': 'Tectonic Craft adicionado',
    'news.item2.desc': 'O modpack técnico da semana já está no catálogo.',
    'news.tag.server': 'Servidor',
    'news.item3.title': 'Manutenção programada',
    'news.item3.desc': 'A sincronização de perfis ficará indisponível por 2 horas.',
    'instances.title': 'Instâncias',
    'instances.new': '+ Nova instância',
    'instances.newCard': 'Nova instância',
    'instances.tab.mine': 'Minhas instâncias',
    'instances.tab.catalog': 'Catálogo',
    'instances.searchCatalog': 'Buscar modpacks...',
    'instances.none': 'Você ainda não instalou nenhuma instância',
    'mods.title': 'Mods',
    'mods.search': 'Buscar mods...',
    'mods.install': 'Instalar',
    'mods.installTarget': 'Instalando mods para:',
    'mods.createModpack': '+ Criar modpack',
    'mods.name': 'Nome do modpack',
    'mods.version': 'Versão do Minecraft',
    'mods.loader': 'Loader',
    'mods.recommended': 'Mods recomendados',
    'mods.addMore': 'Adicionar mais mods',
    'mods.createBtn': 'Criar modpack',
    'mods.creating': 'Criando...',
    'mods.addBtn': 'Adicionar',
    'mods.added': 'Adicionado',
    'mods.installing': 'Instalando...',
    'mods.searching': 'Buscando mods...',
    'mods.notFound': 'Nada encontrado',
    'mods.modsCount': 'mods',
    'mods.devModeHint': 'A busca de mods só funciona a partir do .exe compilado',
    'mods.devOnlyExe': 'A criação de modpack só funciona a partir do .exe compilado',
    'mods.downloadsLabel': 'downloads',
    'mods.followersLabel': 'seguidores',
    'mods.loadingDetails': 'Carregando descrição...',
    'mods.nameRequired': 'Escolha um nome para o modpack',
    'mods.nameTaken': 'Já existe um modpack com esse nome',
    'settings.title': 'Configurações',
    'settings.java.label': 'Caminho do Java',
    'settings.java.hint': 'O executável java.exe. Deixe como está se quiser que o launcher detecte ou baixe a versão certa do Java automaticamente',
    'settings.dir.label': 'Pasta do jogo',
    'settings.dir.hint': 'Onde instâncias, mods e saves são armazenados',
    'settings.ram.label': 'RAM alocada',
    'settings.ram.hint': 'Quantidade de memória disponível para o jogo',
    'settings.lang.label': 'Idioma',
    'settings.lang.hint': 'Idioma da interface do launcher',
    'ram.unit': 'GB',
    'version.notFound': 'Nada encontrado',
    'account.tooltip': 'Conta',
    'auth.tab.guest': 'Convidado',
    'auth.tab.magma': 'Conta Magma',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Nickname',
    'auth.guest.continue': 'Continuar como convidado',
    'auth.magma.emailLabel': 'Email ou nickname',
    'auth.magma.passwordLabel': 'Senha',
    'auth.magma.signIn': 'Entrar',
    'auth.magma.signingIn': 'Entrando...',
    'auth.magma.noAccount': 'Não tem uma conta?',
    'auth.magma.createLink': 'Criar uma',
    'auth.magma.registerEmail': 'Email',
    'auth.magma.registerNick': 'Nickname (login)',
    'auth.magma.registerPassword': 'Senha',
    'auth.magma.registerConfirm': 'Confirmar senha',
    'auth.magma.createBtn': 'Criar conta',
    'auth.magma.haveAccount': 'Já tem uma conta?',
    'auth.magma.loginLink': 'Entrar',
    'auth.ms.desc': 'Entre com a conta Microsoft vinculada ao Minecraft — assim como no launcher oficial.',
    'auth.ms.button': 'Entrar com Microsoft',
    'auth.tab.comingSoonBadge': 'Em breve',
    'auth.ms.comingSoonDesc': 'O login com Microsoft/Xbox ainda está em desenvolvimento — a Microsoft exige aprovação separada do aplicativo para acessar a API do Minecraft. Essa aba funcionará automaticamente assim que o acesso for concedido.',
    'auth.ms.comingSoonButton': 'Em breve',
    'auth.ms.devOnlyExe': 'O login com Microsoft só funciona a partir do .exe compilado',
    'auth.magma.notFound': 'Nenhuma conta encontrada com esse email ou login',
    'auth.magma.wrongPassword': 'Senha incorreta',
    'auth.magma.emailTaken': 'Este email já está cadastrado',
    'auth.magma.nickTaken': 'Este nickname já está em uso',
    'auth.magma.passwordMismatch': 'As senhas não coincidem',
    'auth.magma.fillAll': 'Preencha todos os campos',
    'auth.magma.nickRules': '3–16 caracteres: letras latinas, números e _',
    'auth.magma.invalidNick': 'Nickname: 3–16 caracteres, apenas letras latinas, números e _',
    'auth.magma.invalidEmail': 'Digite um endereço de email válido',
    'auth.magma.weakPassword': 'A senha deve ter pelo menos 6 caracteres',
    'auth.magma.genericError': 'Algo deu errado. Tente novamente.',
    'auth.google.or': 'ou',
    'auth.google.button': 'Entrar com Google',
    'auth.google.registerButton': 'Cadastrar com Google',
    'auth.google.registerDesc': 'Sua conta Magma é criada pelo Google. Leva 10 segundos — não é preciso confirmar o email.',
    'auth.google.setPassword': 'Defina uma senha',
    'auth.google.finishButton': 'Concluir cadastro',
    'auth.google.setupDesc': 'Você está conectado como {email}. Falta só escolher um nickname.',
    'auth.google.repairDesc': 'A senha está correta, mas nenhum nickname foi salvo para esta conta da última vez. Escolha um agora.',
    'auth.google.cancelled': 'Login com Google cancelado',
    'auth.google.failed': 'Não foi possível entrar com o Google. Verifique sua conexão com a internet e tente novamente.',
    'auth.google.accountExists': 'Já existe uma conta com esse email — digite sua senha para entrar.',
    'auth.google.waitingBrowser': 'Aguardando confirmação no navegador...',
    'auth.google.checking': 'Verificando conta...',
    'auth.google.creatingAccount': 'Criando conta...',
    'auth.google.devOnlyExe': 'O login com Google só funciona a partir do .exe compilado',
    'auth.magma.invalidCredentials': 'Email ou senha incorretos',
    'modpacks.none': 'Você ainda não criou nenhum modpack',
    'mods.tab.browse': 'Catálogo',
    'mods.tab.installed': 'Meus mods',
    'mods.installed.empty': 'A pasta mods está vazia',
    'mods.installed.disable': 'Desativar',
    'mods.installed.enable': 'Ativar',
    'mods.installed.delete': 'Excluir',
    'mods.installed.disabled': 'Desativado',
    'mods.installed.confirmDelete': 'Excluir este mod definitivamente?',
    'mods.installed.loadError': 'Não foi possível ler a pasta mods',
    'mods.filter.sortBy': 'Ordenar por',
    'mods.filter.sources': 'Fontes',
    'mods.filter.sort.relevance': 'Relevância',
    'mods.filter.sort.downloads': 'Downloads',
    'mods.filter.sort.followers': 'Seguidores',
    'mods.filter.sort.datePublished': 'Data de publicação',
    'mods.filter.sort.dateUpdated': 'Data de atualização',
    'mods.category.mods': 'Mods',
    'mods.category.resourcepacks': 'Pacotes de Recursos',
    'mods.category.shaders': 'Shaders',
    'mods.category.maps': 'Mapas',
  },
  ja: {
    'nav.home': 'ホーム',
    'nav.instances': 'インスタンス',
    'nav.mods': 'MOD',
    'nav.settings': '設定',
    'hero.eyebrow': '起動準備完了',
    'hero.title': 'あなたの世界が待っています',
    'hero.buildLabel': 'インスタンス',
    'hero.play': 'プレイ',
    'hero.launching': '起動中...',
    'hero.searchVersion': 'バージョンを検索...','hero.snapshots': 'スナップショット',
    'launch.stage.manifest': 'バージョン確認中',
    'launch.stage.java': 'Javaをダウンロード中',
    'launch.stage.client': 'ゲームをダウンロード中',
    'launch.stage.libraries': 'ライブラリをダウンロード中',
    'launch.stage.assets': 'アセットをダウンロード中',
    'launch.stage.launch': '起動中',
    'launch.starting': '準備中...',
    'launch.success': 'ゲームが起動しました',
    'launch.loaderNotSupported': 'このローダーはまだ対応していません — 近日対応予定',
    'launch.pauseTooltip': 'ダウンロードを一時停止／再開',
    'launch.cancelTooltip': 'ダウンロードをキャンセル',
    'launch.cancelled': 'キャンセルしました',
    'launch.paused': '一時停止中 — ⏸をクリックで再開',
    'launch.cancelBtn': 'キャンセル',
    'launch.detailsBtn': '詳細',
    'launch.errorDetailsTitle': '問題が発生しました',
    'launch.devOnlyExe': 'ゲームの起動はビルド済みの.exeからのみ動作します',
    'loader.comingSoon': '近日公開',
    'news.title': 'お知らせ',
    'news.tag.update': 'アップデート',
    'news.item1.title': 'Magma 1.4 公開',
    'news.item1.desc': '新しいMOD管理機能とインスタンス読み込みの高速化。',
    'news.tag.build': 'インスタンス',
    'news.item2.title': 'Tectonic Craft を追加',
    'news.item2.desc': '今週のテクニカルモッドパックがカタログに追加されました。',
    'news.tag.server': 'サーバー',
    'news.item3.title': 'メンテナンス予定',
    'news.item3.desc': 'プロファイル同期は2時間利用できません。',
    'instances.title': 'インスタンス',
    'instances.new': '+ 新しいインスタンス',
    'instances.newCard': '新しいインスタンス',
    'instances.tab.mine': 'マイインスタンス',
    'instances.tab.catalog': 'カタログ',
    'instances.searchCatalog': 'モッドパックを検索...',
    'instances.none': 'まだインスタンスがインストールされていません',
    'mods.title': 'MOD',
    'mods.search': 'MODを検索...',
    'mods.install': 'インストール',
    'mods.installTarget': 'MODのインストール対象：',
    'mods.createModpack': '+ モッドパックを作成',
    'mods.name': 'モッドパック名',
    'mods.version': 'Minecraftのバージョン',
    'mods.loader': 'ローダー',
    'mods.recommended': 'おすすめMOD',
    'mods.addMore': 'MODを追加',
    'mods.createBtn': 'モッドパックを作成',
    'mods.creating': '作成中...',
    'mods.addBtn': '追加',
    'mods.added': '追加済み',
    'mods.installing': 'インストール中...',
    'mods.searching': 'MODを検索中...',
    'mods.notFound': '見つかりませんでした',
    'mods.modsCount': 'MOD',
    'mods.devModeHint': 'MOD検索はビルド済みの.exeからのみ動作します',
    'mods.devOnlyExe': 'モッドパック作成はビルド済みの.exeからのみ動作します',
    'mods.downloadsLabel': 'ダウンロード数',
    'mods.followersLabel': 'フォロワー',
    'mods.loadingDetails': '説明を読み込み中...',
    'mods.nameRequired': 'モッドパック名を入力してください',
    'mods.nameTaken': 'この名前のモッドパックは既に存在します',
    'settings.title': '設定',
    'settings.java.label': 'Javaのパス',
    'settings.java.hint': 'java.exeの実行ファイル。ランチャーに適切なJavaのバージョンを自動検出・ダウンロードさせたい場合はそのままにしてください',
    'settings.dir.label': 'ゲームフォルダ',
    'settings.dir.hint': 'インスタンス、MOD、セーブデータの保存先',
    'settings.ram.label': '割り当てメモリ',
    'settings.ram.hint': 'ゲームが使用できるメモリ量',
    'settings.lang.label': '言語',
    'settings.lang.hint': 'ランチャーの表示言語',
    'ram.unit': 'GB',
    'version.notFound': '見つかりませんでした',
    'account.tooltip': 'アカウント',
    'auth.tab.guest': 'ゲスト',
    'auth.tab.magma': 'Magmaアカウント',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'ニックネーム',
    'auth.guest.continue': 'ゲストとして続ける',
    'auth.magma.emailLabel': 'メールまたはニックネーム',
    'auth.magma.passwordLabel': 'パスワード',
    'auth.magma.signIn': 'ログイン',
    'auth.magma.signingIn': 'ログイン中...',
    'auth.magma.noAccount': 'アカウントをお持ちでない方',
    'auth.magma.createLink': '作成する',
    'auth.magma.registerEmail': 'メールアドレス',
    'auth.magma.registerNick': 'ニックネーム（ログインID）',
    'auth.magma.registerPassword': 'パスワード',
    'auth.magma.registerConfirm': 'パスワード（確認）',
    'auth.magma.createBtn': 'アカウントを作成',
    'auth.magma.haveAccount': '既にアカウントをお持ちですか？',
    'auth.magma.loginLink': 'ログイン',
    'auth.ms.desc': '公式ランチャーと同様に、Minecraftに連携したMicrosoftアカウントでログインします。',
    'auth.ms.button': 'Microsoftでログイン',
    'auth.tab.comingSoonBadge': '近日公開',
    'auth.ms.comingSoonDesc': 'Microsoft/Xboxログインは開発中です。Minecraft APIへのアクセスにはMicrosoftによる別途のアプリ承認が必要です。アクセスが許可され次第、このタブは自動的に有効になります。',
    'auth.ms.comingSoonButton': '近日公開',
    'auth.ms.devOnlyExe': 'Microsoftログインはビルド済みの.exeからのみ動作します',
    'auth.magma.notFound': 'このメールまたはログインIDのアカウントは見つかりません',
    'auth.magma.wrongPassword': 'パスワードが正しくありません',
    'auth.magma.emailTaken': 'このメールアドレスは既に登録されています',
    'auth.magma.nickTaken': 'このニックネームは既に使用されています',
    'auth.magma.passwordMismatch': 'パスワードが一致しません',
    'auth.magma.fillAll': 'すべての項目を入力してください',
    'auth.magma.nickRules': '3〜16文字：半角英数字と_',
    'auth.magma.invalidNick': 'ニックネーム：半角英数字と_のみ、3〜16文字',
    'auth.magma.invalidEmail': '有効なメールアドレスを入力してください',
    'auth.magma.weakPassword': 'パスワードは6文字以上にしてください',
    'auth.magma.genericError': '問題が発生しました。もう一度お試しください。',
    'auth.google.or': 'または',
    'auth.google.button': 'Googleでログイン',
    'auth.google.registerButton': 'Googleで登録',
    'auth.google.registerDesc': 'MagmaアカウントはGoogle経由で作成されます。メール確認は不要で、10秒ほどで完了します。',
    'auth.google.setPassword': 'パスワードを設定',
    'auth.google.finishButton': '登録を完了',
    'auth.google.setupDesc': '{email} としてログインしました。あとはニックネームを選ぶだけです。',
    'auth.google.repairDesc': 'パスワードは正しいですが、このアカウントのニックネームが保存されていませんでした。今すぐ設定してください。',
    'auth.google.cancelled': 'Googleログインがキャンセルされました',
    'auth.google.failed': 'Googleでログインできませんでした。インターネット接続を確認してもう一度お試しください。',
    'auth.google.accountExists': 'このメールアドレスのアカウントは既に存在します。パスワードを入力してログインしてください。',
    'auth.google.waitingBrowser': 'ブラウザでの確認を待っています...',
    'auth.google.checking': 'アカウントを確認中...',
    'auth.google.creatingAccount': 'アカウントを作成中...',
    'auth.google.devOnlyExe': 'Googleログインはビルド済みの.exeからのみ動作します',
    'auth.magma.invalidCredentials': 'メールアドレスまたはパスワードが正しくありません',
    'modpacks.none': 'まだモッドパックを作成していません',
    'mods.tab.browse': 'カタログ',
    'mods.tab.installed': 'マイMOD',
    'mods.installed.empty': 'modsフォルダにはまだ何もありません',
    'mods.installed.disable': '無効化',
    'mods.installed.enable': '有効化',
    'mods.installed.delete': '削除',
    'mods.installed.disabled': '無効',
    'mods.installed.confirmDelete': 'このMODを完全に削除しますか？',
    'mods.installed.loadError': 'modsフォルダを読み込めませんでした',
    'mods.filter.sortBy': '並び替え',
    'mods.filter.sources': 'ソース',
    'mods.filter.sort.relevance': '関連性',
    'mods.filter.sort.downloads': 'ダウンロード数',
    'mods.filter.sort.followers': 'フォロワー数',
    'mods.filter.sort.datePublished': '公開日',
    'mods.filter.sort.dateUpdated': '更新日',
    'mods.category.mods': 'MOD',
    'mods.category.resourcepacks': 'リソースパック',
    'mods.category.shaders': 'シェーダー',
    'mods.category.maps': 'マップ',
  },
  ko: {
    'nav.home': '홈',
    'nav.instances': '인스턴스',
    'nav.mods': '모드',
    'nav.settings': '설정',
    'hero.eyebrow': '실행 준비 완료',
    'hero.title': '당신의 세계가 기다립니다',
    'hero.buildLabel': '인스턴스',
    'hero.play': '플레이',
    'hero.launching': '실행 중...',
    'hero.searchVersion': '버전 검색...','hero.snapshots': '스냅샷',
    'launch.stage.manifest': '버전 확인 중',
    'launch.stage.java': 'Java 다운로드 중',
    'launch.stage.client': '게임 다운로드 중',
    'launch.stage.libraries': '라이브러리 다운로드 중',
    'launch.stage.assets': '에셋 다운로드 중',
    'launch.stage.launch': '실행 중',
    'launch.starting': '준비 중...',
    'launch.success': '게임이 실행되었습니다',
    'launch.loaderNotSupported': '이 로더는 아직 지원되지 않습니다 — 곧 추가됩니다',
    'launch.pauseTooltip': '다운로드 일시정지 / 재개',
    'launch.cancelTooltip': '다운로드 취소',
    'launch.cancelled': '취소됨',
    'launch.paused': '일시정지됨 — ⏸를 클릭해 재개',
    'launch.cancelBtn': '취소',
    'launch.detailsBtn': '자세히',
    'launch.errorDetailsTitle': '문제가 발생했습니다',
    'launch.devOnlyExe': '게임 실행은 빌드된 .exe에서만 작동합니다',
    'loader.comingSoon': '곧 제공 예정',
    'news.title': '뉴스',
    'news.tag.update': '업데이트',
    'news.item1.title': 'Magma 1.4 출시',
    'news.item1.desc': '새로운 모드 관리자와 더 빠른 인스턴스 로딩.',
    'news.tag.build': '인스턴스',
    'news.item2.title': 'Tectonic Craft 추가됨',
    'news.item2.desc': '이번 주 테크니컬 모드팩이 카탈로그에 추가되었습니다.',
    'news.tag.server': '서버',
    'news.item3.title': '예정된 점검',
    'news.item3.desc': '프로필 동기화가 2시간 동안 중단됩니다.',
    'instances.title': '인스턴스',
    'instances.new': '+ 새 인스턴스',
    'instances.newCard': '새 인스턴스',
    'instances.tab.mine': '내 인스턴스',
    'instances.tab.catalog': '카탈로그',
    'instances.searchCatalog': '모드팩 검색...',
    'instances.none': '아직 설치된 인스턴스가 없습니다',
    'mods.title': '모드',
    'mods.search': '모드 검색...',
    'mods.install': '설치',
    'mods.installTarget': '모드 설치 대상:',
    'mods.createModpack': '+ 모드팩 만들기',
    'mods.name': '모드팩 이름',
    'mods.version': '마인크래프트 버전',
    'mods.loader': '로더',
    'mods.recommended': '추천 모드',
    'mods.addMore': '모드 더 추가',
    'mods.createBtn': '모드팩 만들기',
    'mods.creating': '생성 중...',
    'mods.addBtn': '추가',
    'mods.added': '추가됨',
    'mods.installing': '설치 중...',
    'mods.searching': '모드 검색 중...',
    'mods.notFound': '검색 결과 없음',
    'mods.modsCount': '모드',
    'mods.devModeHint': '모드 검색은 빌드된 .exe에서만 작동합니다',
    'mods.devOnlyExe': '모드팩 생성은 빌드된 .exe에서만 작동합니다',
    'mods.downloadsLabel': '다운로드',
    'mods.followersLabel': '팔로워',
    'mods.loadingDetails': '설명 불러오는 중...',
    'mods.nameRequired': '모드팩 이름을 입력하세요',
    'mods.nameTaken': '이미 같은 이름의 모드팩이 있습니다',
    'settings.title': '설정',
    'settings.java.label': 'Java 경로',
    'settings.java.hint': 'java.exe 실행 파일입니다. 런처가 알맞은 Java 버전을 자동으로 찾거나 다운로드하게 하려면 그대로 두세요',
    'settings.dir.label': '게임 폴더',
    'settings.dir.hint': '인스턴스, 모드, 세이브 파일이 저장되는 위치',
    'settings.ram.label': '할당된 RAM',
    'settings.ram.hint': '게임이 사용할 수 있는 메모리 양',
    'settings.lang.label': '언어',
    'settings.lang.hint': '런처 인터페이스 언어',
    'ram.unit': 'GB',
    'version.notFound': '검색 결과 없음',
    'account.tooltip': '계정',
    'auth.tab.guest': '게스트',
    'auth.tab.magma': 'Magma 계정',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': '닉네임',
    'auth.guest.continue': '게스트로 계속하기',
    'auth.magma.emailLabel': '이메일 또는 닉네임',
    'auth.magma.passwordLabel': '비밀번호',
    'auth.magma.signIn': '로그인',
    'auth.magma.signingIn': '로그인 중...',
    'auth.magma.noAccount': '계정이 없으신가요?',
    'auth.magma.createLink': '만들기',
    'auth.magma.registerEmail': '이메일',
    'auth.magma.registerNick': '닉네임(로그인 ID)',
    'auth.magma.registerPassword': '비밀번호',
    'auth.magma.registerConfirm': '비밀번호 확인',
    'auth.magma.createBtn': '계정 만들기',
    'auth.magma.haveAccount': '이미 계정이 있으신가요?',
    'auth.magma.loginLink': '로그인',
    'auth.ms.desc': '공식 런처와 마찬가지로 Minecraft에 연결된 Microsoft 계정으로 로그인하세요.',
    'auth.ms.button': 'Microsoft로 로그인',
    'auth.tab.comingSoonBadge': '곧 제공',
    'auth.ms.comingSoonDesc': 'Microsoft/Xbox 로그인은 아직 개발 중입니다 — Microsoft API 접근을 위해서는 별도의 앱 승인이 필요합니다. 접근 권한이 승인되면 이 탭은 자동으로 작동합니다.',
    'auth.ms.comingSoonButton': '곧 제공 예정',
    'auth.ms.devOnlyExe': 'Microsoft 로그인은 빌드된 .exe에서만 작동합니다',
    'auth.magma.notFound': '이 이메일 또는 로그인 ID로 등록된 계정이 없습니다',
    'auth.magma.wrongPassword': '비밀번호가 올바르지 않습니다',
    'auth.magma.emailTaken': '이미 등록된 이메일입니다',
    'auth.magma.nickTaken': '이미 사용 중인 닉네임입니다',
    'auth.magma.passwordMismatch': '비밀번호가 일치하지 않습니다',
    'auth.magma.fillAll': '모든 항목을 입력해주세요',
    'auth.magma.nickRules': '3–16자: 라틴 문자, 숫자, _',
    'auth.magma.invalidNick': '닉네임: 3–16자, 라틴 문자·숫자·_만 사용 가능',
    'auth.magma.invalidEmail': '올바른 이메일 주소를 입력하세요',
    'auth.magma.weakPassword': '비밀번호는 6자 이상이어야 합니다',
    'auth.magma.genericError': '문제가 발생했습니다. 다시 시도해주세요.',
    'auth.google.or': '또는',
    'auth.google.button': 'Google로 로그인',
    'auth.google.registerButton': 'Google로 가입',
    'auth.google.registerDesc': 'Magma 계정은 Google을 통해 생성됩니다. 이메일 인증 없이 10초면 완료됩니다.',
    'auth.google.setPassword': '비밀번호 설정',
    'auth.google.finishButton': '가입 완료',
    'auth.google.setupDesc': '{email} 계정으로 로그인했습니다. 닉네임만 정하면 됩니다.',
    'auth.google.repairDesc': '비밀번호는 맞지만, 이 계정에 저장된 닉네임이 없습니다. 지금 하나 정해주세요.',
    'auth.google.cancelled': 'Google 로그인이 취소되었습니다',
    'auth.google.failed': 'Google로 로그인할 수 없습니다. 인터넷 연결을 확인하고 다시 시도해주세요.',
    'auth.google.accountExists': '이 이메일로 가입된 계정이 이미 있습니다 — 비밀번호를 입력해 로그인하세요.',
    'auth.google.waitingBrowser': '브라우저 확인을 기다리는 중...',
    'auth.google.checking': '계정 확인 중...',
    'auth.google.creatingAccount': '계정 생성 중...',
    'auth.google.devOnlyExe': 'Google 로그인은 빌드된 .exe에서만 작동합니다',
    'auth.magma.invalidCredentials': '이메일 또는 비밀번호가 올바르지 않습니다',
    'modpacks.none': '아직 만든 모드팩이 없습니다',
    'mods.tab.browse': '카탈로그',
    'mods.tab.installed': '내 모드',
    'mods.installed.empty': 'mods 폴더가 비어 있습니다',
    'mods.installed.disable': '비활성화',
    'mods.installed.enable': '활성화',
    'mods.installed.delete': '삭제',
    'mods.installed.disabled': '비활성화됨',
    'mods.installed.confirmDelete': '이 모드를 완전히 삭제하시겠습니까?',
    'mods.installed.loadError': 'mods 폴더를 읽을 수 없습니다',
    'mods.filter.sortBy': '정렬 기준',
    'mods.filter.sources': '소스',
    'mods.filter.sort.relevance': '관련성',
    'mods.filter.sort.downloads': '다운로드 수',
    'mods.filter.sort.followers': '팔로워 수',
    'mods.filter.sort.datePublished': '게시일',
    'mods.filter.sort.dateUpdated': '업데이트일',
    'mods.category.mods': '모드',
    'mods.category.resourcepacks': '리소스팩',
    'mods.category.shaders': '쉐이더',
    'mods.category.maps': '맵',
  },
  hi: {
    'nav.home': 'होम',
    'nav.instances': 'इंस्टेंस',
    'nav.mods': 'मॉड्स',
    'nav.settings': 'सेटिंग्स',
    'hero.eyebrow': 'लॉन्च के लिए तैयार',
    'hero.title': 'आपकी दुनिया इंतज़ार कर रही है',
    'hero.buildLabel': 'इंस्टेंस',
    'hero.play': 'खेलें',
    'hero.launching': 'लॉन्च हो रहा है...',
    'hero.searchVersion': 'वर्शन खोजें...','hero.snapshots': 'स्नैपशॉट',
    'launch.stage.manifest': 'वर्शन जांचा जा रहा है',
    'launch.stage.java': 'Java डाउनलोड हो रहा है',
    'launch.stage.client': 'गेम डाउनलोड हो रहा है',
    'launch.stage.libraries': 'लाइब्रेरी डाउनलोड हो रही हैं',
    'launch.stage.assets': 'एसेट्स डाउनलोड हो रहे हैं',
    'launch.stage.launch': 'लॉन्च हो रहा है',
    'launch.starting': 'तैयारी हो रही है...',
    'launch.success': 'गेम लॉन्च हो गया',
    'launch.loaderNotSupported': 'यह लोडर अभी सपोर्टेड नहीं है — जल्द आएगा',
    'launch.pauseTooltip': 'डाउनलोड रोकें / जारी रखें',
    'launch.cancelTooltip': 'डाउनलोड रद्द करें',
    'launch.cancelled': 'रद्द किया गया',
    'launch.paused': 'रुका हुआ है — जारी रखने के लिए ⏸ पर क्लिक करें',
    'launch.cancelBtn': 'रद्द करें',
    'launch.detailsBtn': 'विवरण',
    'launch.errorDetailsTitle': 'कुछ गलत हो गया',
    'launch.devOnlyExe': 'गेम लॉन्च केवल बिल्ड की गई .exe से काम करता है',
    'loader.comingSoon': 'जल्द उपलब्ध होगा',
    'news.title': 'समाचार',
    'news.tag.update': 'अपडेट',
    'news.item1.title': 'Magma 1.4 जारी हुआ',
    'news.item1.desc': 'नया मॉड मैनेजर और तेज़ इंस्टेंस लोडिंग।',
    'news.tag.build': 'इंस्टेंस',
    'news.item2.title': 'Tectonic Craft जोड़ा गया',
    'news.item2.desc': 'इस हफ्ते का टेक्निकल मॉडपैक अब कैटलॉग में है।',
    'news.tag.server': 'सर्वर',
    'news.item3.title': 'निर्धारित रखरखाव',
    'news.item3.desc': 'प्रोफ़ाइल सिंक 2 घंटे के लिए अनुपलब्ध रहेगा।',
    'instances.title': 'इंस्टेंस',
    'instances.new': '+ नया इंस्टेंस',
    'instances.newCard': 'नया इंस्टेंस',
    'instances.tab.mine': 'मेरे इंस्टेंस',
    'instances.tab.catalog': 'कैटलॉग',
    'instances.searchCatalog': 'मॉडपैक खोजें...',
    'instances.none': 'आपने अभी तक कोई इंस्टेंस इंस्टॉल नहीं किया',
    'mods.title': 'मॉड्स',
    'mods.search': 'मॉड्स खोजें...',
    'mods.install': 'इंस्टॉल करें',
    'mods.installTarget': 'इनके लिए मॉड्स इंस्टॉल हो रहे हैं:',
    'mods.createModpack': '+ मॉडपैक बनाएं',
    'mods.name': 'मॉडपैक का नाम',
    'mods.version': 'Minecraft वर्शन',
    'mods.loader': 'लोडर',
    'mods.recommended': 'अनुशंसित मॉड्स',
    'mods.addMore': 'और मॉड्स जोड़ें',
    'mods.createBtn': 'मॉडपैक बनाएं',
    'mods.creating': 'बनाया जा रहा है...',
    'mods.addBtn': 'जोड़ें',
    'mods.added': 'जोड़ा गया',
    'mods.installing': 'इंस्टॉल हो रहा है...',
    'mods.searching': 'मॉड्स खोजे जा रहे हैं...',
    'mods.notFound': 'कुछ नहीं मिला',
    'mods.modsCount': 'मॉड्स',
    'mods.devModeHint': 'मॉड सर्च केवल बिल्ड की गई .exe से काम करता है',
    'mods.devOnlyExe': 'मॉडपैक बनाना केवल बिल्ड की गई .exe से काम करता है',
    'mods.downloadsLabel': 'डाउनलोड्स',
    'mods.followersLabel': 'फ़ॉलोअर्स',
    'mods.loadingDetails': 'विवरण लोड हो रहा है...',
    'mods.nameRequired': 'एक मॉडपैक नाम चुनें',
    'mods.nameTaken': 'इस नाम का मॉडपैक पहले से मौजूद है',
    'settings.title': 'सेटिंग्स',
    'settings.java.label': 'Java पथ',
    'settings.java.hint': 'java.exe एग्ज़ीक्यूटेबल। यदि आप चाहते हैं कि लॉन्चर सही Java वर्शन खुद खोजे या डाउनलोड करे, तो इसे वैसे ही छोड़ दें',
    'settings.dir.label': 'गेम फ़ोल्डर',
    'settings.dir.hint': 'जहां इंस्टेंस, मॉड्स और सेव फ़ाइलें रखी जाती हैं',
    'settings.ram.label': 'आवंटित RAM',
    'settings.ram.hint': 'गेम के लिए उपलब्ध मेमोरी की मात्रा',
    'settings.lang.label': 'भाषा',
    'settings.lang.hint': 'लॉन्चर इंटरफ़ेस की भाषा',
    'ram.unit': 'GB',
    'version.notFound': 'कुछ नहीं मिला',
    'account.tooltip': 'खाता',
    'auth.tab.guest': 'गेस्ट',
    'auth.tab.magma': 'Magma खाता',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'निकनेम',
    'auth.guest.continue': 'गेस्ट के रूप में जारी रखें',
    'auth.magma.emailLabel': 'ईमेल या निकनेम',
    'auth.magma.passwordLabel': 'पासवर्ड',
    'auth.magma.signIn': 'साइन इन करें',
    'auth.magma.signingIn': 'साइन इन हो रहा है...',
    'auth.magma.noAccount': 'खाता नहीं है?',
    'auth.magma.createLink': 'एक बनाएं',
    'auth.magma.registerEmail': 'ईमेल',
    'auth.magma.registerNick': 'निकनेम (लॉगिन)',
    'auth.magma.registerPassword': 'पासवर्ड',
    'auth.magma.registerConfirm': 'पासवर्ड की पुष्टि करें',
    'auth.magma.createBtn': 'खाता बनाएं',
    'auth.magma.haveAccount': 'पहले से खाता है?',
    'auth.magma.loginLink': 'साइन इन करें',
    'auth.ms.desc': 'Minecraft से जुड़े Microsoft खाते से साइन इन करें — बिल्कुल आधिकारिक लॉन्चर की तरह।',
    'auth.ms.button': 'Microsoft से साइन इन करें',
    'auth.tab.comingSoonBadge': 'जल्द आएगा',
    'auth.ms.comingSoonDesc': 'Microsoft/Xbox साइन-इन अभी विकास में है — Minecraft API तक पहुंचने के लिए Microsoft को अलग से ऐप स्वीकृति चाहिए। एक्सेस मिलते ही यह टैब अपने आप काम करने लगेगा।',
    'auth.ms.comingSoonButton': 'जल्द उपलब्ध होगा',
    'auth.ms.devOnlyExe': 'Microsoft साइन-इन केवल बिल्ड की गई .exe से काम करता है',
    'auth.magma.notFound': 'इस ईमेल या लॉगिन से कोई खाता नहीं मिला',
    'auth.magma.wrongPassword': 'गलत पासवर्ड',
    'auth.magma.emailTaken': 'यह ईमेल पहले से पंजीकृत है',
    'auth.magma.nickTaken': 'यह निकनेम पहले से लिया जा चुका है',
    'auth.magma.passwordMismatch': 'पासवर्ड मेल नहीं खाते',
    'auth.magma.fillAll': 'कृपया सभी फ़ील्ड भरें',
    'auth.magma.nickRules': '3–16 अक्षर: लैटिन अक्षर, अंक और _',
    'auth.magma.invalidNick': 'निकनेम: 3–16 अक्षर, केवल लैटिन अक्षर, अंक और _',
    'auth.magma.invalidEmail': 'एक मान्य ईमेल पता दर्ज करें',
    'auth.magma.weakPassword': 'पासवर्ड कम से कम 6 अक्षरों का होना चाहिए',
    'auth.magma.genericError': 'कुछ गलत हो गया। कृपया फिर से प्रयास करें।',
    'auth.google.or': 'या',
    'auth.google.button': 'Google से साइन इन करें',
    'auth.google.registerButton': 'Google से साइन अप करें',
    'auth.google.registerDesc': 'आपका Magma खाता Google के ज़रिए बनता है। सिर्फ़ 10 सेकंड लगते हैं — ईमेल पुष्टि की ज़रूरत नहीं।',
    'auth.google.setPassword': 'पासवर्ड सेट करें',
    'auth.google.finishButton': 'सेटअप पूरा करें',
    'auth.google.setupDesc': 'आप {email} के रूप में साइन इन हैं। बस एक निकनेम चुनना बाकी है।',
    'auth.google.repairDesc': 'पासवर्ड सही है, पर पिछली बार इस खाते के लिए कोई निकनेम सेव नहीं हुआ था। अभी एक चुन लें।',
    'auth.google.cancelled': 'Google साइन-इन रद्द किया गया',
    'auth.google.failed': 'Google से साइन इन नहीं हो सका। अपना इंटरनेट कनेक्शन जांचें और फिर से प्रयास करें।',
    'auth.google.accountExists': 'इस ईमेल से पहले से एक खाता मौजूद है — साइन इन करने के लिए अपना पासवर्ड दर्ज करें।',
    'auth.google.waitingBrowser': 'ब्राउज़र में पुष्टि का इंतज़ार हो रहा है...',
    'auth.google.checking': 'खाता जांचा जा रहा है...',
    'auth.google.creatingAccount': 'खाता बनाया जा रहा है...',
    'auth.google.devOnlyExe': 'Google साइन-इन केवल बिल्ड की गई .exe से काम करता है',
    'auth.magma.invalidCredentials': 'गलत ईमेल या पासवर्ड',
    'modpacks.none': 'आपने अभी तक कोई मॉडपैक नहीं बनाया',
    'mods.tab.browse': 'ब्राउज़ करें',
    'mods.tab.installed': 'मेरे मॉड्स',
    'mods.installed.empty': 'mods फ़ोल्डर खाली है',
    'mods.installed.disable': 'निष्क्रिय करें',
    'mods.installed.enable': 'सक्रिय करें',
    'mods.installed.delete': 'हटाएं',
    'mods.installed.disabled': 'निष्क्रिय',
    'mods.installed.confirmDelete': 'क्या इस मॉड को हमेशा के लिए हटाना है?',
    'mods.installed.loadError': 'mods फ़ोल्डर पढ़ी नहीं जा सकी',
    'mods.filter.sortBy': 'क्रमबद्ध करें',
    'mods.filter.sources': 'स्रोत',
    'mods.filter.sort.relevance': 'प्रासंगिकता',
    'mods.filter.sort.downloads': 'डाउनलोड',
    'mods.filter.sort.followers': 'फ़ॉलोअर्स',
    'mods.filter.sort.datePublished': 'प्रकाशन तिथि',
    'mods.filter.sort.dateUpdated': 'अद्यतन तिथि',
    'mods.category.mods': 'मॉड्स',
    'mods.category.resourcepacks': 'रिसोर्स पैक',
    'mods.category.shaders': 'शेडर्स',
    'mods.category.maps': 'मैप्स',
  },
  id: {
    'nav.home': 'Beranda',
    'nav.instances': 'Instance',
    'nav.mods': 'Mod',
    'nav.settings': 'Pengaturan',
    'hero.eyebrow': 'Siap dimainkan',
    'hero.title': 'Duniamu menanti',
    'hero.buildLabel': 'Instance',
    'hero.play': 'MAIN',
    'hero.launching': 'MELUNCURKAN...',
    'hero.searchVersion': 'Cari versi...','hero.snapshots': 'Snapshot',
    'launch.stage.manifest': 'Memeriksa versi',
    'launch.stage.java': 'Mengunduh Java',
    'launch.stage.client': 'Mengunduh game',
    'launch.stage.libraries': 'Mengunduh library',
    'launch.stage.assets': 'Mengunduh aset',
    'launch.stage.launch': 'Meluncurkan',
    'launch.starting': 'Menyiapkan...',
    'launch.success': 'Game diluncurkan',
    'launch.loaderNotSupported': 'Loader ini belum didukung — segera hadir',
    'launch.pauseTooltip': 'Jeda / lanjutkan unduhan',
    'launch.cancelTooltip': 'Batalkan unduhan',
    'launch.cancelled': 'Dibatalkan',
    'launch.paused': 'Dijeda — klik ⏸ untuk melanjutkan',
    'launch.cancelBtn': 'Batal',
    'launch.detailsBtn': 'Detail',
    'launch.errorDetailsTitle': 'Terjadi kesalahan',
    'launch.devOnlyExe': 'Meluncurkan game hanya berfungsi dari .exe hasil build',
    'loader.comingSoon': 'Segera hadir',
    'news.title': 'Berita',
    'news.tag.update': 'Pembaruan',
    'news.item1.title': 'Magma 1.4 telah rilis',
    'news.item1.desc': 'Pengelola mod baru dan pemuatan instance lebih cepat.',
    'news.tag.build': 'Instance',
    'news.item2.title': 'Tectonic Craft ditambahkan',
    'news.item2.desc': 'Modpack teknis minggu ini kini ada di katalog.',
    'news.tag.server': 'Server',
    'news.item3.title': 'Pemeliharaan terjadwal',
    'news.item3.desc': 'Sinkronisasi profil tidak akan tersedia selama 2 jam.',
    'instances.title': 'Instance',
    'instances.new': '+ Instance baru',
    'instances.newCard': 'Instance baru',
    'instances.tab.mine': 'Instance saya',
    'instances.tab.catalog': 'Katalog',
    'instances.searchCatalog': 'Cari modpack...',
    'instances.none': 'Anda belum menginstal instance apa pun',
    'mods.title': 'Mod',
    'mods.search': 'Cari mod...',
    'mods.install': 'Instal',
    'mods.installTarget': 'Menginstal mod untuk:',
    'mods.createModpack': '+ Buat modpack',
    'mods.name': 'Nama modpack',
    'mods.version': 'Versi Minecraft',
    'mods.loader': 'Loader',
    'mods.recommended': 'Mod yang direkomendasikan',
    'mods.addMore': 'Tambah mod lagi',
    'mods.createBtn': 'Buat modpack',
    'mods.creating': 'Membuat...',
    'mods.addBtn': 'Tambah',
    'mods.added': 'Ditambahkan',
    'mods.installing': 'Menginstal...',
    'mods.searching': 'Mencari mod...',
    'mods.notFound': 'Tidak ditemukan',
    'mods.modsCount': 'mod',
    'mods.devModeHint': 'Pencarian mod hanya berfungsi dari .exe hasil build',
    'mods.devOnlyExe': 'Pembuatan modpack hanya berfungsi dari .exe hasil build',
    'mods.downloadsLabel': 'unduhan',
    'mods.followersLabel': 'pengikut',
    'mods.loadingDetails': 'Memuat deskripsi...',
    'mods.nameRequired': 'Pilih nama modpack',
    'mods.nameTaken': 'Modpack dengan nama ini sudah ada',
    'settings.title': 'Pengaturan',
    'settings.java.label': 'Jalur Java',
    'settings.java.hint': 'File eksekusi java.exe. Biarkan seperti ini jika ingin launcher otomatis mendeteksi atau mengunduh versi Java yang tepat',
    'settings.dir.label': 'Folder game',
    'settings.dir.hint': 'Tempat instance, mod, dan save disimpan',
    'settings.ram.label': 'RAM yang dialokasikan',
    'settings.ram.hint': 'Jumlah memori yang tersedia untuk game',
    'settings.lang.label': 'Bahasa',
    'settings.lang.hint': 'Bahasa antarmuka launcher',
    'ram.unit': 'GB',
    'version.notFound': 'Tidak ditemukan',
    'account.tooltip': 'Akun',
    'auth.tab.guest': 'Tamu',
    'auth.tab.magma': 'Akun Magma',
    'auth.tab.microsoft': 'Microsoft',
    'auth.guest.label': 'Nickname',
    'auth.guest.continue': 'Lanjutkan sebagai tamu',
    'auth.magma.emailLabel': 'Email atau nickname',
    'auth.magma.passwordLabel': 'Kata sandi',
    'auth.magma.signIn': 'Masuk',
    'auth.magma.signingIn': 'Sedang masuk...',
    'auth.magma.noAccount': 'Belum punya akun?',
    'auth.magma.createLink': 'Buat akun',
    'auth.magma.registerEmail': 'Email',
    'auth.magma.registerNick': 'Nickname (login)',
    'auth.magma.registerPassword': 'Kata sandi',
    'auth.magma.registerConfirm': 'Konfirmasi kata sandi',
    'auth.magma.createBtn': 'Buat akun',
    'auth.magma.haveAccount': 'Sudah punya akun?',
    'auth.magma.loginLink': 'Masuk',
    'auth.ms.desc': 'Masuk dengan akun Microsoft yang tertaut ke Minecraft — sama seperti di launcher resmi.',
    'auth.ms.button': 'Masuk dengan Microsoft',
    'auth.tab.comingSoonBadge': 'Segera',
    'auth.ms.comingSoonDesc': 'Login Microsoft/Xbox masih dalam pengembangan — Microsoft memerlukan persetujuan aplikasi terpisah untuk mengakses API Minecraft. Tab ini akan otomatis berfungsi begitu akses diberikan.',
    'auth.ms.comingSoonButton': 'Segera hadir',
    'auth.ms.devOnlyExe': 'Login Microsoft hanya berfungsi dari .exe hasil build',
    'auth.magma.notFound': 'Tidak ditemukan akun dengan email atau login ini',
    'auth.magma.wrongPassword': 'Kata sandi salah',
    'auth.magma.emailTaken': 'Email ini sudah terdaftar',
    'auth.magma.nickTaken': 'Nickname ini sudah digunakan',
    'auth.magma.passwordMismatch': 'Kata sandi tidak cocok',
    'auth.magma.fillAll': 'Harap isi semua kolom',
    'auth.magma.nickRules': '3–16 karakter: huruf latin, angka, dan _',
    'auth.magma.invalidNick': 'Nickname: 3–16 karakter, hanya huruf latin, angka, dan _',
    'auth.magma.invalidEmail': 'Masukkan alamat email yang valid',
    'auth.magma.weakPassword': 'Kata sandi harus minimal 6 karakter',
    'auth.magma.genericError': 'Terjadi kesalahan. Silakan coba lagi.',
    'auth.google.or': 'atau',
    'auth.google.button': 'Masuk dengan Google',
    'auth.google.registerButton': 'Daftar dengan Google',
    'auth.google.registerDesc': 'Akun Magma Anda dibuat melalui Google. Hanya butuh 10 detik — tanpa perlu konfirmasi email.',
    'auth.google.setPassword': 'Atur kata sandi',
    'auth.google.finishButton': 'Selesaikan pendaftaran',
    'auth.google.setupDesc': 'Anda masuk sebagai {email}. Tinggal pilih nickname untuk menyelesaikannya.',
    'auth.google.repairDesc': 'Kata sandi benar, tapi nickname untuk akun ini belum pernah tersimpan. Silakan pilih sekarang.',
    'auth.google.cancelled': 'Login Google dibatalkan',
    'auth.google.failed': 'Tidak dapat masuk dengan Google. Periksa koneksi internet Anda dan coba lagi.',
    'auth.google.accountExists': 'Akun dengan email ini sudah ada — masukkan kata sandi Anda untuk masuk.',
    'auth.google.waitingBrowser': 'Menunggu konfirmasi di browser...',
    'auth.google.checking': 'Memeriksa akun...',
    'auth.google.creatingAccount': 'Membuat akun...',
    'auth.google.devOnlyExe': 'Login Google hanya berfungsi dari .exe hasil build',
    'auth.magma.invalidCredentials': 'Email atau kata sandi salah',
    'modpacks.none': 'Anda belum membuat modpack apa pun',
    'mods.tab.browse': 'Jelajahi',
    'mods.tab.installed': 'Mod saya',
    'mods.installed.empty': 'Folder mods kosong',
    'mods.installed.disable': 'Nonaktifkan',
    'mods.installed.enable': 'Aktifkan',
    'mods.installed.delete': 'Hapus',
    'mods.installed.disabled': 'Dinonaktifkan',
    'mods.installed.confirmDelete': 'Hapus mod ini secara permanen?',
    'mods.installed.loadError': 'Tidak dapat membaca folder mods',
    'mods.filter.sortBy': 'Urutkan berdasarkan',
    'mods.filter.sources': 'Sumber',
    'mods.filter.sort.relevance': 'Relevansi',
    'mods.filter.sort.downloads': 'Unduhan',
    'mods.filter.sort.followers': 'Pengikut',
    'mods.filter.sort.datePublished': 'Tanggal publikasi',
    'mods.filter.sort.dateUpdated': 'Tanggal pembaruan',
    'mods.category.mods': 'Mod',
    'mods.category.resourcepacks': 'Resource Pack',
    'mods.category.shaders': 'Shader',
    'mods.category.maps': 'Peta',
  },
};

const ERROR_I18N = {
  ru: {
    ERR_NETWORK: 'Проблема с сетевым соединением',
    ERR_HTTP_STATUS: 'Сервер ответил ошибкой',
    ERR_JAVA_INDEX: 'Не удалось получить список версий Java',
    ERR_JAVA_NO_BUILD: 'Для этой версии нет автоматически скачиваемой Java под Windows x64. Укажите путь к Java вручную в настройках',
    ERR_JAVA_MISSING_EXE: 'Java скачана, но java.exe не найден',
    ERR_JAVA_LAUNCH_FAILED: 'Не удалось запустить java.exe',
    ERR_PROCESS_LAUNCH: 'Не удалось запустить процесс установки',
    ERR_PROCESS_TIMEOUT: 'Процесс установки завис и был прерван по таймауту',
    ERR_FORGE_NO_BUILD: 'Forge не публиковал сборки под эту версию Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Для этой версии используется старый формат установщика Forge без тихого режима',
    ERR_FORGE_INSTALL_FAILED: 'Установщик Forge завершился с ошибкой',
    ERR_MOD_INCOMPATIBLE: 'Этот мод не поддерживает выбранную версию/загрузчик',
    ERR_MOD_NO_FILES: 'У этого мода нет доступных файлов для скачивания',
    ERR_VERSION_NOT_FOUND: 'Версия не найдена в списке версий Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Не удалось найти сборку OptiFine ни на одном зеркале',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Не удалось скачать OptiFine — попробуйте включить VPN или повторить позже',
    ERR_OPTIFINE_INSTALL_FAILED: 'Установка OptiFine завершилась с ошибкой',
    ERR_OPTIFINE_STUB_COMPILE: 'Не удалось подготовить установку OptiFine (ошибка компиляции)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Не удалось скачать JDK, необходимый для установки OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'JDK скачан, но не найден на диске',
    ERR_OPTIFINE_PROFILE_MISSING: 'Установка OptiFine прошла, но профиль версии не найден',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge не публиковал сборки под эту версию Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Для этой версии используется старый формат установщика NeoForge без тихого режима',
    ERR_NEOFORGE_INSTALL_FAILED: 'Установщик NeoForge завершился с ошибкой',
    ERR_ARCHIVE_NO_JARS: 'В архиве не найдено ни одного .jar файла с модом',
    ERR_MAP_NO_LEVEL_DAT: 'В архиве не найдена карта (нет файла level.dat)',
    ERR_RAR_NO_TOOL: 'Для распаковки RAR нужен установленный 7-Zip или WinRAR — скачайте один из них и попробуйте снова',
    ERR_RAR_EXTRACT_FAILED: 'Не удалось распаковать RAR-архив',
    ERR_RAR_NO_ZIP_INSIDE: 'Внутри RAR-архива не найден .zip с ресурс-паком/шейдером',
  },
  en: {
    ERR_NETWORK: 'Network connection problem',
    ERR_HTTP_STATUS: 'The server responded with an error',
    ERR_JAVA_INDEX: 'Could not fetch the list of Java versions',
    ERR_JAVA_NO_BUILD: 'No auto-downloadable Java build exists for this version on Windows x64. Set the Java path manually in settings',
    ERR_JAVA_MISSING_EXE: 'Java was downloaded but java.exe was not found',
    ERR_JAVA_LAUNCH_FAILED: 'Failed to launch java.exe',
    ERR_PROCESS_LAUNCH: 'Failed to start the installer process',
    ERR_PROCESS_TIMEOUT: 'The installer process froze and was stopped after a timeout',
    ERR_FORGE_NO_BUILD: 'Forge has no published build for this Minecraft version',
    ERR_FORGE_OLD_INSTALLER: 'This version uses an old Forge installer format without silent mode',
    ERR_FORGE_INSTALL_FAILED: 'The Forge installer exited with an error',
    ERR_MOD_INCOMPATIBLE: 'This mod does not support the selected version/loader',
    ERR_MOD_NO_FILES: 'This mod has no downloadable files',
    ERR_VERSION_NOT_FOUND: 'Version not found in the Mojang version list',
    ERR_OPTIFINE_NO_MIRROR: 'Could not find an OptiFine build on any mirror',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Failed to download OptiFine — try enabling a VPN or retrying later',
    ERR_OPTIFINE_INSTALL_FAILED: 'The OptiFine installer failed',
    ERR_OPTIFINE_STUB_COMPILE: 'Could not prepare the OptiFine installer (compile error)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Could not download the JDK required to install OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'JDK was downloaded but not found on disk',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine installed, but its version profile was not found',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge has no published build for this Minecraft version',
    ERR_NEOFORGE_OLD_INSTALLER: 'This version uses an old NeoForge installer format without silent mode',
    ERR_NEOFORGE_INSTALL_FAILED: 'The NeoForge installer exited with an error',
    ERR_ARCHIVE_NO_JARS: 'No .jar mod files found in the archive',
    ERR_MAP_NO_LEVEL_DAT: 'No world found in the archive (missing level.dat)',
    ERR_RAR_NO_TOOL: 'Extracting RAR requires 7-Zip or WinRAR installed — install one of them and try again',
    ERR_RAR_EXTRACT_FAILED: 'Failed to extract the RAR archive',
    ERR_RAR_NO_ZIP_INSIDE: 'No .zip resource pack/shader file found inside the RAR archive',
  },
  uk: {
    ERR_NETWORK: 'Проблема з мережевим з\'єднанням',
    ERR_HTTP_STATUS: 'Сервер відповів помилкою',
    ERR_JAVA_INDEX: 'Не вдалося отримати список версій Java',
    ERR_JAVA_NO_BUILD: 'Для цієї версії немає Java, яку можна завантажити автоматично під Windows x64. Вкажіть шлях до Java вручну в налаштуваннях',
    ERR_JAVA_MISSING_EXE: 'Java завантажена, але java.exe не знайдено',
    ERR_JAVA_LAUNCH_FAILED: 'Не вдалося запустити java.exe',
    ERR_PROCESS_LAUNCH: 'Не вдалося запустити процес встановлення',
    ERR_PROCESS_TIMEOUT: 'Процес встановлення завис і був зупинений через таймаут',
    ERR_FORGE_NO_BUILD: 'Forge не публікував збірки під цю версію Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Для цієї версії використовується старий формат установника Forge без тихого режиму',
    ERR_FORGE_INSTALL_FAILED: 'Установник Forge завершився з помилкою',
    ERR_MOD_INCOMPATIBLE: 'Цей мод не підтримує обрану версію/завантажувач',
    ERR_MOD_NO_FILES: 'У цього мода немає доступних файлів для завантаження',
    ERR_VERSION_NOT_FOUND: 'Версію не знайдено у списку версій Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Не вдалося знайти збірку OptiFine на жодному дзеркалі',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Не вдалося завантажити OptiFine — спробуйте увімкнути VPN або повторити пізніше',
    ERR_OPTIFINE_INSTALL_FAILED: 'Встановлення OptiFine завершилося помилкою',
    ERR_OPTIFINE_STUB_COMPILE: 'Не вдалося підготувати встановлення OptiFine (помилка компіляції)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Не вдалося завантажити JDK, необхідний для встановлення OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'JDK завантажено, але не знайдено на диску',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine встановлено, але профіль версії не знайдено',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge не публікував збірки під цю версію Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Для цієї версії використовується старий формат установника NeoForge без тихого режиму',
    ERR_NEOFORGE_INSTALL_FAILED: 'Установник NeoForge завершився з помилкою',
  },
  fr: {
    ERR_NETWORK: 'Problème de connexion réseau',
    ERR_HTTP_STATUS: 'Le serveur a répondu avec une erreur',
    ERR_JAVA_INDEX: 'Impossible de récupérer la liste des versions de Java',
    ERR_JAVA_NO_BUILD: 'Aucune version de Java téléchargeable automatiquement n\'existe pour Windows x64. Définissez le chemin de Java manuellement dans les paramètres',
    ERR_JAVA_MISSING_EXE: 'Java a été téléchargé mais java.exe est introuvable',
    ERR_JAVA_LAUNCH_FAILED: 'Échec du lancement de java.exe',
    ERR_PROCESS_LAUNCH: 'Échec du démarrage du processus d\'installation',
    ERR_PROCESS_TIMEOUT: 'Le processus d\'installation s\'est figé et a été arrêté après un délai d\'attente',
    ERR_FORGE_NO_BUILD: 'Forge n\'a publié aucune version pour cette version de Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Cette version utilise un ancien format d\'installateur Forge sans mode silencieux',
    ERR_FORGE_INSTALL_FAILED: 'L\'installateur Forge s\'est terminé avec une erreur',
    ERR_MOD_INCOMPATIBLE: 'Ce mod ne prend pas en charge la version/le loader sélectionné',
    ERR_MOD_NO_FILES: 'Ce mod n\'a aucun fichier téléchargeable',
    ERR_VERSION_NOT_FOUND: 'Version introuvable dans la liste des versions de Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Impossible de trouver une version d\'OptiFine sur un miroir quelconque',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Échec du téléchargement d\'OptiFine — essayez d\'activer un VPN ou réessayez plus tard',
    ERR_OPTIFINE_INSTALL_FAILED: 'L\'installateur d\'OptiFine a échoué',
    ERR_OPTIFINE_STUB_COMPILE: 'Impossible de préparer l\'installateur d\'OptiFine (erreur de compilation)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Impossible de télécharger le JDK requis pour installer OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'Le JDK a été téléchargé mais introuvable sur le disque',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine installé, mais son profil de version est introuvable',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge n\'a publié aucune version pour cette version de Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Cette version utilise un ancien format d\'installateur NeoForge sans mode silencieux',
    ERR_NEOFORGE_INSTALL_FAILED: 'L\'installateur NeoForge s\'est terminé avec une erreur',
  },
  de: {
    ERR_NETWORK: 'Problem mit der Netzwerkverbindung',
    ERR_HTTP_STATUS: 'Der Server antwortete mit einem Fehler',
    ERR_JAVA_INDEX: 'Die Liste der Java-Versionen konnte nicht abgerufen werden',
    ERR_JAVA_NO_BUILD: 'Für diese Version gibt es keine automatisch herunterladbare Java-Version für Windows x64. Java-Pfad manuell in den Einstellungen festlegen',
    ERR_JAVA_MISSING_EXE: 'Java wurde heruntergeladen, aber java.exe wurde nicht gefunden',
    ERR_JAVA_LAUNCH_FAILED: 'java.exe konnte nicht gestartet werden',
    ERR_PROCESS_LAUNCH: 'Der Installationsprozess konnte nicht gestartet werden',
    ERR_PROCESS_TIMEOUT: 'Der Installationsprozess ist eingefroren und wurde nach einem Timeout gestoppt',
    ERR_FORGE_NO_BUILD: 'Forge hat keine veröffentlichte Version für diese Minecraft-Version',
    ERR_FORGE_OLD_INSTALLER: 'Diese Version verwendet ein altes Forge-Installer-Format ohne stillen Modus',
    ERR_FORGE_INSTALL_FAILED: 'Der Forge-Installer wurde mit einem Fehler beendet',
    ERR_MOD_INCOMPATIBLE: 'Diese Mod unterstützt die ausgewählte Version/den Loader nicht',
    ERR_MOD_NO_FILES: 'Diese Mod hat keine herunterladbaren Dateien',
    ERR_VERSION_NOT_FOUND: 'Version in der Mojang-Versionsliste nicht gefunden',
    ERR_OPTIFINE_NO_MIRROR: 'Es konnte kein OptiFine-Build auf einem Mirror gefunden werden',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'OptiFine konnte nicht heruntergeladen werden — versuche ein VPN oder versuche es später erneut',
    ERR_OPTIFINE_INSTALL_FAILED: 'Der OptiFine-Installer ist fehlgeschlagen',
    ERR_OPTIFINE_STUB_COMPILE: 'Der OptiFine-Installer konnte nicht vorbereitet werden (Kompilierungsfehler)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Das für die OptiFine-Installation benötigte JDK konnte nicht heruntergeladen werden',
    ERR_OPTIFINE_JDK_MISSING: 'Das JDK wurde heruntergeladen, aber nicht auf der Festplatte gefunden',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine wurde installiert, aber sein Versionsprofil wurde nicht gefunden',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge hat keine veröffentlichte Version für diese Minecraft-Version',
    ERR_NEOFORGE_OLD_INSTALLER: 'Diese Version verwendet ein altes NeoForge-Installer-Format ohne stillen Modus',
    ERR_NEOFORGE_INSTALL_FAILED: 'Der NeoForge-Installer wurde mit einem Fehler beendet',
  },
  es: {
    ERR_NETWORK: 'Problema de conexión de red',
    ERR_HTTP_STATUS: 'El servidor respondió con un error',
    ERR_JAVA_INDEX: 'No se pudo obtener la lista de versiones de Java',
    ERR_JAVA_NO_BUILD: 'No existe una versión de Java descargable automáticamente para Windows x64 en esta versión. Configura la ruta de Java manualmente en los ajustes',
    ERR_JAVA_MISSING_EXE: 'Java se descargó, pero no se encontró java.exe',
    ERR_JAVA_LAUNCH_FAILED: 'No se pudo iniciar java.exe',
    ERR_PROCESS_LAUNCH: 'No se pudo iniciar el proceso del instalador',
    ERR_PROCESS_TIMEOUT: 'El proceso del instalador se congeló y se detuvo tras un tiempo de espera',
    ERR_FORGE_NO_BUILD: 'Forge no tiene ninguna versión publicada para esta versión de Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Esta versión usa un formato antiguo del instalador de Forge sin modo silencioso',
    ERR_FORGE_INSTALL_FAILED: 'El instalador de Forge finalizó con un error',
    ERR_MOD_INCOMPATIBLE: 'Este mod no admite la versión/loader seleccionados',
    ERR_MOD_NO_FILES: 'Este mod no tiene archivos descargables',
    ERR_VERSION_NOT_FOUND: 'Versión no encontrada en la lista de versiones de Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'No se pudo encontrar una compilación de OptiFine en ningún mirror',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'No se pudo descargar OptiFine — prueba activando una VPN o inténtalo más tarde',
    ERR_OPTIFINE_INSTALL_FAILED: 'El instalador de OptiFine falló',
    ERR_OPTIFINE_STUB_COMPILE: 'No se pudo preparar el instalador de OptiFine (error de compilación)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'No se pudo descargar el JDK necesario para instalar OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'El JDK se descargó, pero no se encontró en el disco',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine se instaló, pero no se encontró su perfil de versión',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge no tiene ninguna versión publicada para esta versión de Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Esta versión usa un formato antiguo del instalador de NeoForge sin modo silencioso',
    ERR_NEOFORGE_INSTALL_FAILED: 'El instalador de NeoForge finalizó con un error',
  },
  it: {
    ERR_NETWORK: 'Problema di connessione di rete',
    ERR_HTTP_STATUS: 'Il server ha risposto con un errore',
    ERR_JAVA_INDEX: 'Impossibile recuperare l\'elenco delle versioni di Java',
    ERR_JAVA_NO_BUILD: 'Per questa versione non esiste una build di Java scaricabile automaticamente per Windows x64. Imposta il percorso di Java manualmente nelle impostazioni',
    ERR_JAVA_MISSING_EXE: 'Java è stato scaricato, ma java.exe non è stato trovato',
    ERR_JAVA_LAUNCH_FAILED: 'Impossibile avviare java.exe',
    ERR_PROCESS_LAUNCH: 'Impossibile avviare il processo di installazione',
    ERR_PROCESS_TIMEOUT: 'Il processo di installazione si è bloccato ed è stato interrotto dopo un timeout',
    ERR_FORGE_NO_BUILD: 'Forge non ha pubblicato build per questa versione di Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Questa versione usa un vecchio formato dell\'installer di Forge senza modalità silenziosa',
    ERR_FORGE_INSTALL_FAILED: 'L\'installer di Forge è terminato con un errore',
    ERR_MOD_INCOMPATIBLE: 'Questa mod non supporta la versione/loader selezionati',
    ERR_MOD_NO_FILES: 'Questa mod non ha file scaricabili',
    ERR_VERSION_NOT_FOUND: 'Versione non trovata nell\'elenco versioni di Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Impossibile trovare una build di OptiFine su nessun mirror',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Impossibile scaricare OptiFine — prova ad attivare una VPN o riprova più tardi',
    ERR_OPTIFINE_INSTALL_FAILED: 'L\'installer di OptiFine non è riuscito',
    ERR_OPTIFINE_STUB_COMPILE: 'Impossibile preparare l\'installer di OptiFine (errore di compilazione)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Impossibile scaricare il JDK necessario per installare OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'Il JDK è stato scaricato, ma non è stato trovato sul disco',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine installato, ma il suo profilo versione non è stato trovato',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge non ha pubblicato build per questa versione di Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Questa versione usa un vecchio formato dell\'installer di NeoForge senza modalità silenziosa',
    ERR_NEOFORGE_INSTALL_FAILED: 'L\'installer di NeoForge è terminato con un errore',
  },
  pt: {
    ERR_NETWORK: 'Problema de conexão de rede',
    ERR_HTTP_STATUS: 'O servidor respondeu com um erro',
    ERR_JAVA_INDEX: 'Não foi possível obter a lista de versões do Java',
    ERR_JAVA_NO_BUILD: 'Não existe uma versão do Java baixável automaticamente para Windows x64 nesta versão. Defina o caminho do Java manualmente nas configurações',
    ERR_JAVA_MISSING_EXE: 'O Java foi baixado, mas o java.exe não foi encontrado',
    ERR_JAVA_LAUNCH_FAILED: 'Falha ao iniciar o java.exe',
    ERR_PROCESS_LAUNCH: 'Falha ao iniciar o processo do instalador',
    ERR_PROCESS_TIMEOUT: 'O processo do instalador travou e foi interrompido após um tempo limite',
    ERR_FORGE_NO_BUILD: 'O Forge não tem nenhuma versão publicada para esta versão do Minecraft',
    ERR_FORGE_OLD_INSTALLER: 'Esta versão usa um formato antigo do instalador do Forge sem modo silencioso',
    ERR_FORGE_INSTALL_FAILED: 'O instalador do Forge terminou com um erro',
    ERR_MOD_INCOMPATIBLE: 'Este mod não é compatível com a versão/loader selecionados',
    ERR_MOD_NO_FILES: 'Este mod não tem arquivos disponíveis para download',
    ERR_VERSION_NOT_FOUND: 'Versão não encontrada na lista de versões da Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Não foi possível encontrar uma build do OptiFine em nenhum espelho',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Falha ao baixar o OptiFine — tente ativar uma VPN ou tente novamente mais tarde',
    ERR_OPTIFINE_INSTALL_FAILED: 'O instalador do OptiFine falhou',
    ERR_OPTIFINE_STUB_COMPILE: 'Não foi possível preparar o instalador do OptiFine (erro de compilação)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Não foi possível baixar o JDK necessário para instalar o OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'O JDK foi baixado, mas não foi encontrado no disco',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine instalado, mas o perfil da versão não foi encontrado',
    ERR_NEOFORGE_NO_BUILD: 'O NeoForge não tem nenhuma versão publicada para esta versão do Minecraft',
    ERR_NEOFORGE_OLD_INSTALLER: 'Esta versão usa um formato antigo do instalador do NeoForge sem modo silencioso',
    ERR_NEOFORGE_INSTALL_FAILED: 'O instalador do NeoForge terminou com um erro',
  },
  ja: {
    ERR_NETWORK: 'ネットワーク接続に問題があります',
    ERR_HTTP_STATUS: 'サーバーがエラーを返しました',
    ERR_JAVA_INDEX: 'Javaのバージョン一覧を取得できませんでした',
    ERR_JAVA_NO_BUILD: 'このバージョン向けにWindows x64で自動ダウンロードできるJavaがありません。設定でJavaのパスを手動指定してください',
    ERR_JAVA_MISSING_EXE: 'Javaはダウンロードされましたが、java.exeが見つかりません',
    ERR_JAVA_LAUNCH_FAILED: 'java.exeの起動に失敗しました',
    ERR_PROCESS_LAUNCH: 'インストーラープロセスの起動に失敗しました',
    ERR_PROCESS_TIMEOUT: 'インストーラープロセスが停止し、タイムアウトにより中断されました',
    ERR_FORGE_NO_BUILD: 'このMinecraftバージョン向けのForgeビルドが公開されていません',
    ERR_FORGE_OLD_INSTALLER: 'このバージョンはサイレントモードのない古いForgeインストーラー形式を使用しています',
    ERR_FORGE_INSTALL_FAILED: 'Forgeインストーラーがエラーで終了しました',
    ERR_MOD_INCOMPATIBLE: 'このMODは選択したバージョン/ローダーに対応していません',
    ERR_MOD_NO_FILES: 'このMODにはダウンロード可能なファイルがありません',
    ERR_VERSION_NOT_FOUND: 'Mojangのバージョン一覧にこのバージョンが見つかりません',
    ERR_OPTIFINE_NO_MIRROR: 'どのミラーでもOptiFineのビルドが見つかりませんでした',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'OptiFineのダウンロードに失敗しました — VPNを試すか、後でもう一度お試しください',
    ERR_OPTIFINE_INSTALL_FAILED: 'OptiFineインストーラーが失敗しました',
    ERR_OPTIFINE_STUB_COMPILE: 'OptiFineインストーラーの準備に失敗しました（コンパイルエラー）',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'OptiFineのインストールに必要なJDKをダウンロードできませんでした',
    ERR_OPTIFINE_JDK_MISSING: 'JDKはダウンロードされましたが、ディスク上に見つかりません',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFineはインストールされましたが、バージョンプロファイルが見つかりません',
    ERR_NEOFORGE_NO_BUILD: 'このMinecraftバージョン向けのNeoForgeビルドが公開されていません',
    ERR_NEOFORGE_OLD_INSTALLER: 'このバージョンはサイレントモードのない古いNeoForgeインストーラー形式を使用しています',
    ERR_NEOFORGE_INSTALL_FAILED: 'NeoForgeインストーラーがエラーで終了しました',
  },
  ko: {
    ERR_NETWORK: '네트워크 연결 문제',
    ERR_HTTP_STATUS: '서버가 오류로 응답했습니다',
    ERR_JAVA_INDEX: 'Java 버전 목록을 가져올 수 없습니다',
    ERR_JAVA_NO_BUILD: '이 버전에는 Windows x64용으로 자동 다운로드할 수 있는 Java가 없습니다. 설정에서 Java 경로를 직접 지정하세요',
    ERR_JAVA_MISSING_EXE: 'Java는 다운로드되었지만 java.exe를 찾을 수 없습니다',
    ERR_JAVA_LAUNCH_FAILED: 'java.exe 실행에 실패했습니다',
    ERR_PROCESS_LAUNCH: '설치 프로그램 프로세스를 시작하지 못했습니다',
    ERR_PROCESS_TIMEOUT: '설치 프로그램 프로세스가 멈춰서 시간 초과 후 중단되었습니다',
    ERR_FORGE_NO_BUILD: 'Forge에 이 Minecraft 버전용으로 게시된 빌드가 없습니다',
    ERR_FORGE_OLD_INSTALLER: '이 버전은 사일런트 모드가 없는 이전 Forge 설치 프로그램 형식을 사용합니다',
    ERR_FORGE_INSTALL_FAILED: 'Forge 설치 프로그램이 오류와 함께 종료되었습니다',
    ERR_MOD_INCOMPATIBLE: '이 모드는 선택한 버전/로더를 지원하지 않습니다',
    ERR_MOD_NO_FILES: '이 모드에는 다운로드 가능한 파일이 없습니다',
    ERR_VERSION_NOT_FOUND: 'Mojang 버전 목록에서 버전을 찾을 수 없습니다',
    ERR_OPTIFINE_NO_MIRROR: '어떤 미러에서도 OptiFine 빌드를 찾을 수 없습니다',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'OptiFine 다운로드에 실패했습니다 — VPN을 켜거나 나중에 다시 시도해보세요',
    ERR_OPTIFINE_INSTALL_FAILED: 'OptiFine 설치 프로그램이 실패했습니다',
    ERR_OPTIFINE_STUB_COMPILE: 'OptiFine 설치 프로그램을 준비하지 못했습니다 (컴파일 오류)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'OptiFine 설치에 필요한 JDK를 다운로드하지 못했습니다',
    ERR_OPTIFINE_JDK_MISSING: 'JDK는 다운로드되었지만 디스크에서 찾을 수 없습니다',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine은 설치되었지만 버전 프로필을 찾을 수 없습니다',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge에 이 Minecraft 버전용으로 게시된 빌드가 없습니다',
    ERR_NEOFORGE_OLD_INSTALLER: '이 버전은 사일런트 모드가 없는 이전 NeoForge 설치 프로그램 형식을 사용합니다',
    ERR_NEOFORGE_INSTALL_FAILED: 'NeoForge 설치 프로그램이 오류와 함께 종료되었습니다',
  },
  hi: {
    ERR_NETWORK: 'नेटवर्क कनेक्शन की समस्या',
    ERR_HTTP_STATUS: 'सर्वर ने एक त्रुटि के साथ जवाब दिया',
    ERR_JAVA_INDEX: 'Java वर्शन की सूची प्राप्त नहीं हो सकी',
    ERR_JAVA_NO_BUILD: 'इस वर्शन के लिए Windows x64 पर अपने आप डाउनलोड होने वाला कोई Java नहीं है। सेटिंग्स में Java का पथ खुद सेट करें',
    ERR_JAVA_MISSING_EXE: 'Java डाउनलोड हो गया, लेकिन java.exe नहीं मिला',
    ERR_JAVA_LAUNCH_FAILED: 'java.exe लॉन्च करने में विफल',
    ERR_PROCESS_LAUNCH: 'इंस्टॉलर प्रोसेस शुरू करने में विफल',
    ERR_PROCESS_TIMEOUT: 'इंस्टॉलर प्रोसेस अटक गई और टाइमआउट के बाद रोक दी गई',
    ERR_FORGE_NO_BUILD: 'इस Minecraft वर्शन के लिए Forge की कोई बिल्ड प्रकाशित नहीं हुई है',
    ERR_FORGE_OLD_INSTALLER: 'यह वर्शन साइलेंट मोड के बिना Forge इंस्टॉलर के पुराने फ़ॉर्मेट का उपयोग करता है',
    ERR_FORGE_INSTALL_FAILED: 'Forge इंस्टॉलर त्रुटि के साथ बंद हो गया',
    ERR_MOD_INCOMPATIBLE: 'यह मॉड चुने गए वर्शन/लोडर को सपोर्ट नहीं करता',
    ERR_MOD_NO_FILES: 'इस मॉड की कोई डाउनलोड करने योग्य फ़ाइल नहीं है',
    ERR_VERSION_NOT_FOUND: 'Mojang की वर्शन सूची में यह वर्शन नहीं मिला',
    ERR_OPTIFINE_NO_MIRROR: 'किसी भी मिरर पर OptiFine की बिल्ड नहीं मिली',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'OptiFine डाउनलोड करने में विफल — VPN चालू करके देखें या बाद में फिर कोशिश करें',
    ERR_OPTIFINE_INSTALL_FAILED: 'OptiFine इंस्टॉलर विफल हो गया',
    ERR_OPTIFINE_STUB_COMPILE: 'OptiFine इंस्टॉलर तैयार नहीं हो सका (कंपाइल त्रुटि)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'OptiFine इंस्टॉल करने के लिए ज़रूरी JDK डाउनलोड नहीं हो सका',
    ERR_OPTIFINE_JDK_MISSING: 'JDK डाउनलोड हो गया, लेकिन डिस्क पर नहीं मिला',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine इंस्टॉल हो गया, लेकिन उसका वर्शन प्रोफ़ाइल नहीं मिला',
    ERR_NEOFORGE_NO_BUILD: 'इस Minecraft वर्शन के लिए NeoForge की कोई बिल्ड प्रकाशित नहीं हुई है',
    ERR_NEOFORGE_OLD_INSTALLER: 'यह वर्शन साइलेंट मोड के बिना NeoForge इंस्टॉलर के पुराने फ़ॉर्मेट का उपयोग करता है',
    ERR_NEOFORGE_INSTALL_FAILED: 'NeoForge इंस्टॉलर त्रुटि के साथ बंद हो गया',
  },
  id: {
    ERR_NETWORK: 'Masalah koneksi jaringan',
    ERR_HTTP_STATUS: 'Server merespons dengan kesalahan',
    ERR_JAVA_INDEX: 'Tidak dapat mengambil daftar versi Java',
    ERR_JAVA_NO_BUILD: 'Tidak ada build Java yang bisa diunduh otomatis untuk Windows x64 pada versi ini. Atur jalur Java secara manual di pengaturan',
    ERR_JAVA_MISSING_EXE: 'Java sudah diunduh, tetapi java.exe tidak ditemukan',
    ERR_JAVA_LAUNCH_FAILED: 'Gagal menjalankan java.exe',
    ERR_PROCESS_LAUNCH: 'Gagal memulai proses installer',
    ERR_PROCESS_TIMEOUT: 'Proses installer macet dan dihentikan setelah waktu habis',
    ERR_FORGE_NO_BUILD: 'Forge tidak memiliki build yang dipublikasikan untuk versi Minecraft ini',
    ERR_FORGE_OLD_INSTALLER: 'Versi ini menggunakan format installer Forge lama tanpa mode senyap',
    ERR_FORGE_INSTALL_FAILED: 'Installer Forge keluar dengan kesalahan',
    ERR_MOD_INCOMPATIBLE: 'Mod ini tidak mendukung versi/loader yang dipilih',
    ERR_MOD_NO_FILES: 'Mod ini tidak memiliki file yang bisa diunduh',
    ERR_VERSION_NOT_FOUND: 'Versi tidak ditemukan dalam daftar versi Mojang',
    ERR_OPTIFINE_NO_MIRROR: 'Tidak dapat menemukan build OptiFine di mirror mana pun',
    ERR_OPTIFINE_DOWNLOAD_FAILED: 'Gagal mengunduh OptiFine — coba aktifkan VPN atau coba lagi nanti',
    ERR_OPTIFINE_INSTALL_FAILED: 'Installer OptiFine gagal',
    ERR_OPTIFINE_STUB_COMPILE: 'Tidak dapat menyiapkan installer OptiFine (kesalahan kompilasi)',
    ERR_OPTIFINE_JDK_DOWNLOAD: 'Tidak dapat mengunduh JDK yang diperlukan untuk menginstal OptiFine',
    ERR_OPTIFINE_JDK_MISSING: 'JDK sudah diunduh, tetapi tidak ditemukan di disk',
    ERR_OPTIFINE_PROFILE_MISSING: 'OptiFine terpasang, tetapi profil versinya tidak ditemukan',
    ERR_NEOFORGE_NO_BUILD: 'NeoForge tidak memiliki build yang dipublikasikan untuk versi Minecraft ini',
    ERR_NEOFORGE_OLD_INSTALLER: 'Versi ini menggunakan format installer NeoForge lama tanpa mode senyap',
    ERR_NEOFORGE_INSTALL_FAILED: 'Installer NeoForge keluar dengan kesalahan',
  },
};

function translateBackendError(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const sepIndex = raw.indexOf('||');
  if (sepIndex === -1) return raw;
  const code = raw.slice(0, sepIndex);
  const detail = raw.slice(sepIndex + 2);
  const table = ERROR_I18N[currentLang] || ERROR_I18N.en;
  const message = table[code] || ERROR_I18N.en[code];
  if (!message) return detail || raw;
  return detail ? `${message} (${detail})` : message;
}

// Испанский (Испания) пока переиспользует те же строки, что и испанский
// (Латинская Америка) — для такого простого интерфейса разница между
// вариантами непринципиальна, а поддерживать два набора строк накладно.
I18N['es-ES'] = I18N.es;

// Довесок переводов — ключи, которые появились уже после того, как основные
// блоки I18N выше были написаны (модпаки в загрузчиках, переключатель
// "Обычная игра/Модпак", фильтр "Мои моды", модалка модов сборки и т.п.).
// Отдельный объект вместо правки каждого языкового блока — так проще не
// потерять ни один язык и не раздувать основной I18N ещё сильнее.
const I18N_SUPPLEMENT = {
  ru: {
    'instances.import': 'Импорт из файла',
    'instances.importing': 'Импортируем...',
    'instances.allVersions': 'Все версии',
    'mods.addManual': 'Ручная установка',
    'nav.gameFolder': 'Папка игры',
    'nav.refreshVersion': 'Обновить клиент',
    'nav.refreshVersionConfirm': 'Переустановить файлы версии {version}? Лаунчер заново скачает клиент игры и загрузчик при следующем запуске.',
    'hero.searchingSnapshots': 'Ищем снапшоты...',
    'mods.dropHint': 'Перетащите файлы сюда',
    'mods.browseFiles': 'Выбрать файлы',
    'mods.archiveNoJars': 'В архиве не найдено ни одного .jar файла с модом',
    'mods.badModFile': 'Файл должен быть .jar, .zip или .rar с модами',
    'mods.badZipFile': 'Файл должен быть в формате .zip или .rar',
    'mods.badMapFile': 'В архиве не найдена карта (нет файла level.dat)',
    'loader.modpacks': 'Модпаки',
    'mods.scope.vanilla': 'Обычная игра',
    'mods.scope.modpack': 'Модпак',
    'mods.duplicateNameError': 'Мод с таким названием уже установлен из другого источника для этой версии',
    'mods.filter.scope.current': 'Текущая версия',
    'mods.filter.scope.all': 'Все версии',
    'instance.modsTitle': 'Моды сборки',
    'instance.addMods': '+ Добавить моды',
    'instance.noMods': 'В этой сборке пока нет модов',
    'instance.deleteBtn': 'Удалить сборку',
    'instance.confirmDelete': 'Удалить сборку «{name}» вместе со всеми модами и сохранениями? Это действие необратимо.',
    'home.tabOverview': 'Обзор',
    'home.tabUpdates': 'Обновления',
    'updates.title': 'История обновлений',
    'updates.subtitle': 'Кратко о том, что принесло каждое крупное обновление Minecraft, начиная с релиза 1.0.',
    'settings.tab.account': 'Аккаунт',
    'settings.tab.launcher': 'Настройки лаунчера',
    'settings.tab.game': 'Настройки игры',
    'settings.launcher.placeholder': 'Дополнительные настройки лаунчера появятся здесь позже',
    'settings.account.rotateHint': 'Перетащите, чтобы повернуть скин',
    'settings.account.skinSystem.label': 'Система скинов',
    'settings.account.skinSystem.hint': 'Откуда лаунчер берёт ваш скин',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins пока в разработке',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (в разработке)',
    'settings.account.changeSkin': 'Сменить скин',
    'skinChange.title': 'Смена скина',
    'skinChange.desc': 'Чтобы сменить скин, зарегистрируйтесь или войдите на сайте Ely.by — лаунчер сам подхватит новый скин в игре.',
    'skinChange.dontShowAgain': 'Больше не показывать',
    'skinChange.goBtn': 'Перейти на Ely.by',
    'account.addAccount': '+ Добавить аккаунт',
    'account.noAccounts': 'Пока нет добавленных аккаунтов',
    'account.settingsTooltip': 'Настройки аккаунта',
    'account.accountsListLabel': 'Аккаунты',
    'account.changePasswordLabel': 'Смена пароля',
    'account.changePasswordHint': 'Доступно только для Magma-аккаунтов',
    'account.currentPasswordPlaceholder': 'Текущий пароль',
    'account.newPasswordPlaceholder': 'Новый пароль',
    'account.changePasswordBtn': 'Сменить пароль',
    'account.changingPassword': 'Меняем пароль...',
    'account.passwordChanged': 'Пароль успешно изменён',
    'account.notMagmaAccount': 'Смена пароля доступна только для Magma-аккаунтов',
    'account.logoutBtn': 'Выйти из аккаунта',
    'account.deleteBtn': 'Удалить аккаунт',
    'account.logoutConfirmTitle': 'Выйти из аккаунта?',
    'account.logoutConfirmDesc': 'Вы уверены, что хотите выйти?',
    'account.logoutConfirmBtn': 'Выйти',
    'account.deleteConfirmTitle': 'Удалить аккаунт?',
    'account.deleteConfirmDesc': 'Это действие необратимо, аккаунт будет удалён навсегда.',
    'account.deleteConfirmBtn': 'Удалить навсегда',
    'account.deleting': 'Удаляем...',
    'settings.account.viewerLoadError': 'Не удалось загрузить модель скина',
    'settings.fullscreen.label': 'Полноэкранный режим',
    'settings.fullscreen.hint': 'Игра будет запускаться в полноэкранном режиме',
    'settings.resolution.label': 'Разрешение окна',
    'settings.resolution.hint': 'Размер игрового окна при запуске (недоступно в полноэкранном режиме)',
    'settings.resolution.default': 'По умолчанию',
    'settings.resolution.custom': 'Своё...',
    'settings.java.autoDetect': 'Автоопределение',
    'settings.java.browse': 'Обзор',
    'settings.java.autoDetectNotFound': 'Java не найдена в системе',
    'settings.jvmArgs.label': 'Аргументы JVM',
    'settings.jvmArgs.hint': 'Дополнительные флаги для опытных пользователей',
    'settings.jvmArgs.presetG1GC': 'G1GC (рекомендуется)',
    'settings.jvmArgs.presetClear': 'Очистить',
    'settings.dir.modeMagma': 'MagmaLauncher (по умолчанию)',
    'settings.dir.modeVanilla': '.minecraft (папка официального лаунчера)',
    'settings.dir.modeCustom': 'Своя папка',
    'settings.dir.browse': 'Обзор',
    'settings.dir.move': 'Переместить папку игры',
    'settings.dir.moving': 'Переносим папку игры...',
    'settings.dir.moved': 'Папка игры перенесена',
    'settings.dir.devOnlyExe': 'Работа с папкой игры доступна только из собранного .exe',
    'settings.resetBtn': 'Сброс',
    'settings.java.autoPlaceholder': 'Автоматически',
    'settings.jvmArgs.modeDefault': 'Стандартные',
    'settings.jvmArgs.simpleHint': 'Влияет на плавность игры. Если не уверены — оставьте «Стандартные»',
        'settings.jvmArgs.advancedShow': 'Свои флаги (для опытных)',
    'settings.resolution.width': 'Ширина',
    'settings.resolution.height': 'Высота',
    'settings.launcherCat.interface': 'Интерфейс',
    'settings.launcherCat.notifications': 'Уведомления',
    'settings.launcherCat.performance': 'Производительность',
    'settings.launcherCat.privacy': 'Приватность',
    'settings.launcherCat.updates': 'Обновления лаунчера',
    'settings.launcherCat.badge': 'В разработке',
    'settings.launcherCat.notifications.hint': 'Уведомления о новых версиях, событиях серверов и статусе загрузок появятся здесь.',
    'settings.launcherCat.performance.hint': 'Настройки FPS-лимита, анимаций интерфейса и потребления ресурсов лаунчера.',
    'settings.launcherCat.privacy.hint': 'Управление телеметрией и данными, которые лаунчер отправляет для улучшения сервиса.',
    'settings.launcherCat.updates.hint': 'Автоматические обновления самого лаунчера и канал обновлений (стабильный/бета).',
    'settings.heroBg.presetsLabel': 'Готовые фоны',
    'settings.heroBg.presetsHint': 'Выберите один из фонов или загрузите свою картинку ниже',
    'settings.heroBg.uploadLabel': 'Свой фон',
    'settings.heroBg.uploadHint': 'JPG, PNG или WebP — после загрузки можно обрезать и расположить картинку',
    'settings.heroBg.uploadBtn': 'Загрузить',
    'settings.heroBg.none': 'Без фона',
    'settings.updates.checking': 'Проверяем...',
    'settings.updates.channel.label': 'Канал обновлений',
    'settings.updates.channel.hint': 'Бета может содержать необкатанные функции',
    'settings.updates.channel.stable': 'Стабильный',
    'settings.updates.channel.beta': 'Бета',
    'settings.updates.autoInstall.label': 'Устанавливать автоматически',
    'settings.updates.autoInstall.hint': 'Сразу скачивать и ставить обновление, если оно найдено',
    'settings.updates.lastCheck.label': 'Последняя проверка',
  },
  en: {
    'instances.import': 'Import from file',
    'instances.importing': 'Importing...',
    'instances.allVersions': 'All versions',
    'mods.addManual': 'Manual install',
    'nav.gameFolder': 'Game folder',
    'nav.refreshVersion': 'Update client',
    'nav.refreshVersionConfirm': 'Reinstall files for version {version}? The launcher will redownload the game client and loader on next launch.',
    'hero.searchingSnapshots': 'Searching snapshots...',
    'mods.dropHint': 'Drop files here',
    'mods.browseFiles': 'Choose files',
    'mods.archiveNoJars': 'No .jar mod files found in the archive',
    'mods.badModFile': 'The file must be a .jar, .zip or .rar containing mods',
    'mods.badZipFile': 'The file must be a .zip or .rar',
    'mods.badMapFile': 'No world found in the archive (missing level.dat)',
    'loader.modpacks': 'Modpacks',
    'mods.scope.vanilla': 'Vanilla game',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'A mod with this name is already installed from a different source for this version',
    'mods.filter.scope.current': 'Current version',
    'mods.filter.scope.all': 'All versions',
    'instance.modsTitle': 'Instance mods',
    'instance.addMods': '+ Add mods',
    'instance.noMods': "This instance doesn't have any mods yet",
    'instance.deleteBtn': 'Delete instance',
    'instance.confirmDelete': 'Delete instance "{name}" along with all its mods and saves? This cannot be undone.',
    'home.tabOverview': 'Overview',
    'home.tabUpdates': 'Updates',
    'updates.title': 'Update History',
    'updates.subtitle': 'A quick look at what every major Minecraft update brought, starting from the 1.0 release.',
    'settings.tab.account': 'Account',
    'settings.tab.launcher': 'Launcher settings',
    'settings.tab.game': 'Game settings',
    'settings.launcher.placeholder': 'More launcher settings will appear here later',
    'settings.account.rotateHint': 'Drag to rotate the skin',
    'settings.account.skinSystem.label': 'Skin system',
    'settings.account.skinSystem.hint': 'Where the launcher gets your skin from',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins is still in development',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (in development)',
    'settings.account.changeSkin': 'Change skin',
    'skinChange.title': 'Change skin',
    'skinChange.desc': "To change your skin, sign up or log in on Ely.by — the launcher will pick up the new skin automatically.",
    'skinChange.dontShowAgain': "Don't show this again",
    'skinChange.goBtn': 'Go to Ely.by',
    'account.addAccount': '+ Add account',
    'account.noAccounts': 'No accounts added yet',
    'account.settingsTooltip': 'Account settings',
    'account.accountsListLabel': 'Accounts',
    'account.changePasswordLabel': 'Change password',
    'account.changePasswordHint': 'Available only for Magma accounts',
    'account.currentPasswordPlaceholder': 'Current password',
    'account.newPasswordPlaceholder': 'New password',
    'account.changePasswordBtn': 'Change password',
    'account.changingPassword': 'Changing password...',
    'account.passwordChanged': 'Password changed successfully',
    'account.notMagmaAccount': 'Changing password is only available for Magma accounts',
    'account.logoutBtn': 'Log out',
    'account.deleteBtn': 'Delete account',
    'account.logoutConfirmTitle': 'Log out?',
    'account.logoutConfirmDesc': 'Are you sure you want to log out?',
    'account.logoutConfirmBtn': 'Log out',
    'account.deleteConfirmTitle': 'Delete account?',
    'account.deleteConfirmDesc': 'This is irreversible — the account will be deleted forever.',
    'account.deleteConfirmBtn': 'Delete forever',
    'account.deleting': 'Deleting...',
    'settings.account.viewerLoadError': 'Failed to load the skin model',
    'settings.fullscreen.label': 'Fullscreen',
    'settings.fullscreen.hint': 'The game will start in fullscreen mode',
    'settings.resolution.label': 'Window resolution',
    'settings.resolution.hint': 'Game window size on launch (unavailable in fullscreen mode)',
    'settings.resolution.default': 'Default',
    'settings.resolution.custom': 'Custom...',
    'settings.java.autoDetect': 'Auto-detect',
    'settings.java.browse': 'Browse',
    'settings.java.autoDetectNotFound': 'No Java installation found on this system',
    'settings.jvmArgs.label': 'JVM arguments',
    'settings.jvmArgs.hint': 'Extra flags for advanced users',
    'settings.jvmArgs.presetG1GC': 'G1GC (recommended)',
    'settings.jvmArgs.presetClear': 'Clear',
    'settings.dir.modeMagma': 'MagmaLauncher (default)',
    'settings.dir.modeVanilla': '.minecraft (official launcher folder)',
    'settings.dir.modeCustom': 'Custom folder',
    'settings.dir.browse': 'Browse',
    'settings.dir.move': 'Move game folder',
    'settings.dir.moving': 'Moving the game folder...',
    'settings.dir.moved': 'Game folder moved',
    'settings.dir.devOnlyExe': 'Managing the game folder only works from the built .exe',
    'settings.resetBtn': 'Reset',
    'settings.java.autoPlaceholder': 'Automatic',
    'settings.jvmArgs.modeDefault': 'Default',
    'settings.jvmArgs.simpleHint': 'Affects how smooth the game runs. If unsure, leave it on "Default"',
    'settings.jvmArgs.advancedShow': 'Custom flags (advanced)',
    'settings.resolution.width': 'Width',
    'settings.resolution.height': 'Height',
    'settings.launcherCat.interface': 'Interface',
    'settings.launcherCat.notifications': 'Notifications',
    'settings.launcherCat.performance': 'Performance',
    'settings.launcherCat.privacy': 'Privacy',
    'settings.launcherCat.updates': 'Launcher updates',
    'settings.launcherCat.badge': 'In development',
    'settings.launcherCat.notifications.hint': 'Notifications about new releases, server events and download status will show up here.',
    'settings.launcherCat.performance.hint': 'FPS limit, interface animation and launcher resource usage settings.',
    'settings.launcherCat.privacy.hint': 'Manage telemetry and the data the launcher sends to improve the service.',
    'settings.launcherCat.updates.hint': 'Automatic updates for the launcher itself and an update channel (stable/beta).',
    'settings.heroBg.presetsLabel': 'Default backgrounds',
    'settings.heroBg.presetsHint': 'Pick one of the backgrounds or upload your own image below',
    'settings.heroBg.uploadLabel': 'Custom background',
    'settings.heroBg.uploadHint': 'JPG, PNG or WebP — after uploading you can crop and position the image',
    'settings.heroBg.uploadBtn': 'Upload',
    'settings.heroBg.none': 'No background',
  },
  uk: {
    'instances.import': 'Імпорт з файлу',
    'instances.importing': 'Імпортуємо...',
    'instances.allVersions': 'Усі версії',
    'mods.addManual': 'Ручне встановлення',
    'nav.gameFolder': 'Папка гри',
    'nav.refreshVersion': 'Оновити клієнт',
    'nav.refreshVersionConfirm': 'Перевстановити файли версії {version}? Лаунчер заново завантажить клієнт гри та завантажувач під час наступного запуску.',
    'hero.searchingSnapshots': 'Шукаємо снапшоти...',
    'mods.dropHint': 'Перетягніть файли сюди',
    'mods.browseFiles': 'Обрати файли',
    'mods.archiveNoJars': 'В архіві не знайдено жодного .jar файлу з модом',
    'mods.badModFile': 'Файл має бути .jar, .zip або .rar з модами',
    'mods.badZipFile': 'Файл має бути у форматі .zip або .rar',
    'mods.badMapFile': 'В архіві не знайдено карту (немає файлу level.dat)',
    'loader.modpacks': 'Модпаки',
    'mods.scope.vanilla': 'Звичайна гра',
    'mods.scope.modpack': 'Модпак',
    'mods.duplicateNameError': 'Мод з такою назвою вже встановлено з іншого джерела для цієї версії',
    'mods.filter.scope.current': 'Поточна версія',
    'mods.filter.scope.all': 'Усі версії',
    'instance.modsTitle': 'Моди збірки',
    'instance.addMods': '+ Додати моди',
    'instance.noMods': 'У цій збірці поки немає модів',
    'instance.deleteBtn': 'Видалити збірку',
    'instance.confirmDelete': 'Видалити збірку «{name}» разом з усіма модами та збереженнями? Цю дію не можна скасувати.',
    'home.tabOverview': 'Огляд',
    'home.tabUpdates': 'Оновлення',
    'updates.title': 'Історія оновлень',
    'updates.subtitle': 'Коротко про те, що принесло кожне велике оновлення Minecraft, починаючи з релізу 1.0.',
    'settings.tab.account': 'Акаунт',
    'settings.tab.launcher': 'Налаштування лаунчера',
    'settings.tab.game': 'Налаштування гри',
    'settings.launcher.placeholder': "Додаткові налаштування лаунчера з'являться тут пізніше",
    'settings.account.rotateHint': 'Перетягніть, щоб повернути скін',
    'settings.account.skinSystem.label': 'Система скінів',
    'settings.account.skinSystem.hint': 'Звідки лаунчер бере ваш скін',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins поки в розробці',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (у розробці)',
    'settings.account.changeSkin': 'Змінити скін',
    'skinChange.title': 'Зміна скіна',
    'skinChange.desc': 'Щоб змінити скін, зареєструйтесь або увійдіть на сайті Ely.by — лаунчер сам підхопить новий скін у грі.',
    'skinChange.dontShowAgain': 'Більше не показувати',
    'skinChange.goBtn': 'Перейти на Ely.by',
    'account.addAccount': '+ Додати акаунт',
    'account.noAccounts': 'Поки немає доданих акаунтів',
    'account.settingsTooltip': 'Налаштування акаунта',
    'account.accountsListLabel': 'Акаунти',
    'account.changePasswordLabel': 'Зміна пароля',
    'account.changePasswordHint': 'Доступно лише для Magma-акаунтів',
    'account.currentPasswordPlaceholder': 'Поточний пароль',
    'account.newPasswordPlaceholder': 'Новий пароль',
    'account.changePasswordBtn': 'Змінити пароль',
    'account.changingPassword': 'Змінюємо пароль...',
    'account.passwordChanged': 'Пароль успішно змінено',
    'account.notMagmaAccount': 'Зміна пароля доступна лише для Magma-акаунтів',
    'account.logoutBtn': 'Вийти з акаунта',
    'account.deleteBtn': 'Видалити акаунт',
    'account.logoutConfirmTitle': 'Вийти з акаунта?',
    'account.logoutConfirmDesc': 'Ви впевнені, що хочете вийти?',
    'account.logoutConfirmBtn': 'Вийти',
    'account.deleteConfirmTitle': 'Видалити акаунт?',
    'account.deleteConfirmDesc': 'Це незворотна дія, акаунт буде видалено назавжди.',
    'account.deleteConfirmBtn': 'Видалити назавжди',
    'account.deleting': 'Видаляємо...',
    'settings.account.viewerLoadError': 'Не вдалося завантажити модель скіна',
    'settings.fullscreen.label': 'Повноекранний режим',
    'settings.fullscreen.hint': 'Гра буде запускатися в повноекранному режимі',
    'settings.resolution.label': 'Роздільна здатність вікна',
    'settings.resolution.hint': 'Розмір ігрового вікна під час запуску (недоступно в повноекранному режимі)',
    'settings.resolution.default': 'За замовчуванням',
    'settings.resolution.custom': 'Своя...',
    'settings.resolution.width': 'Ширина',
    'settings.resolution.height': 'Висота',
    'settings.java.autoDetect': 'Автовизначення',
    'settings.java.browse': 'Огляд',
    'settings.java.autoDetectNotFound': 'Java не знайдена в системі',
    'settings.java.autoPlaceholder': 'Автоматично',
    'settings.jvmArgs.label': 'Аргументи JVM',
    'settings.jvmArgs.hint': 'Додаткові прапорці для досвідчених користувачів',
    'settings.jvmArgs.presetG1GC': 'G1GC (рекомендовано)',
    'settings.jvmArgs.presetClear': 'Очистити',
    'settings.jvmArgs.modeDefault': 'Стандартні',
    'settings.jvmArgs.simpleHint': 'Впливає на плавність гри. Якщо не впевнені — залиште «Стандартні»',
    'settings.jvmArgs.advancedShow': 'Свої прапорці (для досвідчених)',
    'settings.dir.modeMagma': 'MagmaLauncher (за замовчуванням)',
    'settings.dir.modeVanilla': '.minecraft (папка офіційного лаунчера)',
    'settings.dir.modeCustom': 'Своя папка',
    'settings.dir.browse': 'Огляд',
    'settings.dir.move': 'Перемістити папку гри',
    'settings.dir.moving': 'Переносимо папку гри...',
    'settings.dir.moved': 'Папку гри перенесено',
    'settings.dir.devOnlyExe': 'Робота з папкою гри доступна лише зі зібраного .exe',
    'settings.resetBtn': 'Скинути',
    'settings.launcherCat.interface': 'Інтерфейс',
    'settings.launcherCat.notifications': 'Сповіщення',
    'settings.launcherCat.performance': 'Продуктивність',
    'settings.launcherCat.privacy': 'Приватність',
    'settings.launcherCat.updates': 'Оновлення лаунчера',
    'settings.launcherCat.badge': 'У розробці',
    'settings.launcherCat.notifications.hint': 'Сповіщення про нові версії, події серверів та статус завантажень з\'являться тут.',
    'settings.launcherCat.performance.hint': 'Налаштування ліміту FPS, анімацій інтерфейсу та споживання ресурсів лаунчера.',
    'settings.launcherCat.privacy.hint': 'Керування телеметрією та даними, які лаунчер надсилає для покращення сервісу.',
    'settings.launcherCat.updates.hint': 'Автоматичні оновлення самого лаунчера та канал оновлень (стабільний/бета).',
  },
  fr: {
    'instances.import': 'Importer un fichier',
    'instances.importing': 'Importation...',
    'instances.allVersions': 'Toutes les versions',
    'mods.addManual': 'Installation manuelle',
    'nav.gameFolder': 'Dossier du jeu',
    'nav.refreshVersion': 'Mettre à jour le client',
    'nav.refreshVersionConfirm': 'Réinstaller les fichiers de la version {version} ? Le launcher retéléchargera le client du jeu et le loader au prochain lancement.',
    'hero.searchingSnapshots': 'Recherche de snapshots...',
    'mods.dropHint': 'Déposez les fichiers ici',
    'mods.browseFiles': 'Choisir des fichiers',
    'mods.archiveNoJars': "Aucun fichier .jar de mod trouvé dans l'archive",
    'mods.badModFile': 'Le fichier doit être un .jar, .zip ou .rar contenant des mods',
    'mods.badZipFile': 'Le fichier doit être au format .zip ou .rar',
    'mods.badMapFile': "Aucun monde trouvé dans l'archive (level.dat manquant)",
    'loader.modpacks': 'Modpacks',
    'mods.scope.vanilla': 'Jeu normal',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'Un mod portant ce nom est déjà installé depuis une autre source pour cette version',
    'mods.filter.scope.current': 'Version actuelle',
    'mods.filter.scope.all': 'Toutes les versions',
    'instance.modsTitle': "Mods de l'instance",
    'instance.addMods': '+ Ajouter des mods',
    'instance.noMods': "Cette instance n'a pas encore de mods",
    'instance.deleteBtn': "Supprimer l'instance",
    'instance.confirmDelete': 'Supprimer l\'instance « {name} » ainsi que tous ses mods et sauvegardes ? Cette action est irréversible.',
    'home.tabOverview': 'Aperçu',
    'home.tabUpdates': 'Mises à jour',
    'updates.title': 'Historique des mises à jour',
   'updates.subtitle': "Un aperçu rapide de ce qu'a apporté chaque grande mise à jour de Minecraft, depuis la sortie de la 1.0.",
    'settings.tab.account': 'Compte',
    'settings.tab.launcher': 'Paramètres du launcher',
    'settings.tab.game': 'Paramètres du jeu',
    'settings.launcher.placeholder': "D'autres paramètres du launcher apparaîtront ici plus tard",
    'settings.account.rotateHint': 'Faites glisser pour tourner le skin',
    'settings.account.skinSystem.label': 'Système de skins',
    'settings.account.skinSystem.hint': 'D\'où le launcher récupère votre skin',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins est encore en développement',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (en développement)',
    'settings.account.changeSkin': 'Changer de skin',
    'skinChange.title': 'Changer de skin',
    'skinChange.desc': "Pour changer de skin, inscrivez-vous ou connectez-vous sur Ely.by — le launcher récupérera automatiquement le nouveau skin.",
    'skinChange.dontShowAgain': 'Ne plus afficher',
    'skinChange.goBtn': 'Aller sur Ely.by',
    'account.addAccount': '+ Ajouter un compte',
    'account.noAccounts': "Aucun compte ajouté pour l'instant",
    'account.settingsTooltip': 'Paramètres du compte',
     'account.accountsListLabel': 'Comptes',
    'account.changePasswordLabel': 'Changer le mot de passe',
    'account.changePasswordHint': 'Disponible uniquement pour les comptes Magma',
    'account.currentPasswordPlaceholder': 'Mot de passe actuel',
    'account.newPasswordPlaceholder': 'Nouveau mot de passe',
    'account.changePasswordBtn': 'Changer le mot de passe',
    'account.changingPassword': 'Changement du mot de passe...',
    'account.passwordChanged': 'Mot de passe changé avec succès',
    'account.notMagmaAccount': "Le changement de mot de passe n'est disponible que pour les comptes Magma",
    'account.logoutBtn': 'Se déconnecter',
    'account.deleteBtn': 'Supprimer le compte',
    'account.logoutConfirmTitle': 'Se déconnecter ?',
    'account.logoutConfirmDesc': 'Êtes-vous sûr de vouloir vous déconnecter ?',
    'account.logoutConfirmBtn': 'Se déconnecter',
    'account.deleteConfirmTitle': 'Supprimer le compte ?',
    'account.deleteConfirmDesc': 'Cette action est irréversible, le compte sera supprimé définitivement.',
    'account.deleteConfirmBtn': 'Supprimer définitivement',
    'account.deleting': 'Suppression...',
    'settings.account.viewerLoadError': 'Impossible de charger le modèle du skin',
    'settings.fullscreen.label': 'Mode plein écran',
    'settings.fullscreen.hint': 'Le jeu démarrera en mode plein écran',
    'settings.resolution.label': 'Résolution de la fenêtre',
    'settings.resolution.hint': 'Taille de la fenêtre au démarrage (indisponible en plein écran)',
    'settings.resolution.default': 'Par défaut',
    'settings.resolution.custom': 'Personnalisée...',
    'settings.resolution.width': 'Largeur',
    'settings.resolution.height': 'Hauteur',
    'settings.java.autoDetect': 'Détection automatique',
    'settings.java.browse': 'Parcourir',
    'settings.java.autoDetectNotFound': 'Aucune installation de Java trouvée sur ce système',
    'settings.java.autoPlaceholder': 'Automatique',
    'settings.jvmArgs.label': 'Arguments JVM',
    'settings.jvmArgs.hint': 'Options supplémentaires pour utilisateurs avancés',
    'settings.jvmArgs.presetG1GC': 'G1GC (recommandé)',
    'settings.jvmArgs.presetClear': 'Effacer',
    'settings.jvmArgs.modeDefault': 'Standard',
    'settings.jvmArgs.simpleHint': 'Affecte la fluidité du jeu. En cas de doute, laissez sur « Standard »',
    'settings.jvmArgs.advancedShow': 'Options personnalisées (avancé)',
    'settings.dir.modeMagma': 'MagmaLauncher (par défaut)',
    'settings.dir.modeVanilla': '.minecraft (dossier du launcher officiel)',
    'settings.dir.modeCustom': 'Dossier personnalisé',
    'settings.dir.browse': 'Parcourir',
    'settings.dir.move': 'Déplacer le dossier du jeu',
    'settings.dir.moving': 'Déplacement du dossier du jeu...',
    'settings.dir.moved': 'Dossier du jeu déplacé',
    'settings.dir.devOnlyExe': 'La gestion du dossier du jeu ne fonctionne que depuis l\'.exe compilé',
    'settings.resetBtn': 'Réinitialiser',
    'settings.launcherCat.interface': 'Interface',
    'settings.launcherCat.notifications': 'Notifications',
    'settings.launcherCat.performance': 'Performances',
    'settings.launcherCat.privacy': 'Confidentialité',
    'settings.launcherCat.updates': 'Mises à jour du launcher',
    'settings.launcherCat.badge': 'En développement',
    'settings.launcherCat.notifications.hint': 'Les notifications sur les nouvelles versions, les événements des serveurs et l\'état des téléchargements apparaîtront ici.',
    'settings.launcherCat.performance.hint': 'Paramètres de limite de FPS, animations de l\'interface et utilisation des ressources du launcher.',
    'settings.launcherCat.privacy.hint': 'Gestion de la télémétrie et des données envoyées par le launcher pour améliorer le service.',
    'settings.launcherCat.updates.hint': 'Mises à jour automatiques du launcher lui-même et canal de mise à jour (stable/bêta).',
  },
  de: {
    'instances.import': 'Aus Datei importieren',
    'instances.importing': 'Importiere...',
    'instances.allVersions': 'Alle Versionen',
    'mods.addManual': 'Manuelle Installation',
    'nav.gameFolder': 'Spielordner',
    'nav.refreshVersion': 'Client aktualisieren',
    'nav.refreshVersionConfirm': 'Dateien für Version {version} neu installieren? Der Launcher lädt den Spiel-Client und den Loader beim nächsten Start erneut herunter.',
    'hero.searchingSnapshots': 'Suche Snapshots...',
    'mods.dropHint': 'Dateien hier ablegen',
    'mods.browseFiles': 'Dateien auswählen',
    'mods.archiveNoJars': 'Im Archiv wurde keine .jar-Moddatei gefunden',
    'mods.badModFile': 'Die Datei muss eine .jar, .zip oder .rar mit Mods sein',
    'mods.badZipFile': 'Die Datei muss im Format .zip oder .rar vorliegen',
    'mods.badMapFile': 'Im Archiv wurde keine Welt gefunden (level.dat fehlt)',
    'loader.modpacks': 'Modpacks',
    'mods.scope.vanilla': 'Normales Spiel',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'Ein Mod mit diesem Namen ist bereits aus einer anderen Quelle für diese Version installiert',
    'mods.filter.scope.current': 'Aktuelle Version',
    'mods.filter.scope.all': 'Alle Versionen',
    'instance.modsTitle': 'Mods der Instanz',
    'instance.addMods': '+ Mods hinzufügen',
    'instance.noMods': 'Diese Instanz hat noch keine Mods',
    'instance.deleteBtn': 'Instanz löschen',
    'instance.confirmDelete': 'Instanz „{name}“ zusammen mit allen Mods und Spielständen löschen? Dies kann nicht rückgängig gemacht werden.',
    'home.tabOverview': 'Übersicht',
    'home.tabUpdates': 'Updates',
    'updates.title': 'Update-Verlauf',
    'updates.subtitle': 'Ein kurzer Überblick darüber, was jedes große Minecraft-Update seit der Veröffentlichung von 1.0 gebracht hat.',
    'settings.tab.account': 'Konto',
    'settings.tab.launcher': 'Launcher-Einstellungen',
    'settings.tab.game': 'Spiel-Einstellungen',
    'settings.launcher.placeholder': 'Weitere Launcher-Einstellungen folgen hier später',
    'settings.account.rotateHint': 'Ziehen, um den Skin zu drehen',
    'settings.account.skinSystem.label': 'Skin-System',
    'settings.account.skinSystem.hint': 'Woher der Launcher deinen Skin bezieht',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins befindet sich noch in Entwicklung',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (in Entwicklung)',
    'settings.account.changeSkin': 'Skin ändern',
    'skinChange.title': 'Skin ändern',
    'skinChange.desc': 'Um deinen Skin zu ändern, registriere dich oder melde dich bei Ely.by an — der Launcher übernimmt den neuen Skin automatisch.',
    'skinChange.dontShowAgain': 'Nicht mehr anzeigen',
    'skinChange.goBtn': 'Zu Ely.by',
    'account.addAccount': '+ Konto hinzufügen',
    'account.noAccounts': 'Noch keine Konten hinzugefügt',
    'account.settingsTooltip': 'Kontoeinstellungen',
    'account.accountsListLabel': 'Konten',
    'account.changePasswordLabel': 'Passwort ändern',
    'account.changePasswordHint': 'Nur für Magma-Konten verfügbar',
    'account.currentPasswordPlaceholder': 'Aktuelles Passwort',
    'account.newPasswordPlaceholder': 'Neues Passwort',
    'account.changePasswordBtn': 'Passwort ändern',
    'account.changingPassword': 'Passwort wird geändert...',
    'account.passwordChanged': 'Passwort erfolgreich geändert',
    'account.notMagmaAccount': 'Passwortänderung ist nur für Magma-Konten verfügbar',
    'account.logoutBtn': 'Abmelden',
    'account.deleteBtn': 'Konto löschen',
    'account.logoutConfirmTitle': 'Abmelden?',
    'account.logoutConfirmDesc': 'Möchtest du dich wirklich abmelden?',
    'account.logoutConfirmBtn': 'Abmelden',
    'account.deleteConfirmTitle': 'Konto löschen?',
    'account.deleteConfirmDesc': 'Diese Aktion ist unwiderruflich, das Konto wird dauerhaft gelöscht.',
    'account.deleteConfirmBtn': 'Endgültig löschen',
    'account.deleting': 'Wird gelöscht...',
    'settings.account.viewerLoadError': 'Skin-Modell konnte nicht geladen werden',
    'settings.fullscreen.label': 'Vollbildmodus',
    'settings.fullscreen.hint': 'Das Spiel startet im Vollbildmodus',
    'settings.resolution.label': 'Fensterauflösung',
    'settings.resolution.hint': 'Fenstergröße beim Start (im Vollbildmodus nicht verfügbar)',
    'settings.resolution.default': 'Standard',
    'settings.resolution.custom': 'Benutzerdefiniert...',
    'settings.resolution.width': 'Breite',
    'settings.resolution.height': 'Höhe',
    'settings.java.autoDetect': 'Automatisch erkennen',
    'settings.java.browse': 'Durchsuchen',
    'settings.java.autoDetectNotFound': 'Keine Java-Installation auf diesem System gefunden',
    'settings.java.autoPlaceholder': 'Automatisch',
    'settings.jvmArgs.label': 'JVM-Argumente',
    'settings.jvmArgs.hint': 'Zusätzliche Flags für erfahrene Nutzer',
    'settings.jvmArgs.presetG1GC': 'G1GC (empfohlen)',
    'settings.jvmArgs.presetClear': 'Leeren',
    'settings.jvmArgs.modeDefault': 'Standard',
    'settings.jvmArgs.simpleHint': 'Beeinflusst die Flüssigkeit des Spiels. Im Zweifel bei „Standard" bleiben',
    'settings.jvmArgs.advancedShow': 'Eigene Flags (für Fortgeschrittene)',
    'settings.dir.modeMagma': 'MagmaLauncher (Standard)',
    'settings.dir.modeVanilla': '.minecraft (Ordner des offiziellen Launchers)',
    'settings.dir.modeCustom': 'Eigener Ordner',
    'settings.dir.browse': 'Durchsuchen',
    'settings.dir.move': 'Spielordner verschieben',
    'settings.dir.moving': 'Spielordner wird verschoben...',
    'settings.dir.moved': 'Spielordner verschoben',
    'settings.dir.devOnlyExe': 'Die Verwaltung des Spielordners funktioniert nur aus der kompilierten .exe',
    'settings.resetBtn': 'Zurücksetzen',
    'settings.launcherCat.interface': 'Oberfläche',
    'settings.launcherCat.notifications': 'Benachrichtigungen',
    'settings.launcherCat.performance': 'Leistung',
    'settings.launcherCat.privacy': 'Datenschutz',
    'settings.launcherCat.updates': 'Launcher-Updates',
    'settings.launcherCat.badge': 'In Entwicklung',
    'settings.launcherCat.notifications.hint': 'Benachrichtigungen über neue Versionen, Server-Ereignisse und den Download-Status werden hier erscheinen.',
    'settings.launcherCat.performance.hint': 'Einstellungen für FPS-Limit, Oberflächenanimationen und Ressourcenverbrauch des Launchers.',
    'settings.launcherCat.privacy.hint': 'Verwaltung der Telemetrie und der Daten, die der Launcher zur Verbesserung des Dienstes sendet.',
    'settings.launcherCat.updates.hint': 'Automatische Updates des Launchers selbst und der Update-Kanal (stabil/beta).',
  },
  es: {
    'instances.import': 'Importar desde archivo',
    'instances.importing': 'Importando...',
    'instances.allVersions': 'Todas las versiones',
    'mods.addManual': 'Instalación manual',
    'nav.gameFolder': 'Carpeta del juego',
    'nav.refreshVersion': 'Actualizar cliente',
    'nav.refreshVersionConfirm': '¿Reinstalar los archivos de la versión {version}? El launcher volverá a descargar el cliente del juego y el loader en el próximo inicio.',
    'hero.searchingSnapshots': 'Buscando snapshots...',
    'mods.dropHint': 'Arrastra los archivos aquí',
    'mods.browseFiles': 'Elegir archivos',
    'mods.archiveNoJars': 'No se encontró ningún archivo .jar de mod en el archivo',
    'mods.badModFile': 'El archivo debe ser un .jar, .zip o .rar con mods',
    'mods.badZipFile': 'El archivo debe estar en formato .zip o .rar',
    'mods.badMapFile': 'No se encontró ningún mundo en el archivo (falta level.dat)',
    'loader.modpacks': 'Modpacks',
    'mods.scope.vanilla': 'Juego normal',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'Ya hay un mod con este nombre instalado desde otra fuente para esta versión',
    'mods.filter.scope.current': 'Versión actual',
    'mods.filter.scope.all': 'Todas las versiones',
    'instance.modsTitle': 'Mods de la instancia',
    'instance.addMods': '+ Añadir mods',
    'instance.noMods': 'Esta instancia todavía no tiene mods',
    'instance.deleteBtn': 'Eliminar instancia',
    'instance.confirmDelete': '¿Eliminar la instancia «{name}» junto con todos sus mods y partidas guardadas? Esta acción no se puede deshacer.',
    'home.tabOverview': 'Resumen',
    'home.tabUpdates': 'Actualizaciones',
    'updates.title': 'Historial de actualizaciones',
    'updates.subtitle': 'Un vistazo rápido a lo que trajo cada gran actualización de Minecraft desde el lanzamiento de la 1.0.',
    'settings.tab.account': 'Cuenta',
    'settings.tab.launcher': 'Ajustes del launcher',
    'settings.tab.game': 'Ajustes del juego',
    'settings.launcher.placeholder': 'Más ajustes del launcher aparecerán aquí más adelante',
    'settings.account.rotateHint': 'Arrastra para girar el skin',
    'settings.account.skinSystem.label': 'Sistema de skins',
    'settings.account.skinSystem.hint': 'De dónde obtiene el launcher tu skin',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins todavía está en desarrollo',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (en desarrollo)',
    'settings.account.changeSkin': 'Cambiar skin',
    'skinChange.title': 'Cambiar skin',
    'skinChange.desc': 'Para cambiar tu skin, regístrate o inicia sesión en Ely.by — el launcher tomará el nuevo skin automáticamente.',
    'skinChange.dontShowAgain': 'No volver a mostrar',
    'skinChange.goBtn': 'Ir a Ely.by',
    'account.addAccount': '+ Añadir cuenta',
    'account.noAccounts': 'Todavía no hay cuentas añadidas',
    'account.settingsTooltip': 'Ajustes de la cuenta',
    'account.accountsListLabel': 'Cuentas',
    'account.changePasswordLabel': 'Cambiar contraseña',
    'account.changePasswordHint': 'Disponible solo para cuentas Magma',
    'account.currentPasswordPlaceholder': 'Contraseña actual',
    'account.newPasswordPlaceholder': 'Nueva contraseña',
    'account.changePasswordBtn': 'Cambiar contraseña',
    'account.changingPassword': 'Cambiando contraseña...',
    'account.passwordChanged': 'Contraseña cambiada correctamente',
    'account.notMagmaAccount': 'El cambio de contraseña solo está disponible para cuentas Magma',
    'account.logoutBtn': 'Cerrar sesión',
    'account.deleteBtn': 'Eliminar cuenta',
    'account.logoutConfirmTitle': '¿Cerrar sesión?',
    'account.logoutConfirmDesc': '¿Seguro que quieres cerrar sesión?',
    'account.logoutConfirmBtn': 'Cerrar sesión',
    'account.deleteConfirmTitle': '¿Eliminar cuenta?',
    'account.deleteConfirmDesc': 'Esta acción es irreversible, la cuenta se eliminará para siempre.',
    'account.deleteConfirmBtn': 'Eliminar para siempre',
    'account.deleting': 'Eliminando...',
    'settings.account.viewerLoadError': 'No se pudo cargar el modelo del skin',
    'settings.fullscreen.label': 'Pantalla completa',
    'settings.fullscreen.hint': 'El juego se iniciará en pantalla completa',
    'settings.resolution.label': 'Resolución de ventana',
    'settings.resolution.hint': 'Tamaño de la ventana al iniciar (no disponible en pantalla completa)',
    'settings.resolution.default': 'Predeterminada',
    'settings.resolution.custom': 'Personalizada...',
    'settings.resolution.width': 'Ancho',
    'settings.resolution.height': 'Alto',
    'settings.java.autoDetect': 'Detección automática',
    'settings.java.browse': 'Examinar',
    'settings.java.autoDetectNotFound': 'No se encontró ninguna instalación de Java en este sistema',
    'settings.java.autoPlaceholder': 'Automático',
    'settings.jvmArgs.label': 'Argumentos de la JVM',
    'settings.jvmArgs.hint': 'Opciones adicionales para usuarios avanzados',
    'settings.jvmArgs.presetG1GC': 'G1GC (recomendado)',
    'settings.jvmArgs.presetClear': 'Borrar',
    'settings.jvmArgs.modeDefault': 'Estándar',
    'settings.jvmArgs.simpleHint': 'Afecta la fluidez del juego. Si tienes dudas, deja "Estándar"',
    'settings.jvmArgs.advancedShow': 'Opciones personalizadas (avanzado)',
    'settings.dir.modeMagma': 'MagmaLauncher (predeterminada)',
    'settings.dir.modeVanilla': '.minecraft (carpeta del launcher oficial)',
    'settings.dir.modeCustom': 'Carpeta personalizada',
    'settings.dir.browse': 'Examinar',
    'settings.dir.move': 'Mover carpeta del juego',
    'settings.dir.moving': 'Moviendo la carpeta del juego...',
    'settings.dir.moved': 'Carpeta del juego movida',
    'settings.dir.devOnlyExe': 'La gestión de la carpeta del juego solo funciona desde el .exe compilado',
    'settings.resetBtn': 'Restablecer',
    'settings.launcherCat.interface': 'Interfaz',
    'settings.launcherCat.notifications': 'Notificaciones',
    'settings.launcherCat.performance': 'Rendimiento',
    'settings.launcherCat.privacy': 'Privacidad',
    'settings.launcherCat.updates': 'Actualizaciones del launcher',
    'settings.launcherCat.badge': 'En desarrollo',
    'settings.launcherCat.notifications.hint': 'Las notificaciones sobre nuevas versiones, eventos de servidores y el estado de las descargas aparecerán aquí.',
    'settings.launcherCat.performance.hint': 'Ajustes de límite de FPS, animaciones de la interfaz y uso de recursos del launcher.',
    'settings.launcherCat.privacy.hint': 'Gestiona la telemetría y los datos que el launcher envía para mejorar el servicio.',
    'settings.launcherCat.updates.hint': 'Actualizaciones automáticas del propio launcher y canal de actualización (estable/beta).',
  },
  it: {
    'instances.import': 'Importa da file',
    'instances.importing': 'Importazione...',
    'instances.allVersions': 'Tutte le versioni',
    'mods.addManual': 'Installazione manuale',
    'nav.gameFolder': 'Cartella di gioco',
    'nav.refreshVersion': 'Aggiorna client',
    'nav.refreshVersionConfirm': 'Reinstallare i file della versione {version}? Il launcher riscaricherà il client del gioco e il loader al prossimo avvio.',
    'hero.searchingSnapshots': 'Ricerca snapshot...',
    'mods.dropHint': 'Trascina qui i file',
    'mods.browseFiles': 'Scegli i file',
    'mods.archiveNoJars': "Nessun file .jar di mod trovato nell'archivio",
    'mods.badModFile': 'Il file deve essere un .jar, .zip o .rar con mod',
    'mods.badZipFile': 'Il file deve essere in formato .zip o .rar',
    'mods.badMapFile': "Nessun mondo trovato nell'archivio (manca level.dat)",
    'loader.modpacks': 'Modpack',
    'mods.scope.vanilla': 'Gioco normale',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': "Una mod con questo nome è già installata da un'altra fonte per questa versione",
    'mods.filter.scope.current': 'Versione attuale',
    'mods.filter.scope.all': 'Tutte le versioni',
    'instance.modsTitle': "Mod dell'istanza",
    'instance.addMods': '+ Aggiungi mod',
    'instance.noMods': 'Questa istanza non ha ancora mod',
    'instance.deleteBtn': 'Elimina istanza',
    'instance.confirmDelete': 'Eliminare l\'istanza «{name}» insieme a tutte le sue mod e salvataggi? Questa azione è irreversibile.',
    'home.tabOverview': 'Panoramica',
    'home.tabUpdates': 'Aggiornamenti',
    'updates.title': 'Cronologia aggiornamenti',
    'updates.subtitle': 'Uno sguardo rapido a cosa ha portato ogni grande aggiornamento di Minecraft a partire dalla versione 1.0.',
    'settings.tab.account': 'Account',
    'settings.tab.launcher': 'Impostazioni del launcher',
    'settings.tab.game': 'Impostazioni di gioco',
    'settings.launcher.placeholder': 'Altre impostazioni del launcher arriveranno qui in futuro',
    'settings.account.rotateHint': 'Trascina per ruotare la skin',
    'settings.account.skinSystem.label': 'Sistema di skin',
    'settings.account.skinSystem.hint': 'Da dove il launcher prende la tua skin',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins è ancora in sviluppo',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (in sviluppo)',
    'settings.account.changeSkin': 'Cambia skin',
    'skinChange.title': 'Cambia skin',
    'skinChange.desc': 'Per cambiare skin, registrati o accedi su Ely.by — il launcher applicherà automaticamente la nuova skin.',
    'skinChange.dontShowAgain': 'Non mostrare più',
    'skinChange.goBtn': 'Vai su Ely.by',
    'account.addAccount': '+ Aggiungi account',
    'account.noAccounts': 'Nessun account aggiunto ancora',
    'account.settingsTooltip': 'Impostazioni account',
    'account.accountsListLabel': 'Account',
    'account.changePasswordLabel': 'Cambia password',
    'account.changePasswordHint': 'Disponibile solo per gli account Magma',
    'account.currentPasswordPlaceholder': 'Password attuale',
    'account.newPasswordPlaceholder': 'Nuova password',
    'account.changePasswordBtn': 'Cambia password',
    'account.changingPassword': 'Cambio password in corso...',
    'account.passwordChanged': 'Password cambiata con successo',
    'account.notMagmaAccount': 'Il cambio password è disponibile solo per gli account Magma',
    'account.logoutBtn': "Esci dall'account",
    'account.deleteBtn': 'Elimina account',
    'account.logoutConfirmTitle': "Uscire dall'account?",
    'account.logoutConfirmDesc': 'Sei sicuro di voler uscire?',
    'account.logoutConfirmBtn': 'Esci',
    'account.deleteConfirmTitle': "Eliminare l'account?",
    'account.deleteConfirmDesc': "Questa azione è irreversibile, l'account verrà eliminato per sempre.",
    'account.deleteConfirmBtn': 'Elimina per sempre',
    'account.deleting': 'Eliminazione...',
    'settings.account.viewerLoadError': 'Impossibile caricare il modello della skin',
    'settings.fullscreen.label': 'Schermo intero',
    'settings.fullscreen.hint': 'Il gioco si avvierà a schermo intero',
    'settings.resolution.label': 'Risoluzione della finestra',
    'settings.resolution.hint': "Dimensione della finestra all'avvio (non disponibile a schermo intero)",
    'settings.resolution.default': 'Predefinita',
    'settings.resolution.custom': 'Personalizzata...',
    'settings.resolution.width': 'Larghezza',
    'settings.resolution.height': 'Altezza',
    'settings.java.autoDetect': 'Rilevamento automatico',
    'settings.java.browse': 'Sfoglia',
    'settings.java.autoDetectNotFound': 'Nessuna installazione di Java trovata su questo sistema',
    'settings.java.autoPlaceholder': 'Automatico',
    'settings.jvmArgs.label': 'Argomenti JVM',
    'settings.jvmArgs.hint': 'Flag aggiuntivi per utenti avanzati',
    'settings.jvmArgs.presetG1GC': 'G1GC (consigliato)',
    'settings.jvmArgs.presetClear': 'Cancella',
    'settings.jvmArgs.modeDefault': 'Standard',
    'settings.jvmArgs.simpleHint': 'Influisce sulla fluidità del gioco. In caso di dubbio, lascia "Standard"',
    'settings.jvmArgs.advancedShow': 'Flag personalizzati (avanzato)',
    'settings.dir.modeMagma': 'MagmaLauncher (predefinita)',
    'settings.dir.modeVanilla': '.minecraft (cartella del launcher ufficiale)',
    'settings.dir.modeCustom': 'Cartella personalizzata',
    'settings.dir.browse': 'Sfoglia',
    'settings.dir.move': 'Sposta cartella di gioco',
    'settings.dir.moving': 'Spostamento della cartella di gioco...',
    'settings.dir.moved': 'Cartella di gioco spostata',
    'settings.dir.devOnlyExe': "La gestione della cartella di gioco funziona solo dall'.exe compilato",
    'settings.resetBtn': 'Ripristina',
    'settings.launcherCat.interface': 'Interfaccia',
    'settings.launcherCat.notifications': 'Notifiche',
    'settings.launcherCat.performance': 'Prestazioni',
    'settings.launcherCat.privacy': 'Privacy',
    'settings.launcherCat.updates': 'Aggiornamenti del launcher',
    'settings.launcherCat.badge': 'In sviluppo',
    'settings.launcherCat.notifications.hint': 'Le notifiche su nuove versioni, eventi dei server e stato dei download appariranno qui.',
    'settings.launcherCat.performance.hint': 'Impostazioni del limite FPS, animazioni dell\'interfaccia e utilizzo delle risorse del launcher.',
    'settings.launcherCat.privacy.hint': 'Gestisci la telemetria e i dati che il launcher invia per migliorare il servizio.',
    'settings.launcherCat.updates.hint': 'Aggiornamenti automatici del launcher stesso e canale di aggiornamento (stabile/beta).',
  },
  pt: {
    'instances.import': 'Importar de arquivo',
    'instances.importing': 'Importando...',
    'instances.allVersions': 'Todas as versões',
    'mods.addManual': 'Instalação manual',
    'nav.gameFolder': 'Pasta do jogo',
    'nav.refreshVersion': 'Atualizar cliente',
    'nav.refreshVersionConfirm': 'Reinstalar os arquivos da versão {version}? O launcher fará o download do cliente do jogo e do loader novamente na próxima inicialização.',
    'hero.searchingSnapshots': 'Buscando snapshots...',
    'mods.dropHint': 'Arraste os arquivos aqui',
    'mods.browseFiles': 'Escolher arquivos',
    'mods.archiveNoJars': 'Nenhum arquivo .jar de mod encontrado no arquivo',
    'mods.badModFile': 'O arquivo deve ser um .jar, .zip ou .rar com mods',
    'mods.badZipFile': 'O arquivo deve estar em formato .zip ou .rar',
    'mods.badMapFile': 'Nenhum mundo encontrado no arquivo (falta level.dat)',
    'loader.modpacks': 'Modpacks',
    'mods.scope.vanilla': 'Jogo normal',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'Já existe um mod com esse nome instalado de outra fonte para essa versão',
    'mods.filter.scope.current': 'Versão atual',
    'mods.filter.scope.all': 'Todas as versões',
    'instance.modsTitle': 'Mods da instância',
    'instance.addMods': '+ Adicionar mods',
    'instance.noMods': 'Essa instância ainda não tem mods',
    'instance.deleteBtn': 'Excluir instância',
    'instance.confirmDelete': 'Excluir a instância "{name}" junto com todos os mods e saves? Esta ação não pode ser desfeita.',
    'home.tabOverview': 'Visão geral',
    'home.tabUpdates': 'Atualizações',
    'updates.title': 'Histórico de atualizações',
    'updates.subtitle': 'Um resumo rápido do que cada grande atualização do Minecraft trouxe desde o lançamento da 1.0.',
    'settings.tab.account': 'Conta',
    'settings.tab.launcher': 'Configurações do launcher',
    'settings.tab.game': 'Configurações do jogo',
    'settings.launcher.placeholder': 'Mais configurações do launcher aparecerão aqui em breve',
    'settings.account.rotateHint': 'Arraste para girar a skin',
    'settings.account.skinSystem.label': 'Sistema de skins',
    'settings.account.skinSystem.hint': 'De onde o launcher pega sua skin',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins ainda está em desenvolvimento',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (em desenvolvimento)',
    'settings.account.changeSkin': 'Trocar skin',
    'skinChange.title': 'Trocar skin',
    'skinChange.desc': 'Para trocar sua skin, registre-se ou entre no Ely.by — o launcher vai aplicar a nova skin automaticamente.',
    'skinChange.dontShowAgain': 'Não mostrar novamente',
    'skinChange.goBtn': 'Ir para o Ely.by',
    'account.addAccount': '+ Adicionar conta',
    'account.noAccounts': 'Nenhuma conta adicionada ainda',
    'account.settingsTooltip': 'Configurações da conta',
    'account.accountsListLabel': 'Contas',
    'account.changePasswordLabel': 'Alterar senha',
    'account.changePasswordHint': 'Disponível apenas para contas Magma',
    'account.currentPasswordPlaceholder': 'Senha atual',
    'account.newPasswordPlaceholder': 'Nova senha',
    'account.changePasswordBtn': 'Alterar senha',
    'account.changingPassword': 'Alterando senha...',
    'account.passwordChanged': 'Senha alterada com sucesso',
    'account.notMagmaAccount': 'A alteração de senha só está disponível para contas Magma',
    'account.logoutBtn': 'Sair da conta',
    'account.deleteBtn': 'Excluir conta',
    'account.logoutConfirmTitle': 'Sair da conta?',
    'account.logoutConfirmDesc': 'Tem certeza de que deseja sair?',
    'account.logoutConfirmBtn': 'Sair',
    'account.deleteConfirmTitle': 'Excluir conta?',
    'account.deleteConfirmDesc': 'Esta ação é irreversível, a conta será excluída para sempre.',
    'account.deleteConfirmBtn': 'Excluir para sempre',
    'account.deleting': 'Excluindo...',
    'settings.account.viewerLoadError': 'Não foi possível carregar o modelo da skin',
    'settings.fullscreen.label': 'Tela cheia',
    'settings.fullscreen.hint': 'O jogo será iniciado em tela cheia',
    'settings.resolution.label': 'Resolução da janela',
    'settings.resolution.hint': 'Tamanho da janela ao iniciar (indisponível em tela cheia)',
    'settings.resolution.default': 'Padrão',
    'settings.resolution.custom': 'Personalizada...',
    'settings.resolution.width': 'Largura',
    'settings.resolution.height': 'Altura',
    'settings.java.autoDetect': 'Detecção automática',
    'settings.java.browse': 'Procurar',
    'settings.java.autoDetectNotFound': 'Nenhuma instalação do Java encontrada neste sistema',
    'settings.java.autoPlaceholder': 'Automático',
    'settings.jvmArgs.label': 'Argumentos da JVM',
    'settings.jvmArgs.hint': 'Flags adicionais para usuários avançados',
    'settings.jvmArgs.presetG1GC': 'G1GC (recomendado)',
    'settings.jvmArgs.presetClear': 'Limpar',
    'settings.jvmArgs.modeDefault': 'Padrão',
    'settings.jvmArgs.simpleHint': 'Afeta a fluidez do jogo. Em caso de dúvida, deixe em "Padrão"',
    'settings.jvmArgs.advancedShow': 'Flags personalizadas (avançado)',
    'settings.dir.modeMagma': 'MagmaLauncher (padrão)',
    'settings.dir.modeVanilla': '.minecraft (pasta do launcher oficial)',
    'settings.dir.modeCustom': 'Pasta personalizada',
    'settings.dir.browse': 'Procurar',
    'settings.dir.move': 'Mover pasta do jogo',
    'settings.dir.moving': 'Movendo a pasta do jogo...',
    'settings.dir.moved': 'Pasta do jogo movida',
    'settings.dir.devOnlyExe': 'O gerenciamento da pasta do jogo só funciona a partir do .exe compilado',
    'settings.resetBtn': 'Redefinir',
    'settings.launcherCat.interface': 'Interface',
    'settings.launcherCat.notifications': 'Notificações',
    'settings.launcherCat.performance': 'Desempenho',
    'settings.launcherCat.privacy': 'Privacidade',
    'settings.launcherCat.updates': 'Atualizações do launcher',
    'settings.launcherCat.badge': 'Em desenvolvimento',
    'settings.launcherCat.notifications.hint': 'Notificações sobre novas versões, eventos de servidores e status de downloads aparecerão aqui.',
    'settings.launcherCat.performance.hint': 'Configurações de limite de FPS, animações de interface e uso de recursos do launcher.',
    'settings.launcherCat.privacy.hint': 'Gerencie a telemetria e os dados que o launcher envia para melhorar o serviço.',
    'settings.launcherCat.updates.hint': 'Atualizações automáticas do próprio launcher e canal de atualização (estável/beta).',

  },
  ja: {
    'instances.import': 'ファイルからインポート',
    'instances.importing': 'インポート中...',
    'instances.allVersions': 'すべてのバージョン',
    'mods.addManual': '手動インストール',
    'nav.gameFolder': 'ゲームフォルダ',
    'nav.refreshVersion': 'クライアントを更新',
    'nav.refreshVersionConfirm': 'バージョン{version}のファイルを再インストールしますか？次回起動時にゲームクライアントとローダーが再ダウンロードされます。',
    'hero.searchingSnapshots': 'スナップショットを検索中...',
    'mods.dropHint': 'ここにファイルをドロップ',
    'mods.browseFiles': 'ファイルを選択',
    'mods.archiveNoJars': 'アーカイブ内にMODの.jarファイルが見つかりません',
    'mods.badModFile': 'ファイルは.jar、.zip、または.rar（MODを含む）である必要があります',
    'mods.badZipFile': 'ファイルは.zipまたは.rar形式である必要があります',
    'mods.badMapFile': 'アーカイブ内にワールドが見つかりません（level.datがありません）',
    'loader.modpacks': 'モッドパック',
    'mods.scope.vanilla': '通常プレイ',
    'mods.scope.modpack': 'モッドパック',
    'mods.duplicateNameError': '同じ名前のMODが別のソースからこのバージョン用にすでにインストールされています',
    'mods.filter.scope.current': '現在のバージョン',
    'mods.filter.scope.all': 'すべてのバージョン',
    'instance.modsTitle': 'インスタンスのMOD',
    'instance.addMods': '+ MODを追加',
    'instance.noMods': 'このインスタンスにはまだMODがありません',
    'instance.deleteBtn': 'インスタンスを削除',
    'instance.confirmDelete': 'インスタンス「{name}」をすべてのMODとセーブデータごと削除しますか？この操作は元に戻せません。',
    'home.tabOverview': '概要',
    'home.tabUpdates': 'アップデート',
    'updates.title': 'アップデート履歴',
    'updates.subtitle': '1.0のリリース以降、各メジャーアップデートが何をもたらしたかを簡単に紹介します。',
    'settings.tab.account': 'アカウント',
    'settings.tab.launcher': 'ランチャー設定',
    'settings.tab.game': 'ゲーム設定',
    'settings.launcher.placeholder': '追加のランチャー設定は今後ここに表示されます',
    'settings.account.rotateHint': 'ドラッグしてスキンを回転',
    'settings.account.skinSystem.label': 'スキンシステム',
    'settings.account.skinSystem.hint': 'ランチャーがスキンを取得する場所',
    'settings.account.skinSystem.magmaSoon': 'Magma Skinsはまだ開発中です',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins（開発中）',
    'settings.account.changeSkin': 'スキンを変更',
    'skinChange.title': 'スキンを変更',
    'skinChange.desc': 'スキンを変更するには、Ely.byで登録またはログインしてください。ランチャーが自動的に新しいスキンを反映します。',
    'skinChange.dontShowAgain': '今後表示しない',
    'skinChange.goBtn': 'Ely.byへ移動',
    'account.addAccount': '+ アカウントを追加',
    'account.noAccounts': 'まだアカウントが追加されていません',
    'account.settingsTooltip': 'アカウント設定',
    'account.accountsListLabel': 'アカウント',
    'account.changePasswordLabel': 'パスワード変更',
    'account.changePasswordHint': 'Magmaアカウントのみ利用可能',
    'account.currentPasswordPlaceholder': '現在のパスワード',
    'account.newPasswordPlaceholder': '新しいパスワード',
    'account.changePasswordBtn': 'パスワードを変更',
    'account.changingPassword': 'パスワードを変更中...',
    'account.passwordChanged': 'パスワードを変更しました',
    'account.notMagmaAccount': 'パスワード変更はMagmaアカウントのみ利用できます',
    'account.logoutBtn': 'ログアウト',
    'account.deleteBtn': 'アカウントを削除',
    'account.logoutConfirmTitle': 'ログアウトしますか?',
    'account.logoutConfirmDesc': '本当にログアウトしますか?',
    'account.logoutConfirmBtn': 'ログアウト',
    'account.deleteConfirmTitle': 'アカウントを削除しますか?',
    'account.deleteConfirmDesc': 'この操作は取り消せません。アカウントは完全に削除されます。',
    'account.deleteConfirmBtn': '完全に削除',
    'account.deleting': '削除中...',
    'settings.account.viewerLoadError': 'スキンモデルを読み込めませんでした',
    'settings.fullscreen.label': 'フルスクリーンモード',
    'settings.fullscreen.hint': 'ゲームはフルスクリーンで起動します',
    'settings.resolution.label': 'ウィンドウ解像度',
    'settings.resolution.hint': '起動時のウィンドウサイズ（フルスクリーン時は無効）',
    'settings.resolution.default': 'デフォルト',
    'settings.resolution.custom': 'カスタム...',
    'settings.resolution.width': '幅',
    'settings.resolution.height': '高さ',
    'settings.java.autoDetect': '自動検出',
    'settings.java.browse': '参照',
    'settings.java.autoDetectNotFound': 'このシステムにJavaが見つかりません',
    'settings.java.autoPlaceholder': '自動',
    'settings.jvmArgs.label': 'JVM引数',
    'settings.jvmArgs.hint': '上級ユーザー向けの追加フラグ',
    'settings.jvmArgs.presetG1GC': 'G1GC（推奨）',
    'settings.jvmArgs.presetClear': 'クリア',
    'settings.jvmArgs.modeDefault': '標準',
    'settings.jvmArgs.simpleHint': 'ゲームの快適さに影響します。迷ったら「標準」のままにしてください',
    'settings.jvmArgs.advancedShow': '独自のフラグ（上級者向け）',
    'settings.dir.modeMagma': 'MagmaLauncher（デフォルト）',
    'settings.dir.modeVanilla': '.minecraft（公式ランチャーのフォルダ）',
    'settings.dir.modeCustom': 'カスタムフォルダ',
    'settings.dir.browse': '参照',
    'settings.dir.move': 'ゲームフォルダを移動',
    'settings.dir.moving': 'ゲームフォルダを移動中...',
    'settings.dir.moved': 'ゲームフォルダを移動しました',
    'settings.dir.devOnlyExe': 'ゲームフォルダの操作はビルド済みの.exeからのみ動作します',
    'settings.resetBtn': 'リセット',
    'settings.launcherCat.interface': 'インターフェース',
    'settings.launcherCat.notifications': '通知',
    'settings.launcherCat.performance': 'パフォーマンス',
    'settings.launcherCat.privacy': 'プライバシー',
    'settings.launcherCat.updates': 'ランチャーのアップデート',
    'settings.launcherCat.badge': '開発中',
    'settings.launcherCat.notifications.hint': '新しいバージョン、サーバーイベント、ダウンロード状況の通知がここに表示されます。',
    'settings.launcherCat.performance.hint': 'FPS制限、インターフェースアニメーション、ランチャーのリソース使用量の設定。',
    'settings.launcherCat.privacy.hint': 'テレメトリーとサービス改善のためにランチャーが送信するデータを管理します。',
    'settings.launcherCat.updates.hint': 'ランチャー自体の自動アップデートと更新チャンネル（安定版/ベータ版）。',
  },
  ko: {
    'instances.import': '파일에서 가져오기',
    'instances.importing': '가져오는 중...',
    'instances.allVersions': '모든 버전',
    'mods.addManual': '수동 설치',
    'nav.gameFolder': '게임 폴더',
    'nav.refreshVersion': '클라이언트 업데이트',
    'nav.refreshVersionConfirm': '{version} 버전 파일을 다시 설치하시겠습니까? 다음 실행 시 게임 클라이언트와 로더를 다시 다운로드합니다.',
    'hero.searchingSnapshots': '스냅샷 검색 중...',
    'mods.dropHint': '파일을 여기에 끌어다 놓으세요',
    'mods.browseFiles': '파일 선택',
    'mods.archiveNoJars': '압축 파일 안에 모드 .jar 파일이 없습니다',
    'mods.badModFile': '파일은 .jar, .zip 또는 모드가 담긴 .rar여야 합니다',
    'mods.badZipFile': '파일은 .zip 또는 .rar 형식이어야 합니다',
    'mods.badMapFile': '압축 파일 안에서 월드를 찾을 수 없습니다 (level.dat 없음)',
    'loader.modpacks': '모드팩',
    'mods.scope.vanilla': '일반 게임',
    'mods.scope.modpack': '모드팩',
    'mods.duplicateNameError': '이 버전에 같은 이름의 모드가 다른 소스에서 이미 설치되어 있습니다',
    'mods.filter.scope.current': '현재 버전',
    'mods.filter.scope.all': '모든 버전',
    'instance.modsTitle': '인스턴스 모드',
    'instance.addMods': '+ 모드 추가',
    'instance.noMods': '이 인스턴스에는 아직 모드가 없습니다',
    'instance.deleteBtn': '인스턴스 삭제',
    'instance.confirmDelete': '인스턴스 "{name}"을(를) 모든 모드 및 세이브 파일과 함께 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.',
    'home.tabOverview': '개요',
    'home.tabUpdates': '업데이트',
    'updates.title': '업데이트 기록',
    'updates.subtitle': '1.0 출시 이후 각 주요 업데이트가 무엇을 가져왔는지 간단히 소개합니다.',
    'settings.tab.account': '계정',
    'settings.tab.launcher': '런처 설정',
    'settings.tab.game': '게임 설정',
    'settings.launcher.placeholder': '추가 런처 설정이 나중에 여기에 표시됩니다',
    'settings.account.rotateHint': '드래그하여 스킨 회전',
    'settings.account.skinSystem.label': '스킨 시스템',
    'settings.account.skinSystem.hint': '런처가 스킨을 가져오는 곳',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins는 아직 개발 중입니다',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (개발 중)',
    'settings.account.changeSkin': '스킨 변경',
    'skinChange.title': '스킨 변경',
    'skinChange.desc': '스킨을 변경하려면 Ely.by에서 가입하거나 로그인하세요 — 런처가 자동으로 새 스킨을 적용합니다.',
    'skinChange.dontShowAgain': '다시 표시하지 않기',
    'skinChange.goBtn': 'Ely.by로 이동',
    'account.addAccount': '+ 계정 추가',
    'account.noAccounts': '아직 추가된 계정이 없습니다',
    'account.settingsTooltip': '계정 설정',
    'account.accountsListLabel': '계정',
    'account.changePasswordLabel': '비밀번호 변경',
    'account.changePasswordHint': 'Magma 계정에서만 사용 가능',
    'account.currentPasswordPlaceholder': '현재 비밀번호',
    'account.newPasswordPlaceholder': '새 비밀번호',
    'account.changePasswordBtn': '비밀번호 변경',
    'account.changingPassword': '비밀번호 변경 중...',
    'account.passwordChanged': '비밀번호가 변경되었습니다',
    'account.notMagmaAccount': '비밀번호 변경은 Magma 계정에서만 가능합니다',
    'account.logoutBtn': '로그아웃',
    'account.deleteBtn': '계정 삭제',
    'account.logoutConfirmTitle': '로그아웃하시겠습니까?',
    'account.logoutConfirmDesc': '정말 로그아웃하시겠습니까?',
    'account.logoutConfirmBtn': '로그아웃',
    'account.deleteConfirmTitle': '계정을 삭제하시겠습니까?',
    'account.deleteConfirmDesc': '이 작업은 되돌릴 수 없으며 계정이 영구적으로 삭제됩니다.',
    'account.deleteConfirmBtn': '영구 삭제',
    'account.deleting': '삭제 중...',
    'settings.account.viewerLoadError': '스킨 모델을 불러올 수 없습니다',
    'settings.fullscreen.label': '전체 화면 모드',
    'settings.fullscreen.hint': '게임이 전체 화면으로 실행됩니다',
    'settings.resolution.label': '창 해상도',
    'settings.resolution.hint': '실행 시 창 크기 (전체 화면에서는 사용 불가)',
    'settings.resolution.default': '기본값',
    'settings.resolution.custom': '사용자 지정...',
    'settings.resolution.width': '너비',
    'settings.resolution.height': '높이',
    'settings.java.autoDetect': '자동 감지',
    'settings.java.browse': '찾아보기',
    'settings.java.autoDetectNotFound': '이 시스템에서 Java를 찾을 수 없습니다',
    'settings.java.autoPlaceholder': '자동',
    'settings.jvmArgs.label': 'JVM 인수',
    'settings.jvmArgs.hint': '고급 사용자를 위한 추가 플래그',
    'settings.jvmArgs.presetG1GC': 'G1GC (권장)',
    'settings.jvmArgs.presetClear': '지우기',
    'settings.jvmArgs.modeDefault': '기본',
    'settings.jvmArgs.simpleHint': '게임 부드러움에 영향을 줍니다. 확실하지 않으면 "기본"으로 두세요',
    'settings.jvmArgs.advancedShow': '사용자 지정 플래그 (고급)',
    'settings.dir.modeMagma': 'MagmaLauncher (기본값)',
    'settings.dir.modeVanilla': '.minecraft (공식 런처 폴더)',
    'settings.dir.modeCustom': '사용자 지정 폴더',
    'settings.dir.browse': '찾아보기',
    'settings.dir.move': '게임 폴더 이동',
    'settings.dir.moving': '게임 폴더 이동 중...',
    'settings.dir.moved': '게임 폴더가 이동되었습니다',
    'settings.dir.devOnlyExe': '게임 폴더 관리는 빌드된 .exe에서만 작동합니다',
    'settings.resetBtn': '초기화',
    'settings.launcherCat.interface': '인터페이스',
    'settings.launcherCat.notifications': '알림',
    'settings.launcherCat.performance': '성능',
    'settings.launcherCat.privacy': '개인정보',
    'settings.launcherCat.updates': '런처 업데이트',
    'settings.launcherCat.badge': '개발 중',
    'settings.launcherCat.notifications.hint': '새 버전, 서버 이벤트, 다운로드 상태에 대한 알림이 여기에 표시됩니다.',
    'settings.launcherCat.performance.hint': 'FPS 제한, 인터페이스 애니메이션, 런처 리소스 사용량 설정.',
    'settings.launcherCat.privacy.hint': '서비스 개선을 위해 런처가 전송하는 원격 측정 및 데이터를 관리합니다.',
    'settings.launcherCat.updates.hint': '런처 자체의 자동 업데이트 및 업데이트 채널(안정/베타).',
  },
  hi: {
    'instances.import': 'फ़ाइल से आयात करें',
    'instances.importing': 'आयात हो रहा है...',
    'instances.allVersions': 'सभी वर्शन',
    'mods.addManual': 'मैन्युअल इंस्टॉल',
    'nav.gameFolder': 'गेम फ़ोल्डर',
    'nav.refreshVersion': 'क्लाइंट अपडेट करें',
    'nav.refreshVersionConfirm': 'वर्शन {version} की फ़ाइलें फिर से इंस्टॉल करें? अगली बार लॉन्च करने पर लॉन्चर गेम क्लाइंट और लोडर फिर से डाउनलोड करेगा।',
    'hero.searchingSnapshots': 'स्नैपशॉट खोजे जा रहे हैं...',
    'mods.dropHint': 'फ़ाइलें यहाँ खींचें',
    'mods.browseFiles': 'फ़ाइलें चुनें',
    'mods.archiveNoJars': 'आर्काइव में कोई भी मॉड .jar फ़ाइल नहीं मिली',
    'mods.badModFile': 'फ़ाइल .jar, .zip या मॉड्स वाली .rar होनी चाहिए',
    'mods.badZipFile': 'फ़ाइल .zip या .rar फॉर्मेट में होनी चाहिए',
    'mods.badMapFile': 'आर्काइव में कोई वर्ल्ड नहीं मिला (level.dat नहीं है)',
    'loader.modpacks': 'मॉडपैक',
    'mods.scope.vanilla': 'सामान्य गेम',
    'mods.scope.modpack': 'मॉडपैक',
    'mods.duplicateNameError': 'इस नाम का मॉड इस वर्शन के लिए किसी और स्रोत से पहले ही इंस्टॉल है',
    'mods.filter.scope.current': 'वर्तमान वर्शन',
    'mods.filter.scope.all': 'सभी वर्शन',
    'instance.modsTitle': 'इंस्टेंस के मॉड्स',
    'instance.addMods': '+ मॉड्स जोड़ें',
    'instance.noMods': 'इस इंस्टेंस में अभी कोई मॉड नहीं है',
    'instance.deleteBtn': 'इंस्टेंस हटाएं',
    'instance.confirmDelete': 'क्या इंस्टेंस "{name}" को उसके सभी मॉड्स और सेव के साथ हटाना है? इसे वापस नहीं लाया जा सकता।',
    'home.tabOverview': 'अवलोकन',
    'home.tabUpdates': 'अपडेट्स',
    'updates.title': 'अपडेट इतिहास',
    'updates.subtitle': '1.0 रिलीज़ से लेकर अब तक हर बड़े Minecraft अपडेट में क्या नया आया, इसकी एक झलक।',
    'settings.tab.account': 'खाता',
    'settings.tab.launcher': 'लॉन्चर सेटिंग्स',
    'settings.tab.game': 'गेम सेटिंग्स',
    'settings.launcher.placeholder': 'और लॉन्चर सेटिंग्स बाद में यहाँ दिखेंगी',
    'settings.account.rotateHint': 'स्किन घुमाने के लिए खींचें',
    'settings.account.skinSystem.label': 'स्किन सिस्टम',
    'settings.account.skinSystem.hint': 'लॉन्चर आपकी स्किन कहाँ से लेता है',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins अभी विकास में है',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (विकासाधीन)',
    'settings.account.changeSkin': 'स्किन बदलें',
    'skinChange.title': 'स्किन बदलें',
    'skinChange.desc': 'स्किन बदलने के लिए, Ely.by पर रजिस्टर करें या लॉगिन करें — लॉन्चर अपने आप नई स्किन ले लेगा।',
    'skinChange.dontShowAgain': 'दोबारा न दिखाएं',
    'skinChange.goBtn': 'Ely.by पर जाएं',
    'account.addAccount': '+ खाता जोड़ें',
    'account.noAccounts': 'अभी तक कोई खाता नहीं जोड़ा गया',
    'account.settingsTooltip': 'खाता सेटिंग्स',
    'account.accountsListLabel': 'खाते',
    'account.changePasswordLabel': 'पासवर्ड बदलें',
    'account.changePasswordHint': 'केवल Magma खातों के लिए उपलब्ध',
    'account.currentPasswordPlaceholder': 'मौजूदा पासवर्ड',
    'account.newPasswordPlaceholder': 'नया पासवर्ड',
    'account.changePasswordBtn': 'पासवर्ड बदलें',
    'account.changingPassword': 'पासवर्ड बदला जा रहा है...',
    'account.passwordChanged': 'पासवर्ड सफलतापूर्वक बदला गया',
    'account.notMagmaAccount': 'पासवर्ड बदलना केवल Magma खातों के लिए उपलब्ध है',
    'account.logoutBtn': 'खाते से लॉग आउट करें',
    'account.deleteBtn': 'खाता हटाएं',
    'account.logoutConfirmTitle': 'लॉग आउट करें?',
    'account.logoutConfirmDesc': 'क्या आप वाकई लॉग आउट करना चाहते हैं?',
    'account.logoutConfirmBtn': 'लॉग आउट',
    'account.deleteConfirmTitle': 'खाता हटाएं?',
    'account.deleteConfirmDesc': 'यह कार्रवाई अपरिवर्तनीय है, खाता हमेशा के लिए हटा दिया जाएगा।',
    'account.deleteConfirmBtn': 'हमेशा के लिए हटाएं',
    'account.deleting': 'हटाया जा रहा है...',
    'settings.account.viewerLoadError': 'स्किन मॉडल लोड नहीं हो सका',
    'settings.fullscreen.label': 'फुलस्क्रीन मोड',
    'settings.fullscreen.hint': 'गेम फुलस्क्रीन में शुरू होगा',
    'settings.resolution.label': 'विंडो रिज़ॉल्यूशन',
    'settings.resolution.hint': 'लॉन्च के समय विंडो का आकार (फुलस्क्रीन में उपलब्ध नहीं)',
    'settings.resolution.default': 'डिफ़ॉल्ट',
    'settings.resolution.custom': 'कस्टम...',
    'settings.resolution.width': 'चौड़ाई',
    'settings.resolution.height': 'ऊंचाई',
    'settings.java.autoDetect': 'ऑटो-डिटेक्ट',
    'settings.java.browse': 'ब्राउज़ करें',
    'settings.java.autoDetectNotFound': 'इस सिस्टम पर कोई Java इंस्टॉलेशन नहीं मिला',
    'settings.java.autoPlaceholder': 'स्वचालित',
    'settings.jvmArgs.label': 'JVM आर्ग्युमेंट्स',
    'settings.jvmArgs.hint': 'एडवांस्ड यूज़र्स के लिए अतिरिक्त फ्लैग्स',
    'settings.jvmArgs.presetG1GC': 'G1GC (अनुशंसित)',
    'settings.jvmArgs.presetClear': 'साफ़ करें',
    'settings.jvmArgs.modeDefault': 'मानक',
    'settings.jvmArgs.simpleHint': 'गेम की स्मूदनेस पर असर डालता है। अनिश्चित हों तो "मानक" रहने दें',
    'settings.jvmArgs.advancedShow': 'अपने फ्लैग्स (एडवांस्ड)',
    'settings.dir.modeMagma': 'MagmaLauncher (डिफ़ॉल्ट)',
    'settings.dir.modeVanilla': '.minecraft (आधिकारिक लॉन्चर का फ़ोल्डर)',
    'settings.dir.modeCustom': 'कस्टम फ़ोल्डर',
    'settings.dir.browse': 'ब्राउज़ करें',
    'settings.dir.move': 'गेम फ़ोल्डर स्थानांतरित करें',
    'settings.dir.moving': 'गेम फ़ोल्डर स्थानांतरित हो रहा है...',
    'settings.dir.moved': 'गेम फ़ोल्डर स्थानांतरित हो गया',
    'settings.dir.devOnlyExe': 'गेम फ़ोल्डर प्रबंधन केवल बिल्ड की गई .exe से काम करता है',
    'settings.resetBtn': 'रीसेट',
    'settings.launcherCat.interface': 'इंटरफ़ेस',
    'settings.launcherCat.notifications': 'सूचनाएं',
    'settings.launcherCat.performance': 'प्रदर्शन',
    'settings.launcherCat.privacy': 'गोपनीयता',
    'settings.launcherCat.updates': 'लॉन्चर अपडेट',
    'settings.launcherCat.badge': 'विकासाधीन',
    'settings.launcherCat.notifications.hint': 'नए वर्शन, सर्वर इवेंट्स और डाउनलोड स्थिति की सूचनाएं यहाँ दिखेंगी।',
    'settings.launcherCat.performance.hint': 'FPS सीमा, इंटरफ़ेस एनिमेशन और लॉन्चर संसाधन उपयोग की सेटिंग्स।',
    'settings.launcherCat.privacy.hint': 'टेलीमेट्री और सेवा सुधारने के लिए लॉन्चर द्वारा भेजे गए डेटा का प्रबंधन करें।',
    'settings.launcherCat.updates.hint': 'लॉन्चर के स्वचालित अपडेट और अपडेट चैनल (स्थिर/बीटा)।',
  },
  id: {
    'instances.import': 'Impor dari file',
    'instances.importing': 'Mengimpor...',
    'instances.allVersions': 'Semua versi',
    'mods.addManual': 'Instalasi manual',
    'nav.gameFolder': 'Folder game',
    'nav.refreshVersion': 'Perbarui klien',
    'nav.refreshVersionConfirm': 'Instal ulang file untuk versi {version}? Launcher akan mengunduh ulang klien game dan loader saat peluncuran berikutnya.',
    'hero.searchingSnapshots': 'Mencari snapshot...',
    'mods.dropHint': 'Seret file ke sini',
    'mods.browseFiles': 'Pilih file',
    'mods.archiveNoJars': 'Tidak ditemukan file .jar mod di dalam arsip',
    'mods.badModFile': 'File harus berupa .jar, .zip, atau .rar berisi mod',
    'mods.badZipFile': 'File harus dalam format .zip atau .rar',
    'mods.badMapFile': 'Tidak ditemukan world di dalam arsip (level.dat tidak ada)',
    'loader.modpacks': 'Modpack',
    'mods.scope.vanilla': 'Game normal',
    'mods.scope.modpack': 'Modpack',
    'mods.duplicateNameError': 'Mod dengan nama ini sudah diinstal dari sumber lain untuk versi ini',
    'mods.filter.scope.current': 'Versi saat ini',
    'mods.filter.scope.all': 'Semua versi',
    'instance.modsTitle': 'Mod instance',
    'instance.addMods': '+ Tambah mod',
    'instance.noMods': 'Instance ini belum punya mod',
    'instance.deleteBtn': 'Hapus instance',
    'instance.confirmDelete': 'Hapus instance "{name}" beserta semua mod dan save-nya? Tindakan ini tidak dapat dibatalkan.',
    'home.tabOverview': 'Ikhtisar',
    'home.tabUpdates': 'Pembaruan',
    'updates.title': 'Riwayat Pembaruan',
    'updates.subtitle': 'Ringkasan singkat tentang apa yang dibawa setiap pembaruan besar Minecraft sejak rilis 1.0.',
    'settings.tab.account': 'Akun',
    'settings.tab.launcher': 'Pengaturan launcher',
    'settings.tab.game': 'Pengaturan game',
    'settings.launcher.placeholder': 'Pengaturan launcher lainnya akan muncul di sini nanti',
    'settings.account.rotateHint': 'Seret untuk memutar skin',
    'settings.account.skinSystem.label': 'Sistem skin',
    'settings.account.skinSystem.hint': 'Dari mana launcher mengambil skin Anda',
    'settings.account.skinSystem.magmaSoon': 'Magma Skins masih dalam pengembangan',
    'settings.account.skinSystem.magmaLabel': 'Magma Skins (dalam pengembangan)',
    'settings.account.changeSkin': 'Ganti skin',
    'skinChange.title': 'Ganti skin',
    'skinChange.desc': 'Untuk mengganti skin, daftar atau masuk di Ely.by — launcher akan otomatis mengambil skin baru.',
    'skinChange.dontShowAgain': 'Jangan tampilkan lagi',
    'skinChange.goBtn': 'Buka Ely.by',
    'account.addAccount': '+ Tambah akun',
    'account.noAccounts': 'Belum ada akun yang ditambahkan',
    'account.settingsTooltip': 'Pengaturan akun',
    'account.accountsListLabel': 'Akun',
    'account.changePasswordLabel': 'Ubah kata sandi',
    'account.changePasswordHint': 'Hanya tersedia untuk akun Magma',
    'account.currentPasswordPlaceholder': 'Kata sandi saat ini',
    'account.newPasswordPlaceholder': 'Kata sandi baru',
    'account.changePasswordBtn': 'Ubah kata sandi',
    'account.changingPassword': 'Mengubah kata sandi...',
    'account.passwordChanged': 'Kata sandi berhasil diubah',
    'account.notMagmaAccount': 'Mengubah kata sandi hanya tersedia untuk akun Magma',
    'account.logoutBtn': 'Keluar dari akun',
    'account.deleteBtn': 'Hapus akun',
    'account.logoutConfirmTitle': 'Keluar dari akun?',
    'account.logoutConfirmDesc': 'Yakin ingin keluar?',
    'account.logoutConfirmBtn': 'Keluar',
    'account.deleteConfirmTitle': 'Hapus akun?',
    'account.deleteConfirmDesc': 'Tindakan ini tidak dapat dibatalkan, akun akan dihapus selamanya.',
    'account.deleteConfirmBtn': 'Hapus selamanya',
    'account.deleting': 'Menghapus...',
    'settings.account.viewerLoadError': 'Gagal memuat model skin',
    'settings.fullscreen.label': 'Mode layar penuh',
    'settings.fullscreen.hint': 'Game akan dijalankan dalam mode layar penuh',
    'settings.resolution.label': 'Resolusi jendela',
    'settings.resolution.hint': 'Ukuran jendela saat diluncurkan (tidak tersedia dalam mode layar penuh)',
    'settings.resolution.default': 'Default',
    'settings.resolution.custom': 'Kustom...',
    'settings.resolution.width': 'Lebar',
    'settings.resolution.height': 'Tinggi',
    'settings.java.autoDetect': 'Deteksi otomatis',
    'settings.java.browse': 'Jelajahi',
    'settings.java.autoDetectNotFound': 'Tidak ditemukan instalasi Java di sistem ini',
    'settings.java.autoPlaceholder': 'Otomatis',
    'settings.jvmArgs.label': 'Argumen JVM',
    'settings.jvmArgs.hint': 'Flag tambahan untuk pengguna tingkat lanjut',
    'settings.jvmArgs.presetG1GC': 'G1GC (disarankan)',
    'settings.jvmArgs.presetClear': 'Hapus',
    'settings.jvmArgs.modeDefault': 'Standar',
    'settings.jvmArgs.simpleHint': 'Mempengaruhi kelancaran game. Jika ragu, biarkan di "Standar"',
    'settings.jvmArgs.advancedShow': 'Flag kustom (lanjutan)',
    'settings.dir.modeMagma': 'MagmaLauncher (default)',
    'settings.dir.modeVanilla': '.minecraft (folder launcher resmi)',
    'settings.dir.modeCustom': 'Folder kustom',
    'settings.dir.browse': 'Jelajahi',
    'settings.dir.move': 'Pindahkan folder game',
    'settings.dir.moving': 'Memindahkan folder game...',
    'settings.dir.moved': 'Folder game dipindahkan',
    'settings.dir.devOnlyExe': 'Pengelolaan folder game hanya berfungsi dari .exe hasil build',
    'settings.resetBtn': 'Atur ulang',
    'settings.launcherCat.interface': 'Antarmuka',
    'settings.launcherCat.notifications': 'Notifikasi',
    'settings.launcherCat.performance': 'Performa',
    'settings.launcherCat.privacy': 'Privasi',
    'settings.launcherCat.updates': 'Pembaruan launcher',
    'settings.launcherCat.badge': 'Dalam pengembangan',
    'settings.launcherCat.notifications.hint': 'Notifikasi tentang versi baru, acara server, dan status unduhan akan muncul di sini.',
    'settings.launcherCat.performance.hint': 'Pengaturan batas FPS, animasi antarmuka, dan penggunaan sumber daya launcher.',
    'settings.launcherCat.privacy.hint': 'Kelola telemetri dan data yang dikirim launcher untuk meningkatkan layanan.',
    'settings.launcherCat.updates.hint': 'Pembaruan otomatis untuk launcher itu sendiri dan saluran pembaruan (stabil/beta).',
  },
};

Object.keys(I18N_SUPPLEMENT).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_SUPPLEMENT[lang]);
});
I18N['es-ES'] = I18N.es;

Object.keys(I18N_SUPPLEMENT).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_SUPPLEMENT[lang]);
});
I18N['es-ES'] = I18N.es;

// ============================================
// История обновлений Minecraft — краткие, общими словами написанные пункты
// по каждому крупному релизу (не копия официальных patch notes). ru/en
// заполнены полностью, остальные языки используют ru как запасной вариант —
// как и DEFAULT_MODS_BY_LOADER выше по файлу.
// ============================================
// ============================================
// Названия месяцев для истории обновлений — чтобы не переводить дату у
// каждой версии отдельно на каждый язык, а просто переводить 12 названий
// месяцев один раз и собирать дату программно. Для ja/ko формат "год.месяц"
// собирается без отдельных названий (там просто цифра + иероглиф).
// ============================================
const I18N_SUPPLEMENT_2 = {
  ru: {
    'settings.launcherWindow.fullscreen.label': 'Полноэкранный режим лаунчера',
    'settings.launcherWindow.fullscreen.hint': 'Сам лаунчер будет открываться в полноэкранном режиме',
    'settings.launcherWindow.size.label': 'Размер окна лаунчера',
    'settings.launcherWindow.size.hint': 'Размер окна лаунчера при запуске (недоступно в полноэкранном режиме)',
    'settings.heroBgEditor.title': 'Обрезка и расположение фона',
    'settings.heroBgEditor.hint': 'Перетащите картинку, чтобы выбрать, что показывать, и настройте масштаб',
    'settings.heroBgEditor.zoom': 'Масштаб',
    'settings.heroBgEditor.centerBtn': 'По центру',
    'settings.heroBgEditor.saveBtn': 'Сохранить',
    'settings.heroBgEditor.editBtn': 'Обрезать / расположить',
    'contextMenu.cut': 'Вырезать',
    'contextMenu.copy': 'Копировать',
    'contextMenu.paste': 'Вставить',
    'contextMenu.selectAll': 'Выделить всё',
  },
  en: {
    'settings.launcherWindow.fullscreen.label': 'Launcher fullscreen mode',
    'settings.launcherWindow.fullscreen.hint': 'The launcher itself will open in fullscreen',
    'settings.launcherWindow.size.label': 'Launcher window size',
    'settings.launcherWindow.size.hint': 'Launcher window size on startup (unavailable in fullscreen mode)',
    'settings.heroBgEditor.title': 'Crop & position background',
    'settings.heroBgEditor.hint': "Drag the image to choose what's shown, and adjust the zoom",
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Center',
    'settings.heroBgEditor.saveBtn': 'Save',
    'settings.heroBgEditor.editBtn': 'Crop / position',
    'contextMenu.cut': 'Cut',
    'contextMenu.copy': 'Copy',
    'contextMenu.paste': 'Paste',
    'contextMenu.selectAll': 'Select all',
  },
  uk: {
    'settings.launcherWindow.fullscreen.label': 'Повноекранний режим лаунчера',
    'settings.launcherWindow.fullscreen.hint': 'Сам лаунчер відкриватиметься в повноекранному режимі',
    'settings.launcherWindow.size.label': 'Розмір вікна лаунчера',
    'settings.launcherWindow.size.hint': 'Розмір вікна лаунчера під час запуску (недоступно в повноекранному режимі)',
    'settings.heroBgEditor.title': 'Обрізка та розташування фону',
    'settings.heroBgEditor.hint': 'Перетягніть зображення, щоб вибрати, що показувати, і налаштуйте масштаб',
    'settings.heroBgEditor.zoom': 'Масштаб',
    'settings.heroBgEditor.centerBtn': 'По центру',
    'settings.heroBgEditor.saveBtn': 'Зберегти',
    'settings.heroBgEditor.editBtn': 'Обрізати / розташувати',
    'contextMenu.cut': 'Вирізати',
    'contextMenu.copy': 'Копіювати',
    'contextMenu.paste': 'Вставити',
    'contextMenu.selectAll': 'Виділити все',
  },
  fr: {
    'settings.launcherWindow.fullscreen.label': 'Plein écran du launcher',
    'settings.launcherWindow.fullscreen.hint': "Le launcher lui-même s'ouvrira en plein écran",
    'settings.launcherWindow.size.label': 'Taille de la fenêtre du launcher',
    'settings.launcherWindow.size.hint': 'Taille de la fenêtre au démarrage du launcher (indisponible en plein écran)',
    'settings.heroBgEditor.title': 'Recadrer et positionner le fond',
    'settings.heroBgEditor.hint': "Faites glisser l'image pour choisir ce qui est affiché, puis ajustez le zoom",
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Centrer',
    'settings.heroBgEditor.saveBtn': 'Enregistrer',
    'settings.heroBgEditor.editBtn': 'Recadrer / positionner',
    'contextMenu.cut': 'Couper',
    'contextMenu.copy': 'Copier',
    'contextMenu.paste': 'Coller',
    'contextMenu.selectAll': 'Tout sélectionner',
  },
  de: {
    'settings.launcherWindow.fullscreen.label': 'Vollbildmodus des Launchers',
    'settings.launcherWindow.fullscreen.hint': 'Der Launcher selbst startet im Vollbildmodus',
    'settings.launcherWindow.size.label': 'Fenstergröße des Launchers',
    'settings.launcherWindow.size.hint': 'Fenstergröße beim Start des Launchers (im Vollbildmodus nicht verfügbar)',
    'settings.heroBgEditor.title': 'Hintergrund zuschneiden und positionieren',
    'settings.heroBgEditor.hint': 'Ziehe das Bild, um festzulegen, was angezeigt wird, und passe den Zoom an',
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Zentrieren',
    'settings.heroBgEditor.saveBtn': 'Speichern',
    'settings.heroBgEditor.editBtn': 'Zuschneiden / positionieren',
    'contextMenu.cut': 'Ausschneiden',
    'contextMenu.copy': 'Kopieren',
    'contextMenu.paste': 'Einfügen',
    'contextMenu.selectAll': 'Alles auswählen',
  },
  es: {
    'settings.launcherWindow.fullscreen.label': 'Pantalla completa del launcher',
    'settings.launcherWindow.fullscreen.hint': 'El propio launcher se abrirá en pantalla completa',
    'settings.launcherWindow.size.label': 'Tamaño de la ventana del launcher',
    'settings.launcherWindow.size.hint': 'Tamaño de la ventana al iniciar el launcher (no disponible en pantalla completa)',
    'settings.heroBgEditor.title': 'Recortar y posicionar el fondo',
    'settings.heroBgEditor.hint': 'Arrastra la imagen para elegir qué se muestra y ajusta el zoom',
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Centrar',
    'settings.heroBgEditor.saveBtn': 'Guardar',
    'settings.heroBgEditor.editBtn': 'Recortar / posicionar',
    'contextMenu.cut': 'Cortar',
    'contextMenu.copy': 'Copiar',
    'contextMenu.paste': 'Pegar',
    'contextMenu.selectAll': 'Seleccionar todo',
  },
  it: {
    'settings.launcherWindow.fullscreen.label': 'Schermo intero del launcher',
    'settings.launcherWindow.fullscreen.hint': 'Il launcher stesso si aprirà a schermo intero',
    'settings.launcherWindow.size.label': 'Dimensione della finestra del launcher',
    'settings.launcherWindow.size.hint': "Dimensione della finestra all'avvio del launcher (non disponibile a schermo intero)",
    'settings.heroBgEditor.title': 'Ritaglia e posiziona lo sfondo',
    'settings.heroBgEditor.hint': "Trascina l'immagine per scegliere cosa mostrare e regola lo zoom",
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Centra',
    'settings.heroBgEditor.saveBtn': 'Salva',
    'settings.heroBgEditor.editBtn': 'Ritaglia / posiziona',
    'contextMenu.cut': 'Taglia',
    'contextMenu.copy': 'Copia',
    'contextMenu.paste': 'Incolla',
    'contextMenu.selectAll': 'Seleziona tutto',
  },
  pt: {
    'settings.launcherWindow.fullscreen.label': 'Tela cheia do launcher',
    'settings.launcherWindow.fullscreen.hint': 'O próprio launcher abrirá em tela cheia',
    'settings.launcherWindow.size.label': 'Tamanho da janela do launcher',
    'settings.launcherWindow.size.hint': 'Tamanho da janela ao iniciar o launcher (indisponível em tela cheia)',
    'settings.heroBgEditor.title': 'Cortar e posicionar o fundo',
    'settings.heroBgEditor.hint': 'Arraste a imagem para escolher o que é exibido e ajuste o zoom',
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Centralizar',
    'settings.heroBgEditor.saveBtn': 'Salvar',
    'settings.heroBgEditor.editBtn': 'Cortar / posicionar',
    'contextMenu.cut': 'Recortar',
    'contextMenu.copy': 'Copiar',
    'contextMenu.paste': 'Colar',
    'contextMenu.selectAll': 'Selecionar tudo',
  },
  ja: {
    'settings.launcherWindow.fullscreen.label': 'ランチャーのフルスクリーン',
    'settings.launcherWindow.fullscreen.hint': 'ランチャー自体がフルスクリーンで開きます',
    'settings.launcherWindow.size.label': 'ランチャーウィンドウのサイズ',
    'settings.launcherWindow.size.hint': '起動時のランチャーウィンドウサイズ（フルスクリーン時は無効）',
    'settings.heroBgEditor.title': '背景のトリミングと配置',
    'settings.heroBgEditor.hint': '画像をドラッグして表示範囲を選び、ズームを調整してください',
    'settings.heroBgEditor.zoom': 'ズーム',
    'settings.heroBgEditor.centerBtn': '中央に配置',
    'settings.heroBgEditor.saveBtn': '保存',
    'settings.heroBgEditor.editBtn': 'トリミング／配置',
    'contextMenu.cut': '切り取り',
    'contextMenu.copy': 'コピー',
    'contextMenu.paste': '貼り付け',
    'contextMenu.selectAll': 'すべて選択',
  },
  ko: {
    'settings.launcherWindow.fullscreen.label': '런처 전체 화면',
    'settings.launcherWindow.fullscreen.hint': '런처 자체가 전체 화면으로 열립니다',
    'settings.launcherWindow.size.label': '런처 창 크기',
    'settings.launcherWindow.size.hint': '런처 실행 시 창 크기(전체 화면에서는 사용 불가)',
    'settings.heroBgEditor.title': '배경 자르기 및 위치 조정',
    'settings.heroBgEditor.hint': '이미지를 드래그해 보여줄 부분을 선택하고 확대/축소를 조정하세요',
    'settings.heroBgEditor.zoom': '확대/축소',
    'settings.heroBgEditor.centerBtn': '가운데 정렬',
    'settings.heroBgEditor.saveBtn': '저장',
    'settings.heroBgEditor.editBtn': '자르기 / 위치 조정',
    'contextMenu.cut': '잘라내기',
    'contextMenu.copy': '복사',
    'contextMenu.paste': '붙여넣기',
    'contextMenu.selectAll': '모두 선택',
  },
  hi: {
    'settings.launcherWindow.fullscreen.label': 'लॉन्चर फुलस्क्रीन मोड',
    'settings.launcherWindow.fullscreen.hint': 'लॉन्चर खुद फुलस्क्रीन मोड में खुलेगा',
    'settings.launcherWindow.size.label': 'लॉन्चर विंडो का आकार',
    'settings.launcherWindow.size.hint': 'लॉन्चर शुरू होने पर विंडो का आकार (फुलस्क्रीन में उपलब्ध नहीं)',
    'settings.heroBgEditor.title': 'बैकग्राउंड क्रॉप और पोज़िशन करें',
    'settings.heroBgEditor.hint': 'क्या दिखाना है यह चुनने के लिए तस्वीर खींचें और ज़ूम सेट करें',
    'settings.heroBgEditor.zoom': 'ज़ूम',
    'settings.heroBgEditor.centerBtn': 'बीच में रखें',
    'settings.heroBgEditor.saveBtn': 'सेव करें',
    'settings.heroBgEditor.editBtn': 'क्रॉप / पोज़िशन',
    'contextMenu.cut': 'काटें',
    'contextMenu.copy': 'कॉपी करें',
    'contextMenu.paste': 'पेस्ट करें',
    'contextMenu.selectAll': 'सभी चुनें',
  },
  id: {
    'settings.launcherWindow.fullscreen.label': 'Mode layar penuh launcher',
    'settings.launcherWindow.fullscreen.hint': 'Launcher itu sendiri akan terbuka dalam mode layar penuh',
    'settings.launcherWindow.size.label': 'Ukuran jendela launcher',
    'settings.launcherWindow.size.hint': 'Ukuran jendela launcher saat dijalankan (tidak tersedia dalam mode layar penuh)',
    'settings.heroBgEditor.title': 'Potong dan posisikan latar belakang',
    'settings.heroBgEditor.hint': 'Seret gambar untuk memilih apa yang ditampilkan, lalu atur zoom',
    'settings.heroBgEditor.zoom': 'Zoom',
    'settings.heroBgEditor.centerBtn': 'Tengahkan',
    'settings.heroBgEditor.saveBtn': 'Simpan',
    'settings.heroBgEditor.editBtn': 'Potong / posisikan',
    'contextMenu.cut': 'Potong',
    'contextMenu.copy': 'Salin',
    'contextMenu.paste': 'Tempel',
    'contextMenu.selectAll': 'Pilih semua',
  },
};
const I18N_SUPPLEMENT_3 = {
  ru: {
    'news.item1.title': 'Magma Launcher Alpha 1 уже здесь',
    'news.item1.desc': 'Первая публичная альфа лаунчера доступна всем — обновляйтесь и делитесь впечатлениями.',
    'news.item2.title': 'NeoForge и Quilt в каталоге сборок',
    'news.item2.desc': 'Модпаки теперь можно собирать и на этих загрузчиках прямо из каталога.',
    'news.tag.server': 'Совет',
    'news.item3.title': 'Настройте JVM-аргументы',
    'news.item3.desc': 'Профиль G1GC в настройках игры сглаживает фризы — попробуйте, если ловите лаги.',
    'settings.theme.label': 'Тема оформления',
    'settings.theme.hint': 'Новые темы появятся в одном из ближайших обновлений',
    'settings.heroTitle.label': 'Заголовок главного экрана',
    'settings.heroTitle.hint': 'Текст на главной странице лаунчера',
    'settings.hideNews.label': 'Скрыть новости',
    'settings.hideNews.hint': 'Убирает блок новостей — фон главного экрана растянется на всю ширину',
    'settings.navBottom.label': 'Панель навигации снизу',
    'settings.navBottom.hint': 'Перемещает главное меню вниз экрана — вкладки можно перетаскивать местами',
    'settings.mergeModsInstances.label': 'Объединить Моды и Сборки',
    'settings.mergeModsInstances.hint': 'Сборки станут разделом внутри вкладки Моды',
  },
  en: {
    'news.item1.title': 'Magma Launcher Alpha 1 is out',
    'news.item1.desc': 'The first public alpha of the launcher is available to everyone — update and share your feedback.',
    'news.item2.title': 'NeoForge and Quilt in the modpack catalog',
    'news.item2.desc': 'You can now build modpacks with these loaders straight from the catalog.',
    'news.tag.server': 'Tip',
    'news.item3.title': 'Tune your JVM arguments',
    'news.item3.desc': 'The G1GC preset in game settings smooths out stutters — worth trying if you notice lag.',
    'settings.theme.label': 'Theme',
    'settings.theme.hint': 'New themes are coming in an upcoming update',
    'settings.heroTitle.label': 'Home screen title',
    'settings.heroTitle.hint': 'Text shown on the launcher\'s home screen',
    'settings.hideNews.label': 'Hide news',
    'settings.hideNews.hint': 'Removes the news panel — the home screen background stretches to full width',
    'settings.navBottom.label': 'Bottom navigation bar',
    'settings.navBottom.hint': 'Moves the main menu to the bottom of the screen — tabs can be dragged to reorder',
    'settings.mergeModsInstances.label': 'Merge Mods and Instances',
    'settings.mergeModsInstances.hint': 'Instances become a section inside the Mods tab',
  },
  uk: {
    'news.item1.title': 'Magma Launcher Alpha 1 вже тут',
    'news.item1.desc': 'Перша публічна альфа лаунчера доступна всім — оновлюйтесь і діліться враженнями.',
    'news.item2.title': 'NeoForge і Quilt у каталозі збірок',
    'news.item2.desc': 'Тепер можна збирати модпаки і на цих завантажувачах прямо з каталогу.',
    'news.tag.server': 'Порада',
    'news.item3.title': 'Налаштуйте аргументи JVM',
    'news.item3.desc': 'Профіль G1GC у налаштуваннях гри згладжує фризи — спробуйте, якщо ловите лаги.',
    'settings.theme.label': 'Тема оформлення',
    'settings.theme.hint': 'Нові теми з\'являться в одному з найближчих оновлень',
    'settings.heroTitle.label': 'Заголовок головного екрана',
    'settings.heroTitle.hint': 'Текст на головній сторінці лаунчера',
    'settings.hideNews.label': 'Приховати новини',
    'settings.hideNews.hint': 'Прибирає блок новин — фон головного екрана розтягнеться на всю ширину',
    'settings.navBottom.label': 'Панель навігації знизу',
    'settings.navBottom.hint': 'Переміщує головне меню вниз екрана — вкладки можна перетягувати місцями',
    'settings.mergeModsInstances.label': 'Об\'єднати Моди та Збірки',
    'settings.mergeModsInstances.hint': 'Збірки стануть розділом усередині вкладки Моди',
  },
  fr: {
    'news.item1.title': 'Magma Launcher Alpha 1 est sortie',
    'news.item1.desc': 'La première alpha publique du launcher est disponible pour tous — mettez à jour et partagez votre avis.',
    'news.item2.title': 'NeoForge et Quilt dans le catalogue',
    'news.item2.desc': 'Vous pouvez désormais créer des modpacks avec ces loaders directement depuis le catalogue.',
    'news.tag.server': 'Astuce',
    'news.item3.title': 'Réglez vos arguments JVM',
    'news.item3.desc': 'Le préréglage G1GC dans les paramètres du jeu lisse les saccades — à essayer en cas de lag.',
    'settings.theme.label': 'Thème',
    'settings.theme.hint': 'De nouveaux thèmes arriveront dans une prochaine mise à jour',
    'settings.heroTitle.label': 'Titre de l\'écran d\'accueil',
    'settings.heroTitle.hint': 'Texte affiché sur l\'écran d\'accueil du launcher',
    'settings.hideNews.label': 'Masquer les actualités',
    'settings.hideNews.hint': 'Retire le panneau d\'actualités — le fond de l\'écran d\'accueil s\'étend sur toute la largeur',
    'settings.navBottom.label': 'Barre de navigation en bas',
    'settings.navBottom.hint': 'Déplace le menu principal en bas de l\'écran — les onglets peuvent être réorganisés par glisser-déposer',
    'settings.mergeModsInstances.label': 'Fusionner Mods et Instances',
    'settings.mergeModsInstances.hint': 'Les instances deviennent une section dans l\'onglet Mods',
  },
  de: {
    'news.item1.title': 'Magma Launcher Alpha 1 ist da',
    'news.item1.desc': 'Die erste öffentliche Alpha des Launchers ist für alle verfügbar — aktualisieren und Feedback geben.',
    'news.item2.title': 'NeoForge und Quilt im Katalog',
    'news.item2.desc': 'Modpacks lassen sich jetzt auch mit diesen Loadern direkt aus dem Katalog erstellen.',
    'news.tag.server': 'Tipp',
    'news.item3.title': 'JVM-Argumente anpassen',
    'news.item3.desc': 'Das G1GC-Preset in den Spieleinstellungen glättet Ruckler — einen Versuch wert bei Lags.',
    'settings.theme.label': 'Design',
    'settings.theme.hint': 'Neue Designs kommen in einem der nächsten Updates',
    'settings.heroTitle.label': 'Titel des Startbildschirms',
    'settings.heroTitle.hint': 'Text auf der Startseite des Launchers',
    'settings.hideNews.label': 'Neuigkeiten ausblenden',
    'settings.hideNews.hint': 'Entfernt das Neuigkeiten-Panel — der Hintergrund des Startbildschirms füllt die volle Breite',
    'settings.navBottom.label': 'Navigationsleiste unten',
    'settings.navBottom.hint': 'Verschiebt das Hauptmenü an den unteren Bildschirmrand — Tabs lassen sich per Drag & Drop neu anordnen',
    'settings.mergeModsInstances.label': 'Mods und Instanzen zusammenführen',
    'settings.mergeModsInstances.hint': 'Instanzen werden zu einem Bereich im Mods-Tab',
  },
  es: {
    'news.item1.title': 'Magma Launcher Alpha 1 ya está aquí',
    'news.item1.desc': 'La primera alfa pública del launcher ya está disponible para todos — actualiza y cuéntanos qué te parece.',
    'news.item2.title': 'NeoForge y Quilt en el catálogo',
    'news.item2.desc': 'Ahora puedes crear modpacks con estos loaders directamente desde el catálogo.',
    'news.tag.server': 'Consejo',
    'news.item3.title': 'Ajusta tus argumentos JVM',
    'news.item3.desc': 'El preset G1GC en los ajustes del juego suaviza los tirones — pruébalo si notas lag.',
    'settings.theme.label': 'Tema',
    'settings.theme.hint': 'Nuevos temas llegarán en una próxima actualización',
    'settings.heroTitle.label': 'Título de la pantalla de inicio',
    'settings.heroTitle.hint': 'Texto que se muestra en la pantalla de inicio del launcher',
    'settings.hideNews.label': 'Ocultar noticias',
    'settings.hideNews.hint': 'Quita el panel de noticias — el fondo de la pantalla de inicio se expande a todo el ancho',
    'settings.navBottom.label': 'Barra de navegación inferior',
    'settings.navBottom.hint': 'Mueve el menú principal a la parte inferior de la pantalla — las pestañas se pueden reordenar arrastrando',
    'settings.mergeModsInstances.label': 'Combinar Mods e Instancias',
    'settings.mergeModsInstances.hint': 'Las instancias se convierten en una sección dentro de la pestaña Mods',
  },
  it: {
    'news.item1.title': 'Magma Launcher Alpha 1 è arrivata',
    'news.item1.desc': 'La prima alpha pubblica del launcher è disponibile per tutti — aggiorna e facci sapere cosa ne pensi.',
    'news.item2.title': 'NeoForge e Quilt nel catalogo',
    'news.item2.desc': 'Ora puoi creare modpack anche con questi loader direttamente dal catalogo.',
    'news.tag.server': 'Consiglio',
    'news.item3.title': 'Regola gli argomenti JVM',
    'news.item3.desc': 'Il preset G1GC nelle impostazioni di gioco riduce i cali di frame — provalo se noti lag.',
    'settings.theme.label': 'Tema',
    'settings.theme.hint': 'Nuovi temi arriveranno in uno dei prossimi aggiornamenti',
    'settings.heroTitle.label': 'Titolo della schermata iniziale',
    'settings.heroTitle.hint': 'Testo mostrato nella schermata iniziale del launcher',
    'settings.hideNews.label': 'Nascondi le notizie',
    'settings.hideNews.hint': 'Rimuove il pannello notizie — lo sfondo della schermata iniziale si estende a tutta larghezza',
    'settings.navBottom.label': 'Barra di navigazione in basso',
    'settings.navBottom.hint': 'Sposta il menu principale in fondo allo schermo — le schede possono essere riordinate trascinandole',
    'settings.mergeModsInstances.label': 'Unisci Mod e Istanze',
    'settings.mergeModsInstances.hint': 'Le istanze diventano una sezione all\'interno della scheda Mod',
  },
  pt: {
    'news.item1.title': 'O Magma Launcher Alpha 1 já saiu',
    'news.item1.desc': 'A primeira alpha pública do launcher já está disponível para todos — atualize e conte sua opinião.',
    'news.item2.title': 'NeoForge e Quilt no catálogo',
    'news.item2.desc': 'Agora dá para montar modpacks com esses loaders direto do catálogo.',
    'news.tag.server': 'Dica',
    'news.item3.title': 'Ajuste seus argumentos de JVM',
    'news.item3.desc': 'O perfil G1GC nas configurações do jogo suaviza travadas — vale testar se você sente lag.',
    'settings.theme.label': 'Tema',
    'settings.theme.hint': 'Novos temas chegam em uma das próximas atualizações',
    'settings.heroTitle.label': 'Título da tela inicial',
    'settings.heroTitle.hint': 'Texto exibido na tela inicial do launcher',
    'settings.hideNews.label': 'Ocultar notícias',
    'settings.hideNews.hint': 'Remove o painel de notícias — o fundo da tela inicial se expande para a largura total',
    'settings.navBottom.label': 'Barra de navegação inferior',
    'settings.navBottom.hint': 'Move o menu principal para a parte inferior da tela — as abas podem ser reordenadas arrastando',
    'settings.mergeModsInstances.label': 'Unir Mods e Instâncias',
    'settings.mergeModsInstances.hint': 'Instâncias viram uma seção dentro da aba Mods',
  },
  ja: {
    'news.item1.title': 'Magma Launcher Alpha 1 公開',
    'news.item1.desc': 'ランチャーの最初のパブリックアルファが公開されました。アップデートして感想をお聞かせください。',
    'news.item2.title': 'カタログにNeoForgeとQuiltが追加',
    'news.item2.desc': 'これらのローダーでもカタログから直接モッドパックを作成できるようになりました。',
    'news.tag.server': 'ヒント',
    'news.item3.title': 'JVM引数を調整しよう',
    'news.item3.desc': 'ゲーム設定のG1GCプリセットはカクつきを軽減します。ラグを感じたら試してみてください。',
    'settings.theme.label': 'テーマ',
    'settings.theme.hint': '新しいテーマは今後のアップデートで追加予定です',
    'settings.heroTitle.label': 'ホーム画面のタイトル',
    'settings.heroTitle.hint': 'ランチャーのホーム画面に表示されるテキスト',
    'settings.hideNews.label': 'ニュースを非表示',
    'settings.hideNews.hint': 'ニュースパネルを非表示にし、ホーム画面の背景を全幅に広げます',
    'settings.navBottom.label': 'ナビゲーションバーを下に表示',
    'settings.navBottom.hint': 'メインメニューを画面下部に移動します。タブはドラッグで並べ替え可能です',
    'settings.mergeModsInstances.label': 'MODとインスタンスを統合',
    'settings.mergeModsInstances.hint': 'インスタンスがMODタブ内のセクションになります',
  },
  ko: {
    'news.item1.title': 'Magma Launcher Alpha 1 출시',
    'news.item1.desc': '런처의 첫 공개 알파 버전이 출시되었습니다. 업데이트하고 의견을 들려주세요.',
    'news.item2.title': '카탈로그에 NeoForge와 Quilt 추가',
    'news.item2.desc': '이제 이 로더들로도 카탈로그에서 바로 모드팩을 만들 수 있습니다.',
    'news.tag.server': '팁',
    'news.item3.title': 'JVM 인수를 조정해보세요',
    'news.item3.desc': '게임 설정의 G1GC 프리셋은 끊김을 줄여줍니다. 랙이 느껴진다면 시도해보세요.',
    'settings.theme.label': '테마',
    'settings.theme.hint': '새로운 테마는 다음 업데이트에서 추가됩니다',
    'settings.heroTitle.label': '홈 화면 제목',
    'settings.heroTitle.hint': '런처 홈 화면에 표시되는 텍스트',
    'settings.hideNews.label': '뉴스 숨기기',
    'settings.hideNews.hint': '뉴스 패널을 제거하고 홈 화면 배경을 전체 너비로 확장합니다',
    'settings.navBottom.label': '하단 내비게이션 바',
    'settings.navBottom.hint': '메인 메뉴를 화면 하단으로 이동합니다. 탭을 드래그해 순서를 바꿀 수 있습니다',
    'settings.mergeModsInstances.label': '모드와 인스턴스 통합',
    'settings.mergeModsInstances.hint': '인스턴스가 모드 탭 안의 섹션이 됩니다',
  },
  hi: {
    'news.item1.title': 'Magma Launcher Alpha 1 जारी हुआ',
    'news.item1.desc': 'लॉन्चर का पहला सार्वजनिक अल्फा अब सभी के लिए उपलब्ध है — अपडेट करें और अपनी राय बताएं।',
    'news.item2.title': 'कैटलॉग में NeoForge और Quilt',
    'news.item2.desc': 'अब इन लोडर के साथ भी मॉडपैक सीधे कैटलॉग से बनाए जा सकते हैं।',
    'news.tag.server': 'टिप',
    'news.item3.title': 'JVM आर्ग्युमेंट्स सेट करें',
    'news.item3.desc': 'गेम सेटिंग्स में G1GC प्रीसेट फ्रीज़ कम करता है — लैग महसूस हो तो आज़माएं।',
    'settings.theme.label': 'थीम',
    'settings.theme.hint': 'नई थीम आने वाले अपडेट में जोड़ी जाएंगी',
    'settings.heroTitle.label': 'होम स्क्रीन शीर्षक',
    'settings.heroTitle.hint': 'लॉन्चर के होम स्क्रीन पर दिखने वाला टेक्स्ट',
    'settings.hideNews.label': 'समाचार छिपाएं',
    'settings.hideNews.hint': 'समाचार पैनल हटाता है — होम स्क्रीन का बैकग्राउंड पूरी चौड़ाई में फैल जाता है',
    'settings.navBottom.label': 'नीचे नेविगेशन बार',
    'settings.navBottom.hint': 'मुख्य मेनू को स्क्रीन के नीचे ले जाता है — टैब को खींचकर क्रम बदला जा सकता है',
    'settings.mergeModsInstances.label': 'मॉड्स और इंस्टेंस मिलाएं',
    'settings.mergeModsInstances.hint': 'इंस्टेंस मॉड्स टैब के भीतर एक सेक्शन बन जाएंगे',
  },
  id: {
    'news.item1.title': 'Magma Launcher Alpha 1 telah rilis',
    'news.item1.desc': 'Alpha publik pertama launcher kini tersedia untuk semua — perbarui dan beri tahu pendapat Anda.',
    'news.item2.title': 'NeoForge dan Quilt di katalog',
    'news.item2.desc': 'Kini Anda bisa membuat modpack dengan loader ini langsung dari katalog.',
    'news.tag.server': 'Tips',
    'news.item3.title': 'Atur argumen JVM Anda',
    'news.item3.desc': 'Preset G1GC di pengaturan game meredakan stutter — patut dicoba jika Anda merasakan lag.',
    'settings.theme.label': 'Tema',
    'settings.theme.hint': 'Tema baru akan hadir di pembaruan mendatang',
    'settings.heroTitle.label': 'Judul layar utama',
    'settings.heroTitle.hint': 'Teks yang ditampilkan di layar utama launcher',
    'settings.hideNews.label': 'Sembunyikan berita',
    'settings.hideNews.hint': 'Menghapus panel berita — latar layar utama melebar ke seluruh lebar',
    'settings.navBottom.label': 'Bilah navigasi di bawah',
    'settings.navBottom.hint': 'Memindahkan menu utama ke bagian bawah layar — tab bisa diseret untuk diurutkan ulang',
    'settings.mergeModsInstances.label': 'Gabungkan Mod dan Instance',
    'settings.mergeModsInstances.hint': 'Instance menjadi bagian di dalam tab Mod',
  },
};
Object.keys(I18N_SUPPLEMENT_3).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_SUPPLEMENT_3[lang]);
});
I18N['es-ES'] = I18N.es;

Object.keys(I18N_SUPPLEMENT_2).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_SUPPLEMENT_2[lang]);
});

// Небольшой слой интерфейсных переводов, которые раньше оставались хардкодом
// в HTML/названиях тем. Названия самих тем не переводим — только
// пометку «Magma (по умолчанию)», как и просил пользователь.
// Небольшой слой интерфейсных переводов, которые раньше оставались хардкодом
// в HTML/названиях тем. Названия самих тем не переводим — только
// пометку «Magma (по умолчанию)».
const I18N_PERF_PATCH = {
  ru: {
    'settings.perf.reduceMotion.label': 'Отключить анимации интерфейса',
    'settings.perf.reduceMotion.hint': 'Убирает все анимации и плавные переходы — снижает нагрузку на слабых ПК',
    'settings.perf.pauseSkinUnfocused.label': 'Пауза 3D-скина при потере фокуса',
    'settings.perf.pauseSkinUnfocused.hint': 'Останавливает отрисовку 3D-модели скина, когда окно лаунчера свёрнуто или неактивно',
    'settings.perf.disableBlur.label': 'Отключить размытие фона',
    'settings.perf.disableBlur.hint': 'Убирает эффект размытия (blur) в окнах и подсказках — немного разгружает видеокарту',
    'settings.perf.disableGlow.label': 'Отключить свечение и градиенты',
    'settings.perf.disableGlow.hint': 'Убирает декоративное свечение вокруг логотипа и на главном экране',
    'settings.perf.simpleBg.label': 'Упрощённый фон главного экрана',
    'settings.perf.simpleBg.hint': 'Заменяет свою картинку фона и градиенты на простой тёмный фон',
  },
  en: {
    'settings.perf.reduceMotion.label': 'Disable interface animations',
    'settings.perf.reduceMotion.hint': 'Removes all animations and transitions — reduces load on weaker PCs',
    'settings.perf.pauseSkinUnfocused.label': 'Pause 3D skin when unfocused',
    'settings.perf.pauseSkinUnfocused.hint': 'Stops rendering the 3D skin model while the launcher window is minimized or inactive',
    'settings.perf.disableBlur.label': 'Disable background blur',
    'settings.perf.disableBlur.hint': 'Removes the blur effect in windows and tooltips — slightly reduces GPU load',
    'settings.perf.disableGlow.label': 'Disable glow and gradients',
    'settings.perf.disableGlow.hint': 'Removes the decorative glow around the logo and on the home screen',
    'settings.perf.simpleBg.label': 'Simplified home screen background',
    'settings.perf.simpleBg.hint': 'Replaces your custom background image and gradients with a plain dark background',
  },
  uk: {
    'settings.perf.reduceMotion.label': 'Вимкнути анімації інтерфейсу',
    'settings.perf.reduceMotion.hint': 'Прибирає всі анімації та плавні переходи — знижує навантаження на слабких ПК',
    'settings.perf.pauseSkinUnfocused.label': 'Пауза 3D-скіна при втраті фокуса',
    'settings.perf.pauseSkinUnfocused.hint': 'Зупиняє відтворення 3D-моделі скіна, коли вікно лаунчера згорнуте або неактивне',
    'settings.perf.disableBlur.label': 'Вимкнути розмиття фону',
    'settings.perf.disableBlur.hint': 'Прибирає ефект розмиття (blur) у вікнах і підказках — трохи розвантажує відеокарту',
    'settings.perf.disableGlow.label': 'Вимкнути сяйво та градієнти',
    'settings.perf.disableGlow.hint': 'Прибирає декоративне сяйво навколо логотипа та на головному екрані',
    'settings.perf.simpleBg.label': 'Спрощений фон головного екрана',
    'settings.perf.simpleBg.hint': 'Замінює власну картинку фону та градієнти на простий темний фон',
  },
  fr: {
    'settings.perf.reduceMotion.label': "Désactiver les animations de l'interface",
    'settings.perf.reduceMotion.hint': 'Supprime toutes les animations et transitions — réduit la charge sur les PC plus faibles',
    'settings.perf.pauseSkinUnfocused.label': 'Pause du skin 3D hors focus',
    'settings.perf.pauseSkinUnfocused.hint': 'Arrête le rendu du modèle de skin 3D quand la fenêtre du launcher est réduite ou inactive',
    'settings.perf.disableBlur.label': "Désactiver le flou d'arrière-plan",
    'settings.perf.disableBlur.hint': "Supprime l'effet de flou dans les fenêtres et infobulles — réduit légèrement la charge GPU",
    'settings.perf.disableGlow.label': 'Désactiver les lueurs et dégradés',
    'settings.perf.disableGlow.hint': "Supprime la lueur décorative autour du logo et sur l'écran d'accueil",
    'settings.perf.simpleBg.label': "Fond simplifié de l'écran d'accueil",
    'settings.perf.simpleBg.hint': 'Remplace votre image de fond personnalisée et les dégradés par un fond sombre uni',
  },
  de: {
    'settings.perf.reduceMotion.label': 'Oberflächenanimationen deaktivieren',
    'settings.perf.reduceMotion.hint': 'Entfernt alle Animationen und Übergänge — reduziert die Last auf schwächeren PCs',
    'settings.perf.pauseSkinUnfocused.label': '3D-Skin bei Fokusverlust pausieren',
    'settings.perf.pauseSkinUnfocused.hint': 'Stoppt das Rendern des 3D-Skin-Modells, wenn das Launcher-Fenster minimiert oder inaktiv ist',
    'settings.perf.disableBlur.label': 'Hintergrundunschärfe deaktivieren',
    'settings.perf.disableBlur.hint': 'Entfernt den Unschärfeeffekt in Fenstern und Tooltips — reduziert die GPU-Last etwas',
    'settings.perf.disableGlow.label': 'Leuchten und Farbverläufe deaktivieren',
    'settings.perf.disableGlow.hint': 'Entfernt das dekorative Leuchten um das Logo und auf dem Startbildschirm',
    'settings.perf.simpleBg.label': 'Vereinfachter Startbildschirm-Hintergrund',
    'settings.perf.simpleBg.hint': 'Ersetzt dein eigenes Hintergrundbild und Farbverläufe durch einen einfachen dunklen Hintergrund',
  },
  es: {
    'settings.perf.reduceMotion.label': 'Desactivar animaciones de la interfaz',
    'settings.perf.reduceMotion.hint': 'Elimina todas las animaciones y transiciones — reduce la carga en PCs más débiles',
    'settings.perf.pauseSkinUnfocused.label': 'Pausar el skin 3D sin foco',
    'settings.perf.pauseSkinUnfocused.hint': 'Detiene el renderizado del modelo de skin 3D cuando la ventana del launcher está minimizada o inactiva',
    'settings.perf.disableBlur.label': 'Desactivar desenfoque de fondo',
    'settings.perf.disableBlur.hint': 'Elimina el efecto de desenfoque en ventanas y tooltips — reduce ligeramente la carga de la GPU',
    'settings.perf.disableGlow.label': 'Desactivar brillo y degradados',
    'settings.perf.disableGlow.hint': 'Elimina el brillo decorativo alrededor del logo y en la pantalla de inicio',
    'settings.perf.simpleBg.label': 'Fondo simplificado de la pantalla de inicio',
    'settings.perf.simpleBg.hint': 'Reemplaza tu imagen de fondo personalizada y los degradados por un fondo oscuro liso',
  },
  it: {
    'settings.perf.reduceMotion.label': "Disattiva animazioni dell'interfaccia",
    'settings.perf.reduceMotion.hint': 'Rimuove tutte le animazioni e transizioni — riduce il carico sui PC più deboli',
    'settings.perf.pauseSkinUnfocused.label': 'Pausa skin 3D senza focus',
    'settings.perf.pauseSkinUnfocused.hint': "Ferma il rendering del modello skin 3D quando la finestra del launcher è ridotta a icona o inattiva",
    'settings.perf.disableBlur.label': 'Disattiva sfocatura dello sfondo',
    'settings.perf.disableBlur.hint': "Rimuove l'effetto sfocatura nelle finestre e nei tooltip — riduce leggermente il carico sulla GPU",
    'settings.perf.disableGlow.label': 'Disattiva bagliore e gradienti',
    'settings.perf.disableGlow.hint': 'Rimuove il bagliore decorativo attorno al logo e nella schermata iniziale',
    'settings.perf.simpleBg.label': 'Sfondo semplificato della schermata iniziale',
    'settings.perf.simpleBg.hint': 'Sostituisce la tua immagine di sfondo personalizzata e i gradienti con uno sfondo scuro semplice',
  },
  pt: {
    'settings.perf.reduceMotion.label': 'Desativar animações da interface',
    'settings.perf.reduceMotion.hint': 'Remove todas as animações e transições — reduz a carga em PCs mais fracos',
    'settings.perf.pauseSkinUnfocused.label': 'Pausar skin 3D sem foco',
    'settings.perf.pauseSkinUnfocused.hint': 'Interrompe a renderização do modelo de skin 3D quando a janela do launcher está minimizada ou inativa',
    'settings.perf.disableBlur.label': 'Desativar desfoque de fundo',
    'settings.perf.disableBlur.hint': 'Remove o efeito de desfoque em janelas e dicas — reduz um pouco a carga da GPU',
    'settings.perf.disableGlow.label': 'Desativar brilho e gradientes',
    'settings.perf.disableGlow.hint': 'Remove o brilho decorativo ao redor do logo e na tela inicial',
    'settings.perf.simpleBg.label': 'Fundo simplificado da tela inicial',
    'settings.perf.simpleBg.hint': 'Substitui sua imagem de fundo personalizada e os gradientes por um fundo escuro liso',
  },
  ja: {
    'settings.perf.reduceMotion.label': 'インターフェースのアニメーションを無効化',
    'settings.perf.reduceMotion.hint': 'すべてのアニメーションと遷移効果を削除し、性能の低いPCの負荷を軽減します',
    'settings.perf.pauseSkinUnfocused.label': '非フォーカス時に3Dスキンを一時停止',
    'settings.perf.pauseSkinUnfocused.hint': 'ランチャーウィンドウが最小化または非アクティブのとき、3Dスキンモデルの描画を停止します',
    'settings.perf.disableBlur.label': '背景のぼかしを無効化',
    'settings.perf.disableBlur.hint': 'ウィンドウやツールチップのぼかし効果を削除し、GPU負荷をわずかに軽減します',
    'settings.perf.disableGlow.label': '光沢とグラデーションを無効化',
    'settings.perf.disableGlow.hint': 'ロゴ周りやホーム画面の装飾的な光沢を削除します',
    'settings.perf.simpleBg.label': 'ホーム画面の背景を簡素化',
    'settings.perf.simpleBg.hint': 'カスタム背景画像とグラデーションをシンプルな暗い背景に置き換えます',
  },
  ko: {
    'settings.perf.reduceMotion.label': '인터페이스 애니메이션 비활성화',
    'settings.perf.reduceMotion.hint': '모든 애니메이션과 전환 효과를 제거하여 저사양 PC의 부하를 줄입니다',
    'settings.perf.pauseSkinUnfocused.label': '포커스 해제 시 3D 스킨 일시정지',
    'settings.perf.pauseSkinUnfocused.hint': '런처 창이 최소화되거나 비활성 상태일 때 3D 스킨 모델 렌더링을 멈춥니다',
    'settings.perf.disableBlur.label': '배경 흐림 효과 비활성화',
    'settings.perf.disableBlur.hint': '창과 툴팁의 흐림(blur) 효과를 제거하여 GPU 부하를 약간 줄입니다',
    'settings.perf.disableGlow.label': '광채와 그라디언트 비활성화',
    'settings.perf.disableGlow.hint': '로고 주변과 홈 화면의 장식용 광채를 제거합니다',
    'settings.perf.simpleBg.label': '홈 화면 배경 단순화',
    'settings.perf.simpleBg.hint': '사용자 지정 배경 이미지와 그라디언트를 단순한 어두운 배경으로 바꿉니다',
  },
  hi: {
    'settings.perf.reduceMotion.label': 'इंटरफ़ेस एनिमेशन बंद करें',
    'settings.perf.reduceMotion.hint': 'सभी एनिमेशन और ट्रांज़िशन हटाता है — कमज़ोर पीसी पर लोड कम करता है',
    'settings.perf.pauseSkinUnfocused.label': 'फोकस हटने पर 3D स्किन रोकें',
    'settings.perf.pauseSkinUnfocused.hint': 'जब लॉन्चर विंडो मिनिमाइज़ या निष्क्रिय हो तो 3D स्किन मॉडल की रेंडरिंग रोक देता है',
    'settings.perf.disableBlur.label': 'बैकग्राउंड ब्लर बंद करें',
    'settings.perf.disableBlur.hint': 'विंडो और टूलटिप में ब्लर इफ़ेक्ट हटाता है — GPU पर थोड़ा कम लोड डालता है',
    'settings.perf.disableGlow.label': 'चमक और ग्रेडिएंट बंद करें',
    'settings.perf.disableGlow.hint': 'लोगो के आसपास और होम स्क्रीन पर सजावटी चमक हटाता है',
    'settings.perf.simpleBg.label': 'होम स्क्रीन बैकग्राउंड सरल करें',
    'settings.perf.simpleBg.hint': 'आपकी कस्टम बैकग्राउंड तस्वीर और ग्रेडिएंट को एक सादे गहरे बैकग्राउंड से बदल देता है',
  },
  id: {
    'settings.perf.reduceMotion.label': 'Nonaktifkan animasi antarmuka',
    'settings.perf.reduceMotion.hint': 'Menghapus semua animasi dan transisi — mengurangi beban pada PC yang lebih lemah',
    'settings.perf.pauseSkinUnfocused.label': 'Jeda skin 3D saat tidak fokus',
    'settings.perf.pauseSkinUnfocused.hint': 'Menghentikan rendering model skin 3D saat jendela launcher diminimalkan atau tidak aktif',
    'settings.perf.disableBlur.label': 'Nonaktifkan blur latar belakang',
    'settings.perf.disableBlur.hint': 'Menghapus efek blur pada jendela dan tooltip — sedikit mengurangi beban GPU',
    'settings.perf.disableGlow.label': 'Nonaktifkan cahaya dan gradien',
    'settings.perf.disableGlow.hint': 'Menghapus efek cahaya dekoratif di sekitar logo dan di layar utama',
    'settings.perf.simpleBg.label': 'Latar belakang layar utama disederhanakan',
    'settings.perf.simpleBg.hint': 'Mengganti gambar latar belakang kustom dan gradien Anda dengan latar belakang gelap polos',
  },
};
Object.keys(I18N_PERF_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_PERF_PATCH[lang]);
});
const I18N_PRIVACY_PATCH = {
  ru: {
    "settings.privacy.analytics.label": "Отправка анонимной статистики",
    "settings.privacy.analytics.hint": "Помогает улучшать лаунчер — личные данные не передаются",
    "settings.privacy.crashReports.label": "Крэш-репорты",
    "settings.privacy.crashReports.hint": "Сохранять отчёт об ошибке локально, в папку crashreports",
    "settings.privacy.blockTelemetry.label": "Блокировать телеметрию Minecraft",
    "settings.privacy.blockTelemetry.hint": "Не даёт игре отправлять данные на telemetry.mojang.com и sentry.io",
    "settings.privacy.streamerMode.label": "Режим стримера",
    "settings.privacy.streamerMode.hint": "Скрывает никнейм и почту в интерфейсе лаунчера",
    "settings.privacy.launcherLock.label": "Пароль при запуске лаунчера",
    "settings.privacy.launcherLock.hint": "Запрашивать PIN-код при каждом запуске лаунчера",
    "settings.privacy.launcherLock.setupBtn": "Настроить PIN",
    "settings.privacy.discordPresence.label": "Статус в Discord",
    "settings.privacy.discordPresence.hint": "Показывает в Discord, что вы в MagmaLauncher / играете",
    "settings.privacy.sessions.label": "Сессии",
    "settings.privacy.sessions.hint": "Завершить вход на всех устройствах для этого Magma-аккаунта",
    "settings.privacy.sessions.signOutAllBtn": "Выйти со всех устройств",
    "settings.privacy.clearLogs.label": "Локальные данные",
    "settings.privacy.clearLogs.hint": "Очистить кэш поиска и историю прокрутки лаунчера",
    "settings.privacy.clearLogs.btn": "Очистить",
    "settings.privacy.autoDeleteLogs.label": "Авто-удаление логов игры",
    "settings.privacy.autoDeleteLogs.hint": "Удалять логи игры старше 14 дней при каждом запуске",
  },
  en: {
    "settings.privacy.analytics.label": "Send anonymous usage statistics",
    "settings.privacy.analytics.hint": "Helps improve the launcher — no personal data is sent",
    "settings.privacy.crashReports.label": "Crash reports",
    "settings.privacy.crashReports.hint": "Save a local error report to the crashreports folder",
    "settings.privacy.blockTelemetry.label": "Block Minecraft telemetry",
    "settings.privacy.blockTelemetry.hint": "Prevents the game from sending data to telemetry.mojang.com and sentry.io",
    "settings.privacy.streamerMode.label": "Streamer mode",
    "settings.privacy.streamerMode.hint": "Hides your nickname and email in the launcher interface",
    "settings.privacy.launcherLock.label": "Launcher startup password",
    "settings.privacy.launcherLock.hint": "Require a PIN code every time the launcher starts",
    "settings.privacy.launcherLock.setupBtn": "Set up PIN",
    "settings.privacy.discordPresence.label": "Discord status",
    "settings.privacy.discordPresence.hint": "Shows in Discord that you're in MagmaLauncher / playing",
    "settings.privacy.sessions.label": "Sessions",
    "settings.privacy.sessions.hint": "Sign out on all devices for this Magma account",
    "settings.privacy.sessions.signOutAllBtn": "Sign out everywhere",
    "settings.privacy.clearLogs.label": "Local data",
    "settings.privacy.clearLogs.hint": "Clear the search cache and launcher scroll history",
    "settings.privacy.clearLogs.btn": "Clear",
    "settings.privacy.autoDeleteLogs.label": "Auto-delete game logs",
    "settings.privacy.autoDeleteLogs.hint": "Delete game logs older than 14 days on every launch",
  },
  uk: {
    "settings.privacy.analytics.label": "Надсилання анонімної статистики",
    "settings.privacy.analytics.hint": "Допомагає покращувати лаунчер — особисті дані не передаються",
    "settings.privacy.crashReports.label": "Крэш-репорти",
    "settings.privacy.crashReports.hint": "Зберігати звіт про помилку локально, у папку crashreports",
    "settings.privacy.blockTelemetry.label": "Блокувати телеметрію Minecraft",
    "settings.privacy.blockTelemetry.hint": "Не дозволяє грі надсилати дані на telemetry.mojang.com і sentry.io",
    "settings.privacy.streamerMode.label": "Режим стрімера",
    "settings.privacy.streamerMode.hint": "Приховує нікнейм і пошту в інтерфейсі лаунчера",
    "settings.privacy.launcherLock.label": "Пароль під час запуску лаунчера",
    "settings.privacy.launcherLock.hint": "Запитувати PIN-код під час кожного запуску лаунчера",
    "settings.privacy.launcherLock.setupBtn": "Налаштувати PIN",
    "settings.privacy.discordPresence.label": "Статус у Discord",
    "settings.privacy.discordPresence.hint": "Показує в Discord, що ви в MagmaLauncher / граєте",
    "settings.privacy.sessions.label": "Сесії",
    "settings.privacy.sessions.hint": "Завершити вхід на всіх пристроях для цього Magma-акаунта",
    "settings.privacy.sessions.signOutAllBtn": "Вийти з усіх пристроїв",
    "settings.privacy.clearLogs.label": "Локальні дані",
    "settings.privacy.clearLogs.hint": "Очистити кеш пошуку та історію прокручування лаунчера",
    "settings.privacy.clearLogs.btn": "Очистити",
    "settings.privacy.autoDeleteLogs.label": "Автовидалення логів гри",
    "settings.privacy.autoDeleteLogs.hint": "Видаляти логи гри старші 14 днів під час кожного запуску",
  },
  fr: {
    "settings.privacy.analytics.label": "Envoi de statistiques anonymes",
    "settings.privacy.analytics.hint": "Aide à améliorer le launcher — aucune donnée personnelle n\'est envoyée",
    "settings.privacy.crashReports.label": "Rapports de plantage",
    "settings.privacy.crashReports.hint": "Enregistrer un rapport d\'erreur local dans le dossier crashreports",
    "settings.privacy.blockTelemetry.label": "Bloquer la télémétrie de Minecraft",
    "settings.privacy.blockTelemetry.hint": "Empêche le jeu d\'envoyer des données à telemetry.mojang.com et sentry.io",
    "settings.privacy.streamerMode.label": "Mode streamer",
    "settings.privacy.streamerMode.hint": "Masque votre pseudo et votre email dans l\'interface du launcher",
    "settings.privacy.launcherLock.label": "Mot de passe au démarrage du launcher",
    "settings.privacy.launcherLock.hint": "Demander un code PIN à chaque démarrage du launcher",
    "settings.privacy.launcherLock.setupBtn": "Configurer le PIN",
    "settings.privacy.discordPresence.label": "Statut Discord",
    "settings.privacy.discordPresence.hint": "Affiche sur Discord que vous êtes dans MagmaLauncher / en train de jouer",
    "settings.privacy.sessions.label": "Sessions",
    "settings.privacy.sessions.hint": "Se déconnecter sur tous les appareils pour ce compte Magma",
    "settings.privacy.sessions.signOutAllBtn": "Se déconnecter partout",
    "settings.privacy.clearLogs.label": "Données locales",
    "settings.privacy.clearLogs.hint": "Efface le cache de recherche et l\'historique de défilement du launcher",
    "settings.privacy.clearLogs.btn": "Effacer",
    "settings.privacy.autoDeleteLogs.label": "Suppression automatique des journaux de jeu",
    "settings.privacy.autoDeleteLogs.hint": "Supprime les journaux de jeu de plus de 14 jours à chaque lancement",
  },
  de: {
    "settings.privacy.analytics.label": "Anonyme Nutzungsstatistiken senden",
    "settings.privacy.analytics.hint": "Hilft, den Launcher zu verbessern — es werden keine persönlichen Daten übertragen",
    "settings.privacy.crashReports.label": "Absturzberichte",
    "settings.privacy.crashReports.hint": "Fehlerbericht lokal im Ordner crashreports speichern",
    "settings.privacy.blockTelemetry.label": "Minecraft-Telemetrie blockieren",
    "settings.privacy.blockTelemetry.hint": "Verhindert, dass das Spiel Daten an telemetry.mojang.com und sentry.io sendet",
    "settings.privacy.streamerMode.label": "Streamer-Modus",
    "settings.privacy.streamerMode.hint": "Blendet Nickname und E-Mail in der Launcher-Oberfläche aus",
    "settings.privacy.launcherLock.label": "Passwort beim Start des Launchers",
    "settings.privacy.launcherLock.hint": "Bei jedem Start des Launchers einen PIN-Code verlangen",
    "settings.privacy.launcherLock.setupBtn": "PIN einrichten",
    "settings.privacy.discordPresence.label": "Discord-Status",
    "settings.privacy.discordPresence.hint": "Zeigt in Discord, dass du im MagmaLauncher bist / spielst",
    "settings.privacy.sessions.label": "Sitzungen",
    "settings.privacy.sessions.hint": "Auf allen Geräten für dieses Magma-Konto abmelden",
    "settings.privacy.sessions.signOutAllBtn": "Überall abmelden",
    "settings.privacy.clearLogs.label": "Lokale Daten",
    "settings.privacy.clearLogs.hint": "Suchcache und Scroll-Verlauf des Launchers leeren",
    "settings.privacy.clearLogs.btn": "Leeren",
    "settings.privacy.autoDeleteLogs.label": "Spiel-Logs automatisch löschen",
    "settings.privacy.autoDeleteLogs.hint": "Löscht Spiel-Logs, die älter als 14 Tage sind, bei jedem Start",
  },
  es: {
    "settings.privacy.analytics.label": "Envío de estadísticas anónimas",
    "settings.privacy.analytics.hint": "Ayuda a mejorar el launcher — no se envían datos personales",
    "settings.privacy.crashReports.label": "Informes de fallos",
    "settings.privacy.crashReports.hint": "Guardar un informe de error localmente en la carpeta crashreports",
    "settings.privacy.blockTelemetry.label": "Bloquear la telemetría de Minecraft",
    "settings.privacy.blockTelemetry.hint": "Evita que el juego envíe datos a telemetry.mojang.com y sentry.io",
    "settings.privacy.streamerMode.label": "Modo streamer",
    "settings.privacy.streamerMode.hint": "Oculta tu apodo y correo en la interfaz del launcher",
    "settings.privacy.launcherLock.label": "Contraseña al iniciar el launcher",
    "settings.privacy.launcherLock.hint": "Solicitar un código PIN cada vez que se inicia el launcher",
    "settings.privacy.launcherLock.setupBtn": "Configurar PIN",
    "settings.privacy.discordPresence.label": "Estado en Discord",
    "settings.privacy.discordPresence.hint": "Muestra en Discord que estás en MagmaLauncher / jugando",
    "settings.privacy.sessions.label": "Sesiones",
    "settings.privacy.sessions.hint": "Cerrar sesión en todos los dispositivos de esta cuenta Magma",
    "settings.privacy.sessions.signOutAllBtn": "Cerrar sesión en todas partes",
    "settings.privacy.clearLogs.label": "Datos locales",
    "settings.privacy.clearLogs.hint": "Borra la caché de búsqueda y el historial de desplazamiento del launcher",
    "settings.privacy.clearLogs.btn": "Borrar",
    "settings.privacy.autoDeleteLogs.label": "Autoeliminar registros del juego",
    "settings.privacy.autoDeleteLogs.hint": "Elimina los registros del juego de más de 14 días en cada inicio",
  },
  it: {
    "settings.privacy.analytics.label": "Invio di statistiche anonime",
    "settings.privacy.analytics.hint": "Aiuta a migliorare il launcher — nessun dato personale viene inviato",
    "settings.privacy.crashReports.label": "Segnalazioni di arresto anomalo",
    "settings.privacy.crashReports.hint": "Salva un report di errore localmente nella cartella crashreports",
    "settings.privacy.blockTelemetry.label": "Blocca la telemetria di Minecraft",
    "settings.privacy.blockTelemetry.hint": "Impedisce al gioco di inviare dati a telemetry.mojang.com e sentry.io",
    "settings.privacy.streamerMode.label": "Modalità streamer",
    "settings.privacy.streamerMode.hint": "Nasconde nickname ed email nell\'interfaccia del launcher",
    "settings.privacy.launcherLock.label": "Password all\'avvio del launcher",
    "settings.privacy.launcherLock.hint": "Richiedi un codice PIN ad ogni avvio del launcher",
    "settings.privacy.launcherLock.setupBtn": "Configura PIN",
    "settings.privacy.discordPresence.label": "Stato Discord",
    "settings.privacy.discordPresence.hint": "Mostra su Discord che sei in MagmaLauncher / stai giocando",
    "settings.privacy.sessions.label": "Sessioni",
    "settings.privacy.sessions.hint": "Disconnetti da tutti i dispositivi per questo account Magma",
    "settings.privacy.sessions.signOutAllBtn": "Disconnetti ovunque",
    "settings.privacy.clearLogs.label": "Dati locali",
    "settings.privacy.clearLogs.hint": "Cancella la cache di ricerca e la cronologia di scorrimento del launcher",
    "settings.privacy.clearLogs.btn": "Cancella",
    "settings.privacy.autoDeleteLogs.label": "Eliminazione automatica dei log di gioco",
    "settings.privacy.autoDeleteLogs.hint": "Elimina i log di gioco più vecchi di 14 giorni ad ogni avvio",
  },
  pt: {
    "settings.privacy.analytics.label": "Envio de estatísticas anônimas",
    "settings.privacy.analytics.hint": "Ajuda a melhorar o launcher — nenhum dado pessoal é enviado",
    "settings.privacy.crashReports.label": "Relatórios de falha",
    "settings.privacy.crashReports.hint": "Salvar relatório de erro localmente na pasta crashreports",
    "settings.privacy.blockTelemetry.label": "Bloquear telemetria do Minecraft",
    "settings.privacy.blockTelemetry.hint": "Impede o jogo de enviar dados para telemetry.mojang.com e sentry.io",
    "settings.privacy.streamerMode.label": "Modo streamer",
    "settings.privacy.streamerMode.hint": "Oculta seu apelido e email na interface do launcher",
    "settings.privacy.launcherLock.label": "Senha ao iniciar o launcher",
    "settings.privacy.launcherLock.hint": "Solicitar um código PIN a cada início do launcher",
    "settings.privacy.launcherLock.setupBtn": "Configurar PIN",
    "settings.privacy.discordPresence.label": "Status no Discord",
    "settings.privacy.discordPresence.hint": "Mostra no Discord que você está no MagmaLauncher / jogando",
    "settings.privacy.sessions.label": "Sessões",
    "settings.privacy.sessions.hint": "Encerrar sessão em todos os dispositivos desta conta Magma",
    "settings.privacy.sessions.signOutAllBtn": "Sair de todos os dispositivos",
    "settings.privacy.clearLogs.label": "Dados locais",
    "settings.privacy.clearLogs.hint": "Limpa o cache de busca e o histórico de rolagem do launcher",
    "settings.privacy.clearLogs.btn": "Limpar",
    "settings.privacy.autoDeleteLogs.label": "Excluir logs do jogo automaticamente",
    "settings.privacy.autoDeleteLogs.hint": "Exclui logs do jogo com mais de 14 dias a cada inicialização",
  },
  ja: {
    "settings.privacy.analytics.label": "匿名の利用統計を送信",
    "settings.privacy.analytics.hint": "ランチャーの改善に役立ちます — 個人情報は送信されません",
    "settings.privacy.crashReports.label": "クラッシュレポート",
    "settings.privacy.crashReports.hint": "エラーレポートをcrashreportsフォルダにローカル保存します",
    "settings.privacy.blockTelemetry.label": "Minecraftのテレメトリをブロック",
    "settings.privacy.blockTelemetry.hint": "ゲームがtelemetry.mojang.comとsentry.ioにデータを送信しないようにします",
    "settings.privacy.streamerMode.label": "配信者モード",
    "settings.privacy.streamerMode.hint": "ランチャーのインターフェースでニックネームとメールを非表示にします",
    "settings.privacy.launcherLock.label": "ランチャー起動時のパスワード",
    "settings.privacy.launcherLock.hint": "ランチャー起動のたびにPINコードを要求します",
    "settings.privacy.launcherLock.setupBtn": "PINを設定",
    "settings.privacy.discordPresence.label": "Discordステータス",
    "settings.privacy.discordPresence.hint": "MagmaLauncherを使用中/プレイ中であることをDiscordに表示します",
    "settings.privacy.sessions.label": "セッション",
    "settings.privacy.sessions.hint": "このMagmaアカウントの全デバイスでログアウトします",
    "settings.privacy.sessions.signOutAllBtn": "すべてのデバイスからログアウト",
    "settings.privacy.clearLogs.label": "ローカルデータ",
    "settings.privacy.clearLogs.hint": "検索キャッシュとランチャーのスクロール履歴を消去します",
    "settings.privacy.clearLogs.btn": "消去",
    "settings.privacy.autoDeleteLogs.label": "ゲームログの自動削除",
    "settings.privacy.autoDeleteLogs.hint": "起動のたびに14日以上前のゲームログを削除します",
  },
  ko: {
    "settings.privacy.analytics.label": "익명 사용 통계 전송",
    "settings.privacy.analytics.hint": "런처 개선에 도움이 됩니다 — 개인 정보는 전송되지 않습니다",
    "settings.privacy.crashReports.label": "충돌 보고서",
    "settings.privacy.crashReports.hint": "오류 보고서를 crashreports 폴더에 로컬로 저장합니다",
    "settings.privacy.blockTelemetry.label": "Minecraft 원격 측정 차단",
    "settings.privacy.blockTelemetry.hint": "게임이 telemetry.mojang.com 및 sentry.io로 데이터를 보내지 못하게 합니다",
    "settings.privacy.streamerMode.label": "스트리머 모드",
    "settings.privacy.streamerMode.hint": "런처 인터페이스에서 닉네임과 이메일을 숨깁니다",
    "settings.privacy.launcherLock.label": "런처 시작 시 비밀번호",
    "settings.privacy.launcherLock.hint": "런처를 시작할 때마다 PIN 코드를 요구합니다",
    "settings.privacy.launcherLock.setupBtn": "PIN 설정",
    "settings.privacy.discordPresence.label": "Discord 상태",
    "settings.privacy.discordPresence.hint": "MagmaLauncher 사용 중/플레이 중임을 Discord에 표시합니다",
    "settings.privacy.sessions.label": "세션",
    "settings.privacy.sessions.hint": "이 Magma 계정의 모든 기기에서 로그아웃합니다",
    "settings.privacy.sessions.signOutAllBtn": "모든 기기에서 로그아웃",
    "settings.privacy.clearLogs.label": "로컬 데이터",
    "settings.privacy.clearLogs.hint": "검색 캐시와 런처 스크롤 기록을 지웁니다",
    "settings.privacy.clearLogs.btn": "지우기",
    "settings.privacy.autoDeleteLogs.label": "게임 로그 자동 삭제",
    "settings.privacy.autoDeleteLogs.hint": "실행할 때마다 14일 이상 된 게임 로그를 삭제합니다",
  },
  hi: {
    "settings.privacy.analytics.label": "अनाम आँकड़े भेजना",
    "settings.privacy.analytics.hint": "लॉन्चर को बेहतर बनाने में मदद करता है — कोई व्यक्तिगत डेटा नहीं भेजा जाता",
    "settings.privacy.crashReports.label": "क्रैश रिपोर्ट",
    "settings.privacy.crashReports.hint": "त्रुटि रिपोर्ट को स्थानीय रूप से crashreports फ़ोल्डर में सहेजें",
    "settings.privacy.blockTelemetry.label": "Minecraft टेलीमेट्री ब्लॉक करें",
    "settings.privacy.blockTelemetry.hint": "गेम को telemetry.mojang.com और sentry.io पर डेटा भेजने से रोकता है",
    "settings.privacy.streamerMode.label": "स्ट्रीमर मोड",
    "settings.privacy.streamerMode.hint": "लॉन्चर इंटरफ़ेस में निकनेम और ईमेल छुपाता है",
    "settings.privacy.launcherLock.label": "लॉन्चर शुरू होने पर पासवर्ड",
    "settings.privacy.launcherLock.hint": "हर बार लॉन्चर शुरू होने पर PIN कोड माँगें",
    "settings.privacy.launcherLock.setupBtn": "PIN सेट करें",
    "settings.privacy.discordPresence.label": "Discord स्टेटस",
    "settings.privacy.discordPresence.hint": "Discord में दिखाता है कि आप MagmaLauncher में हैं / खेल रहे हैं",
    "settings.privacy.sessions.label": "सत्र",
    "settings.privacy.sessions.hint": "इस Magma खाते के सभी डिवाइस पर लॉग आउट करें",
    "settings.privacy.sessions.signOutAllBtn": "सभी डिवाइस से लॉग आउट करें",
    "settings.privacy.clearLogs.label": "स्थानीय डेटा",
    "settings.privacy.clearLogs.hint": "खोज कैश और लॉन्चर की स्क्रॉल हिस्ट्री साफ़ करें",
    "settings.privacy.clearLogs.btn": "साफ़ करें",
    "settings.privacy.autoDeleteLogs.label": "गेम लॉग का ऑटो-डिलीट",
    "settings.privacy.autoDeleteLogs.hint": "हर बार लॉन्च पर 14 दिनों से पुराने गेम लॉग हटाएं",
  },
  id: {
    "settings.privacy.analytics.label": "Kirim statistik anonim",
    "settings.privacy.analytics.hint": "Membantu meningkatkan launcher — tidak ada data pribadi yang dikirim",
    "settings.privacy.crashReports.label": "Laporan crash",
    "settings.privacy.crashReports.hint": "Simpan laporan error secara lokal ke folder crashreports",
    "settings.privacy.blockTelemetry.label": "Blokir telemetri Minecraft",
    "settings.privacy.blockTelemetry.hint": "Mencegah game mengirim data ke telemetry.mojang.com dan sentry.io",
    "settings.privacy.streamerMode.label": "Mode streamer",
    "settings.privacy.streamerMode.hint": "Menyembunyikan nickname dan email di antarmuka launcher",
    "settings.privacy.launcherLock.label": "Kata sandi saat memulai launcher",
    "settings.privacy.launcherLock.hint": "Meminta kode PIN setiap kali launcher dimulai",
    "settings.privacy.launcherLock.setupBtn": "Atur PIN",
    "settings.privacy.discordPresence.label": "Status Discord",
    "settings.privacy.discordPresence.hint": "Menampilkan di Discord bahwa Anda sedang di MagmaLauncher / bermain",
    "settings.privacy.sessions.label": "Sesi",
    "settings.privacy.sessions.hint": "Keluar dari semua perangkat untuk akun Magma ini",
    "settings.privacy.sessions.signOutAllBtn": "Keluar dari semua perangkat",
    "settings.privacy.clearLogs.label": "Data lokal",
    "settings.privacy.clearLogs.hint": "Hapus cache pencarian dan riwayat scroll launcher",
    "settings.privacy.clearLogs.btn": "Hapus",
    "settings.privacy.autoDeleteLogs.label": "Hapus log game otomatis",
    "settings.privacy.autoDeleteLogs.hint": "Menghapus log game yang lebih lama dari 14 hari setiap peluncuran",
  },
};
Object.keys(I18N_PRIVACY_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_PRIVACY_PATCH[lang]);
});
I18N['es-ES'] = I18N.es;
const I18N_LOCKSCREEN_PATCH = {
  ru: {
    'settings.privacy.launcherLock.setupTitle': 'Настройка PIN-кода',
    'settings.privacy.launcherLock.newPinLabel': 'Новый PIN-код',
    'settings.privacy.launcherLock.saveBtn': 'Сохранить',
    'settings.privacy.launcherLock.enterTitle': 'Введите PIN-код',
    'settings.privacy.launcherLock.unlockBtn': 'Разблокировать',
    'settings.privacy.launcherLock.wrongPin': 'Неверный PIN-код',
    'settings.privacy.launcherLock.weakPin': 'PIN должен быть не короче 4 символов',
    'settings.privacy.clearLogs.done': 'Готово, локальные данные очищены',
  },
  en: {
    'settings.privacy.launcherLock.setupTitle': 'Set up PIN code',
    'settings.privacy.launcherLock.newPinLabel': 'New PIN code',
    'settings.privacy.launcherLock.saveBtn': 'Save',
    'settings.privacy.launcherLock.enterTitle': 'Enter PIN code',
    'settings.privacy.launcherLock.unlockBtn': 'Unlock',
    'settings.privacy.launcherLock.wrongPin': 'Incorrect PIN code',
    'settings.privacy.launcherLock.weakPin': 'PIN must be at least 4 characters',
    'settings.privacy.clearLogs.done': 'Done, local data cleared',
  },
  uk: {
    'settings.privacy.launcherLock.setupTitle': 'Налаштування PIN-коду',
    'settings.privacy.launcherLock.newPinLabel': 'Новий PIN-код',
    'settings.privacy.launcherLock.saveBtn': 'Зберегти',
    'settings.privacy.launcherLock.enterTitle': 'Введіть PIN-код',
    'settings.privacy.launcherLock.unlockBtn': 'Розблокувати',
    'settings.privacy.launcherLock.wrongPin': 'Невірний PIN-код',
    'settings.privacy.launcherLock.weakPin': 'PIN має бути не коротшим за 4 символи',
    'settings.privacy.clearLogs.done': 'Готово, локальні дані очищено',
  },
  fr: {
    'settings.privacy.launcherLock.setupTitle': 'Configurer le code PIN',
    'settings.privacy.launcherLock.newPinLabel': 'Nouveau code PIN',
    'settings.privacy.launcherLock.saveBtn': 'Enregistrer',
    'settings.privacy.launcherLock.enterTitle': 'Entrez le code PIN',
    'settings.privacy.launcherLock.unlockBtn': 'Déverrouiller',
    'settings.privacy.launcherLock.wrongPin': 'Code PIN incorrect',
    'settings.privacy.launcherLock.weakPin': 'Le code PIN doit comporter au moins 4 caractères',
    'settings.privacy.clearLogs.done': 'Terminé, données locales effacées',
  },
  de: {
    'settings.privacy.launcherLock.setupTitle': 'PIN-Code einrichten',
    'settings.privacy.launcherLock.newPinLabel': 'Neuer PIN-Code',
    'settings.privacy.launcherLock.saveBtn': 'Speichern',
    'settings.privacy.launcherLock.enterTitle': 'PIN-Code eingeben',
    'settings.privacy.launcherLock.unlockBtn': 'Entsperren',
    'settings.privacy.launcherLock.wrongPin': 'Falscher PIN-Code',
    'settings.privacy.launcherLock.weakPin': 'Der PIN muss mindestens 4 Zeichen lang sein',
    'settings.privacy.clearLogs.done': 'Fertig, lokale Daten gelöscht',
  },
  es: {
    'settings.privacy.launcherLock.setupTitle': 'Configurar código PIN',
    'settings.privacy.launcherLock.newPinLabel': 'Nuevo código PIN',
    'settings.privacy.launcherLock.saveBtn': 'Guardar',
    'settings.privacy.launcherLock.enterTitle': 'Introduce el código PIN',
    'settings.privacy.launcherLock.unlockBtn': 'Desbloquear',
    'settings.privacy.launcherLock.wrongPin': 'Código PIN incorrecto',
    'settings.privacy.launcherLock.weakPin': 'El PIN debe tener al menos 4 caracteres',
    'settings.privacy.clearLogs.done': 'Listo, datos locales borrados',
  },
  it: {
    'settings.privacy.launcherLock.setupTitle': 'Configura codice PIN',
    'settings.privacy.launcherLock.newPinLabel': 'Nuovo codice PIN',
    'settings.privacy.launcherLock.saveBtn': 'Salva',
    'settings.privacy.launcherLock.enterTitle': 'Inserisci il codice PIN',
    'settings.privacy.launcherLock.unlockBtn': 'Sblocca',
    'settings.privacy.launcherLock.wrongPin': 'Codice PIN errato',
    'settings.privacy.launcherLock.weakPin': 'Il PIN deve avere almeno 4 caratteri',
    'settings.privacy.clearLogs.done': 'Fatto, dati locali cancellati',
  },
  pt: {
    'settings.privacy.launcherLock.setupTitle': 'Configurar código PIN',
    'settings.privacy.launcherLock.newPinLabel': 'Novo código PIN',
    'settings.privacy.launcherLock.saveBtn': 'Salvar',
    'settings.privacy.launcherLock.enterTitle': 'Digite o código PIN',
    'settings.privacy.launcherLock.unlockBtn': 'Desbloquear',
    'settings.privacy.launcherLock.wrongPin': 'Código PIN incorreto',
    'settings.privacy.launcherLock.weakPin': 'O PIN deve ter pelo menos 4 caracteres',
    'settings.privacy.clearLogs.done': 'Pronto, dados locais apagados',
  },
  ja: {
    'settings.privacy.launcherLock.setupTitle': 'PINコードを設定',
    'settings.privacy.launcherLock.newPinLabel': '新しいPINコード',
    'settings.privacy.launcherLock.saveBtn': '保存',
    'settings.privacy.launcherLock.enterTitle': 'PINコードを入力',
    'settings.privacy.launcherLock.unlockBtn': 'ロック解除',
    'settings.privacy.launcherLock.wrongPin': 'PINコードが違います',
    'settings.privacy.launcherLock.weakPin': 'PINは4文字以上にしてください',
    'settings.privacy.clearLogs.done': '完了、ローカルデータを消去しました',
  },
  ko: {
    'settings.privacy.launcherLock.setupTitle': 'PIN 코드 설정',
    'settings.privacy.launcherLock.newPinLabel': '새 PIN 코드',
    'settings.privacy.launcherLock.saveBtn': '저장',
    'settings.privacy.launcherLock.enterTitle': 'PIN 코드 입력',
    'settings.privacy.launcherLock.unlockBtn': '잠금 해제',
    'settings.privacy.launcherLock.wrongPin': 'PIN 코드가 올바르지 않습니다',
    'settings.privacy.launcherLock.weakPin': 'PIN은 4자 이상이어야 합니다',
    'settings.privacy.clearLogs.done': '완료, 로컬 데이터가 지워졌습니다',
  },
  hi: {
    'settings.privacy.launcherLock.setupTitle': 'PIN कोड सेट करें',
    'settings.privacy.launcherLock.newPinLabel': 'नया PIN कोड',
    'settings.privacy.launcherLock.saveBtn': 'सेव करें',
    'settings.privacy.launcherLock.enterTitle': 'PIN कोड दर्ज करें',
    'settings.privacy.launcherLock.unlockBtn': 'अनलॉक करें',
    'settings.privacy.launcherLock.wrongPin': 'गलत PIN कोड',
    'settings.privacy.launcherLock.weakPin': 'PIN कम से कम 4 अंकों का होना चाहिए',
    'settings.privacy.clearLogs.done': 'हो गया, लोकल डेटा साफ़ हो गया',
  },
  id: {
    'settings.privacy.launcherLock.setupTitle': 'Atur kode PIN',
    'settings.privacy.launcherLock.newPinLabel': 'Kode PIN baru',
    'settings.privacy.launcherLock.saveBtn': 'Simpan',
    'settings.privacy.launcherLock.enterTitle': 'Masukkan kode PIN',
    'settings.privacy.launcherLock.unlockBtn': 'Buka kunci',
    'settings.privacy.launcherLock.wrongPin': 'Kode PIN salah',
    'settings.privacy.launcherLock.weakPin': 'PIN harus minimal 4 karakter',
    'settings.privacy.clearLogs.done': 'Selesai, data lokal telah dihapus',
  },
};
Object.keys(I18N_LOCKSCREEN_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_LOCKSCREEN_PATCH[lang]);
});
I18N['es-ES'] = I18N.es;
const I18N_DISCORD_PATCH = {
  ru: { 'discord.inLauncher': 'В лаунчере MagmaLauncher', 'discord.playing': 'Играет в Minecraft' },
  en: { 'discord.inLauncher': 'Browsing MagmaLauncher', 'discord.playing': 'Playing Minecraft' },
};
Object.keys(I18N_DISCORD_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_DISCORD_PATCH[lang]);
});
I18N['es-ES'] = I18N.es;
const I18N_INFO_PATCH = {
  ru: { 'settings.launcherCat.info': 'Информация', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Неофициальный лаунчер Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Написан на C++ (CEF) и JavaScript.' },
  en: { 'settings.launcherCat.info': 'Information', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'An unofficial Minecraft: Java Edition launcher. Vanilla, Fabric, Forge, NeoForge, Quilt. Built with C++ (CEF) and JavaScript.' },
  uk: { 'settings.launcherCat.info': 'Інформація', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Неофіційний лаунчер Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Написаний на C++ (CEF) та JavaScript.' },
  fr: { 'settings.launcherCat.info': 'Informations', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Un launcher non officiel pour Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Développé en C++ (CEF) et JavaScript.' },
  de: { 'settings.launcherCat.info': 'Informationen', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Ein inoffizieller Launcher für Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Entwickelt mit C++ (CEF) und JavaScript.' },
  es: { 'settings.launcherCat.info': 'Información', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Un launcher no oficial de Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Creado con C++ (CEF) y JavaScript.' },
  it: { 'settings.launcherCat.info': 'Informazioni', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Un launcher non ufficiale per Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Sviluppato in C++ (CEF) e JavaScript.' },
  pt: { 'settings.launcherCat.info': 'Informações', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Um launcher não oficial do Minecraft: Java Edition. Vanilla, Fabric, Forge, NeoForge, Quilt. Feito em C++ (CEF) e JavaScript.' },
  ja: { 'settings.launcherCat.info': '情報', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Minecraft: Java Editionの非公式ランチャーです。Vanilla、Fabric、Forge、NeoForge、Quiltに対応。C++（CEF）とJavaScriptで開発。' },
  ko: { 'settings.launcherCat.info': '정보', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Minecraft: Java Edition 비공식 런처입니다. Vanilla, Fabric, Forge, NeoForge, Quilt 지원. C++(CEF)와 JavaScript로 제작.' },
  hi: { 'settings.launcherCat.info': 'जानकारी', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Minecraft: Java Edition के लिए एक अनौपचारिक लॉन्चर। Vanilla, Fabric, Forge, NeoForge, Quilt समर्थित। C++ (CEF) और JavaScript में बनाया गया।' },
  id: { 'settings.launcherCat.info': 'Informasi', 'settings.launcherCat.info.title': 'MagmaLauncher Alpha 1', 'settings.launcherCat.info.hint': 'Launcher tidak resmi untuk Minecraft: Java Edition. Mendukung Vanilla, Fabric, Forge, NeoForge, Quilt. Dibuat dengan C++ (CEF) dan JavaScript.' },
};
Object.keys(I18N_INFO_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_INFO_PATCH[lang]);
});
I18N['es-ES'] = I18N.es;
const I18N_INTERFACE_PATCH = {
  "ru": {
    "settings.heroTitle.eyebrowPlaceholder": "Готово к запуску",
    "settings.heroTitle.titlePlaceholder": "Твой мир ждёт",
    "settings.heroTitle.reset": "Сброс",
    "settings.theme.magmaDefault": "Magma (по умолчанию)",
    "settings.heroBg.presetsLabel": "Готовые фоны",
    "settings.heroBg.presetsHint": "Выберите один из фонов или загрузите свою картинку ниже",
    "settings.heroBg.uploadLabel": "Свой фон",
    "settings.heroBg.uploadHint": "JPG, PNG или WebP — после загрузки можно обрезать и расположить картинку",
    "settings.heroBg.uploadBtn": "Загрузить",
    "settings.heroBg.none": "Без фона",
  },
  "en": {
    "settings.heroTitle.eyebrowPlaceholder": "Ready to play",
    "settings.heroTitle.titlePlaceholder": "Your world awaits",
    "settings.heroTitle.reset": "Reset",
    "settings.theme.magmaDefault": "Magma (default)",
    "settings.heroBg.presetsLabel": "Default backgrounds",
    "settings.heroBg.presetsHint": "Pick one of the backgrounds or upload your own image below",
    "settings.heroBg.uploadLabel": "Custom background",
    "settings.heroBg.uploadHint": "JPG, PNG or WebP — after uploading you can crop and position the image",
    "settings.heroBg.uploadBtn": "Upload",
    "settings.heroBg.none": "No background",
  },
  "uk": {
    "settings.heroTitle.eyebrowPlaceholder": "Готово до гри",
    "settings.heroTitle.titlePlaceholder": "Твій світ чекає",
    "settings.heroTitle.reset": "Скинути",
    "settings.theme.magmaDefault": "Magma (за замовчуванням)",
    "settings.heroBg.presetsLabel": "Готові фони",
    "settings.heroBg.presetsHint": "Виберіть один із фонів або завантажте власне зображення нижче",
    "settings.heroBg.uploadLabel": "Власний фон",
    "settings.heroBg.uploadHint": "JPG, PNG або WebP — після завантаження можна обрізати й розташувати зображення",
    "settings.heroBg.uploadBtn": "Завантажити",
    "settings.heroBg.none": "Без фону",
  },
  "fr": {
    "settings.heroTitle.eyebrowPlaceholder": "Prêt à jouer",
    "settings.heroTitle.titlePlaceholder": "Votre monde vous attend",
    "settings.heroTitle.reset": "Réinitialiser",
    "settings.theme.magmaDefault": "Magma (par défaut)",
    "settings.heroBg.presetsLabel": "Arrière-plans prédéfinis",
    "settings.heroBg.presetsHint": "Choisissez un arrière-plan ou importez votre propre image ci-dessous",
    "settings.heroBg.uploadLabel": "Arrière-plan personnalisé",
    "settings.heroBg.uploadHint": "JPG, PNG ou WebP — après l’importation, vous pouvez recadrer et positionner l’image",
    "settings.heroBg.uploadBtn": "Importer",
    "settings.heroBg.none": "Sans arrière-plan",
  },
  "de": {
    "settings.heroTitle.eyebrowPlaceholder": "Bereit zum Spielen",
    "settings.heroTitle.titlePlaceholder": "Deine Welt wartet",
    "settings.heroTitle.reset": "Zurücksetzen",
    "settings.theme.magmaDefault": "Magma (Standard)",
    "settings.heroBg.presetsLabel": "Standardhintergründe",
    "settings.heroBg.presetsHint": "Wähle einen Hintergrund oder lade unten dein eigenes Bild hoch",
    "settings.heroBg.uploadLabel": "Eigener Hintergrund",
    "settings.heroBg.uploadHint": "JPG, PNG oder WebP — nach dem Hochladen kannst du das Bild zuschneiden und positionieren",
    "settings.heroBg.uploadBtn": "Hochladen",
    "settings.heroBg.none": "Kein Hintergrund",
  },
  "es": {
    "settings.heroTitle.eyebrowPlaceholder": "Listo para jugar",
    "settings.heroTitle.titlePlaceholder": "Tu mundo te espera",
    "settings.heroTitle.reset": "Restablecer",
    "settings.theme.magmaDefault": "Magma (predeterminado)",
    "settings.heroBg.presetsLabel": "Fondos predeterminados",
    "settings.heroBg.presetsHint": "Elige uno de los fondos o sube tu propia imagen abajo",
    "settings.heroBg.uploadLabel": "Fondo personalizado",
    "settings.heroBg.uploadHint": "JPG, PNG o WebP — después de subirla puedes recortar y colocar la imagen",
    "settings.heroBg.uploadBtn": "Subir",
    "settings.heroBg.none": "Sin fondo",
  },
  "es-ES": {
    "settings.heroTitle.eyebrowPlaceholder": "Listo para jugar",
    "settings.heroTitle.titlePlaceholder": "Tu mundo te espera",
    "settings.heroTitle.reset": "Restablecer",
    "settings.theme.magmaDefault": "Magma (predeterminado)",
    "settings.heroBg.presetsLabel": "Fondos predeterminados",
    "settings.heroBg.presetsHint": "Elige uno de los fondos o sube tu propia imagen abajo",
    "settings.heroBg.uploadLabel": "Fondo personalizado",
    "settings.heroBg.uploadHint": "JPG, PNG o WebP — después de subirla puedes recortar y colocar la imagen",
    "settings.heroBg.uploadBtn": "Subir",
    "settings.heroBg.none": "Sin fondo",
  },
  "it": {
    "settings.heroTitle.eyebrowPlaceholder": "Pronto a giocare",
    "settings.heroTitle.titlePlaceholder": "Il tuo mondo ti aspetta",
    "settings.heroTitle.reset": "Ripristina",
    "settings.theme.magmaDefault": "Magma (predefinito)",
    "settings.heroBg.presetsLabel": "Sfondi predefiniti",
    "settings.heroBg.presetsHint": "Scegli uno sfondo o carica la tua immagine qui sotto",
    "settings.heroBg.uploadLabel": "Sfondo personalizzato",
    "settings.heroBg.uploadHint": "JPG, PNG o WebP — dopo il caricamento puoi ritagliare e posizionare l’immagine",
    "settings.heroBg.uploadBtn": "Carica",
    "settings.heroBg.none": "Nessuno sfondo",
  },
  "pt": {
    "settings.heroTitle.eyebrowPlaceholder": "Pronto para jogar",
    "settings.heroTitle.titlePlaceholder": "Seu mundo espera por você",
    "settings.heroTitle.reset": "Redefinir",
    "settings.theme.magmaDefault": "Magma (padrão)",
    "settings.heroBg.presetsLabel": "Fundos padrão",
    "settings.heroBg.presetsHint": "Escolha um fundo ou envie sua própria imagem abaixo",
    "settings.heroBg.uploadLabel": "Fundo personalizado",
    "settings.heroBg.uploadHint": "JPG, PNG ou WebP — depois do envio, você pode recortar e posicionar a imagem",
    "settings.heroBg.uploadBtn": "Enviar",
    "settings.heroBg.none": "Sem fundo",
  },
  "ja": {
    "settings.heroTitle.eyebrowPlaceholder": "プレイする準備完了",
    "settings.heroTitle.titlePlaceholder": "あなたの世界が待っています",
    "settings.heroTitle.reset": "リセット",
    "settings.theme.magmaDefault": "Magma（デフォルト）",
    "settings.heroBg.presetsLabel": "プリセット背景",
    "settings.heroBg.presetsHint": "背景を1つ選ぶか、下から自分の画像をアップロードしてください",
    "settings.heroBg.uploadLabel": "カスタム背景",
    "settings.heroBg.uploadHint": "JPG、PNG、WebP — アップロード後に画像をトリミングして位置を調整できます",
    "settings.heroBg.uploadBtn": "アップロード",
    "settings.heroBg.none": "背景なし",
  },
  "ko": {
    "settings.heroTitle.eyebrowPlaceholder": "플레이 준비 완료",
    "settings.heroTitle.titlePlaceholder": "당신의 세계가 기다립니다",
    "settings.heroTitle.reset": "초기화",
    "settings.theme.magmaDefault": "Magma (기본값)",
    "settings.heroBg.presetsLabel": "기본 배경",
    "settings.heroBg.presetsHint": "배경을 선택하거나 아래에서 직접 이미지를 업로드하세요",
    "settings.heroBg.uploadLabel": "사용자 지정 배경",
    "settings.heroBg.uploadHint": "JPG, PNG 또는 WebP — 업로드 후 이미지를 자르고 위치를 조정할 수 있습니다",
    "settings.heroBg.uploadBtn": "업로드",
    "settings.heroBg.none": "배경 없음",
  },
  "hi": {
    "settings.heroTitle.eyebrowPlaceholder": "खेलने के लिए तैयार",
    "settings.heroTitle.titlePlaceholder": "आपकी दुनिया आपका इंतज़ार कर रही है",
    "settings.heroTitle.reset": "रीसेट",
    "settings.theme.magmaDefault": "Magma (डिफ़ॉल्ट)",
    "settings.heroBg.presetsLabel": "डिफ़ॉल्ट बैकग्राउंड",
    "settings.heroBg.presetsHint": "किसी एक बैकग्राउंड को चुनें या नीचे अपनी तस्वीर अपलोड करें",
    "settings.heroBg.uploadLabel": "कस्टम बैकग्राउंड",
    "settings.heroBg.uploadHint": "JPG, PNG या WebP — अपलोड करने के बाद आप तस्वीर को क्रॉप और पोज़िशन कर सकते हैं",
    "settings.heroBg.uploadBtn": "अपलोड करें",
    "settings.heroBg.none": "कोई बैकग्राउंड नहीं",
  },
  "id": {
    "settings.heroTitle.eyebrowPlaceholder": "Siap bermain",
    "settings.heroTitle.titlePlaceholder": "Duniamu menunggu",
    "settings.heroTitle.reset": "Atur ulang",
    "settings.theme.magmaDefault": "Magma (default)",
    "settings.heroBg.presetsLabel": "Latar default",
    "settings.heroBg.presetsHint": "Pilih salah satu latar atau unggah gambar sendiri di bawah",
    "settings.heroBg.uploadLabel": "Latar kustom",
    "settings.heroBg.uploadHint": "JPG, PNG atau WebP — setelah mengunggah, Anda dapat memotong dan mengatur posisi gambar",
    "settings.heroBg.uploadBtn": "Unggah",
    "settings.heroBg.none": "Tanpa latar",
  },
};
Object.keys(I18N_INTERFACE_PATCH).forEach(lang => {
  if (!I18N[lang]) I18N[lang] = {};
  Object.assign(I18N[lang], I18N_INTERFACE_PATCH[lang]);
});

const MONTH_NAMES = {
  ru: ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'],
  en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
  uk: ['січень','лютий','березень','квітень','травень','червень','липень','серпень','вересень','жовтень','листопад','грудень'],
  fr: ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'],
  de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
  es: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
  it: ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'],
  pt: ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'],
  hi: ['जनवरी','फ़रवरी','मार्च','अप्रैल','मई','जून','जुलाई','अगस्त','सितंबर','अक्टूबर','नवंबर','दिसंबर'],
  id: ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'],
};

function formatUpdateDate(lang, month, year) {
  if (!month) return String(year);
  if (lang === 'ja') return `${year}年${month}月`;
  if (lang === 'ko') return `${year}년 ${month}월`;
  const names = MONTH_NAMES[lang] || MONTH_NAMES.en;
  return `${names[month - 1]} ${year}`;
}

const UPDATE_2024_RANGE = {
  ru: 'октябрь–декабрь 2024', en: 'October–December 2024', uk: 'жовтень–грудень 2024',
  fr: 'octobre–décembre 2024', de: 'Oktober–Dezember 2024', es: 'octubre–diciembre 2024',
  it: 'ottobre–dicembre 2024', pt: 'outubro–dezembro 2024', ja: '2024年10月–12月',
  ko: '2024년 10월–12월', hi: 'अक्टूबर–दिसंबर 2024', id: 'Oktober–Desember 2024',
};

// ============================================
// История обновлений Minecraft — краткие пункты по каждому крупному релизу
// (не копия официальных patch notes), переведены на все языки лаунчера.
// ============================================
const UPDATES_DATA = [
  { version: '1.0', month: 11, year: 2011,
    title: { ru:'Релиз', en:'Release', uk:'Реліз', fr:'Sortie', de:'Release', es:'Lanzamiento', it:'Rilascio', pt:'Lançamento', ja:'リリース', ko:'릴리스', hi:'रिलीज़', id:'Rilis' },
    highlights: {
      ru: ['Официальный релиз после многих лет альфы и беты', 'Измерение Энд и битва с Эндер-драконом', 'Стол зачарования и система опыта', 'Голод заменил пассивную регенерацию здоровья', 'Деревни жителей'],
      en: ['The official release after years of alpha and beta', 'The End dimension and the Ender Dragon fight', 'Enchanting table and the experience system', 'Hunger replacing passive health regen', 'Villager villages'],
      uk: ['Офіційний реліз після років альфи та бети', 'Вимір Енд і битва з Дракону Енду'],
      fr: ["Sortie officielle après des années d'alpha et de bêta", "La dimension du Néant et le combat contre le Dragon de l'Ender"],
      de: ['Offizielle Veröffentlichung nach Jahren von Alpha und Beta', 'Die Enddimension und der Kampf gegen den Enderdrachen'],
      es: ['Lanzamiento oficial tras años de alfa y beta', 'La dimensión del Fin y la batalla contra el Dragón del Fin'],
      it: ['Rilascio ufficiale dopo anni di alpha e beta', "La dimensione dell'End e la battaglia contro il Drago dell'Ender"],
      pt: ['Lançamento oficial após anos de alpha e beta', 'A dimensão do End e a batalha contra o Dragão do Ender'],
      ja: ['長年のアルファ・ベータを経て正式リリース', 'ジ・エンドとエンダードラゴン戦、エンチャントテーブル'],
      ko: ['오랜 알파·베타를 거친 공식 출시', '엔드 차원과 엔더 드래곤 전투, 마법부여대'],
      hi: ['वर्षों के अल्फा-बीटा के बाद आधिकारिक रिलीज़', 'एंड आयाम, एंडर ड्रैगन लड़ाई और एनचांटिंग टेबल'],
      id: ['Rilis resmi setelah bertahun-tahun alpha dan beta', 'Dimensi End, pertarungan Ender Dragon, dan meja enchant'],
    } },
  { version: '1.1', month: 1, year: 2012,
    title: { ru:'Небольшое обновление', en:'Minor update', uk:'Невелике оновлення', fr:'Mise à jour mineure', de:'Kleines Update', es:'Actualización menor', it:'Aggiornamento minore', pt:'Atualização menor', ja:'マイナーアップデート', ko:'마이너 업데이트', hi:'छोटा अपडेट', id:'Pembaruan kecil' },
    highlights: {
      ru: ['Спавн-яйца существ доступны в творческом режиме', 'Выбор языка интерфейса', 'Мелкие правки генерации'],
      en: ['Spawn eggs available in Creative', 'Language selector added', 'Minor generation tweaks'],
      uk: ['Яйця спавну істот у творчому режимі', 'Вибір мови інтерфейсу'],
      fr: ['Œufs d\'apparition en mode Créatif', 'Sélecteur de langue'],
      de: ['Spawn-Eier im Kreativmodus', 'Sprachauswahl'],
      es: ['Huevos de generación en modo Creativo', 'Selector de idioma'],
      it: ['Uova generatrici in modalità Creativa', 'Selettore della lingua'],
      pt: ['Ovos de spawn no modo Criativo', 'Seletor de idioma'],
      ja: ['クリエイティブでスポーンエッグが使用可能に', '言語選択機能を追加'],
      ko: ['크리에이티브에서 스폰 알 사용 가능', '언어 선택 기능 추가'],
      hi: ['क्रिएटिव मोड में स्पॉन एग उपलब्ध', 'भाषा चयन जोड़ा गया'],
      id: ['Spawn egg tersedia di mode Creative', 'Pemilihan bahasa ditambahkan'],
    } },
  { version: '1.2', month: 3, year: 2012,
    title: { ru:'Adventure Update, часть 1', en:'Adventure Update, part 1', uk:'Adventure Update, частина 1', fr:'Adventure Update, partie 1', de:'Adventure Update, Teil 1', es:'Adventure Update, parte 1', it:'Adventure Update, parte 1', pt:'Adventure Update, parte 1', ja:'Adventure Update パート1', ko:'Adventure Update 1부', hi:'Adventure Update भाग 1', id:'Adventure Update bagian 1' },
    highlights: {
      ru: ['Храмы в джунглях и пустынные храмы с ловушками', 'Оцелоты, приручаемые в котов', 'Железные големы появляются в деревнях сами'],
      en: ['Jungle and desert temples with traps', 'Ocelots, tameable into cats', 'Iron golems now spawn naturally in villages'],
      uk: ['Храми в джунглях і пустелях з пастками', 'Оцелоти, які приручаються в котів'],
      fr: ['Temples de la jungle et du désert avec pièges', 'Ocelots apprivoisables en chats'],
      de: ['Dschungel- und Wüstentempel mit Fallen', 'Zähmbare Ozelots (Katzen)'],
      es: ['Templos de la jungla y el desierto con trampas', 'Ocelotes domesticables en gatos'],
      it: ['Templi della giungla e del deserto con trappole', 'Ocelot addomesticabili in gatti'],
      pt: ['Templos da selva e do deserto com armadilhas', 'Ocelotes domesticáveis em gatos'],
      ja: ['罠のあるジャングル・砂漠の寺院', 'ヤマネコを手懐けてネコに'],
      ko: ['함정이 있는 정글·사막 사원', '오셀롯을 길들여 고양이로'],
      hi: ['जाल वाले जंगल और रेगिस्तानी मंदिर', 'ऑसलॉट को बिल्ली में पालतू बनाना'],
      id: ['Kuil hutan & gurun dengan jebakan', 'Ocelot bisa dijinakkan jadi kucing'],
    } },
  { version: '1.3', month: 8, year: 2012,
    title: { ru:'Обновление', en:'Update', uk:'Оновлення', fr:'Mise à jour', de:'Update', es:'Actualización', it:'Aggiornamento', pt:'Atualização', ja:'アップデート', ko:'업데이트', hi:'अपडेट', id:'Pembaruan' },
    highlights: {
      ru: ['Эндер-сундук — личное хранилище из любого измерения', 'Динамитные вагонетки', 'Поиск по инвентарю в творческом режиме'],
      en: ['Ender chests — personal storage from any dimension', 'TNT minecarts', 'Search bar in the Creative inventory'],
      uk: ['Ендер-скриня — особисте сховище', 'Вагонетки з динамітом'],
      fr: ["Coffres de l'Ender", 'Wagonnets à TNT'],
      de: ['Endertruhen', 'TNT-Loren'],
      es: ['Cofres del Fin', 'Vagonetas con TNT'],
      it: ["Casse dell'Ender", 'Carrelli con TNT'],
      pt: ['Baús do Ender', 'Vagonetas com TNT'],
      ja: ['エンダーチェスト', 'TNTトロッコ'],
      ko: ['엔더 상자', 'TNT 광차'],
      hi: ['एंडर चेस्ट', 'TNT मिनकार्ट'],
      id: ['Ender chest', 'Minecart TNT'],
    } },
  { version: '1.4', month: 10, year: 2012,
    title: { ru:'Pretty Scary Update', en:'Pretty Scary Update', uk:'Pretty Scary Update', fr:'Pretty Scary Update', de:'Pretty Scary Update', es:'Pretty Scary Update', it:'Pretty Scary Update', pt:'Pretty Scary Update', ja:'Pretty Scary Update', ko:'Pretty Scary Update', hi:'Pretty Scary Update', id:'Pretty Scary Update' },
    highlights: {
      ru: ['Виттер — новый босс, и виттер-скелеты', 'Ведьмы', 'Наковальни, маяки', 'Командные блоки и рамки для предметов', 'Картофель'],
      en: ['The Wither boss and wither skeletons', 'Witches', 'Anvils, beacons', 'Command blocks and item frames', 'Potatoes'],
      uk: ['Віттер — новий бос', 'Командні блоки'],
      fr: ['Le Wither, nouveau boss', 'Blocs de commande'],
      de: ['Der Wither, neuer Boss', 'Befehlsblöcke'],
      es: ['El Wither, nuevo jefe', 'Bloques de comandos'],
      it: ['Il Wither, nuovo boss', 'Blocchi comando'],
      pt: ['O Wither, novo chefe', 'Blocos de comando'],
      ja: ['新ボス「ウィザー」', 'コマンドブロック'],
      ko: ['새 보스 위더', '명령 블록'],
      hi: ['नया बॉस विदर', 'कमांड ब्लॉक'],
      id: ['Bos baru Wither', 'Command block'],
    } },
  { version: '1.5', month: 3, year: 2013,
    title: { ru:'Redstone Update', en:'Redstone Update', uk:'Redstone Update', fr:'Redstone Update', de:'Redstone Update', es:'Redstone Update', it:'Redstone Update', pt:'Redstone Update', ja:'レッドストーンアップデート', ko:'레드스톤 업데이트', hi:'रेडस्टोन अपडेट', id:'Redstone Update' },
    highlights: {
      ru: ['Редстоун-компараторы для сложных схем', 'Воронки для автоматической передачи предметов', 'Капельницы и ловушечные сундуки'],
      en: ['Redstone comparators for advanced circuits', 'Hoppers for automatic item transport', 'Droppers and trapped chests'],
      uk: ['Редстоун-компаратори', 'Вороники для автоматичного перенесення предметів'],
      fr: ['Comparateurs de redstone', 'Entonnoirs pour le transport automatique'],
      de: ['Redstone-Komparatoren', 'Trichter für automatischen Transport'],
      es: ['Comparadores de redstone', 'Tolvas para transporte automático'],
      it: ['Comparatori di redstone', "Imbuti per il trasporto automatico"],
      pt: ['Comparadores de redstone', 'Funis para transporte automático'],
      ja: ['レッドストーンコンパレーター', '自動搬送用ホッパー'],
      ko: ['레드스톤 비교기', '자동 운반용 호퍼'],
      hi: ['रेडस्टोन कंपैरेटर', 'स्वचालित परिवहन के लिए हॉपर'],
      id: ['Redstone comparator', 'Hopper untuk transportasi otomatis'],
    } },
  { version: '1.6', month: 7, year: 2013,
    title: { ru:'Horse Update', en:'Horse Update', uk:'Horse Update', fr:'Horse Update', de:'Horse Update', es:'Horse Update', it:'Horse Update', pt:'Horse Update', ja:'馬アップデート', ko:'말 업데이트', hi:'हॉर्स अपडेट', id:'Horse Update' },
    highlights: {
      ru: ['Лошади, ослы и мулы', 'Поводки', 'Ковры', 'Бирки с именами'],
      en: ['Horses, donkeys and mules', 'Leads', 'Carpets', 'Name tags'],
      uk: ['Коні, осли та мули', 'Повідці'],
      fr: ['Chevaux, ânes et mules', 'Longes'],
      de: ['Pferde, Esel und Maultiere', 'Leinen'],
      es: ['Caballos, burros y mulas', 'Correas'],
      it: ['Cavalli, asini e muli', 'Guinzagli'],
      pt: ['Cavalos, jumentos e mulas', 'Guias'],
      ja: ['馬・ロバ・ラバ', 'リード'],
      ko: ['말·당나귀·노새', '목줄'],
      hi: ['घोड़े, गधे और खच्चर', 'लीड'],
      id: ['Kuda, keledai, dan bagal', 'Lead'],
    } },
  { version: '1.7', month: 10, year: 2013,
    title: { ru:'Update that Changed the World', en:'Update that Changed the World', uk:'Update that Changed the World', fr:'Update that Changed the World', de:'Update that Changed the World', es:'Update that Changed the World', it:'Update that Changed the World', pt:'Update that Changed the World', ja:'世界を変えたアップデート', ko:'세상을 바꾼 업데이트', hi:'Update that Changed the World', id:'Update that Changed the World' },
    highlights: {
      ru: ['Переработанная генерация мира с бóльшим разнообразием биомов', 'Новые цветы, цветное стекло', 'Разные виды рыбы', 'Настраиваемый суперплоский мир'],
      en: ['Overhauled world generation with more biome variety', 'New flowers, stained glass', 'Multiple fish types', 'Customizable superflat worlds'],
      uk: ['Оновлена генерація світу з новими біомами', 'Кольорове скло'],
      fr: ['Génération du monde et biomes revus', 'Verre teinté'],
      de: ['Überarbeitete Weltgenerierung mit mehr Biomen', 'Buntglas'],
      es: ['Generación del mundo y biomas renovados', 'Vidrio teñido'],
      it: ['Generazione del mondo e biomi rinnovati', 'Vetro colorato'],
      pt: ['Geração de mundo e biomas renovados', 'Vidro colorido'],
      ja: ['ワールド生成とバイオームの刷新', 'ステンドグラス'],
      ko: ['월드 생성과 바이옴 개편', '스테인드글라스'],
      hi: ['वर्ल्ड जनरेशन और बायोम में सुधार', 'रंगीन शीशा'],
      id: ['Generasi dunia & bioma diperbarui', 'Kaca patri'],
    } },
  { version: '1.8', month: 9, year: 2014,
    title: { ru:'Bountiful Update', en:'Bountiful Update', uk:'Bountiful Update', fr:'Bountiful Update', de:'Bountiful Update', es:'Bountiful Update', it:'Bountiful Update', pt:'Bountiful Update', ja:'Bountiful Update', ko:'Bountiful Update', hi:'Bountiful Update', id:'Bountiful Update' },
    highlights: {
      ru: ['Стражи и подводные монументы', 'Баннеры с узором', 'Слаймовые блоки', 'Андезит, диорит, гранит', 'Стойки для брони', 'Режим наблюдателя'],
      en: ['Guardians and ocean monuments', 'Patterned banners', 'Slime blocks', 'Andesite, diorite, granite', 'Armor stands', 'Spectator mode'],
      uk: ['Стражі та підводні монументи', 'Банери з візерунком'],
      fr: ['Gardiens et monuments océaniques', 'Bannières à motifs'],
      de: ['Wächter und Ozeanmonumente', 'Gemusterte Banner'],
      es: ['Guardianes y monumentos oceánicos', 'Estandartes con patrones'],
      it: ['Guardiani e monumenti oceanici', 'Stendardi decorati'],
      pt: ['Guardiões e monumentos oceânicos', 'Bandeiras com padrões'],
      ja: ['ガーディアンと海底神殿', '模様入りバナー'],
      ko: ['가디언과 해저 유적', '무늬 배너'],
      hi: ['गार्जियन और महासागर स्मारक', 'पैटर्न वाले बैनर'],
      id: ['Guardian & monumen laut', 'Banner bermotif'],
    } },
  { version: '1.9', month: 2, year: 2016,
    title: { ru:'Combat Update', en:'Combat Update', uk:'Combat Update', fr:'Combat Update', de:'Combat Update', es:'Combat Update', it:'Combat Update', pt:'Combat Update', ja:'戦闘アップデート', ko:'전투 업데이트', hi:'कॉम्बैट अपडेट', id:'Combat Update' },
    highlights: {
      ru: ['Новая боевая система с перезарядкой атаки', 'Вторая рука для щита или факела', 'Щиты', 'Элитры и Крепости Края'],
      en: ['New combat system with attack cooldown', 'Off-hand slot for shields or torches', 'Shields', 'Elytra and End cities'],
      uk: ['Нова бойова система з перезарядкою', 'Щити та елітри'],
      fr: ['Nouveau système de combat avec temps de recharge', 'Boucliers et élytres'],
      de: ['Neues Kampfsystem mit Angriffs-Cooldown', 'Schilde und Elytren'],
      es: ['Nuevo sistema de combate con enfriamiento', 'Escudos y élitros'],
      it: ['Nuovo sistema di combattimento con tempo di recupero', 'Scudi ed elitre'],
      pt: ['Novo sistema de combate com tempo de recarga', 'Escudos e élitros'],
      ja: ['クールダウン制の新戦闘システム', '盾とエリトラ'],
      ko: ['쿨다운 기반의 새 전투 시스템', '방패와 겉날개'],
      hi: ['कूलडाउन वाली नई लड़ाई प्रणाली', 'शील्ड और एलिट्रा'],
      id: ['Sistem tempur baru dengan cooldown', 'Perisai dan Elytra'],
    } },
  { version: '1.10', month: 6, year: 2016,
    title: { ru:'Frostburn Update', en:'Frostburn Update', uk:'Frostburn Update', fr:'Frostburn Update', de:'Frostburn Update', es:'Frostburn Update', it:'Frostburn Update', pt:'Frostburn Update', ja:'Frostburn Update', ko:'Frostburn Update', hi:'Frostburn Update', id:'Frostburn Update' },
    highlights: {
      ru: ['Белые медведи', 'Хаски и страи', 'Магматические блоки', 'Структурные блоки для карт'],
      en: ['Polar bears', 'Husks and strays', 'Magma blocks', 'Structure blocks for map makers'],
      uk: ['Білі ведмеді', 'Магматичні блоки'],
      fr: ['Ours polaires', 'Blocs de magma'],
      de: ['Eisbären', 'Magmablöcke'],
      es: ['Osos polares', 'Bloques de magma'],
      it: ['Orsi polari', 'Blocchi di magma'],
      pt: ['Ursos polares', 'Blocos de magma'],
      ja: ['ホッキョクグマ', 'マグマブロック'],
      ko: ['북극곰', '마그마 블록'],
      hi: ['ध्रुवीय भालू', 'मैग्मा ब्लॉक'],
      id: ['Beruang kutub', 'Blok magma'],
    } },
  { version: '1.11', month: 11, year: 2016,
    title: { ru:'Exploration Update', en:'Exploration Update', uk:'Exploration Update', fr:'Exploration Update', de:'Exploration Update', es:'Exploration Update', it:'Exploration Update', pt:'Exploration Update', ja:'探検アップデート', ko:'탐험 업데이트', hi:'एक्सप्लोरेशन अपडेट', id:'Exploration Update' },
    highlights: {
      ru: ['Лесные особняки', 'Иллагеры — вредители и вызыватели', 'Шалкеры и шалкеровые ящики', 'Ламы'],
      en: ['Woodland mansions', 'Illagers — vindicators and evokers', 'Shulkers and shulker boxes', 'Llamas'],
      uk: ['Лісові особняки', 'Ілагери'],
      fr: ['Manoirs des bois', 'Illageois'],
      de: ['Waldvillen', 'Illager'],
      es: ['Mansiones del bosque', 'Ilagers'],
      it: ['Ville nel bosco', 'Illager'],
      pt: ['Mansões da floresta', 'Illagers'],
      ja: ['森の洋館', 'イリジャー'],
      ko: ['숲속 대저택', '약탈자'],
      hi: ['वुडलैंड मैंशन', 'इलेजर'],
      id: ['Woodland mansion', 'Illager'],
    } },
  { version: '1.12', month: 6, year: 2017,
    title: { ru:'World of Color Update', en:'World of Color Update', uk:'World of Color Update', fr:'World of Color Update', de:'World of Color Update', es:'World of Color Update', it:'World of Color Update', pt:'World of Color Update', ja:'World of Color Update', ko:'World of Color Update', hi:'World of Color Update', id:'World of Color Update' },
    highlights: {
      ru: ['Бетон и глазурованная терракота', 'Попугаи', 'Книга рецептов', 'Продвижения вместо достижений'],
      en: ['Concrete and glazed terracotta', 'Parrots', 'Crafting book', 'Advancements replacing achievements'],
      uk: ['Бетон і глазурована теракота', 'Папуги'],
      fr: ['Béton et terre cuite vernissée', 'Perroquets'],
      de: ['Beton und glasierte Terrakotta', 'Papageien'],
      es: ['Hormigón y terracota vidriada', 'Loros'],
      it: ['Cemento e terracotta invetriata', 'Pappagalli'],
      pt: ['Concreto e terracota vitrificada', 'Papagaios'],
      ja: ['コンクリートと彩釉テラコッタ', 'オウム'],
      ko: ['콘크리트와 유광 테라코타', '앵무새'],
      hi: ['कंक्रीट और चमकीली टेराकोटा', 'तोते'],
      id: ['Beton & terracotta glasir', 'Beo'],
    } },
  { version: '1.13', month: 7, year: 2018,
    title: { ru:'Update Aquatic', en:'Update Aquatic', uk:'Update Aquatic', fr:'Update Aquatic', de:'Update Aquatic', es:'Update Aquatic', it:'Update Aquatic', pt:'Update Aquatic', ja:'Update Aquatic', ko:'Update Aquatic', hi:'Update Aquatic', id:'Update Aquatic' },
    highlights: {
      ru: ['Полная переработка океанов', 'Дельфины, кораллы, новые рыбы', 'Трезубцы', 'Полный переход блоков на новую систему ID'],
      en: ['Full ocean overhaul', 'Dolphins, coral reefs, new fish', 'Tridents', 'Full move to the new block/item ID system'],
      uk: ['Повна переробка океанів', 'Тризубці'],
      fr: ['Refonte complète des océans', 'Tridents'],
      de: ['Komplette Ozean-Überarbeitung', 'Dreizacke'],
      es: ['Renovación total de los océanos', 'Tridentes'],
      it: ['Rinnovamento totale degli oceani', 'Tridenti'],
      pt: ['Renovação total dos oceanos', 'Tridentes'],
      ja: ['海洋の全面刷新', 'トライデント'],
      ko: ['바다 전면 개편', '삼지창'],
      hi: ['महासागरों में बड़ा बदलाव', 'त्रिशूल'],
      id: ['Perombakan total lautan', 'Trisula'],
    } },
  { version: '1.14', month: 4, year: 2019,
    title: { ru:'Village & Pillage', en:'Village & Pillage', uk:'Village & Pillage', fr:'Village & Pillage', de:'Village & Pillage', es:'Village & Pillage', it:'Village & Pillage', pt:'Village & Pillage', ja:'Village & Pillage', ko:'Village & Pillage', hi:'Village & Pillage', id:'Village & Pillage' },
    highlights: {
      ru: ['Деревни переработаны под каждый биом', 'Пилейджеры и рейды', 'Коты заменили оцелотов', 'Арбалеты, бамбук'],
      en: ['Villages redesigned per biome', 'Pillagers and raids', 'Cats replaced ocelots', 'Crossbows, bamboo'],
      uk: ['Села перероблено під кожен біом', 'Пілегери та рейди'],
      fr: ['Villages repensés par biome', 'Pillards et raids'],
      de: ['Dörfer je Biom neu gestaltet', 'Plünderer und Überfälle'],
      es: ['Aldeas rediseñadas por bioma', 'Saqueadores y asaltos'],
      it: ['Villaggi ridisegnati per bioma', 'Predoni e razzie'],
      pt: ['Aldeias redesenhadas por bioma', 'Saqueadores e ataques'],
      ja: ['バイオームごとの村デザイン', '略奪者と襲撃'],
      ko: ['바이옴별 마을 재설계', '약탈자와 습격'],
      hi: ['हर बायोम के लिए नए गाँव', 'पिलेजर और छापे'],
      id: ['Desa dirancang ulang per bioma', 'Pillager & serangan'],
    } },
  { version: '1.15', month: 12, year: 2019,
    title: { ru:'Buzzy Bees', en:'Buzzy Bees', uk:'Buzzy Bees', fr:'Buzzy Bees', de:'Buzzy Bees', es:'Buzzy Bees', it:'Buzzy Bees', pt:'Buzzy Bees', ja:'Buzzy Bees', ko:'Buzzy Bees', hi:'Buzzy Bees', id:'Buzzy Bees' },
    highlights: {
      ru: ['Пчёлы, ульи и гнёзда', 'Медовые блоки', 'Много исправлений и оптимизаций'],
      en: ['Bees, beehives and nests', 'Honey blocks', 'A large batch of fixes and performance work'],
      uk: ['Бджоли та вулики', 'Медові блоки'],
      fr: ['Abeilles et ruches', 'Blocs de miel'],
      de: ['Bienen und Bienenstöcke', 'Honigblöcke'],
      es: ['Abejas y colmenas', 'Bloques de miel'],
      it: ['Api e alveari', 'Blocchi di miele'],
      pt: ['Abelhas e colmeias', 'Blocos de mel'],
      ja: ['ミツバチと巣箱', 'ハチミツブロック'],
      ko: ['꿀벌과 벌집', '꿀 블록'],
      hi: ['मधुमक्खियाँ और छत्ते', 'शहद ब्लॉक'],
      id: ['Lebah & sarang lebah', 'Blok madu'],
    } },
  { version: '1.16', month: 6, year: 2020,
    title: { ru:'Nether Update', en:'Nether Update', uk:'Nether Update', fr:'Nether Update', de:'Nether Update', es:'Nether Update', it:'Nether Update', pt:'Nether Update', ja:'ネザーアップデート', ko:'네더 업데이트', hi:'नेदर अपडेट', id:'Nether Update' },
    highlights: {
      ru: ['Полная переработка Нижнего мира', 'Пиглины и торговля', 'Незерит', 'Якоря возрождения'],
      en: ['Full Nether overhaul', 'Piglins and bartering', 'Netherite', 'Respawn anchors'],
      uk: ['Повна переробка Незера', 'Піглини та незерит'],
      fr: ['Refonte complète du Nether', 'Piglins et Netherite'],
      de: ['Komplette Nether-Überarbeitung', 'Piglins und Netherit'],
      es: ['Renovación total del Nether', 'Piglins y netherita'],
      it: ['Rinnovamento totale del Nether', 'Piglin e netherite'],
      pt: ['Renovação total do Nether', 'Piglins e netherite'],
      ja: ['ネザーの全面刷新', 'ピグリンとネザライト'],
      ko: ['네더 전면 개편', '피글린과 네더라이트'],
      hi: ['नेदर में बड़ा बदलाव', 'पिगलिन और नेदराइट'],
      id: ['Perombakan total Nether', 'Piglin & netherite'],
    } },
  { version: '1.17', month: 6, year: 2021,
    title: { ru:'Caves & Cliffs, часть 1', en:'Caves & Cliffs, part 1', uk:'Caves & Cliffs, частина 1', fr:'Caves & Cliffs, partie 1', de:'Caves & Cliffs, Teil 1', es:'Caves & Cliffs, parte 1', it:'Caves & Cliffs, parte 1', pt:'Caves & Cliffs, parte 1', ja:'Caves & Cliffs パート1', ko:'Caves & Cliffs 1부', hi:'Caves & Cliffs भाग 1', id:'Caves & Cliffs bagian 1' },
    highlights: {
      ru: ['Аксолотли и козы', 'Медь и её окисление', 'Аметистовые жеоды', 'Глубинный сланец', 'Подзорная труба'],
      en: ['Axolotls and goats', 'Copper and oxidation', 'Amethyst geodes', 'Deepslate', 'Spyglass'],
      uk: ['Аксолотлі та кози', 'Мідь та аметистові жеоди'],
      fr: ['Axolotls et chèvres', "Cuivre et géodes d'améthyste"],
      de: ['Axolotl und Ziegen', 'Kupfer und Amethystgeoden'],
      es: ['Ajolotes y cabras', 'Cobre y geodas de amatista'],
      it: ['Axolotl e capre', 'Rame e geodi di ametista'],
      pt: ['Axolotes e cabras', 'Cobre e geodos de ametista'],
      ja: ['ウーパールーパーとヤギ', '銅とアメジスト晶洞'],
      ko: ['아홀로틀과 염소', '구리와 자수정 정동석'],
      hi: ['एक्सोलोटल और बकरियाँ', 'तांबा और नीलम भूगर्भ'],
      id: ['Axolotl & kambing', 'Tembaga & geode ametis'],
    } },
  { version: '1.18', month: 11, year: 2021,
    title: { ru:'Caves & Cliffs, часть 2', en:'Caves & Cliffs, part 2', uk:'Caves & Cliffs, частина 2', fr:'Caves & Cliffs, partie 2', de:'Caves & Cliffs, Teil 2', es:'Caves & Cliffs, parte 2', it:'Caves & Cliffs, parte 2', pt:'Caves & Cliffs, parte 2', ja:'Caves & Cliffs パート2', ko:'Caves & Cliffs 2부', hi:'Caves & Cliffs भाग 2', id:'Caves & Cliffs bagian 2' },
    highlights: {
      ru: ['Полная переработка генерации мира', 'Увеличенная высота и глубина', 'Новые типы пещер и горные биомы'],
      en: ['Full world generation overhaul', 'Taller and deeper worlds', 'New cave types and mountain biomes'],
      uk: ['Повна переробка генерації світу', 'Більша висота і глибина'],
      fr: ['Refonte de la génération du monde', 'Mondes plus hauts et plus profonds'],
      de: ['Überarbeitete Weltgenerierung', 'Höhere und tiefere Welten'],
      es: ['Renovación de la generación del mundo', 'Mundos más altos y profundos'],
      it: ['Rinnovamento della generazione del mondo', 'Mondi più alti e profondi'],
      pt: ['Renovação da geração de mundo', 'Mundos mais altos e profundos'],
      ja: ['ワールド生成の全面刷新', 'より高く深い世界'],
      ko: ['월드 생성 전면 개편', '더 높고 깊은 세계'],
      hi: ['वर्ल्ड जनरेशन में बड़ा बदलाव', 'ऊँची और गहरी दुनिया'],
      id: ['Perombakan generasi dunia', 'Dunia lebih tinggi & dalam'],
    } },
  { version: '1.19', month: 6, year: 2022,
    title: { ru:'Wild Update', en:'Wild Update', uk:'Wild Update', fr:'Wild Update', de:'Wild Update', es:'Wild Update', it:'Wild Update', pt:'Wild Update', ja:'Wild Update', ko:'Wild Update', hi:'Wild Update', id:'Wild Update' },
    highlights: {
      ru: ['Мрачные пещеры и Страж', 'Мангровые болота', 'Аллай — помощник, приносящий предметы', 'Лодки с сундуком'],
      en: ['The Deep Dark and the Warden', 'Mangrove swamps', 'The allay, a helper mob', 'Boats with chests'],
      uk: ['Морок і Вартовий', 'Мангрові болота'],
      fr: ['Les tréfonds sombres et le Gardien', 'Marécages de mangrove'],
      de: ['Tiefendunkel und der Wächter', 'Mangrovensümpfe'],
      es: ['Las Profundidades Oscuras y el Guardián', 'Pantanos de manglar'],
      it: ['Il Profondo Oscuro e il Warden', 'Paludi di mangrovie'],
      pt: ['As Profundezas Sombrias e o Warden', 'Pântanos de mangue'],
      ja: ['深層暗黒界とウォーデン', 'マングローブの沼地'],
      ko: ['깊고 어두운 곳과 워든', '맹그로브 늪'],
      hi: ['डीप डार्क और वॉर्डन', 'मैंग्रोव दलदल'],
      id: ['Deep Dark & Warden', 'Rawa mangrove'],
    } },
  { version: '1.20', month: 6, year: 2023,
    title: { ru:'Trails & Tales', en:'Trails & Tales', uk:'Trails & Tales', fr:'Trails & Tales', de:'Trails & Tales', es:'Trails & Tales', it:'Trails & Tales', pt:'Trails & Tales', ja:'Trails & Tales', ko:'Trails & Tales', hi:'Trails & Tales', id:'Trails & Tales' },
    highlights: {
      ru: ['Археология и щётки', 'Нюхач и семена древних растений', 'Биом вишнёвой рощи', 'Верблюды, отделка брони'],
      en: ['Archaeology and brushes', 'The sniffer and ancient seeds', 'Cherry grove biome', 'Camels, armor trims'],
      uk: ['Археологія та щітки', 'Біом вишневого гаю'],
      fr: ['Archéologie et brosses', 'Biome de bosquet de cerisiers'],
      de: ['Archäologie und Bürsten', 'Kirschhain-Biom'],
      es: ['Arqueología y cepillos', 'Bioma de arboleda de cerezos'],
      it: ['Archeologia e pennelli', 'Bioma del boschetto di ciliegi'],
      pt: ['Arqueologia e escovas', 'Bioma de bosque de cerejeiras'],
      ja: ['考古学とブラシ', 'サクラの森バイオーム'],
      ko: ['고고학과 브러시', '벚꽃 숲 바이옴'],
      hi: ['पुरातत्व और ब्रश', 'चेरी ग्रोव बायोम'],
      id: ['Arkeologi & kuas', 'Bioma kebun sakura'],
    } },
  { version: '1.21', month: 6, year: 2024,
    title: { ru:'Tricky Trials', en:'Tricky Trials', uk:'Tricky Trials', fr:'Tricky Trials', de:'Tricky Trials', es:'Tricky Trials', it:'Tricky Trials', pt:'Tricky Trials', ja:'Tricky Trials', ko:'Tricky Trials', hi:'Tricky Trials', id:'Tricky Trials' },
    highlights: {
      ru: ['Испытательные камеры', 'Бриз и уроженец болот', 'Булава — новое оружие', 'Крафтеры', 'Броня для волков'],
      en: ['Trial Chambers', 'The Breeze and Bogged', 'The mace, a new weapon', 'Crafters', 'Wolf armor'],
      uk: ['Випробувальні камери', 'Булава — нова зброя'],
      fr: ["Chambres d'essai", 'La masse, nouvelle arme'],
      de: ['Testkammern', 'Der Streitkolben, neue Waffe'],
      es: ['Cámaras de prueba', 'La maza, nueva arma'],
      it: ['Camere di prova', 'La mazza, nuova arma'],
      pt: ['Câmaras de teste', 'A maça, nova arma'],
      ja: ['試練の間', '新武器「メイス」'],
      ko: ['시련의 방', '새 무기 철퇴'],
      hi: ['ट्रायल चैंबर', 'नया हथियार मेस'],
      id: ['Trial Chamber', 'Senjata baru mace'],
    } },
  { version: '1.21.2–1.21.4', dateRange: UPDATE_2024_RANGE,
    title: { ru:'Обновления конца 2024', en:'Late-2024 updates', uk:'Оновлення кінця 2024', fr:'Mises à jour fin 2024', de:'Updates Ende 2024', es:'Actualizaciones de finales de 2024', it:'Aggiornamenti fine 2024', pt:'Atualizações do fim de 2024', ja:'2024年末アップデート', ko:'2024년 말 업데이트', hi:'2024 के अंत के अपडेट', id:'Pembaruan akhir 2024' },
    highlights: {
      ru: ['Связки (bundles) стали стабильным предметом', 'Биом Бледный сад и моб Крикер', 'Правки генерации структур и боя'],
      en: ['Bundles became a stable item', 'The Pale Garden biome and the Creaking mob', 'Structure generation and combat tweaks'],
      uk: ["В'язки стали стабільним предметом", 'Біом Блідий сад і моб Крикер'],
      fr: ['Les paquetages deviennent un objet stable', 'Biome du Jardin Pâle et mob Craquant'],
      de: ['Bündel wurden ein stabiles Item', 'Biom Fahler Garten und Mob Knarzer'],
      es: ['Los fardos se volvieron un objeto estable', 'Bioma Jardín Pálido y mob Crujiente'],
      it: ['I fagotti diventano un oggetto stabile', 'Bioma Giardino Pallido e mob Scricchiolio'],
      pt: ['Trouxas viraram um item estável', 'Bioma Jardim Pálido e mob Ranger'],
      ja: ['バンドルが正式アイテムに', '青白い庭バイオームとクリーキング'],
      ko: ['꾸러미가 정식 아이템으로', '창백한 정원 바이옴과 크리킹'],
      hi: ['बंडल स्थायी आइटम बने', 'पेल गार्डन बायोम और क्रीकिंग मॉब'],
      id: ['Bundle jadi item stabil', 'Bioma Pale Garden & mob Creaking'],
    } },
  { version: '26.x', year: 2026,
    title: { ru:'Новая нумерация версий', en:'New version numbering', uk:'Нова нумерація версій', fr:'Nouvelle numérotation', de:'Neue Versionsnummerierung', es:'Nueva numeración de versiones', it:'Nuova numerazione delle versioni', pt:'Nova numeração de versões', ja:'新バージョン番号体系', ko:'새로운 버전 번호 체계', hi:'नई वर्शन नंबरिंग', id:'Penomoran versi baru' },
    highlights: {
      ru: ['Mojang перешла на схему «год.дроп» вместо привычной 1.x', 'Обновления выходят чаще, но меньшими порциями', 'За точным списком изменений 26.1/26.2 — в официальных заметках о выпуске'],
      en: ['Mojang switched to a "year.drop" numbering scheme instead of the classic 1.x line', 'Updates now ship more often, in smaller drops', 'For the exact 26.1/26.2 changelog, check the official patch notes'],
      uk: ['Mojang перейшла на схему «рік.дроп»', 'Оновлення виходять частіше меншими порціями'],
      fr: ['Mojang passe au format « année.drop »', 'Mises à jour plus fréquentes, en plus petites portions'],
      de: ['Mojang wechselt zu „Jahr.Drop“', 'Updates erscheinen häufiger in kleineren Paketen'],
      es: ['Mojang cambia al esquema «año.drop»', 'Actualizaciones más frecuentes en porciones más pequeñas'],
      it: ['Mojang passa allo schema "anno.drop"', 'Aggiornamenti più frequenti in porzioni più piccole'],
      pt: ['A Mojang mudou para o esquema "ano.drop"', 'Atualizações mais frequentes em porções menores'],
      ja: ['Mojangが「年.ドロップ」方式に移行', 'より頻繁に小規模なアップデートを配信'],
      ko: ['Mojang이 "년.드롭" 방식으로 전환', '더 자주, 더 작은 단위로 업데이트 제공'],
      hi: ['Mojang "वर्ष.ड्रॉप" प्रणाली पर गया', 'अपडेट अब ज़्यादा बार, छोटे हिस्सों में'],
      id: ['Mojang beralih ke skema "tahun.drop"', 'Update lebih sering, dalam porsi lebih kecil'],
    } },
];

function renderUpdatesTimeline() {
  const container = document.getElementById('homeUpdatesTimeline');
  if (!container) return;
  container.innerHTML = '';
  const langKey = currentLang === 'es-ES' ? 'es' : currentLang;

  UPDATES_DATA.slice().reverse().forEach(entry => {
  const highlights = entry.highlights[langKey] || entry.highlights.ru;
  const title = entry.title[langKey] || entry.title.ru;
  const dateText = entry.dateRange
    ? (entry.dateRange[langKey] || entry.dateRange.ru)
    : formatUpdateDate(langKey, entry.month, entry.year);

  const card = document.createElement('div');
  card.className = 'update-card';

  card.innerHTML = `
    <div class="update-card-head">
      <span class="update-version-badge">${entry.version}</span>
      <span class="update-date">${dateText}</span>
    </div>
    <h3 class="update-card-title">${title}</h3>
    <ul class="update-highlights">
      ${highlights.map(h => `<li>${h}</li>`).join('')}
    </ul>
  `;

  // Обработчик должен находиться внутри forEach,
  // потому что card существует только здесь

  container.appendChild(card);
});

}

let currentLang = localStorage.getItem('magma_lang') || 'ru';

function t(key) {
  if (I18N[currentLang] && I18N[currentLang][key] !== undefined) {
    return I18N[currentLang][key];
  }

  if (I18N.en && I18N.en[key] !== undefined) {
    return I18N.en[key];
  }

  if (I18N.ru && I18N.ru[key] !== undefined) {
    return I18N.ru[key];
  }

  return key;
}

function applyLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('magma_lang', lang);

  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  document.querySelectorAll('[data-tooltip-i18n]').forEach(el => {
    el.setAttribute('data-tooltip', t(el.dataset.tooltipI18n));
  });

  langSelectLabel.textContent = LANG_NAMES[lang];

  langSelectList.querySelectorAll('.custom-select-item').forEach(item => {
    item.classList.toggle('is-selected', item.dataset.value === lang);
  });

  updateRamValue();
  syncResolutionSelectLabel();
  syncGameDirModeLabel();
  renderInstances();
  renderModsCategoryTabs();
  applyModsCategoryVisibility();
  updateModsInstallTargetLabel();
  updateModsMyTabLabel();
  renderModsTargetLoaderTabs();
  renderModsTargetScopeTabs();
  renderModsTargetVersionList('');
  syncModsTargetVersionLabel();
  refreshModsTargetUI()
  renderInstalledModsScopeFilter();
  renderUpdatesTimeline();
  renderThemeOptions();
  applyHeroCustomization();

  if (typeof renderModFilterSortList === 'function') {
    renderModFilterSortList();
  }

  if (versionDropdown.classList.contains('is-open')) {
    renderLoaderTabs();
    renderVersionList(versionSearchEl.value);
  }
}

const LANG_NAMES = {
  ru: 'Русский', en: 'English (United States)', uk: 'Українська',
  fr: 'Français (France)', de: 'Deutsch (Deutschland)', hi: 'हिन्दी (भारत)',
  id: 'Indonesia (Indonesia)', it: 'Italiano (Italia)', ja: '日本語（日本）',
  ko: '한국어(대한민국)', pt: 'Português (Brasil)', es: 'Español (Latinoamérica)',
  'es-ES': 'Español (España)',
};

const langSelectWrap = document.getElementById('langSelectWrap');
const langSelectBtn = document.getElementById('langSelectBtn');
const langSelectLabel = document.getElementById('langSelectLabel');
const langSelectList = document.getElementById('langSelectList');

langSelectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  langSelectWrap.classList.toggle('is-open');
});

langSelectList.querySelectorAll('.custom-select-item').forEach(item => {
  item.addEventListener('click', () => {
    applyLanguage(item.dataset.value);
    langSelectWrap.classList.remove('is-open');
  });
});

document.addEventListener('click', () => langSelectWrap.classList.remove('is-open'));

// ============================================
// Настройки: подвкладки Аккаунт / Лаунчер / Игра
// ============================================
const settingsSubtabs = document.querySelectorAll('.mods-subtab[data-settings-subtab]');
const settingsSubviews = document.querySelectorAll('.mods-subview[data-settings-subview]');

function switchSettingsSubtab(target) {
  settingsSubtabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.settingsSubtab === target));
  settingsSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.settingsSubview === target));
  if (target === 'account') {
    updateSettingsAccountTab();
  }
}

settingsSubtabs.forEach(tab => {
  tab.addEventListener('click', () => switchSettingsSubtab(tab.dataset.settingsSubtab));
});

const launcherCategoryTabs = document.querySelectorAll('.mods-subtab[data-launcher-category]');
const launcherCategoryViews = document.querySelectorAll('.mods-subview[data-launcher-subview]');

launcherCategoryTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    launcherCategoryTabs.forEach(tb => tb.classList.toggle('is-active', tb === tab));
    const target = tab.dataset.launcherCategory;
    launcherCategoryViews.forEach(v => v.classList.toggle('is-active', v.dataset.launcherSubview === target));
  });
});

// ============================================
// Выбор системы скинов (пока доступен только Ely.by)
// ============================================
const SKIN_SYSTEM_KEY = 'magma_skin_system';
function getSkinSystemPref() { return localStorage.getItem(SKIN_SYSTEM_KEY) || 'elyby'; }

document.querySelectorAll('.skin-system-option').forEach(btn => {
  if (btn.classList.contains('is-active') === false && btn.dataset.skinSystem === getSkinSystemPref() && !btn.classList.contains('is-disabled')) {
    document.querySelectorAll('.skin-system-option').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
  }
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-disabled')) return;
    document.querySelectorAll('.skin-system-option').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    localStorage.setItem(SKIN_SYSTEM_KEY, btn.dataset.skinSystem);
  });
});

// ============================================
// Модалка "Сменить скин"
// ============================================
const skinChangeInfoOverlay = document.getElementById('skinChangeInfoOverlay');
const skinChangeInfoClose = document.getElementById('skinChangeInfoClose');
const skinChangeDontShowAgain = document.getElementById('skinChangeDontShowAgain');
const skinChangeGoBtn = document.getElementById('skinChangeGoBtn');
const SKIN_CHANGE_DONT_SHOW_KEY = 'magma_skin_change_dont_show';

document.getElementById('skinChangeBtn')?.addEventListener('click', () => {
  if (localStorage.getItem(SKIN_CHANGE_DONT_SHOW_KEY) === '1') {
    openLinkInBrowser('https://ely.by/');
    return;
  }
  skinChangeInfoOverlay?.classList.add('is-open');
});
skinChangeInfoClose?.addEventListener('click', () => skinChangeInfoOverlay.classList.remove('is-open'));
skinChangeInfoOverlay?.addEventListener('click', (e) => { if (e.target === skinChangeInfoOverlay) skinChangeInfoOverlay.classList.remove('is-open'); });
skinChangeGoBtn?.addEventListener('click', () => {
  if (skinChangeDontShowAgain?.checked) localStorage.setItem(SKIN_CHANGE_DONT_SHOW_KEY, '1');
  skinChangeInfoOverlay?.classList.remove('is-open');
  openLinkInBrowser('https://ely.by/');
});

// ============================================
// Автоустановка CustomSkinLoader с конфигом под Ely.by — качается перед
// каждым запуском, если её ещё нет в текущей папке mods (в т.ч. если игрок
// удалил её вручную), и настраивается на skinsystem.ely.by.
// ============================================
const CUSTOM_SKIN_LOADER_SLUG = 'customskinloader';
const SKIN_LOADER_ENABLED_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

async function ensureCustomSkinLoaderInstalled(loader, version, modsDir, instanceRootDir) {
  if (getSkinSystemPref() !== 'elyby') return;
  if (!SKIN_LOADER_ENABLED_LOADERS.includes(loader)) return;
  if (typeof window.listModsInDir !== 'function' || typeof window.installMod !== 'function') return;

  try {
    const raw = await window.listModsInDir({ dir: modsDir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const files = result.success ? (result.files || []) : [];
    const already = files.some(f => /customskinloader/i.test(f));
    if (!already) {
      await window.installMod({ slug: CUSTOM_SKIN_LOADER_SLUG, version, loader, modsDir });
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось установить CustomSkinLoader:', err);
  }

  if (typeof window.installLocalFile === 'function') {
    const config = {
      enable: true,
      loadlist: [
        { name: 'ElyBy', type: 'ElyByAPI' },
        { name: 'Mojang', type: 'MojangAPI' },
      ],
    };
    try {
      const base64 = btoa(unescape(encodeURIComponent(JSON.stringify(config, null, 2))));
      await window.installLocalFile({
        filename: 'CustomSkinLoader.json',
        dataBase64: base64,
        targetDir: `${instanceRootDir}\\CustomSkinLoader`,
      });
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось записать конфиг CustomSkinLoader:', err);
    }
  }
}

// ============================================
// Версии и лоадеры
// ============================================

// Список версий Minecraft: Java Edition, от новых к старым.
// С 2026 года Mojang перешёл на схему "год.дроп.хотфикс" (26.1, 26.2, ...) —
// версии 1.21.5–1.21.11 были последними в старом формате.
// Порядок 26.x по дате выхода: 26.1 (24 марта) -> 26.1.1 -> 26.1.2 (9 апреля) -> 26.2 (июнь).
// ВАЖНО: версии 26.x требуют Java 25 — но лаунчер теперь сам скачивает нужную
// версию Java автоматически (см. launcher_core.cpp), вручную ставить не нужно.
const VERSIONS = [
  '26.2','26.1.2','26.1.1','26.1',
  '1.21.11','1.21.10','1.21.9','1.21.8','1.21.7','1.21.6','1.21.5',
  '1.21.4','1.21.3','1.21.2','1.21.1','1.21',
  '1.20.6','1.20.5','1.20.4','1.20.3','1.20.2','1.20.1','1.20',
  '1.19.4','1.19.3','1.19.2','1.19.1','1.19',
  '1.18.2','1.18.1','1.18',
  '1.17.1','1.17',
  '1.16.5','1.16.4','1.16.3','1.16.2','1.16.1','1.16',
  '1.15.2','1.15.1','1.15',
  '1.14.4','1.14.3','1.14.2','1.14.1','1.14',
  '1.13.2','1.13.1','1.13',
  '1.12.2','1.12.1','1.12',
  '1.11.2','1.11.1','1.11',
  '1.10.2','1.10.1','1.10',
  '1.9.4','1.9.3','1.9.2','1.9.1','1.9',
  '1.8.9','1.8.8','1.8.7','1.8.6','1.8.5','1.8.4','1.8.3','1.8.2','1.8.1','1.8',
  '1.7.10','1.7.9','1.7.8','1.7.7','1.7.6','1.7.5','1.7.4','1.7.3','1.7.2',
  '1.6.4','1.6.2','1.6.1',
  '1.5.2','1.5.1','1.5',
  '1.4.7','1.4.6','1.4.5','1.4.4','1.4.2',
  '1.3.2','1.3.1',
  '1.2.5','1.2.4','1.2.3','1.2.2','1.2.1',
  '1.1','1.0'
];

async function refreshVersionsFromMojang() {
  if (typeof window.getMinecraftVersions !== 'function') return;
  try {
    const raw = await window.getMinecraftVersions();
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return;
    const releases = (result.versions || [])
      .filter(v => v.type === 'release')
      .map(v => v.id);
    if (releases.length) VERSIONS = releases; // Mojang уже отдаёт новые -> старые
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось обновить список версий:', err);
  }
}

// Лоадеры и минимальная поддерживаемая версия каждого.
// Vanilla, Fabric и Forge реально работают через launcher_core.cpp (Forge —
// через официальный silent-инсталлятор, надёжно начиная примерно с 1.6+,
// у совсем древних версий инсталлятора с CLI-флагом ещё не было).
// OptiFine / Forge+OptiFine ВРЕМЕННО ОТКЛЮЧЕНЫ: у optifine.net нет публичного
// API, скачивание шло через сторонние зеркала (BMCLAPI/FastMCMirror), и это
// оказалось слишком нестабильно (регулярные ERR_OPTIFINE_DOWNLOAD_FAILED).
// Помечены supported:false — вкладки показываются серыми с подсказкой
// "Скоро будет доступно", как и вкладка Microsoft, пока не появится надёжный
// способ их устанавливать.

const THEMES = [
  { id: 'magma', name: 'Magma (по умолчанию)', available: true, accent: ['#ff7a1a', '#ff3d1c'] },
  { id: 'chocolate-forge', name: 'Chocolate Forge', available: true, accent: ['#e08d3c', '#9c4a12'] },
  { id: 'cosmic-ember', name: 'Cosmic Ember', available: true, accent: ['#ff5f8f', '#7b4dff'] },
  { id: 'obsidian-nebula', name: 'Obsidian Nebula', available: true, accent: ['#8a4dff', '#4d1fbf'] },
  { id: 'molten-aurora', name: 'Molten Aurora', available: true, accent: ['#2fe0a0', '#14a8c9'] },
  { id: 'frostbyte', name: 'Frostbyte', available: true, accent: ['#3fb8ff', '#1a6fd4'] },
  { id: 'amber-nightfall', name: 'Amber Nightfall', available: true, accent: ['#ffb347', '#d97a1f'] },
  { id: 'velvet-magma', name: 'Velvet Magma', available: true, accent: ['#ff5a4a', '#b8123f'] },
  { id: 'solar-flare', name: 'Solar Flare', available: true, accent: ['#ffcc33', '#ff6a1f'] },
  { id: 'emerald-deep', name: 'Emerald Deep', available: true, accent: ['#2ecc71', '#10704a'] },
  { id: 'twilight-ashes', name: 'Twilight Ashes', available: true, accent: ['#b1a3d8', '#6c5c99'] },
  { id: 'minecraft', name: 'Minecraft', available: true, accent: ['#5aa829', '#3c7d1b'] },
];
const THEME_KEY = 'magma_theme';
function getActiveTheme() { return localStorage.getItem(THEME_KEY) || 'magma'; }

function applyActiveTheme() {
  document.documentElement.setAttribute('data-theme', getActiveTheme());
}

function renderThemeOptions() {
  const wrap = document.getElementById('themeOptions');
  if (!wrap) return;
  wrap.innerHTML = '';
  const active = getActiveTheme();
  THEMES.forEach(theme => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'skin-system-option' + (theme.id === active ? ' is-active' : '');
    const themeLabel = theme.id === 'magma' ? t('settings.theme.magmaDefault') : theme.name;
    btn.innerHTML = `<span class="theme-swatch" style="background:linear-gradient(135deg, ${theme.accent[0]}, ${theme.accent[1]})"></span><span>${themeLabel}</span>`;
    btn.addEventListener('click', () => {
      localStorage.setItem(THEME_KEY, theme.id);
      applyActiveTheme();
      renderThemeOptions();
    });
    wrap.appendChild(btn);
  });
}

const HERO_CUSTOM_KEY = 'magma_hero_custom';
function getHeroCustom() {
  try { return JSON.parse(localStorage.getItem(HERO_CUSTOM_KEY) || '{}'); } catch { return {}; }
}
function saveHeroCustom(data) {
  localStorage.setItem(HERO_CUSTOM_KEY, JSON.stringify(data));
}

const HERO_BG_PRESETS = [
  { id: 'sunrise',   name: { ru: 'Рассвет', en: 'Sunrise', uk: 'Світанок', fr: 'Aube', de: 'Sonnenaufgang', es: 'Amanecer', it: 'Alba', pt: 'Nascer do sol', ja: '日の出', ko: '일출', hi: 'सूर्योदय', id: 'Matahari terbit' },   gradient: 'linear-gradient(160deg, #ffb457 0%, #ff7a59 40%, #3b2f63 100%)' },
  { id: 'overworld', name: { ru: 'Оверворлд', en: 'Overworld', uk: 'Верхній світ', fr: 'Monde normal', de: 'Oberwelt', es: 'Superficie', it: 'Overworld', pt: 'Mundo superior', ja: 'オーバーワールド', ko: '오버월드', hi: 'ओवरवर्ल्ड', id: 'Overworld' }, gradient: 'linear-gradient(160deg, #4d8fac 0%, #2f6b4f 45%, #16281c 100%)' },
  { id: 'nether',    name: { ru: 'Нижний мир', en: 'Nether', uk: 'Нижній світ', fr: 'Nether', de: 'Nether', es: 'Nether', it: 'Nether', pt: 'Nether', ja: 'ネザー', ko: '네더', hi: 'नीदरलैंड', id: 'Nether' },    gradient: 'linear-gradient(160deg, #a8391f 0%, #5c1c12 45%, #1a0a06 100%)' },
  { id: 'end',       name: { ru: 'Край', en: 'The End', uk: 'Край', fr: 'L’End', de: 'Das Ende', es: 'El End', it: 'End', pt: 'O End', ja: 'ジ・エンド', ko: '엔드', hi: 'द एंड', id: 'The End' },   gradient: 'linear-gradient(160deg, #6a3f8f 0%, #2c1c47 45%, #0d0a1a 100%)' },
  { id: 'ocean',     name: { ru: 'Океан', en: 'Ocean', uk: 'Океан', fr: 'Océan', de: 'Ozean', es: 'Océano', it: 'Oceano', pt: 'Oceano', ja: '海', ko: '바다', hi: 'महासागर', id: 'Laut' },     gradient: 'linear-gradient(160deg, #1c6ea4 0%, #0e3a5c 45%, #061a2b 100%)' },
  { id: 'aurora',    name: { ru: 'Сияние', en: 'Aurora', uk: 'Сяйво', fr: 'Aurore', de: 'Polarlicht', es: 'Aurora', it: 'Aurora', pt: 'Aurora', ja: 'オーロラ', ko: '오로라', hi: 'ऑरोरा', id: 'Aurora' },    gradient: 'linear-gradient(160deg, #2fe0a0 0%, #14a8c9 45%, #0a1a2b 100%)' },
  { id: 'cave',      name: { ru: 'Пещера', en: 'Cave', uk: 'Печера', fr: 'Grotte', de: 'Höhle', es: 'Cueva', it: 'Grotta', pt: 'Caverna', ja: '洞窟', ko: '동굴', hi: 'गुफा', id: 'Gua' },      gradient: 'linear-gradient(160deg, #6b5c44 0%, #392f22 45%, #0e0c09 100%)' },
  { id: 'night',     name: { ru: 'Ночь', en: 'Night', uk: 'Ніч', fr: 'Nuit', de: 'Nacht', es: 'Noche', it: 'Notte', pt: 'Noite', ja: '夜', ko: '밤', hi: 'रात', id: 'Malam' },     gradient: 'linear-gradient(160deg, #2c3a6e 0%, #161c38 45%, #05060d 100%)' },
];

function renderHeroBgPresetOptions() {
  const wrap = document.getElementById('heroBgPresetOptions');
  if (!wrap) return;
  wrap.innerHTML = '';
  const custom = getHeroCustom();
  const langKey = currentLang === 'es-ES' ? 'es' : currentLang;

  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'hero-bg-preset-option' + (!custom.bgPreset && !custom.bgImage ? ' is-active' : '');
  noneBtn.innerHTML = `<span class="hero-bg-preset-swatch hero-bg-preset-swatch-none"></span><span>${t('settings.heroBg.none')}</span>`;
  noneBtn.addEventListener('click', () => selectHeroBgPreset(null));
  wrap.appendChild(noneBtn);

  HERO_BG_PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hero-bg-preset-option' + (custom.bgPreset === preset.id ? ' is-active' : '');
    const label = preset.name[langKey] || preset.name.ru;
    btn.innerHTML = `<span class="hero-bg-preset-swatch" style="background:${preset.gradient}"></span><span>${label}</span>`;
    btn.addEventListener('click', () => selectHeroBgPreset(preset.id));
    wrap.appendChild(btn);
  });
}

function selectHeroBgPreset(presetId) {
  const custom = getHeroCustom();
  if (presetId) {
    custom.bgPreset = presetId;
    delete custom.bgImage;
    delete custom.bgPosX;
    delete custom.bgPosY;
    delete custom.bgZoom;
  } else {
    delete custom.bgPreset;
  }
  saveHeroCustom(custom);
  applyHeroCustomization();
}

function applyHeroCustomization() {
  const custom = getHeroCustom();
  updateHeroPreview(custom);
  renderHeroBgPresetOptions();

  const eyebrowInput = document.getElementById('heroEyebrowInput');
  const titleInput = document.getElementById('heroTitleInput');
  if (eyebrowInput) eyebrowInput.value = custom.eyebrow || '';
  if (titleInput) titleInput.value = custom.title || '';
}
function updateHeroPreview(custom) {
  const eyebrowEl = document.getElementById('heroEyebrowEl');
  const titleEl = document.getElementById('heroTitleEl');
  if (eyebrowEl) eyebrowEl.textContent = custom.eyebrow || t('hero.eyebrow');
  if (titleEl) titleEl.textContent = custom.title || t('hero.title');

  const posX = typeof custom.bgPosX === 'number' ? custom.bgPosX : 50;
  const posY = typeof custom.bgPosY === 'number' ? custom.bgPosY : 50;
  const zoom = typeof custom.bgZoom === 'number' ? custom.bgZoom : 100;
  const preset = custom.bgPreset ? HERO_BG_PRESETS.find(p => p.id === custom.bgPreset) : null;

  const heroEl = document.querySelector('.hero');
  const heroGlowEl = document.querySelector('.hero-glow');
  if (heroEl) {
    heroEl.classList.toggle('is-photo-bg', !!custom.bgImage);
    if (custom.bgImage) {
      heroEl.style.background = `url("${custom.bgImage}")`;
      heroEl.style.backgroundSize = `${zoom}%`;
      heroEl.style.backgroundPosition = `${posX}% ${posY}%`;
      heroEl.style.backgroundRepeat = 'no-repeat';
    } else if (preset) {
      heroEl.style.background = preset.gradient;
      heroEl.style.backgroundSize = '';
      heroEl.style.backgroundPosition = '';
    } else {
      heroEl.style.background = '';
      heroEl.style.backgroundSize = '';
      heroEl.style.backgroundPosition = '';
    }
  }
  if (heroGlowEl) heroGlowEl.style.display = (custom.bgImage || custom.bgPreset) ? 'none' : '';

  const preview = document.getElementById('heroBgPreview');
  if (preview) {
    if (custom.bgImage) {
      preview.style.backgroundImage = `url("${custom.bgImage}")`;
      preview.style.backgroundSize = zoom + '%';
      preview.style.backgroundPosition = `${posX}% ${posY}%`;
    } else if (preset) {
      preview.style.backgroundImage = preset.gradient;
      preview.style.backgroundSize = '';
      preview.style.backgroundPosition = '';
    } else {
      preview.style.backgroundImage = '';
    }
  }

  const editBtn = document.getElementById('heroBgEditBtn');
  if (editBtn) editBtn.style.display = custom.bgImage ? '' : 'none';
}

document.getElementById('heroEyebrowInput')?.addEventListener('input', () => {
  const input = document.getElementById('heroEyebrowInput');
  const custom = getHeroCustom();
  custom.eyebrow = input.value;
  saveHeroCustom(custom);
  updateHeroPreview(custom);
});
document.getElementById('heroTitleInput')?.addEventListener('input', () => {
  const input = document.getElementById('heroTitleInput');
  const custom = getHeroCustom();
  custom.title = input.value;
  saveHeroCustom(custom);
  updateHeroPreview(custom);
});

document.getElementById('heroTextResetBtn')?.addEventListener('click', () => {
  const custom = getHeroCustom();
  delete custom.eyebrow;
  delete custom.title;
  saveHeroCustom(custom);
  applyLanguage(currentLang);
});

document.getElementById('heroBgUploadBtn')?.addEventListener('click', () => {
  document.getElementById('heroBgFileInput')?.click();
});
document.getElementById('heroBgFileInput')?.addEventListener('change', () => {
  const input = document.getElementById('heroBgFileInput');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const custom = getHeroCustom();
    custom.bgImage = reader.result;
    custom.bgPosX = 50;
    custom.bgPosY = 50;
    custom.bgZoom = 100;
    delete custom.bgPreset;
    saveHeroCustom(custom);
    applyHeroCustomization();
  };
  reader.readAsDataURL(file);
});
document.getElementById('heroBgResetBtn')?.addEventListener('click', () => {
  const custom = getHeroCustom();
  delete custom.bgImage;
  delete custom.bgPosX;
  delete custom.bgPosY;
  delete custom.bgZoom;
  delete custom.bgPreset;
  saveHeroCustom(custom);
  applyHeroCustomization();
});

const heroBgEditBtn = document.getElementById('heroBgEditBtn');
const heroBgEditorOverlay = document.getElementById('heroBgEditorOverlay');
const heroBgEditorClose = document.getElementById('heroBgEditorClose');
const heroBgEditorFrame = document.getElementById('heroBgEditorFrame');
const heroBgEditorImageEl = document.getElementById('heroBgEditorImage');
const heroBgEditorZoomEl = document.getElementById('heroBgEditorZoom');
const heroBgEditorResetPosBtn = document.getElementById('heroBgEditorResetPos');
const heroBgEditorSaveBtn = document.getElementById('heroBgEditorSaveBtn');

let heroBgEditorState = { posX: 50, posY: 50, zoom: 100 };
let heroBgEditorDragging = false;
let heroBgEditorDragStart = { x: 0, y: 0, posX: 50, posY: 50 };

function applyHeroBgEditorPreview() {
  if (!heroBgEditorImageEl) return;
  heroBgEditorImageEl.style.backgroundSize = heroBgEditorState.zoom + '%';
  heroBgEditorImageEl.style.backgroundPosition = `${heroBgEditorState.posX}% ${heroBgEditorState.posY}%`;
  if (heroBgEditorZoomEl) heroBgEditorZoomEl.value = heroBgEditorState.zoom;
}

function openHeroBgEditor() {
  const custom = getHeroCustom();
  if (!custom.bgImage) return;
  heroBgEditorState = {
    posX: typeof custom.bgPosX === 'number' ? custom.bgPosX : 50,
    posY: typeof custom.bgPosY === 'number' ? custom.bgPosY : 50,
    zoom: typeof custom.bgZoom === 'number' ? custom.bgZoom : 100,
  };
  if (heroBgEditorImageEl) heroBgEditorImageEl.style.backgroundImage = `url("${custom.bgImage}")`;
  applyHeroBgEditorPreview();
  heroBgEditorOverlay?.classList.add('is-open');
}

function closeHeroBgEditor() {
  heroBgEditorOverlay?.classList.remove('is-open');
}

heroBgEditBtn?.addEventListener('click', openHeroBgEditor);
heroBgEditorClose?.addEventListener('click', closeHeroBgEditor);
heroBgEditorOverlay?.addEventListener('click', (e) => { if (e.target === heroBgEditorOverlay) closeHeroBgEditor(); });

heroBgEditorZoomEl?.addEventListener('input', () => {
  heroBgEditorState.zoom = Number(heroBgEditorZoomEl.value) || 100;
  applyHeroBgEditorPreview();
});

heroBgEditorResetPosBtn?.addEventListener('click', () => {
  heroBgEditorState.posX = 50;
  heroBgEditorState.posY = 50;
  applyHeroBgEditorPreview();
});

heroBgEditorFrame?.addEventListener('pointerdown', (e) => {
  heroBgEditorDragging = true;
  heroBgEditorFrame.classList.add('is-dragging');
  heroBgEditorFrame.setPointerCapture(e.pointerId);
  heroBgEditorDragStart = { x: e.clientX, y: e.clientY, posX: heroBgEditorState.posX, posY: heroBgEditorState.posY };
});
heroBgEditorFrame?.addEventListener('pointermove', (e) => {
  if (!heroBgEditorDragging) return;
  const rect = heroBgEditorFrame.getBoundingClientRect();
  const dxPercent = ((e.clientX - heroBgEditorDragStart.x) / rect.width) * 100;
  const dyPercent = ((e.clientY - heroBgEditorDragStart.y) / rect.height) * 100;
  heroBgEditorState.posX = Math.max(0, Math.min(100, heroBgEditorDragStart.posX - dxPercent));
  heroBgEditorState.posY = Math.max(0, Math.min(100, heroBgEditorDragStart.posY - dyPercent));
  applyHeroBgEditorPreview();
});
function endHeroBgEditorDrag(e) {
  if (!heroBgEditorDragging) return;
  heroBgEditorDragging = false;
  heroBgEditorFrame?.classList.remove('is-dragging');
  try { heroBgEditorFrame?.releasePointerCapture(e.pointerId); } catch {}
}
heroBgEditorFrame?.addEventListener('pointerup', endHeroBgEditorDrag);
heroBgEditorFrame?.addEventListener('pointercancel', endHeroBgEditorDrag);

heroBgEditorSaveBtn?.addEventListener('click', () => {
  const custom = getHeroCustom();
  custom.bgPosX = heroBgEditorState.posX;
  custom.bgPosY = heroBgEditorState.posY;
  custom.bgZoom = heroBgEditorState.zoom;
  saveHeroCustom(custom);
  applyHeroCustomization();
  closeHeroBgEditor();
});

const LOADERS = [
  { id: 'vanilla',        label: 'Vanilla',         min: '1.0',    supported: true },
  { id: 'fabric',         label: 'Fabric',          min: '1.14',   supported: true },
  { id: 'forge',          label: 'Forge',           min: '1.1',    supported: true },
  { id: 'neoforge',       label: 'NeoForge',        min: '1.20.1', supported: true },
  { id: 'quilt',          label: 'Quilt',           min: '1.14',   supported: true },
  { id: 'modpacks',       label: 'Modpacks',        min: '1.0',    supported: true, isModpacksTab: true },
];

let showSnapshots = false;
let snapshotVersionsCache = null;
let snapshotVersionsFetchPromise = null;

async function ensureSnapshotVersions() {
  if (snapshotVersionsCache) return snapshotVersionsCache;
  if (snapshotVersionsFetchPromise) return snapshotVersionsFetchPromise;

  if (typeof window.getMinecraftVersions !== 'function') {
    snapshotVersionsCache = [];
    return snapshotVersionsCache;
  }

  snapshotVersionsFetchPromise = (async () => {
    try {
      const raw = await window.getMinecraftVersions();
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!result.success) { snapshotVersionsCache = []; return snapshotVersionsCache; }
      snapshotVersionsCache = (result.versions || [])
        .filter(v => v.type === 'snapshot')
        .map(v => v.id);
      return snapshotVersionsCache;
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось получить список снапшотов:', err);
      snapshotVersionsCache = [];
      return snapshotVersionsCache;
    } finally {
      snapshotVersionsFetchPromise = null;
    }
  })();

  return snapshotVersionsFetchPromise;
}

let activeLoader = 'vanilla';
let selectedVersion = VERSIONS[0];
let currentSelectedLoader = 'vanilla';
let selectedInstanceName = ''; // непусто, если выбран конкретный модпак (см. МОДПАКИ ниже)

const LAST_SELECTION_KEY = 'magma_last_selection';

function saveLastSelection() {
  try {
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify({
      version: selectedVersion,
      loader: currentSelectedLoader,
      instanceName: selectedInstanceName,
    }));
  } catch {}
}

function restoreLastSelection() {
  try {
    const raw = localStorage.getItem(LAST_SELECTION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved) return;

    if (saved.instanceName) {
      const pack = getModpacks().find(p => p.name === saved.instanceName);
      if (pack) {
        selectedVersion = pack.mcVersion;
        currentSelectedLoader = pack.loader;
        selectedInstanceName = pack.name;
        versionBtnLabel.textContent = `${pack.name} (${pack.mcVersion})`;
        return;
      }
    }

    if (saved.version && saved.loader) {
      const loader = LOADERS.find(l => l.id === saved.loader && !l.isModpacksTab);
      if (!loader) return;

      if (saved.isSnapshot) {
        selectedVersion = saved.version;
        currentSelectedLoader = saved.loader;
        selectedInstanceName = '';
        showSnapshots = true;
        activeLoader = saved.loader;
        versionBtnLabel.textContent = `${loader.label} ${saved.version}`;
        return;
      }

      if (VERSIONS.includes(saved.version) && cmpV(saved.version, loader.min) >= 0) {
        selectedVersion = saved.version;
        currentSelectedLoader = saved.loader;
        selectedInstanceName = '';
        versionBtnLabel.textContent = `${loader.label} ${saved.version}`;
      }
    }
  } catch {}
}

function parseV(v) {
  return v.split('.').map(n => parseInt(n, 10) || 0);
}

function cmpV(a, b) {
  const pa = parseV(a), pb = parseV(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const versionBtn = document.getElementById('versionBtn');
const versionBtnLabel = document.getElementById('versionBtnLabel');
const versionDropdown = document.getElementById('versionDropdown');
if (versionBtnLabel) versionBtnLabel.textContent = `Vanilla ${selectedVersion}`;
const loaderTabsEl = document.getElementById('loaderTabs');
const versionListEl = document.getElementById('versionList');
const versionSearchEl = document.getElementById('versionSearch');

function renderLoaderTabs() {
  loaderTabsEl.innerHTML = '';
  LOADERS.forEach(loader => {
    const tab = document.createElement('button');
    tab.className = 'loader-tab' + (loader.id === activeLoader ? ' is-active' : '') + (loader.supported ? '' : ' is-unsupported');
    tab.textContent = loader.id === 'modpacks' ? t('loader.modpacks') : loader.label;
    if (!loader.supported) tab.setAttribute('data-tooltip', t('loader.comingSoon'));
    tab.addEventListener('click', () => {
      if (!loader.supported) return;

      if (loader.id === activeLoader) {
        if (showSnapshots) {
          showSnapshots = false;
          renderSnapshotToggle();
          renderVersionList(versionSearchEl.value);
        }
        return;
      }

      activeLoader = loader.id;
      renderLoaderTabs();
      renderSnapshotToggle();
      renderVersionList(versionSearchEl.value);
      if (loader.isModpacksTab && !selectedInstanceName) {
        const firstPack = getModpacks()[0];
        if (firstPack) {
          selectedVersion = firstPack.mcVersion;
          currentSelectedLoader = firstPack.loader;
          selectedInstanceName = firstPack.name;
          versionBtnLabel.textContent = `${firstPack.name} (${firstPack.mcVersion})`;
          saveLastSelection();
          renderVersionList(versionSearchEl.value);
        }
      }
    });
    loaderTabsEl.appendChild(tab);
  });
}

const snapshotToggleBtn = document.getElementById('snapshotToggleBtn');

function renderSnapshotToggle() {
  if (!snapshotToggleBtn) return;
  const loader = LOADERS.find(l => l.id === activeLoader);
  const hide = !loader || loader.isModpacksTab;
  snapshotToggleBtn.style.display = hide ? 'none' : 'inline-flex';
  snapshotToggleBtn.classList.toggle('is-active', showSnapshots);
}

snapshotToggleBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  showSnapshots = !showSnapshots;
  renderSnapshotToggle();
  if (showSnapshots) {
    versionListEl.innerHTML = `<div class="v-empty">${t('hero.searchingSnapshots')}</div>`;
    await ensureSnapshotVersions();
  }
  renderVersionList(versionSearchEl.value);
});
function renderVersionList(filter) {
  const loader = LOADERS.find(l => l.id === activeLoader);
  const query = (filter || '').trim().toLowerCase();

  // Вкладка "Modpacks" — вместо версий Minecraft показываем список модпаков,
  // которые игрок уже создал (те же данные, что и в разделе "Сборки").
  if (loader.isModpacksTab) {
    const packs = getModpacks().filter(p => !query || p.name.toLowerCase().includes(query));
    versionListEl.innerHTML = '';

    if (packs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'v-empty';
      empty.textContent = t('modpacks.none');
      versionListEl.appendChild(empty);
      return;
    }

    packs.forEach(pack => {
      const item = document.createElement('button');
      const isSelected = selectedInstanceName === pack.name;
      item.className = 'version-item' + (isSelected ? ' is-selected' : '');
      item.textContent = `${pack.name} (${pack.mcVersion})`;
      item.addEventListener('click', () => {
        selectedVersion = pack.mcVersion;
        currentSelectedLoader = pack.loader;
        selectedInstanceName = pack.name;
        versionBtnLabel.textContent = `${pack.name} (${pack.mcVersion})`;
        saveLastSelection();
        closeDropdown();
        setLaunchProgress(false, 0, '');
      });
      versionListEl.appendChild(item);
    });
    return;
  }

  if (showSnapshots) {
    const list = snapshotVersionsCache || [];
    const filteredSnaps = list.filter(v => !query || v.toLowerCase().includes(query));
    versionListEl.innerHTML = '';

    if (filteredSnaps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'v-empty';
      empty.textContent = t('version.notFound');
      versionListEl.appendChild(empty);
      return;
    }

    filteredSnaps.forEach(v => {
      const item = document.createElement('button');
      item.className = 'version-item' + (v === selectedVersion && activeLoader === currentSelectedLoader && !selectedInstanceName ? ' is-selected' : '');
      item.textContent = v;
      item.addEventListener('click', () => {
        selectedVersion = v;
        currentSelectedLoader = activeLoader;
        selectedInstanceName = '';
        versionBtnLabel.textContent = `${loader.label} ${v}`;
        saveLastSelection();
        closeDropdown();
        setLaunchProgress(false, 0, '');
      });
      versionListEl.appendChild(item);
    });
    return;
  }

  const filtered = VERSIONS.filter(v => {
    if (cmpV(v, loader.min) < 0) return false;
    if (query && !v.toLowerCase().includes(query)) return false;
    return true;
  });

  versionListEl.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'v-empty';
    empty.textContent = t('version.notFound');
    versionListEl.appendChild(empty);
    return;
  }

  filtered.forEach(v => {
    const item = document.createElement('button');
    item.className = 'version-item' + (v === selectedVersion && activeLoader === currentSelectedLoader && !selectedInstanceName ? ' is-selected' : '');
    item.textContent = v;
    item.addEventListener('click', () => {
      selectedVersion = v;
      currentSelectedLoader = activeLoader;
      selectedInstanceName = ''; // это обычная сборка, а не модпак
      versionBtnLabel.textContent = `${loader.label} ${v}`;
      saveLastSelection();
      closeDropdown();
      // Явный выбор новой версии/загрузчика — ошибка или прогресс от
      // предыдущей попытки запуска больше не актуальны, прячем их сразу,
      // а не ждём следующего клика по "Играть".
      setLaunchProgress(false, 0, '');
    });
    versionListEl.appendChild(item);
  });
}

function openDropdown() {
  versionDropdown.classList.add('is-open');
  renderLoaderTabs();
  renderSnapshotToggle();
  renderVersionList(versionSearchEl.value);
}

function closeDropdown() {
  versionDropdown.classList.remove('is-open');
}

versionBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (versionDropdown.classList.contains('is-open')) {
    closeDropdown();
  } else {
    openDropdown();
  }
});

versionSearchEl.addEventListener('input', () => renderVersionList(versionSearchEl.value));
versionSearchEl.addEventListener('click', (e) => e.stopPropagation());
versionDropdown.addEventListener('click', (e) => e.stopPropagation());

document.addEventListener('click', () => closeDropdown());

// ============================================
// Сборки — реальные установленные модпаки (созданные игроком через
// "+ Создать модпак" или установленные из каталога Modrinth/CurseForge).
// Модпаки хранятся в localStorage (сами моды физически лежат в
// instances/<name>/mods на диске, localStorage хранит только метаданные
// для отрисовки карточек и повторного запуска без переустановки).
// ============================================
const MODPACKS_KEY = 'magma_modpacks';

function getModpacks() {
  try {
    const raw = localStorage.getItem(MODPACKS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveModpack(modpack) {
  const list = getModpacks().filter(m => m.name !== modpack.name);
  list.unshift(modpack);
  localStorage.setItem(MODPACKS_KEY, JSON.stringify(list));
}

const instanceGrid = document.getElementById('instanceGrid');

function renderInstances() {
  if (!instanceGrid) return;
  instanceGrid.innerHTML = '';

  const packs = getModpacks();

  if (packs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-hint';
    empty.textContent = t('instances.none');
    instanceGrid.appendChild(empty);
  }

  packs.forEach(pack => {
    const card = document.createElement('div');
    card.className = 'instance-card';
    const loaderLabel = pack.loader === 'forge' ? 'Forge' : pack.loader === 'fabric' ? 'Fabric' : (pack.loader || 'Vanilla');
    const modsCount = Array.isArray(pack.mods) ? pack.mods.length : 0;
    const iconHtml = pack.icon_url
      ? `<img class="instance-icon-img" src="${pack.icon_url}" alt="">`
      : pack.name.charAt(0).toUpperCase();
    card.innerHTML = `
      <div class="instance-icon">${iconHtml}</div>
      <div class="instance-name">${pack.name}</div>
      <div class="instance-meta">${loaderLabel} · ${pack.mcVersion}${modsCount ? ' · ' + modsCount + ' ' + t('mods.modsCount') : ''}</div>
      <button type="button" class="instance-card-play" data-pack="${pack.name}">${t('hero.play')}</button>
    `;
    card.querySelector('.instance-card-play').addEventListener('click', (e) => { e.stopPropagation(); closeInstanceContextMenu(); launchModpack(pack); });
    card.addEventListener('click', () => { closeInstanceContextMenu(); openInstanceModsModal(pack); });
     instanceGrid.appendChild(card);

    const instanceIconImg = card.querySelector('.instance-icon-img');

    if (instanceIconImg) {
      instanceIconImg.addEventListener('error', () => {
        instanceIconImg.replaceWith(
          document.createTextNode(pack.name.charAt(0).toUpperCase())
        );
      }, { once: true });
    }
  });


  const newCard = document.createElement('div');
  newCard.className = 'instance-card is-new';
  newCard.innerHTML = `<span class="plus">+</span><span>${t('instances.newCard')}</span>`;
  newCard.addEventListener('click', openModpackModal);
  instanceGrid.appendChild(newCard);
}

async function removeInstanceEverywhere(pack) {
  if (typeof window.deleteInstance === 'function') {
    try {
      const dir = getGameDir();
      const raw = await window.deleteInstance({ name: pack.name, gameDir: dir });
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!result.success) console.error('[MagmaLauncher] Не удалось удалить файлы сборки:', result.error);
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось удалить файлы сборки:', err);
    }
  }
  const list = getModpacks().filter(p => p.name !== pack.name);
  localStorage.setItem(MODPACKS_KEY, JSON.stringify(list));
  if (selectedInstanceName === pack.name) {
    selectedInstanceName = '';
    selectedVersion = '1.21.4';
    currentSelectedLoader = 'vanilla';
    versionBtnLabel.textContent = `Vanilla ${selectedVersion}`;
    saveLastSelection();
  }
  renderInstances();
}

document.getElementById('newInstanceBtn')?.addEventListener('click', openModpackModal);
// Та же модалка "Создать модпак", но кнопка вызова живёт во вкладке "Моды" —
// раньше у неё не было обработчика вообще, поэтому нажатие ничего не делало.
document.getElementById('createModpackBtn')?.addEventListener('click', openModpackModal);

// ============================================
// Модалка "Моды сборки" — открывается кликом по карточке в "Мои сборки".
// Показывает реальное содержимое instances/<name>/mods (включить/отключить/
// удалить, как в общей вкладке "Мои моды"), плюс кнопка "Добавить моды",
// которая переключает во вкладку "Моды" с уже выбранным этим модпаком.
// ============================================
const instanceModsOverlay = document.getElementById('instanceModsOverlay');
const instanceModsClose = document.getElementById('instanceModsClose');
const instanceModsTitleEl = document.getElementById('instanceModsTitle');
const instanceModsListEl = document.getElementById('instanceModsList');
const instanceModsAddBtn = document.getElementById('instanceModsAddBtn');
const instanceModsDeleteBtnEl = document.getElementById('instanceModsDeleteBtn');

instanceModsClose?.addEventListener('click', closeInstanceModsModal);
instanceModsOverlay?.addEventListener('click', (e) => { if (e.target === instanceModsOverlay) closeInstanceModsModal(); });
instanceModsDeleteBtnEl?.addEventListener('click', async () => {
  const pack = currentInstanceModsPack;
  if (!pack) return;
  const msg = t('instance.confirmDelete').replace('{name}', pack.name);
  if (!window.confirm(msg)) return;
  closeInstanceModsModal();
  await removeInstanceEverywhere(pack);
});

let currentInstanceModsPack = null;

function instanceModsDir(pack) {
  const gameDir = getGameDir();
  return `${gameDir}\\instances\\${pack.name}\\mods`;
}

async function openInstanceModsModal(pack) {
  currentInstanceModsPack = pack;
  if (instanceModsTitleEl) instanceModsTitleEl.textContent = `${t('instance.modsTitle')} — ${pack.name}`;
  if (instanceModsAddBtn) instanceModsAddBtn.textContent = t('instance.addMods');
  const deleteBtnEl = document.getElementById('instanceModsDeleteBtn');
  if (deleteBtnEl) deleteBtnEl.textContent = t('instance.deleteBtn');
  instanceModsOverlay?.classList.add('is-open');
  await loadInstanceModsList(pack);
}

function closeInstanceModsModal() {
  instanceModsOverlay?.classList.remove('is-open');
  currentInstanceModsPack = null;
}

async function loadInstanceModsList(pack) {
  if (!instanceModsListEl) return;
  if (typeof window.listModsInDir !== 'function') {
    instanceModsListEl.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
    return;
  }
  instanceModsListEl.innerHTML = `<div class="mod-list-hint">${t('mods.searching')}</div>`;

  try {
    const dir = instanceModsDir(pack);
    const raw = await window.listModsInDir({ dir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) {
      instanceModsListEl.innerHTML = `<div class="mod-list-hint">${translateBackendError(result.error) || t('mods.installed.loadError')}</div>`;
      return;
    }
    const files = (result.files || []).filter(f => /\.jar(\.disabled)?$/i.test(f));
    renderInstanceModsList(files, dir, pack);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось прочитать моды сборки:', err);
    instanceModsListEl.innerHTML = `<div class="mod-list-hint">${t('mods.installed.loadError')}</div>`;
  }
}

function renderInstanceModsList(files, dir, pack) {
  instanceModsListEl.innerHTML = '';
  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-empty';
    empty.textContent = t('instance.noMods');
    instanceModsListEl.appendChild(empty);
    return;
  }

  files.sort((a, b) => modDisplayNameFromFile(a).localeCompare(modDisplayNameFromFile(b)));

  files.forEach(filename => {
    const isDisabled = /\.disabled$/i.test(filename);
    const slug = findSlugForFilename(filename);

    const card = document.createElement('div');
    card.className = 'installed-mod-card' + (isDisabled ? ' is-disabled' : '');
    card.innerHTML = `
      <div class="installed-mod-icon">${(modDisplayNameFromFile(filename).charAt(0) || '?').toUpperCase()}</div>
      <div class="installed-mod-info">
        <div class="installed-mod-name">${modDisplayNameFromFile(filename)}</div>
        ${isDisabled ? `<div class="installed-mod-status">${t('mods.installed.disabled')}</div>` : ''}
      </div>
      <div class="installed-mod-actions">
        <button type="button" class="installed-mod-btn${isDisabled ? ' is-enable' : ''}">
          ${isDisabled
            ? `<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg><span>${t('mods.installed.enable')}</span>`
            : `<svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16" transform="rotate(45 12 12)"/></svg><span>${t('mods.installed.disable')}</span>`}
        </button>
        <button type="button" class="installed-mod-btn is-delete" data-tooltip="${t('mods.installed.delete')}">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>
    `;

    const cardIconImg = card.querySelector('.mod-card-icon-img');
if (cardIconImg) {
  cardIconImg.addEventListener('error', () => {
    cardIconImg.replaceWith(document.createTextNode(iconFallbackChar));
  }, { once: true });
}

     if (slug) {
      fetchModTitleAndIcon(slug).then(info => {
        if (!info) return;
        const nameEl = card.querySelector('.installed-mod-name');
        const iconEl = card.querySelector('.installed-mod-icon');
        if (nameEl) nameEl.textContent = info.title;
        if (iconEl && info.icon_url) iconEl.innerHTML = `<img src="${info.icon_url}" alt="">`;
      }).catch(() => {});
    } else {
      guessModTitleAndIcon(filename).then(info => {
        if (!info) return;
        const nameEl = card.querySelector('.installed-mod-name');
        const iconEl = card.querySelector('.installed-mod-icon');
        if (nameEl) nameEl.textContent = info.title;
        if (iconEl && info.icon_url) iconEl.innerHTML = `<img src="${info.icon_url}" alt="">`;
      }).catch(() => {});
    }
 
    const toggleBtn = card.querySelector('.installed-mod-btn:not(.is-delete)');
    toggleBtn.addEventListener('click', async () => {
      if (typeof window.toggleModFile !== 'function') return;
      toggleBtn.disabled = true;
      try {
        const raw = await window.toggleModFile({ dir, filename });
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
        loadInstanceModsList(pack);
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось переключить мод сборки:', err);
        toggleBtn.disabled = false;
      }
    });

    const deleteBtn = card.querySelector('.installed-mod-btn.is-delete');
    deleteBtn.addEventListener('click', async () => {
      if (typeof window.deleteModFile !== 'function') return;
      deleteBtn.disabled = true;
      try {
        const raw = await window.deleteModFile({ dir, filename });
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
        // Ключ хранения статуса модпака идёт по имени сборки (см.
        // installedModsStorageKey), поэтому loader/version здесь не важны.
        if (slug) unmarkModInstalled('fabric', pack.mcVersion, slug, pack.name);
        loadInstanceModsList(pack);
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось удалить мод сборки:', err);
        deleteBtn.disabled = false;
      }
    });

    instanceModsListEl.appendChild(card);
  });
}

instanceModsAddBtn?.addEventListener('click', () => {
  if (!currentInstanceModsPack) return;
  const pack = currentInstanceModsPack;
  closeInstanceModsModal();

  railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === 'mods'));
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === 'mods'));
  currentActiveView = 'mods';
VERSIONS[0]
  modsActiveCategory = 'mod';
  modsTargetLoader = 'modpacks';
  modsTargetInstanceName = pack.name;

  renderModsCategoryTabs();
  applyModsCategoryVisibility();
  updateModsInstallTargetLabel();
  updateModsMyTabLabel();
  renderModsTargetLoaderTabs();
  renderModsTargetScopeTabs();
  renderModsTargetVersionList('');
  syncModsTargetVersionLabel();
  saveModsViewState();

  modsSubtabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.subtab === 'browse'));
  modsSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.subview === 'browse'));

  runModSearch(1);
  restoreViewScroll('mods');
});

// ============================================
// Вкладки "Мои сборки" / "Каталог" внутри раздела "Сборки".
// ============================================
const instancesSubtabs = document.querySelectorAll('.mods-subtab[data-instances-subtab]');
const instancesSubviews = document.querySelectorAll('.mods-subview[data-instances-subview]');

instancesSubtabs.forEach(tab => {
  tab.addEventListener('click', () => {
    instancesSubtabs.forEach(tb => tb.classList.toggle('is-active', tb === tab));
    const target = tab.dataset.instancesSubtab;
    instancesSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.instancesSubview === target));
    if (target === 'catalog') runInstancesCatalogSearch(1);
  });
});
// ============================================
// Главная: переключатель "Обзор" / "Обновления"
// ============================================
const homeSubtabs = document.querySelectorAll('.mods-subtab[data-home-subtab]');
const homeSubviews = document.querySelectorAll('.mods-subview[data-home-subview]');

homeSubtabs.forEach(tab => {
  tab.addEventListener('click', () => {
    homeSubtabs.forEach(tb => tb.classList.toggle('is-active', tb === tab));
    const target = tab.dataset.homeSubtab;
    homeSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.homeSubview === target));
    currentHomeSubtab = target;
    updateGameFolderBtnVisibility();
  });
});

// ============================================
// Каталог готовых сборок — реальный поиск модпаков на Modrinth
// (project_type=modpack) или CurseForge (classId=4471), с установкой через
// installModpackFromCatalog (см. launcher_core.cpp — полноценно распаковывает
// .mrpack/CurseForge-манифест, докачивает все моды и копирует overrides).
// ============================================
const INSTANCES_CATALOG_CLASS_ID = 4471;
let instancesCatalogSource = localStorage.getItem('magma_instances_catalog_source') || 'modrinth';
if (instancesCatalogSource !== 'modrinth' && instancesCatalogSource !== 'curseforge') instancesCatalogSource = 'modrinth';
const INSTANCES_CATALOG_VERSION_KEY = 'magma_instances_catalog_version';
let instancesCatalogVersion = localStorage.getItem(INSTANCES_CATALOG_VERSION_KEY) ?? '';
let instancesCatalogSortBy = 'relevance';
let instancesCatalogPage = 1;
let instancesCatalogRequestId = 0;
const INSTANCES_CATALOG_PAGE_SIZE = 20;

const instancesCatalogSearchEl = document.getElementById('instancesCatalogSearch');
const instancesCatalogListEl = document.getElementById('instancesCatalogList');
const instancesCatalogPaginationEl = document.getElementById('instancesCatalogPagination');
const instancesCatalogFilterBtn = document.getElementById('instancesCatalogFilterBtn');
const instancesCatalogFilterDropdown = document.getElementById('instancesCatalogFilterDropdown');
const instancesCatalogSortListEl = document.getElementById('instancesCatalogSortList');
const instancesCatalogSourceModrinth = document.getElementById('instancesCatalogSourceModrinth');
const instancesCatalogSourceCurseForge = document.getElementById('instancesCatalogSourceCurseForge');
const instancesCatalogModrinthLogo = document.getElementById('instancesCatalogModrinthLogo');
const instancesCatalogCurseForgeLogo = document.getElementById('instancesCatalogCurseForgeLogo');
const MODRINTH_LOGO = '<img class="source-logo" src="../assets/modrinth.jpg" alt="Modrinth">';
const CURSEFORGE_LOGO = '<img class="source-logo" src="../assets/curseforge.png" alt="CurseForge">';
const instancesCatalogVersionBtn = document.getElementById('instancesCatalogVersionBtn');
const instancesCatalogVersionLabel = document.getElementById('instancesCatalogVersionLabel');
const instancesCatalogVersionDropdown = document.getElementById('instancesCatalogVersionDropdown');
const instancesCatalogVersionSearch = document.getElementById('instancesCatalogVersionSearch');
const instancesCatalogVersionList = document.getElementById('instancesCatalogVersionList');


if (instancesCatalogModrinthLogo) instancesCatalogModrinthLogo.innerHTML = MODRINTH_LOGO;
if (instancesCatalogCurseForgeLogo) instancesCatalogCurseForgeLogo.innerHTML = CURSEFORGE_LOGO;
if (instancesCatalogSourceModrinth) instancesCatalogSourceModrinth.checked = instancesCatalogSource === 'modrinth';
if (instancesCatalogSourceCurseForge) instancesCatalogSourceCurseForge.checked = instancesCatalogSource === 'curseforge';
if (instancesCatalogVersionLabel) instancesCatalogVersionLabel.textContent = instancesCatalogVersion || t('instances.allVersions');

instancesCatalogFilterBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  instancesCatalogFilterDropdown.classList.toggle('is-open');
});
instancesCatalogFilterDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => instancesCatalogFilterDropdown?.classList.remove('is-open'));

instancesCatalogSourceModrinth?.addEventListener('change', () => {
  if (!instancesCatalogSourceModrinth.checked) return;
  instancesCatalogSource = 'modrinth';
  localStorage.setItem('magma_instances_catalog_source', instancesCatalogSource);
  runInstancesCatalogSearch(1);
});
instancesCatalogSourceCurseForge?.addEventListener('change', () => {
  if (!instancesCatalogSourceCurseForge.checked) return;
  instancesCatalogSource = 'curseforge';
  localStorage.setItem('magma_instances_catalog_source', instancesCatalogSource);
  runInstancesCatalogSearch(1);
});

function renderInstancesCatalogVersionList(filter) {
  if (!instancesCatalogVersionList) return;
  const query = (filter || '').trim().toLowerCase();
  const filtered = VERSIONS.filter(v => !query || v.toLowerCase().includes(query));
  instancesCatalogVersionList.innerHTML = '';

  const allItem = document.createElement('button');
  allItem.className = 'version-item' + (instancesCatalogVersion === '' ? ' is-selected' : '');
  allItem.textContent = t('instances.allVersions');
    allItem.addEventListener('click', () => {
    instancesCatalogVersion = '';
    localStorage.setItem(INSTANCES_CATALOG_VERSION_KEY, instancesCatalogVersion);
    instancesCatalogVersionLabel.textContent = t('instances.allVersions');
    instancesCatalogVersionDropdown.classList.remove('is-open');
    runInstancesCatalogSearch(1);
  });
  instancesCatalogVersionList.appendChild(allItem);

  filtered.forEach(v => {
    const item = document.createElement('button');
    item.className = 'version-item' + (v === instancesCatalogVersion ? ' is-selected' : '');
    item.textContent = v;
    item.addEventListener('click', () => {
      instancesCatalogVersion = v;
      localStorage.setItem(INSTANCES_CATALOG_VERSION_KEY, instancesCatalogVersion);
      instancesCatalogVersionLabel.textContent = v;
      instancesCatalogVersionDropdown.classList.remove('is-open');
      runInstancesCatalogSearch(1);
    });
    instancesCatalogVersionList.appendChild(item);
  });
}

instancesCatalogVersionBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !instancesCatalogVersionDropdown.classList.contains('is-open');
  instancesCatalogVersionDropdown.classList.toggle('is-open', willOpen);
  if (willOpen) { renderInstancesCatalogVersionList(''); positionDropdownNear(instancesCatalogVersionBtn, instancesCatalogVersionDropdown); }
});
instancesCatalogVersionSearch?.addEventListener('input', () => renderInstancesCatalogVersionList(instancesCatalogVersionSearch.value));
instancesCatalogVersionDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => instancesCatalogVersionDropdown?.classList.remove('is-open'));

const debouncedInstancesCatalogSearch = debounce(() => runInstancesCatalogSearch(1), 400);
instancesCatalogSearchEl?.addEventListener('input', debouncedInstancesCatalogSearch);

function renderInstancesCatalogSortList() {
  if (!instancesCatalogSortListEl) return;
  instancesCatalogSortListEl.innerHTML = '';
  MOD_SORT_OPTIONS.forEach(opt => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mod-filter-sort-item' + (opt === instancesCatalogSortBy ? ' is-selected' : '');
    item.textContent = t(MOD_SORT_I18N_KEY[opt]);
    item.addEventListener('click', () => {
      instancesCatalogSortBy = opt;
      renderInstancesCatalogSortList();
      runInstancesCatalogSearch(1);
    });
    instancesCatalogSortListEl.appendChild(item);
  });
}

function uniqueInstanceName(baseName) {
  const existing = new Set(getModpacks().map(p => p.name));
  let candidate = baseName || 'Modpack';
  let i = 2;
  while (existing.has(candidate)) {
    candidate = `${baseName} (${i})`;
    i++;
  }
  return candidate;
}

const activeCatalogInstalls = new Map();

window.__catalogModpackDone = function (data) {
  const entry = activeCatalogInstalls.get(data.instanceName);
  activeCatalogInstalls.delete(data.instanceName);
  const importStatusEl = document.getElementById('importInstanceStatus');

  if (data.success) {
    saveModpack({
      name: data.instanceName,
      mcVersion: data.mcVersion || instancesCatalogVersion,
      loader: data.loader || 'vanilla',
      mods: [],
      icon_url: (entry && entry.iconUrl) || '',
    });
    renderInstances();
    if (entry && entry.btn) {
      entry.btn.textContent = t('mods.added');
      entry.btn.classList.remove('is-loading');
      entry.btn.classList.add('is-installed');
    }
    if (importStatusEl) importStatusEl.textContent = '';
  } else if (entry && entry.btn) {
    const btn = entry.btn;
    btn.classList.remove('is-loading');
    const original = t('mods.install');
    const shortError = (translateBackendError(data.error) || t('auth.magma.genericError')).slice(0, 60);
    btn.textContent = shortError;
    console.error('[MagmaLauncher] Ошибка установки сборки из каталога:', data.error);
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 4000);
  } else if (importStatusEl) {
    importStatusEl.textContent = translateBackendError(data.error) || t('auth.magma.genericError');
  }
};

function reportCatalogInstallProgress(data) {
  activeCatalogInstalls.forEach(entry => {
    if (entry.btn && !entry.btn.classList.contains('is-installed')) {
      entry.btn.textContent = Math.round((data.progress || 0) * 100) + '%';
    }
  });
}

async function installCatalogModpack(hit, btn) {
  if (typeof window.installModpackFromCatalog !== 'function') {
    btn.textContent = t('mods.devOnlyExe');
    return;
  }

  const id = instancesCatalogSource === 'curseforge' ? String(hit.curseforgeId) : hit.modrinthSlug;
  if (!id) return;

  const instanceName = uniqueInstanceName(hit.title || 'Modpack');
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.textContent = t('mods.installing');
  activeCatalogInstalls.set(instanceName, { btn, iconUrl: hit.icon_url || '' });

  try {
    const raw = await window.installModpackFromCatalog({
      source: instancesCatalogSource,
      id,
      version: instancesCatalogVersion,
      instanceName,
      gameDir: getGameDir(),
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.started) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка установки сборки из каталога:', err);
    activeCatalogInstalls.delete(instanceName);
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.textContent = t('mods.install');
  }
}

async function runInstancesCatalogSearch(page) {
  if (!instancesCatalogListEl) return;
  instancesCatalogPage = page;
  const myRequestId = ++instancesCatalogRequestId;
  const query = instancesCatalogSearchEl ? instancesCatalogSearchEl.value.trim() : '';
  const offset = (page - 1) * INSTANCES_CATALOG_PAGE_SIZE;

  instancesCatalogListEl.innerHTML = `<div class="mod-list-hint">${instancesSearchingLabel()}</div>`;

  let result;
  if (instancesCatalogSource === 'curseforge') {
    if (typeof window.searchContentCurseForge !== 'function') {
      instancesCatalogListEl.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
      return;
    }
    try {
      const raw = await window.searchContentCurseForge({ query, version: instancesCatalogVersion, classId: INSTANCES_CATALOG_CLASS_ID, offset });
      result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      result = { success: false, error: String(err.message || err) };
    }
  } else {
    if (typeof window.searchContent !== 'function') {
      instancesCatalogListEl.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
      return;
    }
    try {
      const raw = await window.searchContent({ query, version: instancesCatalogVersion, projectType: 'modpack', offset });
      result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      result = { success: false, error: String(err.message || err) };
    }
  }

  if (myRequestId !== instancesCatalogRequestId) return;

  if (!result || !result.success) {
    instancesCatalogListEl.innerHTML = `<div class="mod-list-hint">${translateBackendError(result && result.error) || t('auth.magma.genericError')}</div>`;
    instancesCatalogPaginationEl.innerHTML = '';
    return;
  }

  const mergedUnsorted = instancesCatalogSource === 'curseforge'
    ? buildUnifiedHits([], result.hits || [])
    : buildUnifiedHits(result.hits || [], []);
  const merged = sortUnifiedHits(mergedUnsorted, instancesCatalogSortBy);

  const installedNames = new Set(getModpacks().map(p => p.name));

  renderModCardsInto(instancesCatalogListEl, merged, {
    installedUids: new Set(),
    uidToFilename: new Map(),
    onInstall: installCatalogModpack,
    onUninstall: null,
  });

  merged.forEach((hit, idx) => {
    if (installedNames.has(hit.title)) {
      const card = instancesCatalogListEl.children[idx];
      const btn = card && card.querySelector('.mod-install-btn');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('is-installed');
        btn.textContent = t('mods.added');
      }
    }
  });

  const total = result.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / INSTANCES_CATALOG_PAGE_SIZE));
  instancesCatalogPage = Math.min(Math.max(1, page), totalPages);

  instancesCatalogPaginationEl.innerHTML = '';
  if (totalPages > 1) {
    const mkBtn = (label, p, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mod-page-btn' + (opts.active ? ' is-active' : '');
      b.textContent = label;
      b.disabled = !!opts.disabled;
      if (!opts.disabled && !opts.active) b.addEventListener('click', () => runInstancesCatalogSearch(p));
      return b;
    };
    instancesCatalogPaginationEl.appendChild(mkBtn('‹', Math.max(1, instancesCatalogPage - 1), { disabled: instancesCatalogPage === 1 }));
    const start = Math.max(1, instancesCatalogPage - 2);
    const end = Math.min(totalPages, start + 4);
    for (let p = start; p <= end; p++) {
      instancesCatalogPaginationEl.appendChild(mkBtn(String(p), p, { active: p === instancesCatalogPage }));
    }
    instancesCatalogPaginationEl.appendChild(mkBtn('›', Math.min(totalPages, instancesCatalogPage + 1), { disabled: instancesCatalogPage === totalPages }));
  }
}

// Запуск модпака: подставляем его данные как текущий выбор и дёргаем обычную
// кнопку "Играть" — переиспользуем весь существующий прогресс-бар/логику паузы/отмены.
function launchModpack(pack) {
  selectedVersion = pack.mcVersion;
  currentSelectedLoader = pack.loader;
  selectedInstanceName = pack.name;
  versionBtnLabel.textContent = `${pack.name} (${pack.mcVersion})`;
  saveLastSelection();

  railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === 'home'));
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === 'home'));

  playBtn.click();
}

// ============================================
// Моды — поиск на Modrinth и установка либо "просто в mods/", либо в состав
// модпака (внутри модалки создания модпака, см. ниже).
// ============================================
const modList = document.getElementById('modList');
const modSearch = document.getElementById('modSearch');

// Настоящие логотипы Modrinth/CurseForge — файлы лежат в frontend/assets/
// (кладутся рядом с index.html, путь относительный, как и у CSS/JS).
// Настоящие логотипы Modrinth/CurseForge. ВАЖНО: папка assets/ лежит РЯДОМ
// с frontend/ (сестринская папка в корне проекта), а не внутри неё — значит
// из index.html (который лежит в frontend/index.html) путь должен идти на
// уровень выше: "../assets/...", а не "assets/...". Если позже перенесёшь
// assets/ внутрь frontend/, поменяй путь обратно на "assets/...".


// Источники модов теперь ВЗАИМОИСКЛЮЧАЮЩИЕ: либо только Modrinth, либо
// только CurseForge, никогда оба одновременно. Раньше оба были включены по
// умолчанию и результаты сливались в один список с дедупликацией по
// названию — из-за этого часть модов, которые технически были только на
// CurseForge, "терялись" внутри слияния, а общее число страниц считалось по
// смеси двух разных totalCount, из-за чего пагинация не отражала реальное
// количество модов ни одного из источников. Теперь список строится 1:1 из
// API выбранного источника — что видно, то и есть на самом деле.
// ============================================
// Категория контента внутри раздела "Моды": Моды / Ресурс-паки / Шейдеры /
// Карты. Модпаки ("сборки") сюда не входят — они в отдельном разделе
// "Сборки" в левом рейле.
//
// curseforgeClassId — числовой classId CurseForge для этого типа контента
// (6 = моды, 12 = ресурс-паки, 17 = карты/миры); null — для этого типа
// CurseForge не поддержан на их стороне (шейдеры у CurseForge не выделены
// в отдельную категорию), тогда переключатель источника скрывается и всегда
// используется Modrinth. modrinthSupported=false — обратный случай (у
// Modrinth в принципе нет типа "карта/мир" как отдельного project_type),
// тогда переключатель тоже скрывается и всегда используется CurseForge.
// ============================================
const MODS_CATEGORIES = [
  { id: 'mod',          i18nKey: 'mods.category.mods',          projectType: 'mod',          dirName: 'mods',          curseforgeClassId: 6,    modrinthSupported: true },
  { id: 'resourcepack', i18nKey: 'mods.category.resourcepacks', projectType: 'resourcepack', dirName: 'resourcepacks', curseforgeClassId: 12,   modrinthSupported: true },
  { id: 'shader',       i18nKey: 'mods.category.shaders',       projectType: 'shader',       dirName: 'shaderpacks',   curseforgeClassId: null, modrinthSupported: true },
  { id: 'map',          i18nKey: 'mods.category.maps',          projectType: null,           dirName: 'maps',         curseforgeClassId: 17,   modrinthSupported: false },
];

const MODS_ACTIVE_CATEGORY_KEY = 'magma_mods_active_category';
let modsActiveCategory = 'mod';

function currentCategoryDef() {
  return MODS_CATEGORIES.find(c => c.id === modsActiveCategory) || MODS_CATEGORIES[0];
}

const MODS_INSTALL_TARGET_PARTS = {
  ru: { prefix: 'Ставим ', suffix: ' под:' },
  en: { prefix: 'Installing ', suffix: ' for:' },
};

function modsInstallTargetLabel() {
  const parts = MODS_INSTALL_TARGET_PARTS[currentLang];
  if (!parts) return t('mods.installTarget');
  return parts.prefix + t(currentCategoryDef().i18nKey).toLowerCase() + parts.suffix;
}

function updateModsInstallTargetLabel() {
  const el = document.getElementById('modsInstallTargetLabel');
  if (el) el.textContent = modsInstallTargetLabel();
}

const MODS_SEARCHING_PARTS = {
  ru: { prefix: 'Ищем ', suffix: '...' },
  en: { prefix: 'Searching ', suffix: '...' },
};

function modsSearchingLabel() {
  const parts = MODS_SEARCHING_PARTS[currentLang];
  if (!parts) return t('mods.searching');
  return parts.prefix + t(currentCategoryDef().i18nKey).toLowerCase() + parts.suffix;
}

const INSTANCES_SEARCHING_TEXT = {
  ru: 'Ищем сборки...',
  en: 'Searching modpacks...',
};

function instancesSearchingLabel() {
  return INSTANCES_SEARCHING_TEXT[currentLang] || INSTANCES_SEARCHING_TEXT.en;
}

const MODS_MY_TAB_PREFIX = {
  ru: 'Мои ',
  en: 'My ',
};

function modsMyTabLabel() {
  const prefix = MODS_MY_TAB_PREFIX[currentLang];
  if (!prefix) return t('mods.tab.installed');
  const label = t(currentCategoryDef().i18nKey);
  return prefix + label.charAt(0).toLowerCase() + label.slice(1);
}

function updateModsMyTabLabel() {
  const el = document.getElementById('modsInstalledTabBtn');
  if (el) el.textContent = modsMyTabLabel();
}

const MODS_INSTALLED_EMPTY_SUFFIX = {
  ru: ' ещё не установлены',
  en: ' not installed yet',
};

function modsInstalledEmptyLabel() {
  const suffix = MODS_INSTALLED_EMPTY_SUFFIX[currentLang];
  if (!suffix) return t('mods.installed.empty');
  return t(currentCategoryDef().i18nKey) + suffix;
}

const MODS_ACTIVE_SOURCE_KEY = 'magma_mods_active_source';
const MODS_SORT_KEY = 'magma_mods_sort';

let modsActiveSource = 'modrinth';
let modsSortBy = 'relevance';

function saveModsFilterPrefs() { saveModsViewState(); }

function modsSourcesKey() {
  return modsActiveSource;
}

function canonicalUid(slug) {
  return slug.includes(':') ? slug : ('mr:' + slug);
}

function normalizeTitleKey(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildUnifiedHits(modrinthHits, curseforgeHits) {
  const byKey = new Map();
  const order = [];

  (modrinthHits || []).forEach(h => {
    const key = normalizeTitleKey(h.title);
    const entry = {
      uid: 'mr:' + h.slug,
      title: h.title,
      description: h.description || '',
      icon_url: h.icon_url || '',
      downloads: h.downloads || 0,
      followers: h.follows || 0,
      dateCreated: h.date_created || '',
      dateModified: h.date_modified || '',
      sources: ['modrinth'],
      modrinthSlug: h.slug,
      curseforgeId: null,
    };
    byKey.set(key, entry);
    order.push(key);
  });

  (curseforgeHits || []).forEach(h => {
    const key = normalizeTitleKey(h.title);
    if (byKey.has(key)) {
      const entry = byKey.get(key);
      entry.downloads += (h.downloads || 0);
      entry.sources.push('curseforge');
      entry.curseforgeId = h.curseforge_id;
      if (!entry.description) entry.description = h.description || '';
      if (!entry.icon_url) entry.icon_url = h.icon_url || '';
    } else {
      const key2 = key + '\u0001' + h.curseforge_id;
      byKey.set(key2, {
        uid: 'cf:' + h.curseforge_id,
        title: h.title,
        description: h.description || '',
        icon_url: h.icon_url || '',
        downloads: h.downloads || 0,
        followers: 0,
        dateCreated: '',
        dateModified: '',
        sources: ['curseforge'],
        modrinthSlug: null,
        curseforgeId: h.curseforge_id,
      });
      order.push(key2);
    }
  });

  return order.map(k => byKey.get(k));
}

function sortUnifiedHits(hits, sortBy) {
  const arr = hits.slice();
  if (sortBy === 'downloads') arr.sort((a, b) => b.downloads - a.downloads);
  else if (sortBy === 'followers') arr.sort((a, b) => b.followers - a.followers);
  else if (sortBy === 'date_published') arr.sort((a, b) => (b.dateCreated || '').localeCompare(a.dateCreated || ''));
  else if (sortBy === 'date_updated') arr.sort((a, b) => (b.dateModified || '').localeCompare(a.dateModified || ''));
  return arr;
}

// Независимый от героя выбор "под какую версию/загрузчик ставим моды" —
// у обычной установки модов (не через модпак) он свой.
let modsTargetLoader = 'fabric';
let modsTargetVersion = VERSIONS[0];
// Непусто, если во вкладке "Моды" выбран не голый загрузчик/версия, а
// конкретный модпак — тогда моды ставятся в instances/<name>/mods, а не в
// общий gameDir/mods, и "Мои моды" показывает содержимое именно этой папки.
let modsTargetInstanceName = '';
// Для категорий без загрузчика (ресурс-паки/шейдеры/карты) не рисуются
// полноценные "лоадер-табы" — вместо этого простой переключатель "Обычная
// игра" / "Модпак" ниже, использующий тот же modsTargetInstanceName.
let modsTargetNonModScope = 'vanilla'; // 'vanilla' | 'modpack'

function isModpackScopeActive() {
  return modsActiveCategory === 'mod' ? modsTargetLoader === 'modpacks' : modsTargetNonModScope === 'modpack';
}

function hasSelectedModpackTarget() {
  return isModpackScopeActive() && !!modsTargetInstanceName;
}

// Загрузчик/версия, которые реально нужно слать в Modrinth API и на диск —
// если выбран модпак, берём его loader/mcVersion, иначе то, что выбрано в
// табах напрямую.
function effectiveModsTargetLoader() {
  // Вне категории "Моды" понятия загрузчика не существует — используем саму
  // категорию как ключ хранения статуса "установлено" (см. комментарий у
  // MODS_CATEGORIES выше), она так же однозначно разделяет записи между
  // ресурс-паками/дата-паками/шейдерами.
  if (modsActiveCategory !== 'mod') return modsActiveCategory;
  if (isModpackScopeActive() && modsTargetInstanceName) {
    const pack = getModpacks().find(p => p.name === modsTargetInstanceName);
    if (pack) return pack.loader;
  }
  return modsTargetLoader;
}
function effectiveModsTargetVersion() {
  if (isModpackScopeActive() && modsTargetInstanceName) {
    const pack = getModpacks().find(p => p.name === modsTargetInstanceName);
    if (pack) return pack.mcVersion;
  }
  return modsTargetVersion;
}

// ============================================
// Память выбора во вкладке "Моды" — какой загрузчик/версия/модпак и какая
// страница результатов были выбраны. Сохраняется в localStorage, поэтому
// переживает и простое переключение вкладок, и полный перезапуск лаунчера
// (restoreModsViewState() вызывается один раз при старте, см. конец файла).
// ============================================
const MODS_VIEW_STATE_KEY = 'magma_mods_view_state';

function saveModsViewState() {
  try {
    localStorage.setItem(MODS_VIEW_STATE_KEY, JSON.stringify({
      loader: modsTargetLoader,
      version: modsTargetVersion,
      instanceName: modsTargetInstanceName,
      nonModScope: modsTargetNonModScope,
      source: modsActiveSource,
      sort: modsSortBy,
    }));
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось сохранить состояние вкладки Моды:', err);
  }
}

function restoreModsViewState() {
  try {
    const raw = localStorage.getItem(MODS_VIEW_STATE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
       if (s) {
        if (s.loader === 'fabric' || s.loader === 'forge' || s.loader === 'neoforge' || s.loader === 'quilt' || s.loader === 'modpacks') modsTargetLoader = s.loader;
       
        if (s.version && VERSIONS.includes(s.version)) modsTargetVersion = s.version;
        if (s.nonModScope === 'vanilla' || s.nonModScope === 'modpack') modsTargetNonModScope = s.nonModScope;
        if (s.instanceName && getModpacks().some(p => p.name === s.instanceName)) modsTargetInstanceName = s.instanceName;
        if (s.source === 'modrinth' || s.source === 'curseforge') modsActiveSource = s.source;
        if (s.sort) modsSortBy = s.sort;
      }
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось восстановить состояние вкладки Моды:', err);
  }
 
  // ВАЖНО: modFilterSourceModrinth/CurseForge при своём объявлении ниже по файлу
  // ставят чекбокс по умолчанию ("Modrinth") ДО того, как эта функция реально
  // восстановит modsActiveSource из localStorage — без этой синхронизации список
  // модов после перезапуска лаунчера грузился из восстановленного источника,
  // а сам переключатель в фильтре продолжал показывать невосстановленное значение.
  if (modFilterSourceModrinth) modFilterSourceModrinth.checked = modsActiveSource === 'modrinth';
  if (modFilterSourceCurseForge) modFilterSourceCurseForge.checked = modsActiveSource === 'curseforge';
}

const modsTargetLoaderTabsEl = document.getElementById('modsTargetLoaderTabs');
const modsTargetScopeTabsEl = document.getElementById('modsTargetScopeTabs');
const modsTargetVersionBtn = document.getElementById('modsTargetVersionBtn');
const modsTargetVersionLabel = document.getElementById('modsTargetVersionLabel');
const modsTargetVersionDropdown = document.getElementById('modsTargetVersionDropdown');
const modsTargetVersionSearch = document.getElementById('modsTargetVersionSearch');
const modsTargetVersionList = document.getElementById('modsTargetVersionList');

function syncModsTargetVersionLabel() {
  if (!modsTargetVersionLabel) return;
  if (isModpackScopeActive() && !modsTargetInstanceName) {
    modsTargetVersionLabel.textContent = t('modpacks.none');
    return;
  }
  modsTargetVersionLabel.textContent = (isModpackScopeActive() && modsTargetInstanceName)
    ? modsTargetInstanceName
    : modsTargetVersion;
}

// ============================================
// Переключатель категорий раздела "Моды" (Моды / Ресурс-паки / Шейдеры /
// Карты) — управляет тем, какие элементы шапки видны: у ресурс-паков/
// шейдеров/карт нет понятия "загрузчик", а источник (Modrinth/CurseForge)
// доступен только там, где его реально поддерживает бэкенд (см.
// MODS_CATEGORIES выше).
// ============================================
const modsCategoryTabsEl = document.getElementById('modsCategoryTabs');
const modsBrowseSubviewEl = document.querySelector('.mods-subview[data-subview="browse"]');
const modsSubtabsEl = document.querySelector('.mods-subtabs');

function renderModsCategoryTabs() {
  if (!modsCategoryTabsEl) return;
  modsCategoryTabsEl.innerHTML = '';
  MODS_CATEGORIES.forEach(cat => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mods-category-tab' + (!mergedInstancesOpen && cat.id === modsActiveCategory ? ' is-active' : '');
    tab.textContent = t(cat.i18nKey);
    tab.addEventListener('click', () => switchModsCategory(cat.id));
    modsCategoryTabsEl.appendChild(tab);
  });

  if (getMergeModsInstancesPref()) {
    const instancesTab = document.createElement('button');
    instancesTab.type = 'button';
    instancesTab.className = 'mods-category-tab' + (mergedInstancesOpen ? ' is-active' : '');
    instancesTab.textContent = t('instances.title');
    instancesTab.addEventListener('click', openMergedInstancesView);
    modsCategoryTabsEl.appendChild(instancesTab);
  }
}

const NEWS_FEED_URL = 'https://raw.githubusercontent.com/Erz05506/Magma-News/main/news.json';
let newsFeedCache = null;

function renderNewsFeed() {
  const container = document.getElementById('newsContainer');
  if (!container || !newsFeedCache) return;
  const headHtml = `<div class="news-head"><h2>${t('news.title')}</h2></div>`;
  const cardsHtml = newsFeedCache.slice(0, 6).map(item => {
    const pick = (obj) => (obj && (obj[currentLang] || obj.en || obj.ru)) || '';
    return `<article class="news-card">
      <span class="news-tag">${pick(item.tag)}</span>
      <h3>${pick(item.title)}</h3>
      <p>${pick(item.desc)}</p>
    </article>`;
  }).join('');
  container.innerHTML = headHtml + cardsHtml;
}

async function loadNewsFeed() {
  try {
    const resp = await fetch(NEWS_FEED_URL, { cache: 'no-store' });
    if (!resp.ok) return;
    const items = await resp.json();
    if (Array.isArray(items) && items.length) {
      newsFeedCache = items;
      renderNewsFeed();
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось загрузить новости:', err);
  }
}

function resetInstancesViewHeaderTitle() {
  const h2 = document.querySelector('.view[data-view="instances"] .view-header h2');
  if (h2) h2.textContent = t('instances.title');
}

const LAUNCHER_UPDATE_MANIFEST_URL_STABLE = 'https://raw.githubusercontent.com/Erz05506/Magma-News/main/update.json';
const LAUNCHER_UPDATE_MANIFEST_URL_BETA = 'https://raw.githubusercontent.com/Erz05506/Magma-News/main/update-beta.json';
const UPDATE_CHANNEL_KEY = 'magma_update_channel';
const AUTO_INSTALL_UPDATES_KEY = 'magma_auto_install_updates';
const LAST_UPDATE_CHECK_KEY = 'magma_last_update_check';
const AUTO_CHECK_UPDATES_KEY = 'magma_auto_check_updates';
let pendingUpdateUrl = null;

function getUpdateChannel() { return localStorage.getItem(UPDATE_CHANNEL_KEY) || 'stable'; }
function currentUpdateManifestUrl() {
  return getUpdateChannel() === 'beta' ? LAUNCHER_UPDATE_MANIFEST_URL_BETA : LAUNCHER_UPDATE_MANIFEST_URL_STABLE;
}

const updateChannelSelectWrap = document.getElementById('updateChannelSelectWrap');
const updateChannelSelectBtn = document.getElementById('updateChannelSelectBtn');
const updateChannelSelectLabel = document.getElementById('updateChannelSelectLabel');
const updateChannelSelectList = document.getElementById('updateChannelSelectList');

function syncUpdateChannelLabel() {
  if (!updateChannelSelectLabel) return;
  const ch = getUpdateChannel();
  updateChannelSelectLabel.textContent = t(ch === 'beta' ? 'settings.updates.channel.beta' : 'settings.updates.channel.stable');
  updateChannelSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
    item.classList.toggle('is-selected', item.dataset.value === ch);
  });
}

updateChannelSelectBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  updateChannelSelectWrap?.classList.toggle('is-open');
});
updateChannelSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
  item.addEventListener('click', () => {
    localStorage.setItem(UPDATE_CHANNEL_KEY, item.dataset.value);
    syncUpdateChannelLabel();
    updateChannelSelectWrap?.classList.remove('is-open');
    checkForLauncherUpdate(false);
  });
});
document.addEventListener('click', () => updateChannelSelectWrap?.classList.remove('is-open'));
syncUpdateChannelLabel();

document.getElementById('autoInstallUpdatesToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(AUTO_INSTALL_UPDATES_KEY, e.target.checked ? '1' : '0');
});
if (document.getElementById('autoInstallUpdatesToggle')) {
  document.getElementById('autoInstallUpdatesToggle').checked = localStorage.getItem(AUTO_INSTALL_UPDATES_KEY) !== '0';
}

function renderLastUpdateCheckText() {
  const el = document.getElementById('lastUpdateCheckText');
  if (!el) return;
  const raw = localStorage.getItem(LAST_UPDATE_CHECK_KEY);
  if (!raw) { el.textContent = '—'; return; }
  const d = new Date(Number(raw));
  el.textContent = isNaN(d.getTime()) ? '—' : d.toLocaleString(currentLang === 'ru' ? 'ru-RU' : 'en-US');
}
renderLastUpdateCheckText();

document.getElementById('autoCheckUpdatesToggle')?.addEventListener('change', (e) => {
  localStorage.setItem(AUTO_CHECK_UPDATES_KEY, e.target.checked ? '1' : '0');
});

async function checkForLauncherUpdate(manual) {
  const statusEl = document.getElementById('updateStatusMsg');
  const installBtn = document.getElementById('installUpdateBtn');
  const notesEl = document.getElementById('updateNotesBlock');
  if (notesEl) notesEl.textContent = '';
  if (typeof window.checkLauncherUpdate !== 'function') {
    if (manual && statusEl) statusEl.textContent = t('mods.devModeHint');
    return;
  }
  if (statusEl) statusEl.innerHTML = `<span class="update-check-spinner"></span>${t('settings.updates.checking')}`;
  try {
    const raw = await window.checkLauncherUpdate({ manifestUrl: currentUpdateManifestUrl() });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

    localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(Date.now()));
    renderLastUpdateCheckText();

    if (!result.success) { if (statusEl) statusEl.textContent = translateBackendError(result.error); return; }
    if (result.available) {
      pendingUpdateUrl = result.url;
      if (statusEl) statusEl.textContent = `${t('settings.updates.newVersion')} ${result.version}`;
      if (notesEl && result.notes) notesEl.textContent = result.notes;
      if (installBtn) installBtn.style.display = 'block';
      if (localStorage.getItem(AUTO_INSTALL_UPDATES_KEY) !== '0') installBtn?.click();
    } else if (statusEl) {
      statusEl.textContent = t('settings.updates.upToDate');
    }
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка проверки обновлений:', err);
    if (statusEl) statusEl.textContent = t('auth.magma.genericError');
  }
}

document.getElementById('checkUpdateBtn')?.addEventListener('click', () => checkForLauncherUpdate(true));

document.getElementById('installUpdateBtn')?.addEventListener('click', async (e) => {
  if (!pendingUpdateUrl || typeof window.installLauncherUpdate !== 'function') return;
  const btn = e.currentTarget;
  const track = document.getElementById('updateProgressTrack');
  const fill = document.getElementById('updateProgressFillBar');
  btn.disabled = true;
  btn.textContent = '0%';
  if (track) track.style.display = 'block';
  if (fill) fill.style.width = '0%';
  try {
    const raw = await window.installLauncherUpdate({ url: pendingUpdateUrl });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.started) throw new Error(translateBackendError(result.error));
  } catch (err) {
    btn.disabled = false;
    console.error('[MagmaLauncher] Ошибка установки обновления:', err);
  }
});

async function autoUpdateOnBoot() {
  if (typeof window.checkLauncherUpdate !== 'function' || typeof window.installLauncherUpdate !== 'function') return false;
  try {
    const raw = await window.checkLauncherUpdate({ manifestUrl: currentUpdateManifestUrl() });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    localStorage.setItem(LAST_UPDATE_CHECK_KEY, String(Date.now()));
    if (!result.success || !result.available) return false;

    const bootTitleEl = document.querySelector('.boot-title');
    if (bootTitleEl) bootTitleEl.innerHTML = 'Загрузка обновления<span class="boot-title-accent">...</span>';
    setBootProgress(0);

    window.__updateProgress = (data) => setBootProgress(data.progress || 0);

    const installRaw = await window.installLauncherUpdate({ url: result.url });
    const installResult = typeof installRaw === 'string' ? JSON.parse(installRaw) : installRaw;
    if (!installResult.started) return false;

    // Приложение закроет само себя (CefQuitMessageLoop после успешной
    // установки) и перезапустится через .bat — просто держим сплеш открытым.
    await new Promise(() => {});
  } catch (err) {
    console.error('[MagmaLauncher] Автообновление при запуске не удалось:', err);
    return false;
  }
  return true;
}

window.__updateProgress = function (data) {
  const btn = document.getElementById('installUpdateBtn');
  const track = document.getElementById('updateProgressTrack');
  const fill = document.getElementById('updateProgressFillBar');
  const pct = Math.round((data.progress || 0) * 100);
  if (track) track.style.display = 'block';
  if (fill) fill.style.width = pct + '%';
  if (btn) btn.textContent = pct + '%';
};
window.__updateDone = function (data) {
  if (!data.success) {
    const btn = document.getElementById('installUpdateBtn');
    const track = document.getElementById('updateProgressTrack');
    if (btn) { btn.disabled = false; btn.textContent = t('settings.updates.installBtn'); }
    if (track) track.style.display = 'none';
  }
};

function openMergedInstancesView() {
  if (!getMergeModsInstancesPref()) return;

  mergedInstancesOpen = true;

  // ВАЖНО: сначала полностью собираем разметку "Сборок" (переносим панель
  // категорий, меняем заголовок, рендерим табы) и только ПОТОМ показываем
  // саму вкладку — раньше порядок был обратный, из-за чего один кадр
  // рисовался ещё без перенесённой панели, а следующий — уже с ней,
  // и это ощущалось как лёгкий скачок экрана.
  const instancesView = document.querySelector('.view[data-view="instances"]');
  const instancesHeader = instancesView ? instancesView.querySelector('.view-header') : null;
  if (modsCategoryTabsEl && instancesView && instancesHeader) {
    instancesView.insertBefore(modsCategoryTabsEl, instancesHeader.nextSibling);
  }
  const h2 = instancesHeader ? instancesHeader.querySelector('h2') : null;
  if (h2) h2.textContent = t('mods.title');
  renderModsCategoryTabs();

  railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === 'mods'));
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === 'instances'));
  currentActiveView = 'instances';
  updateGameFolderBtnVisibility();

  renderInstances();
  const activeTab = document.querySelector('.mods-subtab[data-instances-subtab].is-active');
  if (activeTab?.dataset.instancesSubtab === 'catalog') runInstancesCatalogSearch(1);
  restoreViewScroll('instances');
}

function switchModsCategory(categoryId) {
  if (categoryId === modsActiveCategory && !mergedInstancesOpen) return;
  mergedInstancesOpen = false;

  const modsView = document.querySelector('.view[data-view="mods"]');
  const modsViewHeader = modsView ? modsView.querySelector('.view-header') : null;
  if (modsCategoryTabsEl && modsView && modsViewHeader && modsCategoryTabsEl.parentElement !== modsView) {
    modsView.insertBefore(modsCategoryTabsEl, modsViewHeader.nextSibling);
  }
  resetInstancesViewHeaderTitle();

  if (currentActiveView !== 'mods') {
    railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === 'mods'));
    views.forEach(v => v.classList.toggle('is-active', v.dataset.view === 'mods'));
    currentActiveView = 'mods';
    updateGameFolderBtnVisibility();
  }
  modsActiveCategory = categoryId;
  renderModsCategoryTabs();

  // Раньше здесь безусловно сбрасывался modsTargetInstanceName при уходе из
  // категории "Моды" — из-за этого выбор модпака "слетал" даже при простом
  // переключении между ресурс-паками/шейдерами/картами. Теперь instanceName
  // используется только когда реально активен режим "Модпак" (см.
  // isModpackScopeActive), поэтому переключать категории можно без потери
  // выбранного модпака.

  const cat = currentCategoryDef();
  if (!cat.modrinthSupported) modsActiveSource = 'curseforge';
  else if (!cat.curseforgeClassId && modsActiveSource === 'curseforge') modsActiveSource = 'modrinth';
  saveModsFilterPrefs();
  if (modFilterSourceModrinth) modFilterSourceModrinth.checked = modsActiveSource === 'modrinth';
  if (modFilterSourceCurseForge) modFilterSourceCurseForge.checked = modsActiveSource === 'curseforge';

  applyModsCategoryVisibility();
  updateModsInstallTargetLabel();
  updateModsMyTabLabel();

  syncModsTargetVersionLabel();
  modSearchPage = 1;
  modSearchPage = 1;
  if (modList) modList.innerHTML = '';
  clearModsPagination();
  refreshModsTargetUI();
  if (document.querySelector('.mods-subtab[data-subtab="installed"]')?.classList.contains('is-active')) {
    loadInstalledMods();
  }
}

const MODS_SOURCE_UNSUPPORTED_TEXT = {
  ru: {
    modrinth: 'Modrinth не поддерживает карты — доступен только CurseForge.',
    curseforge: 'CurseForge не поддерживает шейдеры — доступен только Modrinth.',
  },
  en: {
    modrinth: "Modrinth doesn't support maps — only CurseForge is available.",
    curseforge: "CurseForge doesn't support shaders — only Modrinth is available.",
  },
};

function applyModsCategoryVisibility() {
  const isMod = modsActiveCategory === 'mod';
  const cat = currentCategoryDef();
  const modrinthOk = !!cat.modrinthSupported;
  const curseforgeOk = !!cat.curseforgeClassId;

  if (modsTargetLoaderTabsEl) modsTargetLoaderTabsEl.style.display = isMod ? '' : 'none';
  if (modsTargetScopeTabsEl) modsTargetScopeTabsEl.style.display = isMod ? 'none' : '';
  if (createModpackBtnEl) createModpackBtnEl.style.display = isMod ? '' : 'none';

  if (modFilterSourceModrinth && modFilterSourceCurseForge) {
    const sourceRowModrinth = modFilterSourceModrinth.closest('.mod-filter-source-row');
    const sourceRowCurseForge = modFilterSourceCurseForge.closest('.mod-filter-source-row');

    // Обе строки всегда видны — недоступный источник не прячется, а
    // становится серым и некликабельным, с пояснением почему.
    if (sourceRowModrinth) {
      sourceRowModrinth.style.display = '';
      sourceRowModrinth.classList.toggle('is-disabled', !modrinthOk);
    }
    if (sourceRowCurseForge) {
      sourceRowCurseForge.style.display = '';
      sourceRowCurseForge.classList.toggle('is-disabled', !curseforgeOk);
    }
    modFilterSourceModrinth.disabled = !modrinthOk;
    modFilterSourceCurseForge.disabled = !curseforgeOk;

    const noteEl = document.getElementById('modFilterSourceNote');
    if (noteEl) {
      const texts = MODS_SOURCE_UNSUPPORTED_TEXT[currentLang] || MODS_SOURCE_UNSUPPORTED_TEXT.en;
      let msg = '';
      if (!modrinthOk) msg = texts.modrinth;
      else if (!curseforgeOk) msg = texts.curseforge;
      noteEl.textContent = msg;
      noteEl.style.display = msg ? 'block' : 'none';
    }
  }
}

const createModpackBtnEl = document.getElementById('createModpackBtn');

const MOD_LOADERS_ONLY = LOADERS.filter(l => l.id === 'fabric' || l.id === 'forge' || l.id === 'neoforge' || l.id === 'quilt');
// Псевдо-таб "Modpacks" — те же данные, что и в hero-выборе версии, только
// переключает панель "Моды" на установку внутрь конкретного созданного
// модпака (instances/<name>/mods), а не в общую gameDir/mods.
const MODPACKS_TARGET_TAB = LOADERS.find(l => l.id === 'modpacks');

function renderModsTargetLoaderTabs() {
  if (!modsTargetLoaderTabsEl) return;
  modsTargetLoaderTabsEl.innerHTML = '';
  [...MOD_LOADERS_ONLY, MODPACKS_TARGET_TAB].forEach(loader => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'loader-tab' + (loader.id === modsTargetLoader ? ' is-active' : '');
    tab.textContent = loader.id === 'modpacks' ? t('loader.modpacks') : loader.label;
    tab.addEventListener('click', () => {
      modsTargetLoader = loader.id;
      if (loader.id !== 'modpacks') modsTargetInstanceName = '';
      if (loader.id === 'modpacks' && !modsTargetInstanceName) {
        const firstPack = getModpacks()[0];
        if (firstPack) modsTargetInstanceName = firstPack.name;
      }
      refreshModsTargetUI();
      renderModsTargetVersionList(modsTargetVersionSearch.value);
      syncModsTargetVersionLabel();
      if (loader.id !== 'modpacks') runModSearch(1);
      if (loader.id === 'modpacks' && modsTargetInstanceName) runModSearch(1);
      if (loader.id === 'modpacks' && !modsTargetInstanceName) {
        if (modList) modList.innerHTML = `<div class="mod-list-hint">${t('modpacks.none')}</div>`;
        clearModsPagination();
      }
      saveModsViewState();
    });
    modsTargetLoaderTabsEl.appendChild(tab);
  });
}

function renderModsTargetScopeTabs() {
  if (!modsTargetScopeTabsEl) return;
  modsTargetScopeTabsEl.innerHTML = '';
  const options = [
    { id: 'vanilla', label: t('mods.scope.vanilla') },
    { id: 'modpack', label: t('mods.scope.modpack') },
  ];
  options.forEach(opt => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'loader-tab' + (modsTargetNonModScope === opt.id ? ' is-active' : '');
    tab.textContent = opt.label;
    tab.addEventListener('click', () => {
      modsTargetNonModScope = opt.id;
      if (opt.id === 'vanilla') {
        modsTargetInstanceName = '';
      } else if (!modsTargetInstanceName) {
        const firstPack = getModpacks()[0];
        if (firstPack) modsTargetInstanceName = firstPack.name;
      }
      syncModsTargetVersionLabel();
      saveModsViewState();
      if (opt.id === 'modpack' && !modsTargetInstanceName) {
        if (modList) modList.innerHTML = `<div class="mod-list-hint">${t('modpacks.none')}</div>`;
        clearModsPagination();
      } else {
        refreshModsTargetUI();
      }
    });
    modsTargetScopeTabsEl.appendChild(tab);
  });
}

async function refreshModsTargetUI() {
  renderModsTargetLoaderTabs();
  renderModsTargetScopeTabs();
  renderModsTargetVersionList(modsTargetVersionSearch ? modsTargetVersionSearch.value : '');
  syncModsTargetVersionLabel();
  saveModsViewState();

  if (isModpackScopeActive() && !modsTargetInstanceName) {
    if (modList) modList.innerHTML = `<div class="mod-list-hint">${t('modpacks.none')}</div>`;
    clearModsPagination();
    if (document.querySelector('.mods-subtab[data-subtab="installed"]')?.classList.contains('is-active')) {
      loadInstalledMods();
    }
    return;
  }

  await runModSearch(1);
  if (document.querySelector('.mods-subtab[data-subtab="installed"]')?.classList.contains('is-active')) {
    loadInstalledMods();
  }
}

function renderModsTargetVersionList(filter) {
  if (!modsTargetVersionList) return;
  const query = (filter || '').trim().toLowerCase();

  if (isModpackScopeActive()) {
    const packs = getModpacks().filter(p => !query || p.name.toLowerCase().includes(query));
    modsTargetVersionList.innerHTML = '';

    if (packs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'v-empty';
      empty.textContent = t('modpacks.none');
      modsTargetVersionList.appendChild(empty);
      return;
    }

    packs.forEach(pack => {
      const item = document.createElement('button');
      item.className = 'version-item' + (modsTargetInstanceName === pack.name ? ' is-selected' : '');
      item.textContent = `${pack.name} (${pack.mcVersion})`;
      modsTargetInstanceName = pack.name;
      modsTargetVersionDropdown.classList.remove('is-open');
      refreshModsTargetUI
      modsTargetVersionList.appendChild(item);
    });
    return;
  }

  const loaderMin = (modsActiveCategory === 'mod' && MOD_LOADERS_ONLY.find(l => l.id === modsTargetLoader))
    ? MOD_LOADERS_ONLY.find(l => l.id === modsTargetLoader).min
    : '1.0';
  const filtered = VERSIONS.filter(v => cmpV(v, loaderMin) >= 0 && (!query || v.toLowerCase().includes(query)));

  modsTargetVersionList.innerHTML = '';
  filtered.forEach(v => {
    const item = document.createElement('button');
    item.className = 'version-item' + (v === modsTargetVersion ? ' is-selected' : '');
    item.textContent = v;
    item.addEventListener('click', () => {
      modsTargetVersion = v;
      syncModsTargetVersionLabel();
      modsTargetVersionDropdown.classList.remove('is-open');
      saveModsViewState();
      runModSearch(1);
    });
    modsTargetVersionList.appendChild(item);
  });
}

// Ставит фиксированно-позиционированную панель (dropdown) ровно под кнопкой,
// по которой кликнули, и подправляет её так, чтобы она не вылезала за
// пределы окна лаунчера (окно небольшое, 800x600 по умолчанию).
function positionDropdownNear(anchorBtn, dropdownEl) {
  dropdownEl.style.right = 'auto';
  const width = Math.min(dropdownEl.offsetWidth || 280, 320);
  dropdownEl.style.width = width + 'px';

  const rect = anchorBtn.getBoundingClientRect();
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

  const height = dropdownEl.offsetHeight || 380;
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 8) {
    top = rect.top - height - 8;
  }
  top = Math.max(8, top);
  dropdownEl.style.maxHeight = Math.min(420, window.innerHeight - 16) + 'px';

  dropdownEl.style.left = left + 'px';
  dropdownEl.style.top = top + 'px';
}

modsTargetVersionBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !modsTargetVersionDropdown.classList.contains('is-open');
  modsTargetVersionDropdown.classList.toggle('is-open', willOpen);
  if (willOpen) {
    renderModsTargetVersionList(modsTargetVersionSearch ? modsTargetVersionSearch.value : '');
    positionDropdownNear(modsTargetVersionBtn, modsTargetVersionDropdown);
  }
});
modsTargetVersionSearch?.addEventListener('input', () => renderModsTargetVersionList(modsTargetVersionSearch.value));
modsTargetVersionDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => modsTargetVersionDropdown?.classList.remove('is-open'));

// Простая debounce-обёртка, чтобы не долбить Modrinth API на каждое нажатие клавиши.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function formatModDownloads(n) {
  if (typeof n !== 'number') return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function renderModCardsInto(container, hits, { installedUids = new Set(), uidToFilename = new Map(), onInstall, onUninstall } = {}) {
  hideJsTooltip();
  container.innerHTML = '';

  if (!hits || hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-empty';
    empty.textContent = t('mods.notFound');
    container.appendChild(empty);
    return;
  }

  hits.forEach(hit => {
    const uid = hit.uid;
    const alreadyInstalled = installedUids.has(uid);
    const filename = uidToFilename.get(uid);

    const card = document.createElement('div');
    card.className = 'mod-card';

   const iconFallbackChar = (hit.title || uid).charAt(0).toUpperCase();
const iconHtml = hit.icon_url
  ? `<img class="mod-card-icon-img" src="${hit.icon_url}" alt="">`
  : iconFallbackChar;

    const sourceBadges = hit.sources.map(s => s === 'modrinth' ? MODRINTH_LOGO : CURSEFORGE_LOGO).join('');

    card.innerHTML = `
      <div class="mod-icon">${iconHtml}</div>
      <div class="mod-info">
        <div class="mod-name">${hit.title || uid} <span class="mod-source-badges">${sourceBadges}</span></div>
        <div class="mod-desc">${hit.description || ''}</div>
        <div class="mod-downloads">⭳ ${formatModDownloads(hit.downloads)} ${t('mods.downloadsLabel')}</div>
      </div>
      <div class="mod-card-actions">
        <button type="button" class="mod-install-btn${alreadyInstalled ? ' is-installed' : ''}" ${alreadyInstalled ? 'disabled' : ''}>
          ${alreadyInstalled ? t('mods.added') : t('mods.install')}
        </button>
        ${alreadyInstalled && filename ? `
        <button type="button" class="mod-uninstall-btn" data-tooltip="${t('mods.installed.delete')}">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
        </button>` : ''}
      </div>
    `;

    const cardIconImg = card.querySelector('.mod-card-icon-img');
if (cardIconImg) {
  cardIconImg.addEventListener('error', () => {
    cardIconImg.replaceWith(document.createTextNode(iconFallbackChar));
  }, { once: true });
}

    card.addEventListener('click', () => openModDetails(hit, onInstall, alreadyInstalled));

    const btn = card.querySelector('.mod-install-btn');
    if (!alreadyInstalled) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); onInstall(hit, btn); });
    } else {
      btn.addEventListener('click', (e) => e.stopPropagation());
    }

    const uninstallBtn = card.querySelector('.mod-uninstall-btn');
    if (uninstallBtn && onUninstall) {
      uninstallBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onUninstall(uid, filename, uninstallBtn);
      });
    }

    container.appendChild(card);
  });
}

// ============================================
// Модалка "О моде" — полное описание + статистика, тянется с Modrinth
// по клику на карточку (getModDetails -> project endpoint).
// ============================================
const modDetailsOverlay = document.getElementById('modDetailsOverlay');
const modDetailsClose = document.getElementById('modDetailsClose');
const modDetailsIcon = document.getElementById('modDetailsIcon');
const modDetailsTitle = document.getElementById('modDetailsTitle');
const modDetailsStats = document.getElementById('modDetailsStats');
const modDetailsBody = document.getElementById('modDetailsBody');
const modDetailsInstallBtn = document.getElementById('modDetailsInstallBtn');

modDetailsClose?.addEventListener('click', () => modDetailsOverlay.classList.remove('is-open'));
modDetailsOverlay?.addEventListener('click', (e) => { if (e.target === modDetailsOverlay) modDetailsOverlay.classList.remove('is-open'); });

// Модринт отдаёт описание в markdown (поле body), и многие авторы модов
// вперемешку с markdown вставляют сырой HTML прямо в тело (бейджи вида
// [![Available on Fabric](url)](link), заголовки <h1 id="...">...</h1> и
// т.п.) — это валидный приём в markdown (raw HTML проходит насквозь), но
// самодельный regex-парсер, который был здесь раньше, такого не понимал и
// просто показывал сырые теги/скобки текстом на экране. marked — обкатанный
// markdown-парсер, который умеет и то, и другое правильно; DOMPurify после
// него чистит результат от script/style/on*-обработчиков и javascript:-ссылок
// перед вставкой в DOM. Ссылкам дополнительно проставляем target/rel, чтобы
// клик по ним не пытался открыть новое окно самого WebView (см. обработчик
// внешних ссылок ниже — openExternalLinksIn открывает их в системном браузере).
function mdToSafeHtml(md) {
  if (!md) return '';
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    // CDN не загрузился (нет сети при первом запуске и т.п.) — показываем
    // хотя бы неотформатированный текст, а не падаем с ошибкой.
    const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
  }

  marked.setOptions({ breaks: true, gfm: true });
  const rawHtml = marked.parse(md);

  const clean = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
  });

  // DOMPurify не расставляет target/rel сам — делаем это отдельным проходом
  // через реальный DOM, заодно навешивая класс на картинки для существующих
  // CSS-правил .md-img.
  const container = document.createElement('div');
  container.innerHTML = clean;
  container.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  container.querySelectorAll('img').forEach(img => img.classList.add('md-img'));
  container.querySelectorAll('pre').forEach(pre => pre.classList.add('md-code-block'));
  container.querySelectorAll('ul').forEach(ul => ul.classList.add('md-list'));
  container.querySelectorAll('ol').forEach(ol => ol.classList.add('md-list'));
  container.querySelectorAll('hr').forEach(hr => hr.classList.add('md-hr'));

  return container.innerHTML;
}

const modDetailsCache = new Map();
let modDetailsRequestId = 0;

function sanitizeCurseForgeHtml(html) {
  const raw = html || '';
  if (typeof DOMPurify === 'undefined') {
    // Запасной путь на случай недоступного CDN — тот же список опасных
    // конструкций, что чистил старый ручной вариант.
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/ on[a-z]+="[^"]*"/gi, '')
      .replace(/ on[a-z]+='[^']*'/gi, '');
  }

  const clean = DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
  });

  const container = document.createElement('div');
  container.innerHTML = clean;
  container.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return container.innerHTML;
}

async function openModDetails(hit, onInstall, alreadyInstalled) {
  const uid = hit.uid;
  modDetailsOverlay.classList.add('is-open');
  modDetailsTitle.textContent = hit.title || uid;
  modDetailsIcon.textContent = (hit.title || uid).charAt(0).toUpperCase();
  modDetailsInstallBtn.style.display = 'none';

  const myRequestId = ++modDetailsRequestId;

  const renderBody = (title, downloads, followers, iconUrl, bodyHtml) => {
    modDetailsTitle.textContent = title || hit.title || uid;
    modDetailsStats.textContent =
      `⭳ ${formatModDownloads(downloads)} ${t('mods.downloadsLabel')}` +
      (followers ? ` · ♥ ${formatModDownloads(followers)} ${t('mods.followersLabel')}` : '');
    modDetailsBody.innerHTML = bodyHtml || '';
    if (iconUrl) modDetailsIcon.innerHTML = `<img src="${iconUrl}" alt="">`;

    if (alreadyInstalled) {
      modDetailsInstallBtn.style.display = 'block';
      modDetailsInstallBtn.textContent = t('mods.added');
      modDetailsInstallBtn.disabled = true;
    } else if (onInstall) {
      modDetailsInstallBtn.style.display = 'block';
      modDetailsInstallBtn.textContent = t('mods.install');
      modDetailsInstallBtn.disabled = false;
      modDetailsInstallBtn.onclick = () => {
        onInstall(hit, modDetailsInstallBtn);
        modDetailsInstallBtn.textContent = t('mods.added');
        modDetailsInstallBtn.disabled = true;
      };
    }
  };

  if (modDetailsCache.has(uid)) {
    const cached = modDetailsCache.get(uid);
    renderBody(cached.title, cached.downloads, cached.followers, cached.icon_url, cached.bodyHtml);
  } else {
    modDetailsBody.innerHTML = '';
    modDetailsStats.textContent = t('mods.loadingDetails');
  }

  try {
    let title = hit.title, iconUrl = hit.icon_url, bodyHtml = '';

    if (hit.modrinthSlug && typeof window.getModDetails === 'function') {
      const raw = await window.getModDetails({ slug: hit.modrinthSlug });
      if (myRequestId !== modDetailsRequestId) return;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result.success) {
        title = result.project.title || title;
        iconUrl = result.project.icon_url || iconUrl;
        bodyHtml = mdToSafeHtml(result.project.body || result.project.description || '');
      }
    } else if (hit.curseforgeId && typeof window.getModDetailsCurseForge === 'function') {
      const raw = await window.getModDetailsCurseForge({ modId: String(hit.curseforgeId) });
      if (myRequestId !== modDetailsRequestId) return;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result.success) bodyHtml = sanitizeCurseForgeHtml(result.html);
    }

    if (!bodyHtml) bodyHtml = `<p>${hit.description || ''}</p>`;

    const entry = { title, downloads: hit.downloads, followers: hit.followers, icon_url: iconUrl, bodyHtml };
    modDetailsCache.set(uid, entry);
    renderBody(title, hit.downloads, hit.followers, iconUrl, bodyHtml);
  } catch (err) {
    if (myRequestId !== modDetailsRequestId) return;
    console.error('[MagmaLauncher] Ошибка загрузки описания мода:', err);
    if (!modDetailsCache.has(uid)) modDetailsStats.textContent = t('auth.magma.genericError');
  }
}

// ============================================
// Отслеживание уже установленных модов.
// Записи хранятся как {slug, filename} — filename нужен, чтобы позже сверить
// с реальным содержимым mods/ на диске (см. reconcileInstalledMods ниже):
// если игрок вручную удалил jar, бейдж "Добавлено" должен перестать врать.
// Записи старого формата (просто строка-slug, без filename — до этого фикса)
// оставляем как есть при сверке: раз имя файла неизвестно, проверить нечем,
// но и удалять запись "на всякий случай" тоже неправильно.
// ============================================
const INSTALLED_MODS_KEY = 'magma_installed_mods';

function installedModsStorageKey(loader, version, instanceName) {
  return instanceName ? `pack:${instanceName}` : `${loader}:${version}`;
}

function getInstalledModRecords(loader, version, instanceName) {
  try {
    const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
    return all[installedModsStorageKey(loader, version, instanceName)] || [];
  } catch {
    return [];
  }
}

function markModInstalled(loader, version, uid, filename, instanceName) {
  try {
    const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
    const key = installedModsStorageKey(loader, version, instanceName);
    const list = (all[key] || []).filter(r => (typeof r === 'string' ? canonicalUid(r) : canonicalUid(r.slug)) !== uid);
    list.push({ slug: uid, filename });
    all[key] = list;
    localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(all));
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось сохранить статус установки мода:', err);
  }
}

async function fetchModsDirFiles(dirPath) {
  if (typeof window.listModsInDir !== 'function') return null;
  try {
    const raw = await window.listModsInDir({ dir: dirPath });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return null;
    return new Set(result.files || []);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось прочитать папку mods:', err);
    return null;
  }
}

function verifyInstalledRecords(loader, version, instanceName, filesOnDisk) {
  const records = getInstalledModRecords(loader, version, instanceName);
  const uidToFilename = new Map();

  if (!filesOnDisk) {
    records.forEach(r => {
      if (typeof r === 'string') return;
      uidToFilename.set(canonicalUid(r.slug), r.filename);
    });
    return uidToFilename;
  }

  const kept = [];
  records.forEach(r => {
    if (typeof r === 'string') return;
    if (filesOnDisk.has(r.filename) || filesOnDisk.has(r.filename + '.disabled')) {
      kept.push(r);
      uidToFilename.set(canonicalUid(r.slug), r.filename);
    }
  });

  if (kept.length !== records.length) {
    try {
      const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
      all[installedModsStorageKey(loader, version, instanceName)] = kept;
      localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(all));
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось сохранить сверенный статус модов:', err);
    }
  }

  return uidToFilename;
}

function unmarkModInstalled(loader, version, uid, instanceName) {
  try {
    const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
    const key = installedModsStorageKey(loader, version, instanceName);
    all[key] = (all[key] || []).filter(r => (typeof r === 'string' ? canonicalUid(r) : canonicalUid(r.slug)) !== uid);
    localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(all));
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось убрать статус установки мода:', err);
  }
}

let currentRecordUidByHitUid = new Map();

async function modUninstallHandler(uid, filename, btn) {
  if (!filename || typeof window.deleteModFile !== 'function') return;

  btn.disabled = true;
  try {
    const raw = await window.deleteModFile({ dir: currentContentDir(), filename });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));

    // Если карточка "установлена" была найдена не по своему точному uid, а
    // по совпадению названия с записью другого источника (см.
    // resolveCrossSourceMatch ниже), снимать статус нужно с ТОГО, настоящего
    // uid записи — иначе запись в манифесте останется висеть навсегда.
    const recordUid = currentRecordUidByHitUid.get(uid) || uid;
    unmarkModInstalled(effectiveModsTargetLoader(), effectiveModsTargetVersion(), recordUid, modsTargetInstanceName);
    loadModsPage(modSearchPage);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось удалить мод:', err);
    btn.disabled = false;
  }
}

// Ищет среди уже установленных записей (в рамках текущей связки
// загрузчик/версия/модпак) мод с таким же названием, но installед из
// ДРУГОГО источника — используется в двух местах: чтобы не дать поставить
// один и тот же мод дважды (findConflictingInstalledMod ниже дублирует
// эту же проверку под установку) и чтобы карточка каталога показывала
// "Добавлено" и кнопку удаления, даже если сам мод физически ставился не
// с того источника, который сейчас выбран в фильтре (Modrinth/CurseForge).
async function resolveCrossSourceMatch(hit, loader, version, instanceName) {
  const records = getInstalledModRecords(loader, version, instanceName);
  const targetKey = normalizeTitleKey(hit.title);
  if (!targetKey) return null;

  for (const r of records) {
    if (typeof r === 'string') continue;
    const uid = canonicalUid(r.slug);
    if (uid === hit.uid) continue;

    let title = null;
    if (modTitleCache.has(uid)) {
      title = modTitleCache.get(uid).title;
    } else {
      const info = await fetchModTitleAndIcon(uid);
      title = info ? info.title : null;
    }
    if (title && normalizeTitleKey(title) === targetKey) return { uid, filename: r.filename };
  }
  return null;
}

// Если мод с таким же названием уже установлен из ДРУГОГО источника под ту
// же версию/загрузчик/модпак — возвращает его uid (конфликт), иначе null.
// Одна и та же игра не должна одновременно грузить, например, "Fabric API"
// и с Modrinth, и с CurseForge — это реальный источник крашей. При смене
// версии/загрузчика это ограничение снова не действует, так как проверка
// выполняется в рамках конкретного scope (см. getInstalledModRecords).
async function findConflictingInstalledMod(hit, loader, version, instanceName) {
  const match = await resolveCrossSourceMatch(hit, loader, version, instanceName);
  return match ? match.uid : null;
}

async function modInstallHandler(hit, btn) {
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.textContent = t('mods.installing');

  try {
    const loaderForConflictCheck = effectiveModsTargetLoader();
    const versionForConflictCheck = effectiveModsTargetVersion();
    const conflict = await findConflictingInstalledMod(hit, loaderForConflictCheck, versionForConflictCheck, modsTargetInstanceName);
    if (conflict) {
      btn.classList.remove('is-loading');
      btn.disabled = false;
      const original = t('mods.install');
      btn.textContent = t('mods.duplicateNameError').slice(0, 40);
      setTimeout(() => { btn.textContent = original; }, 3000);
      return;
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось проверить дубликаты модов:', err);
  }

  try {
    const modsDir = currentContentDir();
    const loader = effectiveModsTargetLoader();
    const version = effectiveModsTargetVersion();
    const category = currentCategoryDef();

    let res2;
    if (category.id !== 'mod') {
      if (hit.curseforgeId && typeof window.installContentCurseForge === 'function') {
        const raw2 = await window.installContentCurseForge({ modId: String(hit.curseforgeId), version, targetDir: modsDir });
        res2 = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
      } else if (hit.modrinthSlug && typeof window.installContent === 'function') {
        const raw2 = await window.installContent({ slug: hit.modrinthSlug, version, projectType: category.projectType, targetDir: modsDir });
        res2 = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
      } else {
        throw new Error(t('auth.magma.genericError'));
      }
    } else if (hit.modrinthSlug && typeof window.installMod === 'function') {
      const raw2 = await window.installMod({ slug: hit.modrinthSlug, version, loader, modsDir });
      res2 = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
    } else if (hit.curseforgeId && typeof window.installModCurseForge === 'function') {
      const raw2 = await window.installModCurseForge({ modId: String(hit.curseforgeId), version, loader, modsDir });
      res2 = typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
    } else {
      throw new Error(t('auth.magma.genericError'));
    }

    if (!res2.success) throw new Error(translateBackendError(res2.error) || t('auth.magma.genericError'));

    markModInstalled(loader, version, hit.uid, res2.filename, modsTargetInstanceName);
    btn.classList.remove('is-loading');
    btn.classList.add('is-installed');
    btn.disabled = true;
    btn.textContent = t('mods.added');
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка установки мода:', err);
    btn.classList.remove('is-loading');
    btn.disabled = false;
    const original = t('mods.install');
    btn.textContent = String(err.message || err).slice(0, 40);
    setTimeout(() => { btn.textContent = original; }, 2500);
  }
}

const MODS_PAGE_SIZE = 20;
let modSearchPage = 1;
let modSearchTotalHits = 0;
let modSearchRequestId = 0; // отбрасываем ответы устаревших запросов, если игрок быстро листает/меняет фильтры

const modListPaginationEl = document.getElementById('modListPagination');

function clearModsPagination() {
  if (modListPaginationEl) modListPaginationEl.innerHTML = '';
}

function mkPageEllipsis() {
  const span = document.createElement('span');
  span.className = 'mod-page-ellipsis';
  span.textContent = '…';
  return span;
}

function renderModsPagination(totalPages) {
  if (!modListPaginationEl) return;
  modListPaginationEl.innerHTML = '';
  if (totalPages <= 1) return;

  const mkBtn = (label, page, opts = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mod-page-btn' + (opts.active ? ' is-active' : '');
    b.textContent = label;
    b.disabled = !!opts.disabled;
    if (!opts.disabled && !opts.active) {
      b.addEventListener('click', () => {
        loadModsPage(page);
        // Явный клик по странице — логично показать её с начала списка, а
        // не оставлять прокрутку там, где была пагинация (внизу экрана).
        if (contentEl) contentEl.scrollTop = 0;
      });
    }
    return b;
  };

  modListPaginationEl.appendChild(mkBtn('‹', Math.max(1, modSearchPage - 1), { disabled: modSearchPage === 1 }));

  // Небольшое окно вокруг текущей страницы + первая/последняя — как в
  // оригинале: на 1-й странице это "1 2 … 3520", а не длинный ряд цифр.
  const windowSize = 3;
  let start = Math.max(1, modSearchPage - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  if (start > 1) {
    modListPaginationEl.appendChild(mkBtn('1', 1));
    if (start > 2) modListPaginationEl.appendChild(mkPageEllipsis());
  }
  for (let p = start; p <= end; p++) {
    modListPaginationEl.appendChild(mkBtn(String(p), p, { active: p === modSearchPage }));
  }
  if (end < totalPages) {
    if (end < totalPages - 1) modListPaginationEl.appendChild(mkPageEllipsis());
    modListPaginationEl.appendChild(mkBtn(String(totalPages), totalPages));
  }

  modListPaginationEl.appendChild(mkBtn('›', Math.min(totalPages, modSearchPage + 1), { disabled: modSearchPage === totalPages }));
}

// Загружает конкретную страницу результатов с сервера (реальный запрос с
// offset, а не нарезка уже скачанного списка) и перерисовывает список + пагинацию.
// Кэш уже загруженных страниц поиска (на время сессии, в памяти) — ключ
// учитывает загрузчик/версию/запрос/сдвиг. Если страница уже в кэше, рисуем
// её мгновенно без сетевого похода и без "Ищем моды...". Дополнительно после
// показа текущей страницы тихо (без ожидания и индикаторов) подгружаем
// соседние страницы — это и есть "прогрев", о котором просили: к моменту,
// когда игрок реально нажмёт "дальше/назад", результат уже готов.
const modSearchCache = new Map();
const MOD_SEARCH_CACHE_LIMIT = 60;

function modSearchCacheKey(query, version, loader, offset) {
  return `${modsActiveCategory}\u0001${loader}\u0001${version}\u0001${query}\u0001${offset}\u0001${modsSourcesKey()}\u0001${modsSortBy}`;
}

function cacheModSearchResult(key, data) {
  modSearchCache.set(key, data);
  if (modSearchCache.size > MOD_SEARCH_CACHE_LIMIT) {
    modSearchCache.delete(modSearchCache.keys().next().value);
  }
}

async function fetchOneSource(fn, query, version, loader, offset) {
  if (typeof fn !== 'function') return { success: true, hits: [], total: 0 };
  try {
    const raw = await fn({ query, version, loader, offset });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return result.success ? result : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function fetchContentSearchOneSource(query, version, projectType, offset) {
  if (typeof window.searchContent !== 'function') return { success: true, hits: [], total: 0 };
  try {
    const raw = await window.searchContent({ query, version, projectType, offset });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return result.success ? result : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function fetchContentSearchCurseForge(query, version, classId, offset) {
  if (typeof window.searchContentCurseForge !== 'function') return { success: true, hits: [], total: 0 };
  try {
    const raw = await window.searchContentCurseForge({ query, version, classId, offset });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return result.success ? result : { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function fetchModsSearch(query, version, loader, offset) {
  const key = modSearchCacheKey(query, version, loader, offset);
  if (modSearchCache.has(key)) return modSearchCache.get(key);

  const category = currentCategoryDef();

  if (category.id !== 'mod') {
    const useCurseForge = modsActiveSource === 'curseforge' && category.curseforgeClassId;
    const res = useCurseForge
      ? await fetchContentSearchCurseForge(query, version, category.curseforgeClassId, offset)
      : (category.projectType ? await fetchContentSearchOneSource(query, version, category.projectType, offset) : { success: true, hits: [], total: 0 });
    if (!res.success) return { success: false, error: res.error };
    const merged = useCurseForge ? buildUnifiedHits([], res.hits || []) : buildUnifiedHits(res.hits || [], []);
    const sorted = sortUnifiedHits(merged, modsSortBy);
    const data = { success: true, hits: sorted, total: res.total || 0, warnings: [] };
    cacheModSearchResult(key, data);
    return data;
  }

  const isModrinth = modsActiveSource === 'modrinth';
  const res = isModrinth
    ? await fetchOneSource(window.searchMods, query, version, loader, offset)
    : await fetchOneSource(window.searchModsCurseForge, query, version, loader, offset);

  if (!res.success) {
    return { success: false, error: res.error };
  }

  const warnings = [];

  // Список рендерится строго из ОДНОГО источника — buildUnifiedHits тут просто
  // приводит сырые hits к единому формату карточки (uid/иконка/badge и т.п.),
  // без слияния с другим источником.
  const merged = isModrinth ? buildUnifiedHits(res.hits || [], []) : buildUnifiedHits([], res.hits || []);
  const sorted = sortUnifiedHits(merged, modsSortBy);
  const total = res.total || 0;

  const data = { success: true, hits: sorted, total, warnings };
  cacheModSearchResult(key, data);
  return data;
}

const modSearchWarningEl = document.getElementById('modSearchWarning');
function renderModsSearchWarning(warnings) {
  if (!modSearchWarningEl) return;
  if (!warnings || warnings.length === 0) {
    modSearchWarningEl.style.display = 'none';
    modSearchWarningEl.textContent = '';
    return;
  }
  modSearchWarningEl.style.display = 'block';
  modSearchWarningEl.textContent = warnings.join('  ·  ');
}

async function loadModsPage(page) {
  if (!modList) return;
  if (modsActiveCategory === 'servers') return;
  if (modsActiveCategory === 'mod' && modsTargetLoader === 'modpacks' && !modsTargetInstanceName) return;

  const loader = effectiveModsTargetLoader();
  const version = effectiveModsTargetVersion();

  modSearchPage = page;
  const myRequestId = ++modSearchRequestId;
  const query = modSearch ? modSearch.value.trim() : '';
  const offset = (page - 1) * MODS_PAGE_SIZE;
  const cacheKey = modSearchCacheKey(query, version, loader, offset);

  if (!modSearchCache.has(cacheKey)) {
    modList.innerHTML = `<div class="mod-list-hint">${modsSearchingLabel()}</div>`;
  }

  try {
    const [result, filesOnDisk] = await Promise.all([
      fetchModsSearch(query, version, loader, offset),
      fetchModsDirFiles(currentContentDir()),
    ]);
    if (myRequestId !== modSearchRequestId) return;

    if (!result.success) {
      renderModsSearchWarning(null);
      modList.innerHTML = `<div class="mod-list-hint">${translateBackendError(result.error) || t('auth.magma.genericError')}</div>`;
      clearModsPagination();
      return;
    }

    renderModsSearchWarning(result.warnings);

    modSearchTotalHits = result.total || 0;
    const totalPages = Math.max(1, Math.ceil(modSearchTotalHits / MODS_PAGE_SIZE));
    modSearchPage = Math.min(Math.max(1, page), totalPages);

    const uidToFilename = verifyInstalledRecords(loader, version, modsTargetInstanceName, filesOnDisk);

    // Довязываем карточки из ДРУГОГО источника, у которых есть уже
    // установленный мод с тем же названием (см. resolveCrossSourceMatch) —
    // так "Добавлено" и кнопка удаления показываются одинаково что на
    // Modrinth, что на CurseForge, если игрок ставил мод только с одного из них.
    const recordUidByHitUid = new Map();
    for (const hit of (result.hits || [])) {
      if (uidToFilename.has(hit.uid)) {
        recordUidByHitUid.set(hit.uid, hit.uid);
        continue;
      }
      const cross = await resolveCrossSourceMatch(hit, loader, version, modsTargetInstanceName);
      if (cross) {
        uidToFilename.set(hit.uid, cross.filename);
        recordUidByHitUid.set(hit.uid, cross.uid);
      }
    }
    currentRecordUidByHitUid = recordUidByHitUid;

    renderModCardsInto(modList, result.hits || [], {
      installedUids: new Set(uidToFilename.keys()),
      uidToFilename,
      onInstall: modInstallHandler,
      onUninstall: modUninstallHandler,
    });
    renderModsPagination(totalPages);

    // ВАЖНО: раньше здесь был modList.scrollIntoView({block:'start'}) — он
    // прокручивал .content так, чтобы САМ СПИСОК модов оказался у верхнего
    // края окна, а это ниже заголовка "Моды"/поиска/вкладок загрузчика.
    // Из-за этого при каждом заходе на вкладку "Моды" экран открывался
    // "чуть ниже", а не с самого верха. Явную прокрутку наверх теперь делает
    // только сам вызывающий код (например клик по странице пагинации, см.
    // renderModsPagination) — обычная загрузка/смена фильтров прокрутку не
    // навязывает, и позиция остаётся такой, какую сохранил viewScrollState.
    saveModsViewState();

    [modSearchPage + 1, modSearchPage - 1].forEach(p => {
      if (p < 1 || p > totalPages) return;
      const pKey = modSearchCacheKey(query, version, loader, (p - 1) * MODS_PAGE_SIZE);
      if (modSearchCache.has(pKey)) return;
      fetchModsSearch(query, version, loader, (p - 1) * MODS_PAGE_SIZE).catch(() => {});
    });
  } catch (err) {
    if (myRequestId !== modSearchRequestId) return;
    console.error('[MagmaLauncher] Ошибка поиска модов:', err);
    modList.innerHTML = `<div class="mod-list-hint">${t('auth.magma.genericError')}</div>`;
    clearModsPagination();
  }
}

async function runModSearch(page) {
  if (!modList) return;
  if (modsActiveCategory === 'servers') return;

  if (modsActiveCategory === 'mod' && typeof window.searchMods !== 'function' && typeof window.searchModsCurseForge !== 'function') {
    modList.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
    clearModsPagination();
    return;
  }

  // Без явно переданной страницы переиспользуем последнюю, на которой
  // находился игрок (modSearchPage) — иначе повторный вызов при возврате на
  // вкладку "Моды" (см. обработчик клика по рейлу) всегда откатывал бы
  // список обратно на первую страницу, даже если игрок листал дальше.
  await loadModsPage(page || modSearchPage || 1);
}

// ВАЖНО: раньше здесь стоял debounce(runModSearch, 400) напрямую — это
// молча пробрасывало DOM-событие ввода как первый аргумент runModSearch.
// Пока у runModSearch не было параметров, это ничего не ломало, но теперь
// первый параметр — номер страницы, поэтому событие ввода могло бы попасть
// туда вместо номера страницы. Явно оборачиваем и всегда просим страницу 1 —
// новый поисковый запрос должен начинаться с первой страницы результатов.
const debouncedModSearch = debounce(() => runModSearch(1), 400);
modSearch?.addEventListener('input', debouncedModSearch);

const modFilterBtn = document.getElementById('modFilterBtn');
const modFilterDropdown = document.getElementById('modFilterDropdown');
const modFilterSortList = document.getElementById('modFilterSortList');
const modFilterSourceModrinth = document.getElementById('modFilterSourceModrinth');
const modFilterSourceCurseForge = document.getElementById('modFilterSourceCurseForge');
const modFilterModrinthLogo = document.getElementById('modFilterModrinthLogo');
const modFilterCurseForgeLogo = document.getElementById('modFilterCurseForgeLogo');

if (modFilterModrinthLogo) modFilterModrinthLogo.innerHTML = MODRINTH_LOGO;
if (modFilterCurseForgeLogo) modFilterCurseForgeLogo.innerHTML = CURSEFORGE_LOGO;
if (modFilterSourceModrinth) modFilterSourceModrinth.checked = modsActiveSource === 'modrinth';
if (modFilterSourceCurseForge) modFilterSourceCurseForge.checked = modsActiveSource === 'curseforge';

const MOD_SORT_OPTIONS = ['relevance', 'downloads', 'followers', 'date_published', 'date_updated'];
const MOD_SORT_I18N_KEY = {
  relevance: 'mods.filter.sort.relevance',
  downloads: 'mods.filter.sort.downloads',
  followers: 'mods.filter.sort.followers',
  date_published: 'mods.filter.sort.datePublished',
  date_updated: 'mods.filter.sort.dateUpdated',
};

function renderModFilterSortList() {
  if (!modFilterSortList) return;
  modFilterSortList.innerHTML = '';
  MOD_SORT_OPTIONS.forEach(opt => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mod-filter-sort-item' + (opt === modsSortBy ? ' is-selected' : '');
    item.textContent = t(MOD_SORT_I18N_KEY[opt]);
    item.addEventListener('click', () => {
      modsSortBy = opt;
      saveModsFilterPrefs();
      renderModFilterSortList();
      runModSearch(1);
    });
    modFilterSortList.appendChild(item);
  });
}
renderModFilterSortList();
renderInstancesCatalogSortList();

modFilterBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  modFilterDropdown.classList.toggle('is-open');
});
modFilterDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => modFilterDropdown?.classList.remove('is-open'));

modFilterSourceModrinth?.addEventListener('change', () => {
  if (!modFilterSourceModrinth.checked) return;
  modsActiveSource = 'modrinth';
  saveModsFilterPrefs();
  runModSearch(1);
});
modFilterSourceCurseForge?.addEventListener('change', () => {
  if (!modFilterSourceCurseForge.checked) return;
  modsActiveSource = 'curseforge';
  saveModsFilterPrefs();
  runModSearch(1);
});

// ============================================
// "Каталог" / "Мои моды" — переключатель вкладок внутри "Моды".
// ============================================
const modsSubtabs = document.querySelectorAll('.mods-subtab[data-subtab]');
const modsSubviews = document.querySelectorAll('.mods-subview[data-subview]');

modsSubtabs.forEach(tab => {
  tab.addEventListener('click', () => {
    hideJsTooltip();
    modsSubtabs.forEach(t => t.classList.toggle('is-active', t === tab));
    const target = tab.dataset.subtab;
    modsSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.subview === target));
    if (target === 'installed') loadInstalledMods();
  });
});

// ============================================
// "Мои моды" — реальный список файлов из mods/ на диске. Источник истины —
// сама файловая система (через listModsInDir), а не localStorage, поэтому
// удалённый вручную мод не может "зависнуть" в интерфейсе как установленный.
// Отключение мода — стандартный трюк лаунчеров: добавить/убрать суффикс
// ".disabled" в имени файла (Minecraft грузит только *.jar, поэтому файл
// остаётся на диске, но игра его игнорирует).
// ============================================
const installedModListEl = document.getElementById('installedModList');
const installedModsScopeFilterEl = document.getElementById('installedModsScopeFilter');

// Фильтр "Мои моды": по умолчанию показываем только моды, установленные под
// ТЕКУЩУЮ выбранную в шапке версию/загрузчик (даже если физически общая папка
// mods/ одна на все версии сразу) — так список не превращается в свалку
// модов сразу под все версии, которыми игрок когда-либо пользовался. Второй
// режим — "Все версии" — показывает вообще все файлы из папки и подписывает
// каждый мод версией(-ями), под которую он был установлен.
const INSTALLED_MODS_SCOPE_KEY = 'magma_installed_mods_scope';
let installedModsScopeFilter = localStorage.getItem(INSTALLED_MODS_SCOPE_KEY) || 'current';

function renderInstalledModsScopeFilter() {
  if (!installedModsScopeFilterEl) return;
  // Раздел "Модпаки" активен — кнопки не нужны, даже если ни один модпак
  // ещё не создан/выбран (раньше проверялось только реальное наличие
  // выбранного модпака, из-за чего кнопки не пропадали).
   installedModsScopeFilterEl.style.display = (isModpackScopeActive() || modsActiveCategory === 'map') ? 'none' : 'flex';
  installedModsScopeFilterEl.querySelectorAll('[data-installed-scope]').forEach(btn => {
    const scope = btn.dataset.installedScope;
    btn.textContent = t(scope === 'all' ? 'mods.filter.scope.all' : 'mods.filter.scope.current');
    btn.classList.toggle('is-active', installedModsScopeFilter === scope);
  });
}

installedModsScopeFilterEl?.querySelectorAll('[data-installed-scope]').forEach(btn => {
  btn.addEventListener('click', () => {
    installedModsScopeFilter = btn.dataset.installedScope;
    localStorage.setItem(INSTALLED_MODS_SCOPE_KEY, installedModsScopeFilter);
    renderInstalledModsScopeFilter();
    loadInstalledMods();
  });
});

// Ищет ВСЕ версии/загрузчики (ключи вида "loader:version" в INSTALLED_MODS_KEY,
// без модпаков), под которые конкретный файл был установлен через лаунчер —
// нужно и для фильтра "Текущая версия" (скрыть файлы чужой версии), и для
// подписи версии рядом с названием мода в режиме "Все версии".
const LOADER_DISPLAY_LABELS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla' };

function getAllInstalledModVersionsForFilename(filename) {
  const base = filename.replace(/\.disabled$/i, '');
  const entries = [];
  try {
    const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
    for (const key of Object.keys(all)) {
      if (key.startsWith('pack:')) continue;
      const rec = (all[key] || []).find(r => typeof r !== 'string' && r.filename === base);
      if (rec) {
        const idx = key.indexOf(':');
        const loader = idx >= 0 ? key.slice(0, idx) : '';
        const version = idx >= 0 ? key.slice(idx + 1) : key;
        entries.push({ loader, version });
      }
    }
  } catch {}
  return entries;
}

function currentContentDir() {
  const gameDir = getGameDir();
  const dirName = currentCategoryDef().dirName || 'mods';
  if (isModpackScopeActive() && modsTargetInstanceName) {
    return `${gameDir}\\instances\\${modsTargetInstanceName}\\${dirName}`;
  }
  return `${gameDir}\\${dirName}`;
}
// Старое имя оставлено алиасом — им пользуются места кода, написанные ещё
// до появления категорий (например манифест совместимости модов), которым
// всегда нужна именно папка mods/, а не текущая активная категория.
function currentModsDir() {
  const gameDir = getGameDir();
  if (modsTargetInstanceName) {
    return `${gameDir}\\instances\\${modsTargetInstanceName}\\mods`;
  }
  return gameDir + '\\mods';
}

function modDisplayNameFromFile(filename) {
  const base = filename.replace(/\.disabled$/, '').replace(/\.(jar|zip)$/i, '');
  return base;
}

// Ищет slug мода по имени файла среди ВСЕХ сохранённых записей (по всем
// связкам загрузчик:версия и всем модпакам) — нужен для "Моих модов",
// потому что общая mods/ (не-модпак игра) физически одна на все версии/
// загрузчики сразу, а не только на текущий выбранный в шапке.
function findSlugForFilename(filename) {
  const base = filename.replace(/\.disabled$/i, '');
  try {
    const all = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '{}');
    for (const key of Object.keys(all)) {
      const rec = (all[key] || []).find(r => typeof r !== 'string' && r.filename === base);
      if (rec) return canonicalUid(rec.slug);
    }
  } catch {}
  return null;
}

const modTitleCache = new Map();

async function fetchModTitleAndIcon(uid) {
  if (modTitleCache.has(uid)) return modTitleCache.get(uid);
  if (modDetailsCache.has(uid)) {
    const p = modDetailsCache.get(uid);
    const info = { title: p.title || uid, icon_url: p.icon_url || null };
    modTitleCache.set(uid, info);
    return info;
  }

  try {
    if (uid.startsWith('mr:') && typeof window.getModDetails === 'function') {
      const raw = await window.getModDetails({ slug: uid.slice(3) });
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!result.success) return null;
      const info = { title: result.project.title || uid, icon_url: result.project.icon_url || null };
      modTitleCache.set(uid, info);
      return info;
    }
    if (uid.startsWith('cf:') && typeof window.getModInfoCurseForge === 'function') {
      const raw = await window.getModInfoCurseForge({ modId: uid.slice(3) });
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!result.success) return null;
      const info = { title: result.title || uid, icon_url: result.icon_url || null };
      modTitleCache.set(uid, info);
      return info;
    }
  } catch {
    return null;
  }
  return null;
}

// ============================================
// Угадывание названия/иконки мода по имени файла, когда slug неизвестен
// (мод не ставился через каталог лаунчера, а просто лежит в mods/) — чистим
// версии/загрузчик из имени файла и ищем совпадение через обычный поиск
// Modrinth. Эвристика: совпадение не гарантировано, поэтому при неуверенном
// результате мод просто остаётся с дефолтной буквой, как и раньше.
// ============================================
const MOD_GUESS_CACHE_KEY = 'magma_mod_guess_cache';
const modGuessCache = new Map();
try {
  const rawGuessCache = JSON.parse(localStorage.getItem(MOD_GUESS_CACHE_KEY) || '{}');
  Object.keys(rawGuessCache).forEach(k => modGuessCache.set(k, rawGuessCache[k]));
} catch {}
 
function saveModGuessCache() {
  try {
    const obj = {};
    modGuessCache.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(MOD_GUESS_CACHE_KEY, JSON.stringify(obj));
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось сохранить кэш угадывания модов:', err);
  }
}
 
function cleanFilenameForModSearch(filename) {
  let base = modDisplayNameFromFile(filename);
  base = base.replace(/mc[\s_-]?\d+(\.\d+){1,3}/gi, ' ');
  base = base.replace(/[-_+.]v?\d+(\.\d+){1,3}[a-z0-9]*/gi, ' ');
  base = base.replace(/\b(fabric|forge|quilt|neoforge|universal|client|server|api|release|build|mod)\b/gi, ' ');
  base = base.replace(/[-_+.]/g, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  return base;
}
 
function titlesLooselyMatch(title, query) {
  const kt = normalizeTitleKey(title);
  const kq = normalizeTitleKey(query);
  if (!kt || !kq) return false;
  return kt === kq || kt.includes(kq) || kq.includes(kt);
}
 
async function guessModTitleAndIcon(filename) {
  if (modGuessCache.has(filename)) return modGuessCache.get(filename);
  if (modsActiveCategory !== 'mod') return null;
  if (typeof window.searchMods !== 'function') return null;
 
  const query = cleanFilenameForModSearch(filename);
  if (!query) { modGuessCache.set(filename, null); saveModGuessCache(); return null; }
 
  const guessLoader = (() => {
    const l = effectiveModsTargetLoader();
    return (l === 'fabric' || l === 'forge') ? l : 'fabric';
  })();
 
  try {
    const raw = await window.searchMods({ query, version: effectiveModsTargetVersion(), loader: guessLoader, offset: 0 });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success || !result.hits || !result.hits.length) {
      modGuessCache.set(filename, null); saveModGuessCache(); return null;
    }
 
    const bestHit = result.hits.find(h => titlesLooselyMatch(h.title, query)) || null;
    if (!bestHit) { modGuessCache.set(filename, null); saveModGuessCache(); return null; }
 
    const info = { title: bestHit.title, icon_url: bestHit.icon_url || null };
    modGuessCache.set(filename, info);
    saveModGuessCache();
    return info;
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось угадать мод по имени файла:', err);
    return null;
  }
}

async function loadInstalledMods() {
  if (!installedModListEl) return;

  renderInstalledModsScopeFilter();

  if (isModpackScopeActive() && !modsTargetInstanceName) {
    installedModListEl.innerHTML = `<div class="mod-list-hint">${t('modpacks.none')}</div>`;
    return;
  }

  if (modsActiveCategory === 'map') {
    await loadInstalledMapFolders();
    return;
  }

  if (typeof window.listModsInDir !== 'function') {
    installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
    return;
  }

  installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.searching')}</div>`;

  try {
    const raw = await window.listModsInDir({ dir: currentContentDir() });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) {
      installedModListEl.innerHTML = `<div class="mod-list-hint">${translateBackendError(result.error) || t('mods.installed.loadError')}</div>`;
      return;
    }

    const extPattern = modsActiveCategory === 'mod' ? /\.jar(\.disabled)?$/i : /\.zip(\.disabled)?$/i;
    const files = (result.files || []).filter(f => extPattern.test(f));
    renderInstalledMods(files);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось прочитать папку mods:', err);
    installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.installed.loadError')}</div>`;
  }
}

// ============================================
// "Мои карты" — карта это ПАПКА, а не файл, поэтому свой листинг
// (listMapFolders вместо listModsInDir) и своя отрисовка — без переключателя
// включить/отключить (для мира это не имеет смысла) и без версии.
// ============================================
async function loadInstalledMapFolders() {
  if (typeof window.listMapFolders !== 'function') {
    installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.devModeHint')}</div>`;
    return;
  }

  installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.searching')}</div>`;

  try {
    const raw = await window.listMapFolders({ dir: currentContentDir() });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) {
      installedModListEl.innerHTML = `<div class="mod-list-hint">${translateBackendError(result.error) || t('mods.installed.loadError')}</div>`;
      return;
    }
    renderInstalledMapFolders(result.folders || []);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось прочитать папку карт:', err);
    installedModListEl.innerHTML = `<div class="mod-list-hint">${t('mods.installed.loadError')}</div>`;
  }
}

function renderInstalledMapFolders(folders) {
  hideJsTooltip();
  installedModListEl.innerHTML = '';

  if (!folders.length) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-empty';
    empty.textContent = modsInstalledEmptyLabel();
    installedModListEl.appendChild(empty);
    return;
  }

  const dir = currentContentDir();
  folders.slice().sort((a, b) => a.localeCompare(b)).forEach(folderName => {
    const card = document.createElement('div');
    card.className = 'installed-mod-card';
    card.innerHTML = `
      <div class="installed-mod-icon">${(folderName.charAt(0) || '?').toUpperCase()}</div>
      <div class="installed-mod-info">
        <div class="installed-mod-name">${folderName}</div>
      </div>
      <div class="installed-mod-actions">
        <button type="button" class="installed-mod-btn is-delete" data-tooltip="${t('mods.installed.delete')}">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>
    `;

    card.querySelector('.installed-mod-btn.is-delete').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (typeof window.deleteMapFolder !== 'function') return;
      if (!window.confirm(t('mods.installed.confirmDelete'))) return;
      btn.disabled = true;
      try {
        const raw = await window.deleteMapFolder({ dir, folder: folderName });
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
        loadInstalledMapFolders();
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось удалить карту:', err);
        btn.disabled = false;
      }
    });

    installedModListEl.appendChild(card);
  });
}

function renderInstalledMods(files) {
  hideJsTooltip();
  installedModListEl.innerHTML = '';

  const showAllVersions = !isModpackScopeActive() && installedModsScopeFilter === 'all';
  const currentVersion = effectiveModsTargetVersion();

    const visibleFiles = showAllVersions ? files : files.filter(f => {
    const versions = getAllInstalledModVersionsForFilename(f);
    return versions.length === 0 || versions.some(v => v.version === currentVersion);
  });
  if (visibleFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-empty';
    empty.textContent = modsInstalledEmptyLabel();
    installedModListEl.appendChild(empty);
    return;
  }

  visibleFiles.sort((a, b) => modDisplayNameFromFile(a).localeCompare(modDisplayNameFromFile(b)));

  visibleFiles.forEach(filename => {
    const isDisabled = /\.disabled$/i.test(filename);
    const slug = findSlugForFilename(filename);

    // В режиме "Все версии" рядом с названием показываем, под какую
    // версию/загрузчик этот конкретный файл был установлен — иначе список
    // становится неотличимой мешаниной модов сразу под все версии игрока.
      const versionPrefix = (showAllVersions && !isModpackScopeActive())
      ? (() => {
          const entries = getAllInstalledModVersionsForFilename(filename);
          if (!entries.length) return '';
          const text = entries.map(e => `${LOADER_DISPLAY_LABELS[e.loader] || e.loader} ${e.version}`).join(', ');
          return `<span class="installed-mod-version-tag">(${text})</span> `;
        })()
      : '';

    const card = document.createElement('div');
    card.className = 'installed-mod-card' + (isDisabled ? ' is-disabled' : '');
    card.innerHTML = `
      <div class="installed-mod-icon">${(modDisplayNameFromFile(filename).charAt(0) || '?').toUpperCase()}</div>
      <div class="installed-mod-info">
        <div class="installed-mod-name">${versionPrefix}${modDisplayNameFromFile(filename)}</div>
        ${isDisabled ? `<div class="installed-mod-status">${t('mods.installed.disabled')}</div>` : ''}
      </div>
      <div class="installed-mod-actions">
        <button type="button" class="installed-mod-btn${isDisabled ? ' is-enable' : ''}">
          ${isDisabled
            ? `<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg><span>${t('mods.installed.enable')}</span>`
            : `<svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16" transform="rotate(45 12 12)"/></svg><span>${t('mods.installed.disable')}</span>`}
        </button>
        <button type="button" class="installed-mod-btn is-delete" data-tooltip="${t('mods.installed.delete')}">
          <svg viewBox="0 0 24 24"><path d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
        </button>
      </div>
    `;

    const cardIconImg = card.querySelector('.mod-card-icon-img');
if (cardIconImg) {
  cardIconImg.addEventListener('error', () => {
    cardIconImg.replaceWith(document.createTextNode(iconFallbackChar));
  }, { once: true });
}

    // Подтягиваем красивое название и аватарку с Modrinth, если знаем slug —
    // до этого показываем аккуратное имя из файла, а не сырое "some-mod-1.2.3.jar".
    if (slug) {
      fetchModTitleAndIcon(slug).then(info => {
        if (!info) return;
        const nameEl = card.querySelector('.installed-mod-name');
        const iconEl = card.querySelector('.installed-mod-icon');
        if (nameEl) nameEl.textContent = info.title;
        if (iconEl && info.icon_url) iconEl.innerHTML = `<img src="${info.icon_url}" alt="">`;
      }).catch(() => {});
    } else {
      guessModTitleAndIcon(filename).then(info => {
        if (!info) return;
        const nameEl = card.querySelector('.installed-mod-name');
        const iconEl = card.querySelector('.installed-mod-icon');
        if (nameEl) nameEl.textContent = info.title;
        if (iconEl && info.icon_url) iconEl.innerHTML = `<img src="${info.icon_url}" alt="">`;
      }).catch(() => {});
    }
 
    const toggleBtn = card.querySelector('.installed-mod-btn:not(.is-delete)');
    toggleBtn.addEventListener('click', async () => {
      if (typeof window.toggleModFile !== 'function') return;
      toggleBtn.disabled = true;
      try {
        const raw = await window.toggleModFile({ dir: currentContentDir(), filename });
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
        loadInstalledMods();
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось переключить мод:', err);
        toggleBtn.disabled = false;
      }
    });

    const deleteBtn = card.querySelector('.installed-mod-btn.is-delete');
    deleteBtn.addEventListener('click', async () => {
      if (typeof window.deleteModFile !== 'function') return;
      deleteBtn.disabled = true;
      try {
        const raw = await window.deleteModFile({ dir: currentContentDir(), filename });
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!result.success) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
        if (slug) unmarkModInstalled(effectiveModsTargetLoader(), effectiveModsTargetVersion(), slug, modsTargetInstanceName);
        loadInstalledMods();
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось удалить мод:', err);
        deleteBtn.disabled = false;
      }
    });

    installedModListEl.appendChild(card);
  });
}

// ============================================
// Модалка "Создать модпак"
// ============================================
const modpackOverlay = document.getElementById('modpackOverlay');
const modpackModalClose = document.getElementById('modpackModalClose');
const modpackNameInput = document.getElementById('modpackNameInput');
const modpackVersionBtn = document.getElementById('modpackVersionBtn');
const modpackVersionLabel = document.getElementById('modpackVersionLabel');
const modpackVersionDropdown = document.getElementById('modpackVersionDropdown');
const modpackVersionSearch = document.getElementById('modpackVersionSearch');
const modpackVersionList = document.getElementById('modpackVersionList');
const modpackLoaderTabsEl = document.getElementById('modpackLoaderTabs');
const modpackDefaultModsEl = document.getElementById('modpackDefaultMods');
const modpackError = document.getElementById('modpackError');
const modpackProgress = document.getElementById('modpackProgress');
const modpackProgressFill = document.getElementById('modpackProgressFill');
const modpackProgressLabel = document.getElementById('modpackProgressLabel');
const modpackSubmit = document.getElementById('modpackSubmit');

// Рекомендуемые моды по умолчанию для каждого загрузчика — совпадает с тем,
// что просил игрок: для Fabric сразу отмечены Fabric API и Sodium.
const DEFAULT_MODS_BY_LOADER = {
  fabric: [
    { slug: 'fabric-api', label: 'Fabric API', desc: { ru: 'Библиотека, нужна почти всем модам на Fabric', en: 'Library required by almost every Fabric mod' }, checked: true },
    { slug: 'sodium',     label: 'Sodium',     desc: { ru: 'Оптимизация рендеринга без потери качества картинки', en: 'Rendering optimization without sacrificing visual quality' }, checked: true },
  ],
  forge: [
    { slug: 'cloth-config', label: 'Cloth Config API', desc: { ru: 'Библиотека настроек, нужна многим модам на Forge', en: 'Config library required by many Forge mods' }, checked: true },
  ],
  neoforge: [],
  quilt: [
    { slug: 'qsl', label: 'Quilt Standard Libraries', desc: { ru: 'Библиотека, нужна многим модам на Quilt', en: 'Library required by many Quilt mods' }, checked: true },
  ],
};
let modpackLoader = 'fabric';
let modpackVersion = VERSIONS[0];

function resetModpackModal() {
  modpackNameInput.value = '';
  modpackLoader = 'fabric';
  modpackVersion = VERSIONS[0];
  modpackVersionLabel.textContent = modpackVersion;
  hideError(modpackError);
  modpackProgress.style.display = 'none';
  modpackSubmit.disabled = false;

  modpackLoaderTabsEl.querySelectorAll('.loader-tab').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.loader === modpackLoader);
  });

  renderModpackDefaultMods();
  renderModpackVersionList('');
}

function renderModpackDefaultMods() {
  modpackDefaultModsEl.innerHTML = '';
  (DEFAULT_MODS_BY_LOADER[modpackLoader] || []).forEach(mod => {
    const row = document.createElement('label');
    row.className = 'modpack-mod-check';
    row.innerHTML = `
      <input type="checkbox" data-slug="${mod.slug}" ${mod.checked ? 'checked' : ''}>
      <div>
        <div>${mod.label}</div>
        <div class="mod-check-desc">${mod.desc[currentLang] || mod.desc.ru}</div>
      </div>
    `;
    modpackDefaultModsEl.appendChild(row);
  });
}

function renderModpackVersionList(filter) {
  const query = (filter || '').trim().toLowerCase();
  const loaderMin = MOD_LOADERS_ONLY.find(l => l.id === modpackLoader).min;
  const filtered = VERSIONS.filter(v => cmpV(v, loaderMin) >= 0 && (!query || v.toLowerCase().includes(query)));

  modpackVersionList.innerHTML = '';
  filtered.forEach(v => {
    const item = document.createElement('button');
    item.className = 'version-item' + (v === modpackVersion ? ' is-selected' : '');
    item.textContent = v;
    item.addEventListener('click', () => {
      modpackVersion = v;
      modpackVersionLabel.textContent = v;
      modpackVersionDropdown.classList.remove('is-open');
    });
    modpackVersionList.appendChild(item);
  });
}

function openModpackModal() {
  resetModpackModal();
  modpackOverlay.classList.add('is-open');
}
function closeModpackModal() {
  modpackOverlay.classList.remove('is-open');
}

modpackModalClose?.addEventListener('click', closeModpackModal);
modpackOverlay?.addEventListener('click', (e) => { if (e.target === modpackOverlay) closeModpackModal(); });

modpackVersionBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  modpackVersionDropdown.classList.toggle('is-open');
});
modpackVersionSearch?.addEventListener('input', () => renderModpackVersionList(modpackVersionSearch.value));
modpackVersionDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => modpackVersionDropdown?.classList.remove('is-open'));

modpackLoaderTabsEl?.querySelectorAll('.loader-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    modpackLoader = tab.dataset.loader;
    modpackLoaderTabsEl.querySelectorAll('.loader-tab').forEach(t2 => t2.classList.toggle('is-active', t2 === tab));
    renderModpackDefaultMods();
    renderModpackVersionList(modpackVersionSearch.value);
  });
});

// Раздел "Добавить ещё моды" (поиск + добавление произвольных модов прямо в
// модалке создания модпака) убран по просьбе — модпак теперь собирается
// только из рекомендуемых модов по умолчанию, а расширять список модов можно
// уже после создания через вкладку "Моды" -> "Мои моды" в папке модпака.

window.__modpackProgress = function (data) {
  modpackProgress.style.display = 'block';
  modpackProgressFill.style.width = Math.round((data.progress || 0) * 100) + '%';
  modpackProgressLabel.textContent = data.detail || '';
  reportCatalogInstallProgress(data);
  const importStatusEl = document.getElementById('importInstanceStatus');
  if (importStatusEl && importStatusEl.textContent) {
    importStatusEl.textContent = data.detail || t('instances.importing');
  }
};

window.__modpackDone = function (data) {
  modpackSubmit.disabled = false;
  modpackSubmit.textContent = t('mods.createBtn');

  if (!data.success) {
    showError(modpackError, translateBackendError(data.error) || t('auth.magma.genericError'));
    return;
  }

  saveModpack(window.__pendingModpackMeta);
  window.__pendingModpackMeta = null;
  closeModpackModal();
  renderInstances();
};

modpackSubmit?.addEventListener('click', async () => {
  hideError(modpackError);

  const name = modpackNameInput.value.trim();
  if (!name) { showError(modpackError, t('mods.nameRequired')); return; }
  if (getModpacks().some(m => m.name === name)) { showError(modpackError, t('mods.nameTaken')); return; }

  const allMods = [...modpackDefaultModsEl.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => ({ slug: cb.dataset.slug, enabled: true }));

  if (typeof window.createModpack !== 'function') {
    console.log('[MagmaLauncher] (dev-режим, бэкенд не подключен) createModpack недоступен');
    showError(modpackError, t('mods.devOnlyExe'));
    return;
  }

  window.__pendingModpackMeta = {
    name, mcVersion: modpackVersion, loader: modpackLoader,
    mods: allMods.map(m => m.slug),
  };

  modpackSubmit.disabled = true;
  modpackSubmit.textContent = t('mods.creating');
  modpackProgress.style.display = 'block';
  modpackProgressFill.style.width = '0%';
  modpackProgressLabel.textContent = t('launch.starting');

  try {
    const raw = await window.createModpack({
      name, version: modpackVersion, loader: modpackLoader,
      mods: allMods, gameDir: getGameDir(),
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.started) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка создания модпака:', err);
    modpackSubmit.disabled = false;
    modpackSubmit.textContent = t('mods.createBtn');
    showError(modpackError, String(err.message || err));
  }
});

// ============================================
// Настройки — плавный слайдер ОЗУ
// ============================================
const ramSlider = document.getElementById('ramSlider');
const ramValue = document.getElementById('ramValue');
const javaPathInputEl = document.getElementById('javaPathInput');
const javaPathResetBtn = document.getElementById('javaPathResetBtn');
const gameDirInputEl = document.getElementById('gameDirInput');
const gameDirResetBtn = document.getElementById('gameDirResetBtn');
const jvmArgsInputEl = document.getElementById('jvmArgsInput');
const jvmModeOptionsEl = document.getElementById('jvmModeOptions');
const jvmAdvancedToggleEl = document.getElementById('jvmAdvancedToggle');
const jvmAdvancedPanelEl = document.getElementById('jvmAdvancedPanel');
const fullscreenToggleEl = document.getElementById('fullscreenToggle');
const resolutionRowEl = document.getElementById('resolutionRow');
const resolutionSelectWrap = document.getElementById('resolutionSelectWrap');
const resolutionSelectBtn = document.getElementById('resolutionSelectBtn');
const resolutionSelectLabel = document.getElementById('resolutionSelectLabel');
const resolutionSelectList = document.getElementById('resolutionSelectList');
const resolutionCustomRowEl = document.getElementById('resolutionCustomRow');
const resolutionWidthInputEl = document.getElementById('resolutionWidthInput');
const resolutionHeightInputEl = document.getElementById('resolutionHeightInput');

function parentDirOf(p) {
  if (!p) return '';
  const clean = p.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return idx > 0 ? clean.substring(0, idx) : clean;
}

[javaPathInputEl, gameDirInputEl].forEach(el => {
  el?.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
});

function updateRamValue() {
  if (!ramSlider) return;
  const min = Number(ramSlider.min), max = Number(ramSlider.max), val = Number(ramSlider.value);
  const percent = ((val - min) / (max - min)) * 100;
  ramSlider.style.setProperty('--fill', percent + '%');
  ramValue.textContent = `${val} ${t('ram.unit')}`;
}

// ============================================
// Полноэкранный режим / разрешение окна.
// ============================================
let resolutionMode = 'default';
const RESOLUTION_LABEL_KEYS = { default: 'settings.resolution.default', custom: 'settings.resolution.custom' };

function syncResolutionSelectLabel() {
  if (!resolutionSelectLabel) return;
  resolutionSelectLabel.textContent = RESOLUTION_LABEL_KEYS[resolutionMode] ? t(RESOLUTION_LABEL_KEYS[resolutionMode]) : resolutionMode;
  resolutionSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
    item.classList.toggle('is-selected', item.dataset.value === resolutionMode);
  });
}

function setResolutionMode(mode) {
  resolutionMode = mode;
  syncResolutionSelectLabel();
  updateResolutionCustomVisibility();
  saveLauncherSettings();
}

resolutionSelectBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = !resolutionSelectWrap?.classList.contains('is-open');
  resolutionSelectWrap?.classList.toggle('is-open');
  if (willOpen) positionDropdownNear(resolutionSelectBtn, resolutionSelectList);
});
resolutionSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
  item.addEventListener('click', () => {
    setResolutionMode(item.dataset.value);
    resolutionSelectWrap?.classList.remove('is-open');
  });
});
document.addEventListener('click', () => resolutionSelectWrap?.classList.remove('is-open'));

function updateResolutionCustomVisibility() {
  const isCustom = resolutionMode === 'custom';
  if (resolutionCustomRowEl) resolutionCustomRowEl.style.display = isCustom ? 'flex' : 'none';
}

function updateFullscreenDependentUI() {
  const fullscreenOn = !!(fullscreenToggleEl && fullscreenToggleEl.checked);
  if (resolutionRowEl) resolutionRowEl.style.opacity = fullscreenOn ? '0.5' : '1';
  if (resolutionSelectBtn) resolutionSelectBtn.disabled = fullscreenOn;
  if (resolutionWidthInputEl) resolutionWidthInputEl.disabled = fullscreenOn;
  if (resolutionHeightInputEl) resolutionHeightInputEl.disabled = fullscreenOn;
}

// Возвращает {width, height} для передачи в launchGame — оба 0, если
// выбрано "По умолчанию" (значит --width/--height вообще не передаются).
function getLaunchResolution() {
  if (resolutionMode === 'default') return { width: 0, height: 0 };
  if (resolutionMode === 'custom') {
    const w = Number(resolutionWidthInputEl ? resolutionWidthInputEl.value : 0) || 0;
    const h = Number(resolutionHeightInputEl ? resolutionHeightInputEl.value : 0) || 0;
    return { width: w, height: h };
  }
  const parts = resolutionMode.split('x').map(Number);
  return { width: parts[0] || 0, height: parts[1] || 0 };
}

fullscreenToggleEl?.addEventListener('change', () => { updateFullscreenDependentUI(); saveLauncherSettings(); });
resolutionWidthInputEl?.addEventListener('change', saveLauncherSettings);
resolutionHeightInputEl?.addEventListener('change', saveLauncherSettings);

// ============================================
// Аргументы JVM — упрощённый переключатель (Стандартные / G1GC) вместо
// голого текстового поля. "Свои флаги" остаются доступны за раскрывашкой
// для тех, кому реально нужен произвольный набор параметров.
// ============================================
function syncJvmModeButtons() {
  if (!jvmModeOptionsEl) return;
  const current = (jvmArgsInputEl?.value || '').trim();
  const mode = current === JVM_PRESET_G1GC ? 'g1gc' : (current === '' ? 'default' : 'custom');
  jvmModeOptionsEl.querySelectorAll('.skin-system-option').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.jvmMode === mode);
  });
  if (mode === 'custom' && jvmAdvancedPanelEl) jvmAdvancedPanelEl.style.display = 'block';
  jvmAdvancedToggleEl?.classList.toggle('is-active', mode === 'custom');
}

jvmModeOptionsEl?.querySelectorAll('.skin-system-option').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!jvmArgsInputEl) return;
    jvmArgsInputEl.value = btn.dataset.jvmMode === 'g1gc' ? JVM_PRESET_G1GC : '';
    syncJvmModeButtons();
    saveLauncherSettings();
  });
});

jvmAdvancedToggleEl?.addEventListener('click', () => {
  if (!jvmAdvancedPanelEl) return;
  const willShow = jvmAdvancedPanelEl.style.display === 'none';
  jvmAdvancedPanelEl.style.display = willShow ? 'block' : 'none';
  jvmAdvancedToggleEl.classList.toggle('is-active', willShow);
});

// ============================================
// Аргументы JVM — свободный текст + пресеты.
// ============================================
const JVM_PRESET_G1GC =
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 ' +
  '-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 ' +
  '-XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 ' +
  '-XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 ' +
  '-XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 ' +
  '-XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

jvmArgsInputEl?.addEventListener('change', () => { syncJvmModeButtons(); saveLauncherSettings(); });

// ============================================
// Java: автоопределение и нативный выбор файла.
// ============================================
document.getElementById('javaAutoDetectBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (typeof window.autoDetectJava !== 'function') {
    console.log('[MagmaLauncher] (dev-режим) autoDetectJava недоступен');
    return;
  }
  btn.disabled = true;
  try {
    const raw = await window.autoDetectJava();
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (result.success && javaPathInputEl) {
      javaPathInputEl.value = result.path;
      saveLauncherSettings();
    } else {
      console.error('[MagmaLauncher] Java не найдена:', result.error);
    }
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка автоопределения Java:', err);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('javaBrowseBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (typeof window.browseJavaExe !== 'function') {
    console.log('[MagmaLauncher] (dev-режим) browseJavaExe недоступен');
    return;
  }
  btn.disabled = true;
  try {
    const raw = await window.browseJavaExe({ initialDir: parentDirOf(javaPathInputEl ? javaPathInputEl.value : '') });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (result.success && javaPathInputEl) {
      javaPathInputEl.value = result.path;
      saveLauncherSettings();
    }
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка выбора java.exe:', err);
  } finally {
    btn.disabled = false;
  }
});

// ============================================
// Папка игры: режим (MagmaLauncher / .minecraft / своя), обзор, перенос.
// ============================================
const GAME_DIR_MODE_KEY = 'magma_game_dir_mode';
let gameDirMode = localStorage.getItem(GAME_DIR_MODE_KEY) || 'magma';

const gameDirModeSelectWrap = document.getElementById('gameDirModeSelectWrap');
const gameDirModeSelectBtn = document.getElementById('gameDirModeSelectBtn');
const gameDirModeSelectLabel = document.getElementById('gameDirModeSelectLabel');
const gameDirModeSelectList = document.getElementById('gameDirModeSelectList');

const GAME_DIR_MODE_LABEL_KEYS = {
  magma: 'settings.dir.modeMagma',
  vanilla: 'settings.dir.modeVanilla',
  custom: 'settings.dir.modeCustom',
};

function syncGameDirModeLabel() {
  if (gameDirModeSelectLabel) {
    const key = GAME_DIR_MODE_LABEL_KEYS[gameDirMode] || GAME_DIR_MODE_LABEL_KEYS.magma;
    gameDirModeSelectLabel.textContent = t(key);
  }
  gameDirModeSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
    item.classList.toggle('is-selected', item.dataset.value === gameDirMode);
  });
  // В режиме "MagmaLauncher"/".minecraft" путь подставляется автоматически —
  // редактировать поле вручную можно только в режиме "Своя папка", иначе
  // получилось бы, что игрок правит путь, а он тут же перезаписывается при
  // следующем переключении режима.
  if (gameDirInputEl) gameDirInputEl.readOnly = gameDirMode !== 'custom';
}

gameDirModeSelectBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  gameDirModeSelectWrap?.classList.toggle('is-open');
});
gameDirModeSelectList?.querySelectorAll('.custom-select-item').forEach(item => {
  item.addEventListener('click', () => {
    gameDirMode = item.dataset.value;
    localStorage.setItem(GAME_DIR_MODE_KEY, gameDirMode);
    syncGameDirModeLabel();
    gameDirModeSelectWrap?.classList.remove('is-open');

    if (gameDirMode !== 'custom' && gameDirInputEl) {
      // Заменяем последнюю папку в уже известном пути на MagmaLauncher/.minecraft —
      // родительская папка (обычно %APPDATA%\Roaming) остаётся той же.
      const base = gameDirInputEl.value.replace(/[\\/][^\\/]+[\\/]?$/, '');
      const suffix = gameDirMode === 'magma' ? 'MagmaLauncher' : '.minecraft';
      gameDirInputEl.value = `${base}\\${suffix}`;
      saveLauncherSettings();
    }
  });
});
document.addEventListener('click', () => gameDirModeSelectWrap?.classList.remove('is-open'));

document.getElementById('gameDirBrowseBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (typeof window.browseFolder !== 'function') {
    console.log('[MagmaLauncher] (dev-режим) browseFolder недоступен');
    return;
  }
  btn.disabled = true;
  try {
    const raw = await window.browseFolder({ initialDir: getGameDir() });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (result.success && gameDirInputEl) {
      gameDirMode = 'custom';
      localStorage.setItem(GAME_DIR_MODE_KEY, gameDirMode);
      syncGameDirModeLabel();
      gameDirInputEl.value = sanitizeGameDirPath(result.path);
      saveLauncherSettings();
    }
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка выбора папки:', err);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('gameDirMoveBtn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const statusEl = document.getElementById('gameDirMoveStatus');
  if (typeof window.browseFolder !== 'function' || typeof window.moveGameFolder !== 'function') {
    if (statusEl) statusEl.textContent = t('settings.dir.devOnlyExe');
    return;
  }

  const oldPath = getGameDir();
  btn.disabled = true;
  if (statusEl) statusEl.textContent = '';

  try {
    const rawPick = await window.browseFolder({ initialDir: parentDirOf(oldPath) });
    const pickResult = typeof rawPick === 'string' ? JSON.parse(rawPick) : rawPick;
    if (!pickResult.success) { btn.disabled = false; return; }

    const newPath = sanitizeGameDirPath(pickResult.path) + '\\MagmaLauncher';
    if (statusEl) statusEl.textContent = t('settings.dir.moving');

    const rawMove = await window.moveGameFolder({ oldPath, newPath });
    const moveResult = typeof rawMove === 'string' ? JSON.parse(rawMove) : rawMove;
    if (!moveResult.success) throw new Error(translateBackendError(moveResult.error) || t('auth.magma.genericError'));

    gameDirMode = 'custom';
    localStorage.setItem(GAME_DIR_MODE_KEY, gameDirMode);
    syncGameDirModeLabel();
    if (gameDirInputEl) gameDirInputEl.value = newPath;
    saveLauncherSettings();
    if (statusEl) statusEl.textContent = t('settings.dir.moved');
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось перенести папку игры:', err);
    if (statusEl) statusEl.textContent = String(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

// ============================================
// Настройки (Java-путь, папка игры, ОЗУ, JVM, экран) — сохраняем локально
// на этой машине.
// ============================================
const SETTINGS_KEY = 'magma_launcher_settings';

function saveLauncherSettings() {
  const settings = {
    javaPath: javaPathInputEl ? javaPathInputEl.value : '',
    gameDir: gameDirInputEl ? gameDirInputEl.value : '',
    ramGb: ramSlider ? Number(ramSlider.value) : 4,
    jvmArgs: jvmArgsInputEl ? jvmArgsInputEl.value : '',
    fullscreen: fullscreenToggleEl ? fullscreenToggleEl.checked : false,
    resolution: resolutionMode,
    resolutionWidth: resolutionWidthInputEl ? resolutionWidthInputEl.value : '',
    resolutionHeight: resolutionHeightInputEl ? resolutionHeightInputEl.value : '',
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function restoreLauncherSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const settings = JSON.parse(raw);
      if (settings.javaPath && javaPathInputEl) javaPathInputEl.value = settings.javaPath;
      if (settings.gameDir && gameDirInputEl) gameDirInputEl.value = sanitizeGameDirPath(settings.gameDir);
      if (settings.ramGb && ramSlider) {
        const clamped = Math.min(Number(ramSlider.max), Math.max(Number(ramSlider.min), Number(settings.ramGb)));
        ramSlider.value = clamped;
      }
      if (jvmArgsInputEl) jvmArgsInputEl.value = settings.jvmArgs || '';
      if (fullscreenToggleEl) fullscreenToggleEl.checked = !!settings.fullscreen;
      if (settings.resolution) resolutionMode = settings.resolution;
      if (resolutionWidthInputEl) resolutionWidthInputEl.value = settings.resolutionWidth || '';
      if (resolutionHeightInputEl) resolutionHeightInputEl.value = settings.resolutionHeight || '';
      saveLauncherSettings();
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось восстановить настройки:', err);
  }
  syncGameDirModeLabel();
  syncResolutionSelectLabel();
  updateResolutionCustomVisibility();
  updateFullscreenDependentUI();
  syncJvmModeButtons();
}

ramSlider?.addEventListener('input', () => { updateRamValue(); saveLauncherSettings(); });
javaPathInputEl?.addEventListener('change', saveLauncherSettings);
gameDirInputEl?.addEventListener('change', () => {
  gameDirInputEl.value = sanitizeGameDirPath(gameDirInputEl.value);
  saveLauncherSettings();
});

javaPathResetBtn?.addEventListener('click', () => {
  if (!javaPathInputEl) return;
  javaPathInputEl.value = '';
  saveLauncherSettings();
});

gameDirResetBtn?.addEventListener('click', () => {
  if (!gameDirInputEl) return;
  gameDirMode = 'magma';
  localStorage.setItem(GAME_DIR_MODE_KEY, gameDirMode);
  syncGameDirModeLabel();
  const base = gameDirInputEl.value.replace(/[\\/][^\\/]+[\\/]?$/, '');
  gameDirInputEl.value = sanitizeGameDirPath(`${base}\\MagmaLauncher`);
  saveLauncherSettings();
});

document.getElementById('gameFolderBtn')?.addEventListener('click', async () => {
  if (typeof window.openGameFolder !== 'function') {
    console.log('[MagmaLauncher] (dev-режим) openGameFolder недоступен');
    return;
  }
  try {
    const dir = sanitizeGameDirPath(gameDirInputEl ? gameDirInputEl.value : '');
    if (gameDirInputEl && dir !== gameDirInputEl.value) { gameDirInputEl.value = dir; saveLauncherSettings(); }
    const raw = await window.openGameFolder({ dir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) console.error('[MagmaLauncher] Не удалось открыть папку игры:', result.error);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось открыть папку игры:', err);
  }
});

versionRefreshBtnEl?.addEventListener('click', async () => {
  if (!selectedVersion) return;
  if (typeof window.resetVersionCache !== 'function') {
    console.log('[MagmaLauncher] (dev-режим) resetVersionCache недоступен');
    return;
  }
  try {
    const dir = getGameDir();
    const raw = await window.resetVersionCache({ version: selectedVersion, gameDir: dir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) {
      console.error('[MagmaLauncher] Не удалось очистить кэш версии:', result.error);
      return;
    }
    playBtn.click();
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось очистить кэш версии:', err);
  }
});

// ============================================
// Модалка авторизации
// ============================================
const authOverlay = document.getElementById('authOverlay');
const accountTrigger = document.getElementById('accountTrigger');
const accountName = document.getElementById('accountName');
const authModalClose = document.getElementById('authModalClose');

let isLoggedIn = false;

// ============================================
// Список локально известных аккаунтов (гости переключаются мгновенно,
// Magma/Microsoft — только показываются в списке и подставляют email в форму
// входа при клике, т.к. пароли нигде не хранятся).
// ============================================
const ACCOUNTS_KEY = 'magma_accounts';
const ACTIVE_ACCOUNT_KEY = 'magma_active_account_id';

function getAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch { return []; }
}
function saveAccounts(list) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch {}
}
function getActiveAccountId() {
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY) || '';
}
function upsertActiveAccount(acc) {
  const list = getAccounts().filter(a => a.id !== acc.id);
  list.unshift(acc);
  saveAccounts(list);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, acc.id);
  renderAccountsListPanel();
  updateSettingsAccountTab();
}
supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (!session) return;
  const activeId = getActiveAccountId();
  if (!activeId || activeId !== session.user.id) return;
  const acc = getAccounts().find(a => a.id === activeId);
  if (!acc || acc.type !== 'magma') return;
  const list = getAccounts().filter(a => a.id !== acc.id);
  list.unshift({ ...acc, accessToken: session.access_token, refreshToken: session.refresh_token });
  saveAccounts(list);
});

let magmaIconIdCounter = 0;
function magmaTypeIconMarkup() {
  const gradId = 'accountTypeMagmaGrad' + (magmaIconIdCounter++);
  return `<svg viewBox="0 0 24 24" class="account-type-icon"><defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a4d"/><stop offset="1" stop-color="#ff3d1c"/></linearGradient></defs><path fill="url(#${gradId})" d="M12 2 4 12l8 10 8-10zM12 6.5 17 12l-5 6-5-6z"/></svg>`;
}

const ACCOUNT_TYPE_ICONS_STATIC = {
  microsoft: '<svg viewBox="0 0 23 23" class="account-type-icon"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>',
  guest: '',
};

function accountTypeIconMarkup(type) {
  if (type === 'magma') return magmaTypeIconMarkup();
  return ACCOUNT_TYPE_ICONS_STATIC[type] || '';
}

function currentAccountType() {
  const acc = getAccounts().find(a => a.id === getActiveAccountId());
  return acc ? acc.type : 'guest';
}

// ============================================
// Головы скинов из аватарки Ely.by — рисуем face(8,8)+hat(40,8) на канвасе,
// с фолбэком на букву ника, если скин не найден (гость / чистый ник).
// ============================================
function elyBySkinUrl(nickname, cacheBust = false) {
  const nick = encodeURIComponent((nickname || '').trim());
  const base = `https://skinsystem.ely.by/skins/${nick}.png`;
  return cacheBust ? `${base}?version=2&t=${Date.now()}` : `${base}?version=2`;
}

function elyByHeadUrl(nickname) {
  return elyBySkinUrl(nickname, false);
}

// Официальная текстура Стива от Mojang — подставляется, если у ely.by нет
// скина для ника (гость, или аккаунт, который скин ни разу не менял).
const DEFAULT_STEVE_SKIN_URL = '../assets/steve.png';

function drawSkinHead(canvas, img) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = img.width / 64;
  ctx.drawImage(img, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 40 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, canvas.width, canvas.height);
}

function drawSkinHeadFallback(canvas, nickname) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#2a2a30';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ff9a4d';
  ctx.font = `bold ${Math.round(canvas.width * 0.5)}px Sora, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((nickname || '?').charAt(0).toUpperCase(), canvas.width / 2, canvas.height / 2 + 1);
}

// Ключ — сам canvas: у каждого своя "версия" запроса. Если пока грузился
// старый запрос (например, дефолтный "Steve" при старте) успел прийти новый
// (реальный ник после входа), результат старого запроса просто отбрасывается,
// вместо того чтобы затереть уже нарисованный правильный скин.
const skinHeadRequestIds = new WeakMap();

async function loadSkinHeadInto(canvas, nickname, attempt = 0) {
  if (!canvas || !nickname) return;

  if (attempt === 0) {
    skinHeadRequestIds.set(canvas, (skinHeadRequestIds.get(canvas) || 0) + 1);
  }
  const myId = skinHeadRequestIds.get(canvas);
  const isCurrent = () => skinHeadRequestIds.get(canvas) === myId;

  const drawFromUrl = (url) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { if (isCurrent()) drawSkinHead(canvas, img); resolve(true); };
    img.onerror = () => resolve(false);
    img.src = url;
  });

  if (typeof window.fetchSkinBytes === 'function') {
    try {
      const raw = await window.fetchSkinBytes({ url: elyBySkinUrl(nickname, attempt > 0) });
      if (!isCurrent()) return;
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result.success) {
        const bytes = base64ToUint8Array(result.dataBase64);
        const blob = new Blob([bytes], { type: 'image/png' });
        const blobUrl = URL.createObjectURL(blob);
        const ok = await drawFromUrl(blobUrl);
        URL.revokeObjectURL(blobUrl);
        if (ok) return;
      }
    } catch (err) {
      // сеть/бэкенд недоступны — падаем на запасной путь ниже
    }
  }

  if (!isCurrent()) return;
  const direct = await drawFromUrl(elyByHeadUrl(nickname));
  if (direct) return;
  if (!isCurrent()) return;
  if (attempt < 1 && typeof window.fetchSkinBytes === 'function') {
    setTimeout(() => loadSkinHeadInto(canvas, nickname, attempt + 1), 300);
    return;
  }
  const fallback = await drawFromUrl(DEFAULT_STEVE_SKIN_URL);
  if (!fallback && isCurrent()) drawSkinHeadFallback(canvas, nickname);
}

function renderAccountAvatar() {
  const canvas = document.getElementById('accountAvatarCanvas');
  const nick = (accountName && accountName.textContent) || '';
  loadSkinHeadInto(canvas, nick);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Дефолтный Стив кэшируется одним Blob URL на всё время жизни страницы —
// пересоздавать его на каждый запрос смысла нет, файл один и тот же.
let cachedDefaultSteveBlobUrl = null;
async function defaultSteveSkinBlobUrl() {
  if (cachedDefaultSteveBlobUrl) return cachedDefaultSteveBlobUrl;

  if (typeof window.fetchLocalAsset === 'function') {
    try {
      const raw = await window.fetchLocalAsset({ path: 'steve.png' });
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result.success) {
        const bytes = base64ToUint8Array(result.dataBase64);
        const blob = new Blob([bytes], { type: 'image/png' });
        cachedDefaultSteveBlobUrl = URL.createObjectURL(blob);
        return cachedDefaultSteveBlobUrl;
      }
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось загрузить дефолтный скин Стива через бэкенд:', err);
    }
  }

  try {
    const resp = await fetch(DEFAULT_STEVE_SKIN_URL);
    const blob = await resp.blob();
    cachedDefaultSteveBlobUrl = URL.createObjectURL(blob);
    return cachedDefaultSteveBlobUrl;
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось загрузить дефолтный скин Стива:', err);
    return DEFAULT_STEVE_SKIN_URL;
  }
}

async function loadSkinBlobUrl(nickname) {
  if (typeof window.fetchSkinBytes !== 'function') return elyByHeadUrl(nickname);
  try {
    const raw = await window.fetchSkinBytes({ url: elyBySkinUrl(nickname, true) });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // ВАЖНО: раньше тут возвращался сырой путь DEFAULT_STEVE_SKIN_URL
    // напрямую — для обычного 2D-канваса (иконка в шапке) это ещё худо-бедно
    // работало, но WebGL (3D-вьюер скина) отдельно проверяет "чистоту"
    // источника текстуры и молча отказывался её загружать с file://.
    // Прогоняем через тот же Blob-путь, что и настоящий скин с ely.by —
    // Blob URL для WebGL всегда "чистый", независимо от происхождения байт.
    if (!result.success) return await defaultSteveSkinBlobUrl();
    const bytes = base64ToUint8Array(result.dataBase64);
    const blob = new Blob([bytes], { type: 'image/png' });
    return URL.createObjectURL(blob);
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось загрузить байты скина:', err);
    return await defaultSteveSkinBlobUrl();
  }
}

let accountSkinViewer = null;
let accountSkinViewerBlobUrl = null;
let accountSkinViewerRequestId = 0;
let accountSkinViewerContextLossBound = false;

function waitForNonZeroCanvasSize(canvas, maxFrames) {
  return new Promise((resolve) => {
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) { resolve(true); return; }
    let settled = false;
    const observer = new ResizeObserver(() => {
      if (!settled && canvas.clientWidth > 0 && canvas.clientHeight > 0) finish(true);
    });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(ok);
    };
    observer.observe(canvas);
    let frame = 0;
    const poll = () => {
      if (settled) return;
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) { finish(true); return; }
      frame++;
      if (frame >= maxFrames) { finish(false); return; }
      requestAnimationFrame(poll);
    };
    poll();
  });
}

function bindAccountSkinViewerContextLossRecovery(canvas) {
  if (accountSkinViewerContextLossBound) return;
  accountSkinViewerContextLossBound = true;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    accountSkinViewer = null;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    const nick = (accountName && accountName.textContent) || '';
    if (nick) refreshAccountSkinViewer(nick);
  });
}

async function ensureAccountSkinViewer(forceRecreate) {
  const canvas = document.getElementById('accountSkinViewerCanvas');
  if (!canvas || typeof skinview3d === 'undefined') return null;

  if (accountSkinViewer && !forceRecreate) return accountSkinViewer;

  if (accountSkinViewer) {
    try { accountSkinViewer.dispose(); } catch (err) {}
    accountSkinViewer = null;
  }

  await waitForNonZeroCanvasSize(canvas, 40);
  bindAccountSkinViewerContextLossRecovery(canvas);

    try {
    accountSkinViewer = new skinview3d.SkinViewer({
      canvas,
      width: 240,
      height: 320,
      zoom: 0.8,
    });
    // Если канвас в момент инициализации всё ещё был скрыт (display:none
    // родителя), WebGL-контекст мог создаться "пустым" — пересоздаём вьюер
    // ещё раз, уже точно после того, как вкладка стала видимой.
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      try { accountSkinViewer.dispose(); } catch (err) {}
      await waitForNonZeroCanvasSize(canvas, 40);
      accountSkinViewer = new skinview3d.SkinViewer({ canvas, width: 240, height: 320, zoom: 0.8 });
    }
    accountSkinViewer.controls.enableZoom = false;
    accountSkinViewer.animation = new skinview3d.IdleAnimation();
    if (document.hasFocus && !document.hasFocus() && getPauseSkinUnfocusedPref()) {
      accountSkinViewer.renderPaused = true;
    }
  } catch (err) {
    console.error('[MagmaLauncher] Не удалось создать 3D-вьюер скина:', err);
    accountSkinViewer = null;
  }
  return accountSkinViewer;
}

async function refreshAccountSkinViewer(nickname) {
  if (!nickname) return;
  if (!isSkinViewerCanvasVisible()) return;
  const hintEl = document.querySelector('.account-skin-viewer-hint');

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (!isSkinViewerCanvasVisible()) return;

  if (typeof skinview3d === 'undefined') {
    if (hintEl) hintEl.textContent = t('settings.account.viewerLoadError');
    return;
  }

  let viewer = await ensureAccountSkinViewer(true);
  if (!viewer) {
    if (hintEl) hintEl.textContent = t('settings.account.viewerLoadError');
    return;
  }

  const myRequestId = ++accountSkinViewerRequestId;
  const blobUrl = await loadSkinBlobUrl(nickname);
  if (myRequestId !== accountSkinViewerRequestId) return;

  const tryLoad = async (attempt) => {
    try {
      await viewer.loadSkin(blobUrl);
      if (hintEl) hintEl.textContent = t('settings.account.rotateHint');
    } catch (err) {
      console.error('[MagmaLauncher] Не удалось загрузить модель скина:', err);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        if (myRequestId !== accountSkinViewerRequestId) return;
        return tryLoad(attempt + 1);
      }
      if (myRequestId === accountSkinViewerRequestId) {
        viewer = await ensureAccountSkinViewer(true);
        if (viewer) {
          try {
            await viewer.loadSkin(blobUrl);
            if (hintEl) hintEl.textContent = t('settings.account.rotateHint');
            return;
          } catch (err2) {
            console.error('[MagmaLauncher] Не удалось загрузить модель скина после пересоздания вьюера:', err2);
          }
        }
      }
      if (hintEl) hintEl.textContent = t('settings.account.viewerLoadError');
    }
  };
  await tryLoad(0);

  if (accountSkinViewerBlobUrl && accountSkinViewerBlobUrl.startsWith('blob:')) {
    URL.revokeObjectURL(accountSkinViewerBlobUrl);
  }
  accountSkinViewerBlobUrl = blobUrl.startsWith('blob:') ? blobUrl : null;
}

function isSkinViewerCanvasVisible() {
  const canvas = document.getElementById('accountSkinViewerCanvas');
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function updateSettingsAccountTab() {
  const nameEl = document.getElementById('settingsAccountName');
  const iconEl = document.getElementById('settingsAccountTypeIcon');
  const nick = (accountName && accountName.textContent) || '';
  if (nameEl) nameEl.textContent = nick;
  if (iconEl) iconEl.innerHTML = accountTypeIconMarkup(currentAccountType());

  const changePasswordBlock = document.getElementById('accountChangePasswordBlock');
  if (changePasswordBlock) changePasswordBlock.style.display = currentAccountType() === 'magma' ? '' : 'none';

  if (isSkinViewerCanvasVisible()) refreshAccountSkinViewer(nick);
}

function finishLogin(nick, isMicrosoftLogin) {
  if (!isMicrosoftLogin) window.msAuthState = null;
  accountName.textContent = nick;
  isLoggedIn = true;
  closeAuthModal();
  renderAccountAvatar();
  renderAccountsListPanel();
  updateSettingsAccountTab();
}

function openAuthModal() {
  authOverlay.classList.add('is-open');
}
function closeAuthModal() {
  authOverlay.classList.remove('is-open');
}

function updateModalCloseVisibility() {
  if (authModalClose) authModalClose.style.display = isLoggedIn ? 'flex' : 'none';
}

function resetAuthModalForms() {
  const guestNick = document.getElementById('guestNickname');
  if (guestNick) guestNick.value = '';
  hideError(guestError);

  const loginEmail = document.getElementById('magmaLoginEmail');
  const loginPassword = document.getElementById('magmaLoginPassword');
  if (loginEmail) loginEmail.value = '';
  if (loginPassword) loginPassword.value = '';
  hideError(magmaLoginError);
  hideError(magmaRegisterError);

  const googleNick = document.getElementById('magmaGoogleNick');
  if (googleNick) googleNick.value = '';
  hideError(magmaGoogleSetupError);
  profileRepairUserId = null;

  showMagmaStep('login');

  authTabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.tab === 'guest'));
  authPanes.forEach(p => p.classList.toggle('is-active', p.dataset.pane === 'guest'));
}

const accountListDropdown = document.getElementById('accountListDropdown');
const accountListItems = document.getElementById('accountListItems');
const accountListAddBtn = document.getElementById('accountListAddBtn');

function renderAccountsListInto(containerEl, showGear) {
  if (!containerEl) return;
  const activeId = getActiveAccountId();
  const accounts = getAccounts();
  containerEl.innerHTML = '';

  accounts.forEach(acc => {
    const isActive = acc.id === activeId;
    const row = document.createElement('div');
    row.className = 'account-list-item' + (isActive ? ' is-active' : '');
    row.innerHTML = `
      <span class="account-list-avatar"><canvas width="26" height="26"></canvas></span>
      <span class="account-list-name">${acc.nickname}</span>
      ${accountTypeIconMarkup(acc.type)}
      ${isActive && showGear ? `<button type="button" class="account-list-gear"><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>` : ''}
    `;

    loadSkinHeadInto(row.querySelector('canvas'), acc.nickname);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.account-list-gear')) {
        closeAccountListDropdown();
        openSettingsAccountTab();
        return;
      }
      if (isActive) return;
      closeAccountListDropdown();
      switchToAccount(acc);
    });

    containerEl.appendChild(row);
  });

  if (accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mod-list-hint';
    empty.textContent = t('account.noAccounts');
    containerEl.appendChild(empty);
  }
}

function renderAccountsListPanel() {
  renderAccountsListInto(accountListItems, true);
  renderAccountsListInto(document.getElementById('settingsAccountsList'), false);
}

async function switchToAccount(acc) {
  closeAccountListDropdown();
  if (acc.type === 'guest') {
    saveGuestSession(acc.nickname);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, acc.id);
    finishLogin(acc.nickname);
    return;
  }

  // ВАЖНО: раньше переключение на уже добавленный Magma-аккаунт делало
  // await supabaseClient.auth.setSession(...) и ТОЛЬКО ПОСЛЕ ответа сети
  // (иногда 20-30 секунд, а на второй раз — вообще с ошибкой из-за ротации
  // refresh_token у Supabase) показывало результат. Никнейм аккаунта у нас
  // и так уже надёжно закеширован локально (acc.nickname) — для самого
  // переключения в лаунчере (кому показываем ник, каким скином играем)
  // реальный поход в сеть не нужен вообще. Поэтому переключаемся мгновенно
  // по кешу, а сессию Supabase (нужна только для повторного успешного
  // access/refresh на будущее) тихо освежаем в фоне, не блокируя интерфейс
  // и никогда не показывая форму входа/регистрации при переключении между
  // уже известными аккаунтами.
  if (acc.type === 'magma') {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, acc.id);
    finishLogin(acc.nickname);

    if (acc.accessToken && acc.refreshToken) {
      supabaseClient.auth.setSession({
        access_token: acc.accessToken,
        refresh_token: acc.refreshToken,
      }).then(({ data, error }) => {
        if (!error && data.session) {
          upsertActiveAccount({
            ...acc,
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
          });
        }
      }).catch((err) => {
        console.error('[MagmaLauncher] Не удалось обновить сессию аккаунта в фоне:', err);
      });
    }
    return;
  }

  // Совсем новый Magma-аккаунт без сохранённых токенов (такое в списке
  // "Аккаунты" в норме не встречается, но на всякий случай) — просим пароль.
  resetAuthModalForms();
  authTabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.tab === 'magma'));
  authPanes.forEach(p => p.classList.toggle('is-active', p.dataset.pane === 'magma'));
  showMagmaStep('login');
  const loginEmailEl = document.getElementById('magmaLoginEmail');
  if (loginEmailEl) loginEmailEl.value = acc.identifier || acc.nickname;
  updateModalCloseVisibility();
  openAuthModal();
}

function openAccountListDropdown() {
  renderAccountsListPanel();
  accountListDropdown?.classList.add('is-open');
}
function closeAccountListDropdown() {
  accountListDropdown?.classList.remove('is-open');
}

function openSettingsAccountTab() {
  railButtons.forEach(b => b.classList.toggle('is-active', b.dataset.view === 'settings'));
  views.forEach(v => v.classList.toggle('is-active', v.dataset.view === 'settings'));
  currentActiveView = 'settings';
  updateGameFolderBtnVisibility();
  switchSettingsSubtab('account');
  restoreViewScroll('settings');
}

accountTrigger?.addEventListener('click', (e) => {
  e.stopPropagation();
  updateSettingsAccountTab();
  if (accountListDropdown?.classList.contains('is-open')) { closeAccountListDropdown(); return; }
  openAccountListDropdown();
});

accountListAddBtn?.addEventListener('click', () => {
  closeAccountListDropdown();
  resetAuthModalForms();
  updateModalCloseVisibility();
  openAuthModal();
});

document.getElementById('settingsAddAccountBtn')?.addEventListener('click', () => {
  resetAuthModalForms();
  updateModalCloseVisibility();
  openAuthModal();
});

accountListDropdown?.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeAccountListDropdown);

async function tryRestoreActiveAccount() {
  const activeId = getActiveAccountId();
  if (!activeId) return false;
  const acc = getAccounts().find(a => a.id === activeId);
  if (!acc) return false;

  if (acc.type === 'guest') {
    if (!acc.nickname || !isValidMinecraftNick(acc.nickname)) return false;
    saveGuestSession(acc.nickname);
    finishLogin(acc.nickname);
    updateModalCloseVisibility();
    return true;
  }

  if (acc.type === 'magma') {
    // Раньше это было "всё или ничего" — если поход в сеть за сессией не
    // успевал мгновенно, функция целиком возвращала false, и человек видел
    // окно входа заново, хотя ник и сам факт входа у нас и так надёжно
    // закешированы локально. Теперь, как и при переключении между уже
    // известными аккаунтами (см. switchToAccount), логиним сразу по кешу,
    // а сессию Supabase освежаем в фоне — разовый сбой сети больше никогда
    // не выглядит как "нужно войти заново".
    if (!acc.nickname) return false;

    finishLogin(acc.nickname);
    updateModalCloseVisibility();

    (async () => {
      try {
        let session = null;
        const { data: existing } = await supabaseClient.auth.getSession();
        if (existing && existing.session && existing.session.user.id === acc.id) {
          session = existing.session;
        } else if (acc.accessToken && acc.refreshToken) {
          const { data, error } = await supabaseClient.auth.setSession({
            access_token: acc.accessToken,
            refresh_token: acc.refreshToken,
          });
          if (!error && data.session) session = data.session;
        }
        if (!session) return;

        const refreshedAcc = { ...acc, accessToken: session.access_token, refreshToken: session.refresh_token };
        upsertActiveAccount(refreshedAcc);

        const { profile, missing } = await fetchProfileWithRetry(session.user.id);
        if (missing || !profile) return;

        if (profile.nick !== acc.nickname) {
          upsertActiveAccount({ ...refreshedAcc, nickname: profile.nick });
          accountName.textContent = profile.nick;
          renderAccountAvatar();
        }
      } catch (err) {
        console.error('[MagmaLauncher] Не удалось освежить сессию аккаунта в фоне:', err);
      }
    })();

    return true;
  }

  return false;
}

const GUEST_SESSION_KEY = 'magma_guest_session';

function saveGuestSession(nickname) {
  localStorage.setItem(GUEST_SESSION_KEY, JSON.stringify({ nickname }));
}

function tryRestoreGuestSession() {
  try {
    const raw = localStorage.getItem(GUEST_SESSION_KEY);
    if (!raw) return false;
    const { nickname } = JSON.parse(raw);
   if (!nickname || !isValidMinecraftNick(nickname)) return false;
    upsertActiveAccount({ id: 'guest:' + nickname.toLowerCase(), type: 'guest', nickname, identifier: '' });
    finishLogin(nickname);
    updateModalCloseVisibility();
    return true;
  } catch {
    return false;
  }
}

authModalClose?.addEventListener('click', () => {
  if (isLoggedIn) closeAuthModal();
});

authOverlay?.addEventListener('click', (e) => {
  if (e.target === authOverlay && isLoggedIn) closeAuthModal();
});

function showError(el, message) {
  el.style.color = '';
  el.textContent = message;
  el.classList.add('is-visible');
}
function hideError(el) {
  el.textContent = '';
  el.classList.remove('is-visible');
}

function setButtonLoading(button, loadingText) {
  const label = button.querySelector('span') || button;
  button.dataset.originalText = label.textContent;
  label.textContent = loadingText;
  button.disabled = true;
  button.classList.add('is-loading');
}
function restoreButton(button) {
  const label = button.querySelector('span') || button;
  if (button.dataset.originalText) label.textContent = button.dataset.originalText;
  button.disabled = false;
  button.classList.remove('is-loading');
}

// --- Глазок показать/скрыть пароль ---
document.querySelectorAll('.auth-eye-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;

    const openIcon = btn.querySelector('.eye-open');
    const closedIcon = btn.querySelector('.eye-closed');
    const isCurrentlyHidden = input.type === 'password';

    input.type = isCurrentlyHidden ? 'text' : 'password';
    openIcon.style.display = isCurrentlyHidden ? 'none' : 'block';
    closedIcon.style.display = isCurrentlyHidden ? 'block' : 'none';
  });
});

// --- Переключение вкладок Гость / Magma / Microsoft ---
const authTabs = document.querySelectorAll('.auth-tab');
const authPanes = document.querySelectorAll('.auth-pane');

authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    authTabs.forEach(tb => tb.classList.remove('is-active'));
    tab.classList.add('is-active');

    const target = tab.dataset.tab;
    authPanes.forEach(p => p.classList.toggle('is-active', p.dataset.pane === target));
  });
});

// --- Гость: вход по никнейму ---
const guestError = document.getElementById('guestError');

document.getElementById('guestSubmit')?.addEventListener('click', () => {
  const nickname = document.getElementById('guestNickname').value.trim();
  hideError(guestError);

  if (!nickname) {
    showError(guestError, t('auth.magma.fillAll'));
    return;
  }
  if (!isValidMinecraftNick(nickname)) {
    showError(guestError, t('auth.magma.invalidNick'));
    return;
  }

  saveGuestSession(nickname);
  upsertActiveAccount({ id: 'guest:' + nickname.toLowerCase(), type: 'guest', nickname, identifier: '' });
  finishLogin(nickname);
});

// ============================================
// Валидация ввода
// ============================================
function isValidMinecraftNick(nick) {
  return /^[A-Za-z0-9_]{3,16}$/.test(nick);
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function isValidPassword(password) {
  return password.length >= 6;
}

const magmaLoginForm = document.getElementById('magmaLoginForm');
const magmaRegisterForm = document.getElementById('magmaRegisterForm');
const magmaGoogleSetupForm = document.getElementById('magmaGoogleSetupForm');

const magmaLoginError = document.getElementById('magmaLoginError');
const magmaRegisterError = document.getElementById('magmaRegisterError');
const magmaGoogleSetupError = document.getElementById('magmaGoogleSetupError');
const magmaGoogleSetupDesc = document.getElementById('magmaGoogleSetupDesc');

function showMagmaStep(step) {
  magmaLoginForm.style.display = step === 'login' ? 'flex' : 'none';
  magmaRegisterForm.style.display = step === 'register' ? 'flex' : 'none';
  magmaGoogleSetupForm.style.display = step === 'google-setup' ? 'flex' : 'none';
}

document.getElementById('showMagmaRegister')?.addEventListener('click', (e) => {
  e.preventDefault();
  hideError(magmaLoginError);
  showMagmaStep('register');
});

document.getElementById('showMagmaLogin')?.addEventListener('click', (e) => {
  e.preventDefault();
  hideError(magmaRegisterError);
  showMagmaStep('login');
});

document.getElementById('magmaRegisterBack')?.addEventListener('click', () => {
  hideError(magmaRegisterError);
  showMagmaStep('login');
});

document.getElementById('magmaGoogleSetupBack')?.addEventListener('click', () => {
  hideError(magmaGoogleSetupError);
  profileRepairUserId = null;
  showMagmaStep('login');
});

// --- Вход в существующий Magma-аккаунт ---
document.getElementById('magmaLoginSubmit')?.addEventListener('click', async (e) => {
  const identifier = document.getElementById('magmaLoginEmail').value.trim();
  const password = document.getElementById('magmaLoginPassword').value;
  hideError(magmaLoginError);

  if (!identifier || !password) {
    showError(magmaLoginError, t('auth.magma.fillAll'));
    return;
  }

  const isEmailInput = identifier.includes('@');
  if (isEmailInput && !isValidEmail(identifier)) {
    showError(magmaLoginError, t('auth.magma.invalidEmail'));
    return;
  }
  if (!isEmailInput && !isValidMinecraftNick(identifier)) {
    showError(magmaLoginError, t('auth.magma.invalidNick'));
    return;
  }

  const button = e.currentTarget;
  setButtonLoading(button, t('auth.magma.signingIn'));

  try {
    let email = identifier;
    let accountKnownToExist = false;

    if (!isEmailInput) {
      const { data: resolvedEmail, error: resolveError } = await withTimeout(
        supabaseClient.rpc('nick_to_email', { check_nick: identifier })
      );

      if (resolveError || !resolvedEmail) {
        showError(magmaLoginError, t('auth.magma.notFound'));
        return;
      }
      email = resolvedEmail;
      accountKnownToExist = true;
    }

    const { data, error } = await withTimeout(supabaseClient.auth.signInWithPassword({ email, password }));

    if (error) {
      if (accountKnownToExist) {
        showError(magmaLoginError, t('auth.magma.wrongPassword'));
        return;
      }
      const { data: exists } = await withTimeout(supabaseClient.rpc('email_exists', { check_email: email }));
      showError(magmaLoginError, exists ? t('auth.magma.wrongPassword') : t('auth.magma.notFound'));
      return;
    }

        const { profile, missing } = await fetchProfileWithRetry(data.user.id);

    if (missing) {
      profileRepairUserId = data.user.id;
      document.getElementById('magmaGoogleNick').value = '';
      magmaGoogleSetupDesc.textContent = t('auth.google.repairDesc');
      hideError(magmaGoogleSetupError);
      showMagmaStep('google-setup');
      return;
    }

    upsertActiveAccount({
      id: data.user.id, type: 'magma', nickname: profile.nick, identifier: email,
      accessToken: data.session?.access_token, refreshToken: data.session?.refresh_token,
    });
    finishLogin(profile.nick);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка входа:', err);
    showError(magmaLoginError, t('auth.magma.genericError'));
  } finally {
    restoreButton(button);
  }
});

// ============================================
// Вход/регистрация через Google OAuth
// ============================================
let profileRepairUserId = null;

async function runGoogleAuth() {
  if (typeof window.googleOAuthSignIn === 'function') {
    const raw = await window.googleOAuthSignIn();
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  console.log('[MagmaLauncher] (dev-режим, бэкенд не подключен) Имитация входа через Google');
  window.alert(t('auth.google.devOnlyExe'));
  return { success: false, cancelled: true };
}

async function handleGoogleAuthClick(button) {
  const errorTarget = button.dataset.context === 'register' ? magmaRegisterError : magmaLoginError;
  hideError(errorTarget);
  setButtonLoading(button, t('auth.google.waitingBrowser'));

  try {
    const result = await runGoogleAuth();

    if (!result.success) {
      if (!result.cancelled) showError(errorTarget, t('auth.google.failed'));
      return;
    }

    restoreButton(button);
    setButtonLoading(button, t('auth.google.checking'));

    const { data, error } = await withTimeout(
      supabaseClient.auth.signInWithIdToken({ provider: 'google', token: result.idToken })
    );

    if (error) {
      console.error('[MagmaLauncher] Ошибка Google signInWithIdToken:', error);
      showError(errorTarget, t('auth.google.failed'));
      return;
    }

        const { profile, missing } = await fetchProfileWithRetry(data.user.id);

    if (missing) {
      profileRepairUserId = data.user.id;
      document.getElementById('magmaGoogleNick').value = '';
      magmaGoogleSetupDesc.textContent = t('auth.google.repairDesc');
      hideError(magmaGoogleSetupError);
      showMagmaStep('google-setup');
      return;
    }

        if (!profile) {
      showError(magmaLoginError, t('auth.magma.genericError'));
      return;
    }

    upsertActiveAccount({
      id: data.user.id, type: 'magma', nickname: profile.nick, identifier: data.user.email,
      accessToken: data.session?.access_token, refreshToken: data.session?.refresh_token,
    });
    finishLogin(profile.nick);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка входа через Google:', err);
    showError(errorTarget, t('auth.google.failed'));
  } finally {
    restoreButton(button);
  }
}

document.getElementById('googleAuthSubmit')?.addEventListener('click', (e) => handleGoogleAuthClick(e.currentTarget));
document.getElementById('googleRegisterSubmit')?.addEventListener('click', (e) => handleGoogleAuthClick(e.currentTarget));

document.getElementById('magmaGoogleSetupSubmit')?.addEventListener('click', async (e) => {
  hideError(magmaGoogleSetupError);

  if (!profileRepairUserId) return;

  const nick = document.getElementById('magmaGoogleNick').value.trim();

  if (!nick) {
    showError(magmaGoogleSetupError, t('auth.magma.fillAll'));
    return;
  }
  if (!isValidMinecraftNick(nick)) {
    showError(magmaGoogleSetupError, t('auth.magma.invalidNick'));
    return;
  }

  const button = e.currentTarget;
  setButtonLoading(button, t('auth.google.creatingAccount'));

  try {
    const { error: profileError } = await withTimeout(
      supabaseClient.from('profiles').insert({ id: profileRepairUserId, nick })
    );

    if (profileError) {
      if (profileError.code === '23505') {
        const isPkConflict = (profileError.message || '').includes('profiles_pkey')
          || (profileError.details || '').includes('(id)');

        if (isPkConflict) {
          const { data: existingProfile, error: fetchError } = await withTimeout(
            supabaseClient.from('profiles').select('nick').eq('id', profileRepairUserId).single()
          );

           if (!fetchError && existingProfile) {
            const { data: repairSessionData } = await withTimeout(supabaseClient.auth.getSession());
            upsertActiveAccount({
              id: profileRepairUserId,
              type: 'magma',
              nickname: existingProfile.nick,
              identifier: repairSessionData?.session?.user?.email || '',
              accessToken: repairSessionData?.session?.access_token,
              refreshToken: repairSessionData?.session?.refresh_token,
            });
            profileRepairUserId = null;
            finishLogin(existingProfile.nick);
            return;
          }
        }

        showError(magmaGoogleSetupError, t('auth.magma.nickTaken'));
      } else {
        console.error('[MagmaLauncher] Ошибка создания профиля:', profileError);
        showError(magmaGoogleSetupError, t('auth.magma.genericError'));
      }
      return;
    }

    const { data: sessionData } = await withTimeout(supabaseClient.auth.getSession());
    upsertActiveAccount({
      id: profileRepairUserId, type: 'magma', nickname: nick, identifier: '',
      accessToken: sessionData?.session?.access_token, refreshToken: sessionData?.session?.refresh_token,
    });
    profileRepairUserId = null;
    finishLogin(nick);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка завершения регистрации:', err);
    showError(magmaGoogleSetupError, t('auth.magma.genericError'));
  } finally {
    restoreButton(button);
  }
});

// --- Microsoft: вход по лицензии Minecraft через Xbox Live ---
window.msAuthState = null; // { username, uuid, accessToken } | null

const msErrorEl = document.getElementById('msError');

document.getElementById('msSubmit')?.addEventListener('click', async (e) => {
  const button = e.currentTarget;

  if (typeof window.msOAuthSignIn !== 'function') {
    console.log('[MagmaLauncher] (dev-режим, бэкенд не подключен) msOAuthSignIn недоступен');
    window.alert(t('auth.ms.devOnlyExe'));
    return;
  }

  if (msErrorEl) hideError(msErrorEl);
  setButtonLoading(button, t('auth.google.waitingBrowser'));

  try {
    const raw = await window.msOAuthSignIn();
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (!result.success) {
      if (msErrorEl) showError(msErrorEl, translateBackendError(result.error) || t('auth.google.failed'));
      return;
    }

    window.msAuthState = {
      username: result.username,
      uuid: result.uuid,
      accessToken: result.accessToken,
    };
    finishLogin(result.username, true);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка входа через Microsoft:', err);
    if (msErrorEl) showError(msErrorEl, t('auth.google.failed'));
  } finally {
    restoreButton(button);
  }
});

// ============================================
// Enter в полях авторизации
// ============================================
function chainEnterKeys(elements) {
  for (let i = 0; i < elements.length - 1; i++) {
    const el = elements[i];
    if (!el) continue;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = elements[i + 1];
      if (!next) return;
      if (next.tagName === 'BUTTON') {
        next.click();
      } else {
        next.focus();
      }
    });
  }
}

chainEnterKeys([
  document.getElementById('guestNickname'),
  document.getElementById('guestSubmit'),
]);

chainEnterKeys([
  document.getElementById('magmaLoginEmail'),
  document.getElementById('magmaLoginPassword'),
  document.getElementById('magmaLoginSubmit'),
]);

chainEnterKeys([
  document.getElementById('magmaGoogleNick'),
  document.getElementById('magmaGoogleSetupSubmit'),
]);

// ============================================
// Экран загрузки при старте — прогружаем сессию/настройки заранее, чтобы
// потом при работе с лаунчером не дёргались пустые состояния и задержки
// (например поход в Supabase за аккаунтом). Не делаем его длинным:
// минимум показываем чуть-чуть (чтобы не было "моргания"), максимум ждём
// сети — дальше открываем лаунчер как есть.
// ============================================
const bootSplash = document.getElementById('bootSplash');
const bootBarFill = document.getElementById('bootBarFill');

function setBootProgress(fraction) {
  if (bootBarFill) bootBarFill.style.width = Math.round(Math.min(1, Math.max(0, fraction)) * 100) + '%';
}

function hideBootSplash() {
  if (!bootSplash) return;
  bootSplash.classList.add('is-hidden');
  setTimeout(() => bootSplash.remove(), 450);
}

async function bootSequence() {
  const MIN_VISIBLE_MS = 500;    // не даём экрану загрузки мелькнуть слишком быстро
  const SAFETY_TIMEOUT_MS = 12000; // страховка на случай совсем мёртвой сети — не решение,
                                    // а именно предохранитель, чтобы не зависнуть навсегда
  const startedAt = Date.now();

  setBootProgress(0.2);
  restoreLauncherSettings();
  updateRamValue();
  initPrivacySettings();
  if (getPrivacyPref(PRIVACY_AUTO_DELETE_LOGS_KEY, false) && typeof window.cleanOldGameLogs === 'function') {
    window.cleanOldGameLogs({ gameDir: getGameDir(), days: 14 }).catch(() => {});
  }
  if (isLauncherLockEnabled()) {
    hideBootSplash();
    await showLauncherLockScreen();
  }
  if (typeof window.getLauncherVersion === 'function') {
  window.getLauncherVersion().then(raw => {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const el = document.getElementById('currentLauncherVersionText');
    if (el) el.textContent = r.version;
  }).catch(() => {});
}
const autoCheck = localStorage.getItem(AUTO_CHECK_UPDATES_KEY);
document.getElementById('autoCheckUpdatesToggle') && (document.getElementById('autoCheckUpdatesToggle').checked = autoCheck !== '0');

if (autoCheck !== '0') {
  const autoInstallOn = localStorage.getItem(AUTO_INSTALL_UPDATES_KEY) !== '0';
  if (autoInstallOn) {
    await autoUpdateOnBoot(); // если найдёт обновление — скачает и перезапустит лаунчер, дальше код не выполнится
  } else {
    checkForLauncherUpdate(false);
  }
}
loadNewsFeed();

  // "Прогреваем" соединение с Modrinth API прямо сейчас, параллельно с
  // остальной загрузкой — специально НЕ дожидаемся результата (await), чтобы
  // не удлинять экран загрузки: это просто заранее устанавливает
  // DNS/TLS-соединение, чтобы к моменту открытия вкладки "Моды" первый
  // реальный поиск не был первым, кто платит за холодное соединение, и не
  // падал по случайному таймауту на медленной сети.
  if (typeof window.warmupModrinth === 'function') {
    window.warmupModrinth().catch(() => {});
  }
  // Дополнительно тихо тянем саму первую страницу модов по умолчанию
  // (Fabric + 1.21.4, пустой запрос) прямо в кэш — если игрок откроет вкладку
  // "Моды" без смены фильтров, список отрисуется мгновенно, а не после
  // "Ищем моды...".
  if (typeof window.searchMods === 'function') {
    fetchModsSearch('', modsTargetVersion, modsTargetLoader, 0).catch(() => {});
  }

  setBootProgress(0.5);

  // ВАЖНО: раньше здесь была гонка (Promise.race) между реальной проверкой
  // сессии Supabase и таймаутом в 4с. Promise.race не отменяет проигравшего —
  // если Supabase отвечал дольше 4с, таймаут "побеждал", лаунчер открывал
  // окно входа, а через мгновение доехавший ответ Supabase сам вызывал
  // finishLogin() -> closeAuthModal(), из-за чего окно входа мелькало и
  // резко захлопывалось. Теперь по-настоящему ждём результат проверки —
  // предзагрузка (в том числе Supabase) действительно завершается ДО того,
  // как решаем, показывать окно входа или нет.
  let restored = false;
  try {
    restored = await Promise.race([
      tryRestoreActiveAccount(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('boot-safety-timeout')), SAFETY_TIMEOUT_MS)),
    ]);
  } catch (err) {
    // Сработал только предохранитель (сеть действительно не отвечает) —
    // открываем лаунчер как гостя/с окном входа, ждать дальше нет смысла.
    console.error('[MagmaLauncher] Восстановление сессии не уложилось в таймаут:', err);
    restored = false;
  }

  setBootProgress(0.9);

  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_VISIBLE_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_VISIBLE_MS - elapsed));
  }

  setBootProgress(1);
  hideBootSplash();
  updateSettingsAccountTab();

  if (getPrivacyPref(PRIVACY_DISCORD_KEY, true)) startDiscordPresence();
  if (!restored) openAuthModal();
}

// ============================================
// F11 — полноэкранный режим. Слушаем нажатие клавиши здесь и просто зовём
// нативный биндинг toggleFullscreen из main.cpp (реализован через WinAPI,
// разворачивает само окно лаунчера, а не только веб-контент внутри него).
// ============================================
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'F11') return;
  e.preventDefault();

  if (typeof window.toggleFullscreen !== 'function') {
    console.log('[MagmaLauncher] (dev-режим, бэкенд не подключен) toggleFullscreen недоступен');
    return;
  }

  try {
    await window.toggleFullscreen();
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка переключения полноэкранного режима:', err);
  }
});

// ============================================
// Внешние ссылки (описания модов, CurseForge HTML и т.п.) — открываем в
// системном браузере пользователя, а не даём WebView открыть их сам.
// Раньше клик по такой ссылке (target="_blank", как в mdToSafeHtml выше)
// заставлял сам webview поднимать НОВОЕ окно — а это окно не проходит через
// нормальную настройку сети/TLS основного окна лаунчера, из-за чего страницы
// в нём иногда не грузились вовсе (ERR_QUIC_PROTOCOL_ERROR и т.п.) и в любом
// случае выглядело как случайное левое окно поверх лаунчера, а не как
// открытие ссылки в браузере пользователя. Перехватываем клик на самой
// ранней стадии (capture:true, до того как WebView успеет его обработать),
// отменяем стандартное поведение и просим C++-бэкенд открыть ссылку через
// системный ShellExecute — то же самое, что уже делает страница согласия
// Google при входе (см. main.cpp -> googleOAuthSignIn).
// ============================================
const nativeWindowOpen = window.open ? window.open.bind(window) : null;
const nativeOpenExternalUrl = typeof window.openExternalUrl === 'function' ? window.openExternalUrl : null;

async function openLinkInBrowser(url) {
  if (!url) return;
  if (nativeOpenExternalUrl) {
    try { await nativeOpenExternalUrl({ url }); return; } catch (err) {
      console.error('[MagmaLauncher] Не удалось открыть ссылку в браузере:', err);
    }
  }
  if (nativeWindowOpen) nativeWindowOpen(url, '_blank', 'noopener,noreferrer');
}

// ============================================
// Жёсткая защита от посторонних всплывающих окон. Перехват клика
// по <a href> (см. ниже) закрывает почти все случаи, но что угодно из
// стороннего контента (например HTML-описания модов с CurseForge) в теории
// может вызвать window.open(...) напрямую, иногда с некорректным
// аргументом (не строкой) — именно так получалось окно вида
// file:///.../frontend/[object%20Object] вместо настоящей ссылки: движок
// пытался открыть НОВОЕ окно по мусорному относительному пути. Полностью
// переопределяем window.open: настоящая http(s)-ссылка всегда уходит в
// системный браузер через openExternalUrl, всё остальное просто
// блокируется, а не открывает битое окно поверх лаунчера.
window.open = function (url) {
  const href = typeof url === 'string' ? url : '';
  if (/^https?:\/\//i.test(href)) {
    openLinkInBrowser(href);
  } else {
    console.warn('[MagmaLauncher] Заблокирована попытка открыть постороннее окно:', url);
  }
  return null;
};

document.addEventListener('click', (e) => {
  const link = e.target.closest && e.target.closest('a[href]');
  if (!link) return;
  // ВАЖНО: preventDefault теперь ставится ДО проверки протокола. Раньше при
  // невалидном href (например, битая ссылка внутри чьего-то описания мода)
  // функция выходила без preventDefault — браузерный движок сам обрабатывал
  // клик как обычную навигацию и открывал отдельное окно с относительным путём
  // (тот самый "файл не найден" на скрине). Теперь переход блокируется
  // всегда, а в системный браузер уходят только настоящие http/https ссылки.
  e.preventDefault();
  e.stopPropagation();
  const href = link.getAttribute('href') || '';
  if (/^https?:\/\//i.test(href)) {
    openLinkInBrowser(href);
  }
}, { capture: true });

// ============================================
// Ручная прокрутка колесом мыши для основной области контента.
// Раньше во вкладке "Моды" список модов был отдельным вложенным
// overflow-контейнером — из-за двойной вложенной прокрутки (внешний
// .content + внутренний список) колесо мыши в используемом здесь WebView
// иногда вообще не долистывало до конца. Список модов теперь больше НЕ
// скроллится сам по себе (см. правки в style.css: .mod-list/.installed-
// mod-list — обычный блочный поток) — скроллится только один-единственный
// .content, как и на остальных вкладках. Этот форвардер — доп. страховка на
// случай, если родное колесо мыши в этом WebView всё равно не долистывает
// какой-то конкретный overflow-контейнер: находим ближайший скроллящийся
// элемент под курсором и явно двигаем его scrollTop сами.
// ============================================
function findScrollableAncestor(el) {
  let node = el;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const style = getComputedStyle(node);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node;
    }
    node = node.parentElement;
  }
  return document.querySelector('.content');
}

const smoothScrollState = new WeakMap();

function cancelPendingSmoothScroll(target) {
  const state = smoothScrollState.get(target);
  if (!state) return;
  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = null;
  }
  state.targetTop = target.scrollTop;
}

function syncSmoothScrollTarget(target, top) {
  const state = smoothScrollState.get(target);
  if (state) {
    state.targetTop = top;
  } else {
    smoothScrollState.set(target, { targetTop: top, raf: null });
  }
}

function smoothScrollBy(target, delta) {
  let state = smoothScrollState.get(target);
  if (!state) {
    state = { targetTop: target.scrollTop, raf: null };
    smoothScrollState.set(target, state);
  }
  const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
  state.targetTop = Math.max(0, Math.min(maxScroll, state.targetTop + delta));

  if (!state.raf) {
    const step = () => {
      const diff = state.targetTop - target.scrollTop;
      if (Math.abs(diff) < 0.5) {
        target.scrollTop = state.targetTop;
        state.raf = null;
        return;
      }
      target.scrollTop += diff * 0.28;
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  }
}

document.addEventListener('wheel', (e) => {
  const target = findScrollableAncestor(e.target);
  if (!target || target.scrollHeight <= target.clientHeight) return;
  cancelPendingSmoothScroll(target);
  target.scrollTop += e.deltaY;
  syncSmoothScrollTarget(target, target.scrollTop);
  e.preventDefault();
}, { passive: false, capture: true });

(function enableGrabScroll() {
  let dragState = null;
  const DRAG_THRESHOLD = 6;

  function isInteractiveTarget(el) {
    return !!(el.closest && el.closest('button, a, input, textarea, select, [contenteditable="true"], .rail-btn, canvas, .settings-slider'));
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (isInteractiveTarget(e.target)) return;
    const target = findScrollableAncestor(e.target);
    if (!target || target.scrollHeight <= target.clientHeight) return;
    dragState = { target, startX: e.clientX, startY: e.clientY, startScrollTop: target.scrollTop, dragging: false, pointerId: e.pointerId };
  }, { capture: true });

  document.addEventListener('pointermove', (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const dy = e.clientY - dragState.startY;
    const dx = e.clientX - dragState.startX;
    if (!dragState.dragging && Math.abs(dy) < DRAG_THRESHOLD && Math.abs(dx) < DRAG_THRESHOLD) return;

    if (!dragState.dragging) {
      dragState.dragging = true;
      dragState.target.classList.add('is-grab-scrolling');
      try { dragState.target.setPointerCapture(dragState.pointerId); } catch (err) {}
      cancelPendingSmoothScroll(dragState.target);
    }

    dragState.target.scrollTop = dragState.startScrollTop - dy;
    syncSmoothScrollTarget(dragState.target, dragState.target.scrollTop);
    e.preventDefault();
  }, { capture: true });

  function endDrag(e) {
    if (!dragState) return;
    if (dragState.dragging) {
      dragState.target.classList.remove('is-grab-scrolling');
      try { dragState.target.releasePointerCapture(dragState.pointerId); } catch (err) {}
      const suppressClick = (ce) => { ce.stopPropagation(); ce.preventDefault(); document.removeEventListener('click', suppressClick, true); };
      document.addEventListener('click', suppressClick, true);
      setTimeout(() => document.removeEventListener('click', suppressClick, true), 0);
    }
    dragState = null;
  }
  document.addEventListener('pointerup', endDrag, { capture: true });
  document.addEventListener('pointercancel', endDrag, { capture: true });
})();

// ПКМ полностью отключён: CEF также очищает стандартное Chromium-меню.
const customContextMenuEl = document.createElement('div');
customContextMenuEl.className = 'custom-context-menu';
document.body.appendChild(customContextMenuEl);

function hideCustomContextMenu() {
  customContextMenuEl.classList.remove('is-visible');
}

async function runContextMenuCommand(cmd, target) {
  target.focus();
  if (cmd === 'selectAll') { target.select(); return; }

  if (cmd === 'paste' && navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const val = target.value;
      target.value = val.slice(0, start) + text + val.slice(end);
      const caret = start + text.length;
      target.setSelectionRange(caret, caret);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    } catch (err) {
      // Нет доступа к буферу обмена — пробуем execCommand как запасной путь.
    }
  }

  try {
    document.execCommand(cmd);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    if (cmd === 'paste') target.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    console.error('[MagmaLauncher] Команда контекстного меню не сработала:', cmd, err);
  }
}

const CONTEXT_MENU_ICONS = {
  cut: '<svg viewBox="0 0 24 24"><path d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.5 15.5M20 20 4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  paste: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/></svg>',
  selectAll: '<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 1-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>',
};

function showCustomContextMenu(target, x, y) {
  const hasSelection = target.selectionStart !== target.selectionEnd;
  const isEditableNow = !target.disabled && !target.readOnly;

  const items = [
    { cmd: 'cut', label: t('contextMenu.cut'), disabled: !hasSelection || !isEditableNow },
    { cmd: 'copy', label: t('contextMenu.copy'), disabled: !hasSelection },
    { cmd: 'paste', label: t('contextMenu.paste'), disabled: !isEditableNow },
    { cmd: 'selectAll', label: t('contextMenu.selectAll'), disabled: !target.value },
  ];

  customContextMenuEl.innerHTML = '';
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'custom-context-menu-item';
    btn.disabled = item.disabled;
    btn.innerHTML = `${CONTEXT_MENU_ICONS[item.cmd]}<span>${item.label}</span>`;
    btn.addEventListener('click', async () => {
      hideCustomContextMenu();
      await runContextMenuCommand(item.cmd, target);
    });
    customContextMenuEl.appendChild(btn);
  });

  customContextMenuEl.classList.add('is-visible');
  const menuWidth = customContextMenuEl.offsetWidth || 180;
  const menuHeight = customContextMenuEl.offsetHeight || 160;
  let left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  let top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
  customContextMenuEl.style.left = left + 'px';
  customContextMenuEl.style.top = top + 'px';
}

document.addEventListener('click', hideCustomContextMenu);
document.addEventListener('scroll', hideCustomContextMenu, true);
document.addEventListener('input', hideCustomContextMenu, true);
window.addEventListener('blur', hideCustomContextMenu);

function selectAllTextIn(container) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copySelectionOrContainer(container) {
  const selection = window.getSelection();
  const text = (selection && !selection.isCollapsed) ? selection.toString() : container.innerText;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch (err) {}
  }
  document.execCommand('copy');
}

function showCopyOnlyContextMenu(container, x, y) {
  const hasSelection = !!(window.getSelection() && window.getSelection().toString());

  customContextMenuEl.innerHTML = '';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'custom-context-menu-item';
  copyBtn.disabled = !hasSelection;
  copyBtn.innerHTML = `${CONTEXT_MENU_ICONS.copy}<span>${t('contextMenu.copy')}</span>`;
  copyBtn.addEventListener('click', async () => {
    hideCustomContextMenu();
    await copySelectionOrContainer(container);
  });
  customContextMenuEl.appendChild(copyBtn);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'custom-context-menu-item';
  selectAllBtn.innerHTML = `${CONTEXT_MENU_ICONS.selectAll}<span>${t('contextMenu.selectAll')}</span>`;
  selectAllBtn.addEventListener('click', () => {
    hideCustomContextMenu();
    selectAllTextIn(container);
  });
  customContextMenuEl.appendChild(selectAllBtn);

  customContextMenuEl.classList.add('is-visible');
  const menuWidth = customContextMenuEl.offsetWidth || 180;
  const menuHeight = customContextMenuEl.offsetHeight || 90;
  let left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  let top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
  customContextMenuEl.style.left = left + 'px';
  customContextMenuEl.style.top = top + 'px';
}

document.addEventListener('contextmenu', (e) => {
  const editable = e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]');
  const copyable = !editable && e.target.closest && e.target.closest(
    '.updates-timeline .update-card-title, .updates-timeline .update-highlights, ' +
    '.news-card h3, .news-card p, ' +
    '.mod-name, .mod-desc, .mod-details-title, .mod-details-body, ' +
    '.installed-mod-name, .server-card .server-name, .server-card .server-description'
  );
  if (editable) {
    e.preventDefault();
    showCustomContextMenu(editable, e.clientX, e.clientY);
    return;
  }
  if (copyable) {
    e.preventDefault();
    showCopyOnlyContextMenu(copyable, e.clientX, e.clientY);
    return;
  }
  hideCustomContextMenu();
  // В остальных местах возвращаем обычное контекстное меню Windows/CEF.
}, { capture: true });

// ============================================
// Инициализация
// ============================================
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function uploadLocalFilesToDir(files, targetDir) {
  if (typeof window.installLocalFile !== 'function') {
    return { success: false, error: t('mods.devModeHint') };
  }
  let lastError = '';
  let successCount = 0;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);
      const raw = await window.installLocalFile({ filename: file.name, dataBase64: base64, targetDir });
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (result.success) successCount++;
      else lastError = translateBackendError(result.error) || result.error || '';
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  return { success: successCount > 0, error: lastError, count: successCount };
}

const modManualInstallBtnEl = document.getElementById('modManualInstallBtn');
const modManualInstallInputEl = document.getElementById('modManualInstallInput');

async function handleManualModFiles(files) {
  const cat = currentCategoryDef();
  const kind = cat.id === 'mod' ? 'mod' : (cat.id === 'resourcepack' ? 'resourcepack' : (cat.id === 'shader' ? 'shader' : 'map'));
  const targetDir = currentContentDir();
  if (modManualInstallBtnEl) modManualInstallBtnEl.disabled = true;
  const result = await installFilesForCategory(files, kind, targetDir);
  if (modManualInstallBtnEl) modManualInstallBtnEl.disabled = false;
  if (result.success) {
    modsSubtabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.subtab === 'installed'));
    modsSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.subview === 'installed'));
    loadInstalledMods();
  } else if (result.error) {
    console.error('[MagmaLauncher] Не удалось добавить файл вручную:', result.error);
  }
}

modManualInstallBtnEl?.addEventListener('click', () => {
  const cat = currentCategoryDef();
  const kind = cat.id === 'mod' ? 'mod' : (cat.id === 'resourcepack' ? 'resourcepack' : (cat.id === 'shader' ? 'shader' : 'map'));
  openManualInstallModal(kind, currentContentDir(), () => {
    modsSubtabs.forEach(tb => tb.classList.toggle('is-active', tb.dataset.subtab === 'installed'));
    modsSubviews.forEach(v => v.classList.toggle('is-active', v.dataset.subview === 'installed'));
    loadInstalledMods();
  });
});

[document.getElementById('modList'), document.getElementById('installedModList')].forEach(el => {
  if (!el) return;
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-drop-target'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('is-drop-target');
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await handleManualModFiles(files);
  });
});

const instanceModsManualBtnEl = document.getElementById('instanceModsManualBtn');
const instanceModsManualInputEl = document.getElementById('instanceModsManualInput');

instanceModsManualBtnEl?.addEventListener('click', () => {
  if (!currentInstanceModsPack) return;
  openManualInstallModal('instanceMod', instanceModsDir(currentInstanceModsPack), () => {
    loadInstanceModsList(currentInstanceModsPack);
  });
});

instanceModsListEl?.addEventListener('dragover', (e) => { e.preventDefault(); instanceModsListEl.classList.add('is-drop-target'); });
instanceModsListEl?.addEventListener('dragleave', () => instanceModsListEl.classList.remove('is-drop-target'));
instanceModsListEl?.addEventListener('drop', async (e) => {
  e.preventDefault();
  instanceModsListEl.classList.remove('is-drop-target');
  const files = await collectFilesFromDataTransfer(e.dataTransfer);
  if (!files.length || !currentInstanceModsPack) return;
  const result = await installFilesForCategory(files, 'instanceMod', instanceModsDir(currentInstanceModsPack));
  if (result.success) loadInstanceModsList(currentInstanceModsPack);
});

instanceModsListEl?.addEventListener('dragover', (e) => { e.preventDefault(); instanceModsListEl.classList.add('is-drop-target'); });
instanceModsListEl?.addEventListener('dragleave', () => instanceModsListEl.classList.remove('is-drop-target'));
instanceModsListEl?.addEventListener('drop', async (e) => {
  e.preventDefault();
  instanceModsListEl.classList.remove('is-drop-target');
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length || !currentInstanceModsPack) return;
  const result = await uploadLocalFilesToDir(files, instanceModsDir(currentInstanceModsPack));
  if (result.success) loadInstanceModsList(currentInstanceModsPack);
});

const importInstanceBtnEl = document.getElementById('importInstanceBtn');
const importInstanceInputEl = document.getElementById('importInstanceInput');
const importInstanceStatusEl = document.getElementById('importInstanceStatus');

importInstanceBtnEl?.addEventListener('click', () => {
  openManualInstallModal('modpack', '', null);
});

async function readEntryFiles(entry, pathPrefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => { out.push(file); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) { resolve(); return; }
          for (const child of entries) {
            await readEntryFiles(child, pathPrefix + entry.name + '/', out);
          }
          readBatch();
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

async function collectFilesFromDataTransfer(dataTransfer) {
  const directFiles = Array.from(dataTransfer.files || []);
  if (directFiles.length) return directFiles;

  const out = [];
  const items = dataTransfer.items;
  if (items && items.length && items[0] && items[0].webkitGetAsEntry) {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    for (const entry of entries) await readEntryFiles(entry, '', out);
  }
  return out;
}

function manualInstallFileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function rarUnsupportedText() {
  return RAR_UNSUPPORTED_TEXT[currentLang] || RAR_UNSUPPORTED_TEXT.en;
}

async function installArchiveModsToDir(file, targetDir) {
  if (typeof window.installArchiveMods !== 'function') return { success: false, error: t('mods.devModeHint') };
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const raw = await window.installArchiveMods({ filename: file.name, dataBase64: base64, targetDir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return { success: false, error: translateBackendError(result.error) || t('mods.archiveNoJars') };
    return { success: true, count: result.count || 0 };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function installArchiveMapToDir(file, targetDir) {
  if (typeof window.installArchiveMap !== 'function') return { success: false, error: t('mods.devModeHint') };
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const raw = await window.installArchiveMap({ filename: file.name, dataBase64: base64, targetDir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return { success: false, error: translateBackendError(result.error) || t('mods.badMapFile') };
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function installArchiveContentToDir(file, targetDir) {
  if (typeof window.installArchiveContent !== 'function') return { success: false, error: t('mods.devModeHint') };
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const raw = await window.installArchiveContent({ filename: file.name, dataBase64: base64, targetDir });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.success) return { success: false, error: translateBackendError(result.error) || t('mods.badZipFile') };
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

async function installFilesForCategory(files, kind, targetDir) {
  let successCount = 0;
  let lastError = '';
  for (const file of files) {
    const ext = manualInstallFileExt(file.name);
    let res;
    if (kind === 'mod' || kind === 'instanceMod') {
      if (ext === 'jar') res = await uploadLocalFilesToDir([file], targetDir);
      else if (ext === 'zip' || ext === 'rar') res = await installArchiveModsToDir(file, targetDir);
      else res = { success: false, error: t('mods.badModFile') };
    } else if (kind === 'resourcepack' || kind === 'shader') {
      if (ext === 'zip') res = await uploadLocalFilesToDir([file], targetDir);
      else if (ext === 'rar') res = await installArchiveContentToDir(file, targetDir);
      else res = { success: false, error: t('mods.badZipFile') };
    } else if (kind === 'map') {
      if (ext === 'zip' || ext === 'rar') res = await installArchiveMapToDir(file, targetDir);
      else res = { success: false, error: t('mods.badZipFile') };
    }
    if (res && res.success) successCount++;
    else if (res) lastError = res.error;
  }
  return { success: successCount > 0, count: successCount, error: lastError };
}

async function importModpackFile(file) {
  if (typeof window.installModpackFromLocalFile !== 'function') return;
  const instanceName = uniqueInstanceName(file.name.replace(/\.(zip|mrpack)$/i, ''));
  if (importInstanceStatusEl) importInstanceStatusEl.textContent = t('instances.importing');
  activeCatalogInstalls.set(instanceName, { btn: null });
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const raw = await window.installModpackFromLocalFile({
      filename: file.name,
      dataBase64: base64,
      instanceName,
      gameDir: getGameDir()
    });
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!result.started) throw new Error(translateBackendError(result.error) || t('auth.magma.genericError'));
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка импорта сборки:', err);
    activeCatalogInstalls.delete(instanceName);
    if (importInstanceStatusEl) importInstanceStatusEl.textContent = String(err.message || err);
  }
}

const manualInstallOverlay = document.getElementById('manualInstallOverlay');
const manualInstallClose = document.getElementById('manualInstallClose');
const manualInstallHintEl = document.getElementById('manualInstallHint');
const manualInstallDropEl = document.getElementById('manualInstallDrop');
const manualInstallBrowseBtn = document.getElementById('manualInstallBrowseBtn');
const manualInstallInputEl2 = document.getElementById('manualInstallInput');
const manualInstallListEl = document.getElementById('manualInstallList');
const manualInstallErrorEl = document.getElementById('manualInstallError');

let manualInstallKind = 'mod';
let manualInstallTargetDir = '';
let manualInstallOnDone = null;

const MANUAL_INSTALL_HINTS = {
  mod: { ru: 'Перетащите .jar моды, .zip или .rar-архив с несколькими модами.', en: 'Drop .jar mods, or a .zip/.rar archive with several mods.' },
  resourcepack: { ru: 'Перетащите .zip или .rar ресурс-пак — распаковывать не нужно.', en: 'Drop a .zip or .rar resource pack — no need to unpack it.' },
  shader: { ru: 'Перетащите .zip или .rar шейдер-пак — распаковывать не нужно.', en: 'Drop a .zip or .rar shader pack — no need to unpack it.' },
  map: { ru: 'Перетащите .zip или .rar с картой (резервной копией мира) — лаунчер сам её распакует.', en: 'Drop a .zip or .rar world backup — the launcher will extract it automatically.' },
  instanceMod: { ru: 'Перетащите .jar моды, .zip или .rar-архив с несколькими модами для этой сборки.', en: 'Drop .jar mods, or a .zip/.rar archive with several mods for this instance.' },
  modpack: { ru: 'Перетащите .zip, .rar или .mrpack со сборкой.', en: 'Drop a .zip, .rar or .mrpack modpack file.' },
};

function manualInstallHintText(kind) {
  const entry = MANUAL_INSTALL_HINTS[kind] || MANUAL_INSTALL_HINTS.mod;
  return entry[currentLang] || entry.ru || entry.en;
}

function openManualInstallModal(kind, targetDir, onDone) {
  manualInstallKind = kind;
  manualInstallTargetDir = targetDir;
  manualInstallOnDone = onDone || null;
  if (manualInstallHintEl) manualInstallHintEl.textContent = manualInstallHintText(kind);
  if (manualInstallListEl) manualInstallListEl.innerHTML = '';
  hideError(manualInstallErrorEl);
  manualInstallOverlay?.classList.add('is-open');
}

function closeManualInstallModal() {
  manualInstallOverlay?.classList.remove('is-open');
}

manualInstallClose?.addEventListener('click', closeManualInstallModal);
manualInstallOverlay?.addEventListener('click', (e) => { if (e.target === manualInstallOverlay) closeManualInstallModal(); });

manualInstallBrowseBtn?.addEventListener('click', () => manualInstallInputEl2.click());
manualInstallInputEl2?.addEventListener('change', async () => {
  const files = Array.from(manualInstallInputEl2.files || []);
  manualInstallInputEl2.value = '';
  if (files.length) await processManualInstallFiles(files);
});

manualInstallDropEl?.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); manualInstallDropEl.classList.add('is-drag-over'); });
manualInstallDropEl?.addEventListener('dragleave', () => manualInstallDropEl.classList.remove('is-drag-over'));
manualInstallDropEl?.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  manualInstallDropEl.classList.remove('is-drag-over');
  const files = await collectFilesFromDataTransfer(e.dataTransfer);
  if (files.length) await processManualInstallFiles(files);
});

manualInstallOverlay?.addEventListener('dragover', (e) => e.preventDefault());
manualInstallOverlay?.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = await collectFilesFromDataTransfer(e.dataTransfer);
  if (files.length) await processManualInstallFiles(files);
});

function addManualInstallRow(name, statusText, isError) {
  const row = document.createElement('div');
  row.className = 'manual-install-item' + (isError ? ' is-error' : ' is-ok');
  row.innerHTML = `<span>${name}</span><span class="manual-install-item-status">${statusText}</span>`;
  manualInstallListEl?.appendChild(row);
}

async function processManualInstallFiles(files) {
  hideError(manualInstallErrorEl);
  let anySuccess = false;

  for (const file of files) {
    const ext = manualInstallFileExt(file.name);

    if (manualInstallKind === 'mod' || manualInstallKind === 'instanceMod') {
      if (ext === 'jar') {
        const res = await uploadLocalFilesToDir([file], manualInstallTargetDir);
        addManualInstallRow(file.name, res.success ? t('mods.added') : (res.error || t('auth.magma.genericError')), !res.success);
        if (res.success) anySuccess = true;
      } else if (ext === 'zip' || ext === 'rar') {
        const res = await installArchiveModsToDir(file, manualInstallTargetDir);
        addManualInstallRow(file.name, res.success ? `${res.count} .jar` : (res.error || t('mods.archiveNoJars')), !res.success);
        if (res.success) anySuccess = true;
      } else {
        addManualInstallRow(file.name, t('mods.badModFile'), true);
      }
    } else if (manualInstallKind === 'resourcepack' || manualInstallKind === 'shader') {
      if (ext === 'zip') {
        const res = await uploadLocalFilesToDir([file], manualInstallTargetDir);
        addManualInstallRow(file.name, res.success ? t('mods.added') : (res.error || t('auth.magma.genericError')), !res.success);
        if (res.success) anySuccess = true;
      } else if (ext === 'rar') {
        const res = await installArchiveContentToDir(file, manualInstallTargetDir);
        addManualInstallRow(file.name, res.success ? t('mods.added') : (res.error || t('mods.badZipFile')), !res.success);
        if (res.success) anySuccess = true;
      } else {
        addManualInstallRow(file.name, t('mods.badZipFile'), true);
      }
    } else if (manualInstallKind === 'map') {
      if (ext === 'zip' || ext === 'rar') {
        const res = await installArchiveMapToDir(file, manualInstallTargetDir);
        addManualInstallRow(file.name, res.success ? t('mods.added') : (res.error || t('mods.badMapFile')), !res.success);
        if (res.success) anySuccess = true;
      } else {
        addManualInstallRow(file.name, t('mods.badZipFile'), true);
      }
    } else if (manualInstallKind === 'modpack') {
      if (ext === 'zip' || ext === 'mrpack' || ext === 'rar') {
        await importModpackFile(file);
        addManualInstallRow(file.name, t('instances.importing'), false);
      } else {
        addManualInstallRow(file.name, t('mods.badZipFile'), true);
      }
    }
  }

  if (anySuccess && manualInstallOnDone) manualInstallOnDone();
}

const accountChangePasswordBtn = document.getElementById('accountChangePasswordBtn');
const accountChangePasswordError = document.getElementById('accountChangePasswordError');
const accountChangePasswordOverlay = document.getElementById('accountChangePasswordOverlay');
const accountChangePasswordOpenBtn = document.getElementById('accountChangePasswordOpenBtn');
const accountChangePasswordClose = document.getElementById('accountChangePasswordClose');

accountChangePasswordOpenBtn?.addEventListener('click', () => {
  hideError(accountChangePasswordError);
  document.getElementById('accountCurrentPasswordInput').value = '';
  document.getElementById('accountNewPasswordInput').value = '';
  accountChangePasswordOverlay?.classList.add('is-open');
});
accountChangePasswordClose?.addEventListener('click', () => accountChangePasswordOverlay?.classList.remove('is-open'));
accountChangePasswordOverlay?.addEventListener('click', (e) => { if (e.target === accountChangePasswordOverlay) accountChangePasswordOverlay.classList.remove('is-open'); });

accountChangePasswordBtn?.addEventListener('click', async () => {
  hideError(accountChangePasswordError);
  accountChangePasswordError.style.color = '';
  const currentPasswordInput = document.getElementById('accountCurrentPasswordInput');
  const newPasswordInput = document.getElementById('accountNewPasswordInput');
  const currentPassword = currentPasswordInput.value;
  const newPassword = newPasswordInput.value;

  const acc = getAccounts().find(a => a.id === getActiveAccountId());
  if (!acc || acc.type !== 'magma') {
    showError(accountChangePasswordError, t('account.notMagmaAccount'));
    return;
  }
  if (!currentPassword || !newPassword) {
    showError(accountChangePasswordError, t('auth.magma.fillAll'));
    return;
  }
  if (!isValidPassword(newPassword)) {
    showError(accountChangePasswordError, t('auth.magma.weakPassword'));
    return;
  }

  setButtonLoading(accountChangePasswordBtn, t('account.changingPassword'));
  try {
    const email = acc.identifier;
    if (!email) throw new Error(t('auth.magma.genericError'));

    const { error: signInError } = await supabaseClient.auth.signInWithPassword({ email, password: currentPassword });
    if (signInError) { showError(accountChangePasswordError, t('auth.magma.wrongPassword')); return; }

    const { error: updateError } = await supabaseClient.auth.updateUser({ password: newPassword });
    if (updateError) { showError(accountChangePasswordError, t('auth.magma.genericError')); return; }

    const { data: sessionData } = await supabaseClient.auth.getSession();
    upsertActiveAccount({
      ...acc,
      accessToken: sessionData?.session?.access_token,
      refreshToken: sessionData?.session?.refresh_token,
    });

    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    accountChangePasswordError.style.color = '#7fd88f';
    showError(accountChangePasswordError, t('account.passwordChanged'));
    setTimeout(() => accountChangePasswordOverlay?.classList.remove('is-open'), 1200);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка смены пароля:', err);
    showError(accountChangePasswordError, t('auth.magma.genericError'));
  } finally {
    restoreButton(accountChangePasswordBtn);
  }
});

async function endSessionAndPickNext(currentId) {
  const remaining = getAccounts().filter(a => a.id !== currentId);
  if (remaining.length > 0) {
    await switchToAccount(remaining[0]);
  } else {
    isLoggedIn = false;
    accountName.textContent = '';
    renderAccountAvatar();
    renderAccountsListPanel();
    updateSettingsAccountTab();
    resetAuthModalForms();
    updateModalCloseVisibility();
    openAuthModal();
  }
}

const accountLogoutOverlay = document.getElementById('accountLogoutOverlay');
const accountLogoutBtn = document.getElementById('accountLogoutBtn');
const accountLogoutClose = document.getElementById('accountLogoutClose');
const accountLogoutConfirmBtn = document.getElementById('accountLogoutConfirmBtn');

accountLogoutBtn?.addEventListener('click', () => accountLogoutOverlay?.classList.add('is-open'));
accountLogoutClose?.addEventListener('click', () => accountLogoutOverlay?.classList.remove('is-open'));
accountLogoutOverlay?.addEventListener('click', (e) => { if (e.target === accountLogoutOverlay) accountLogoutOverlay.classList.remove('is-open'); });

accountLogoutConfirmBtn?.addEventListener('click', async () => {
  accountLogoutOverlay?.classList.remove('is-open');
  const currentId = getActiveAccountId();
  const acc = getAccounts().find(a => a.id === currentId);

  if (acc && acc.type === 'magma') {
    try { await supabaseClient.auth.signOut(); } catch (err) { console.error('[MagmaLauncher] Ошибка выхода:', err); }
  }

  const list = getAccounts().filter(a => a.id !== currentId);
  saveAccounts(list);

  localStorage.removeItem(GUEST_SESSION_KEY);
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);

  await endSessionAndPickNext(currentId);
});

const accountDeleteOverlay = document.getElementById('accountDeleteOverlay');
const accountDeleteBtn = document.getElementById('accountDeleteBtn');
const accountDeleteClose = document.getElementById('accountDeleteClose');
const accountDeleteConfirmBtn = document.getElementById('accountDeleteConfirmBtn');
const accountDeleteError = document.getElementById('accountDeleteError');

accountDeleteBtn?.addEventListener('click', () => {
  hideError(accountDeleteError);
  accountDeleteOverlay?.classList.add('is-open');
});
accountDeleteClose?.addEventListener('click', () => accountDeleteOverlay?.classList.remove('is-open'));
accountDeleteOverlay?.addEventListener('click', (e) => { if (e.target === accountDeleteOverlay) accountDeleteOverlay.classList.remove('is-open'); });

accountDeleteConfirmBtn?.addEventListener('click', async () => {
  hideError(accountDeleteError);
  const currentId = getActiveAccountId();
  const acc = getAccounts().find(a => a.id === currentId);
  if (!acc) return;

  setButtonLoading(accountDeleteConfirmBtn, t('account.deleting'));
  try {
    if (acc.type === 'magma') {
      const { error } = await supabaseClient.rpc('delete_own_account');
      if (error) throw error;
      await supabaseClient.auth.signOut();
    }

    const list = getAccounts().filter(a => a.id !== currentId);
    saveAccounts(list);
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    if (acc.type === 'guest') localStorage.removeItem(GUEST_SESSION_KEY);

    accountDeleteOverlay?.classList.remove('is-open');
    await endSessionAndPickNext(currentId);
  } catch (err) {
    console.error('[MagmaLauncher] Ошибка удаления аккаунта:', err);
    showError(accountDeleteError, t('auth.magma.genericError'));
  } finally {
    restoreButton(accountDeleteConfirmBtn);
  }
});

applyActiveTheme();
restoreLastSelection();
restoreModsViewState();
applyLanguage(currentLang);
updateGameFolderBtnVisibility();
renderAccountAvatar();
renderAccountsListPanel();
applyNewsVisibility();
applyNavPosition();
applySavedNavOrder();
applyMergeModsInstances();
applyReduceMotion();
applyPauseSkinUnfocusedToggle();
applyDisableBlur();
applyDisableGlow();
applySimpleBg();
bootSequence().then(() => restoreViewScroll(currentActiveView));
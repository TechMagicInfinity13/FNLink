// --- плашки и эффекты ника ---
// У некоторых пользователей есть плашка: иконка, цветная подложка и
// особое оформление ника. Сами плашки (цвета, иконки) и то, у кого какая,
// приходят с сервера (GET /api/badges и поле badge в профилях). Здесь клиент
// знает только, как нарисовать плашку по этим данным.
//
// Всё, что пришло с сервера, проверяется: принимаются только цвета, числа и
// картинки data:image. Произвольный CSS или HTML через плашку не пройдёт.

let badgeDefs = new Map(); // id плашки -> проверенное определение

const BADGE_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const BADGE_ICON_RE = /^data:image\/(?:png|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const BADGE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const BADGE_VIDEO_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:webm|mp4)$/;
const BADGE_POSTER_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:jpg|jpeg|png|webp)$/;

function bColor(value) {
  return typeof value === 'string' && BADGE_COLOR_RE.test(value) ? value : null;
}

function bNum(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function normalizeBadge(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const plate = raw.plate && typeof raw.plate === 'object' ? raw.plate : {};

  const stops = (Array.isArray(plate.stops) ? plate.stops : [])
    .slice(0, 6)
    .map((s) => (Array.isArray(s) && bColor(s[0]) ? [s[0], bNum(s[1], 0, 100, 0)] : null))
    .filter(Boolean);
  if (stops.length < 2) return null;

  const colors = (list) => (Array.isArray(list) ? list.slice(0, 2).map(bColor).filter(Boolean) : []);
  const icon =
    typeof raw.icon === 'string' && raw.icon.length <= 120000 && BADGE_ICON_RE.test(raw.icon)
      ? raw.icon
      : '';
  const seam =
    plate.seam && bColor(plate.seam.a) && bColor(plate.seam.b)
      ? { a: plate.seam.a, b: plate.seam.b }
      : null;

  const n = raw.name && typeof raw.name === 'object' ? raw.name : {};
  let name = { type: 'plain' };
  if (n.type === 'wave' && bColor(n.left) && bColor(n.right)) {
    name = { type: 'wave', left: n.left, right: n.right };
  } else if (n.type === 'gradient' && bColor(n.from) && bColor(n.to)) {
    name = { type: 'gradient', from: n.from, to: n.to };
  }

  // баннер в панели собеседника: имена файлов на сервере (/badge-assets/<имя>)
  const bn = raw.banner && typeof raw.banner === 'object' ? raw.banner : null;
  const bVideo = bn && typeof bn.video === 'string' && BADGE_VIDEO_RE.test(bn.video) ? bn.video : '';
  const bPoster = bn && typeof bn.poster === 'string' && BADGE_POSTER_RE.test(bn.poster) ? bn.poster : '';

  return {
    icon,
    banner: bVideo || bPoster ? { video: bVideo, poster: bPoster } : null,
    footerIconSize: bNum(raw.footerIconSize, 14, 36, 22),
    angle: bNum(plate.angle, 0, 360, 135),
    stops,
    border: bColor(plate.border),
    glow: colors(plate.glow),
    seam,
    iconGlow: colors(plate.iconGlow),
    plateName: raw.plateName === 'white' ? 'white' : 'name', // имя на плашке: как обычно или белое
    name,
  };
}

function setBadgeDefs(rawDefs) {
  const next = new Map();
  if (rawDefs && typeof rawDefs === 'object') {
    for (const id of Object.keys(rawDefs).slice(0, 50)) {
      if (!BADGE_ID_RE.test(id)) continue;
      const def = normalizeBadge(rawDefs[id]);
      if (def) next.set(id, def);
    }
  }
  badgeDefs = next;
}

async function loadBadges() {
  try {
    const data = await authFetch('/api/badges');
    setBadgeDefs(data.defs);
  } catch (err) {
    console.error('Не удалось загрузить плашки', err);
  }
}

// Плашка пользователя (по его профилю) или null, если плашки нет
function badgeOf(username, profile) {
  const p = profile || profilesCache[username];
  if (!p || typeof p.badge !== 'string') return null;
  return badgeDefs.get(p.badge) || null;
}

// Оформление плашки задаётся CSS-переменными, сами правила лежат в styles.css
function plateGradient(badge) {
  const stops = badge.stops.map(([c, p]) => `${c} ${p}%`).join(', ');
  return `linear-gradient(${badge.angle}deg, ${stops})`;
}

function applyPlate(el, badge) {
  el.classList.add('bplate');
  el.style.setProperty('--bp-bg', plateGradient(badge));

  const shadow = [];
  if (badge.border) shadow.push(`inset 0 0 0 1px ${badge.border}`);
  for (const c of badge.glow) shadow.push(`0 0 10px ${c}`);
  el.style.setProperty('--bp-shadow', shadow.length ? shadow.join(', ') : 'none');

  el.style.setProperty(
    '--bp-icon-glow',
    badge.iconGlow.length ? badge.iconGlow.map((c) => `drop-shadow(0 0 4px ${c})`).join(' ') : 'none'
  );
  el.style.setProperty('--bp-footer-icon', badge.footerIconSize + 'px');

  if (badge.seam) {
    el.classList.add('has-seam');
    el.style.setProperty(
      '--bp-seam-bg',
      `linear-gradient(115deg, transparent 40%, ${badge.seam.a} 48%, ${badge.seam.b} 52%, transparent 60%)`
    );
  }
}

function clearPlate(el) {
  el.classList.remove('bplate', 'has-seam');
  for (const v of ['--bp-bg', '--bp-shadow', '--bp-icon-glow', '--bp-footer-icon', '--bp-seam-bg']) {
    el.style.removeProperty(v);
  }
}

function createBadgeIcon(badge) {
  const icon = document.createElement('span');
  icon.className = 'bp-icon';
  if (badge.icon) {
    const img = document.createElement('img');
    img.src = badge.icon;
    img.alt = '';
    icon.appendChild(img);
  }
  return icon;
}

// Ник с оформлением плашки. inPlate=true: ник стоит прямо на плашке (там
// он может быть просто белым). profile нужен, если пользователя ещё нет в
// кэше профилей (результат поиска, заявка в друзья).
function createNameNode(username, inPlate, profile) {
  return nameNodeFor(username, badgeOf(username, profile), inPlate);
}

function nameNodeFor(username, badge, inPlate) {
  if (!badge || (inPlate && badge.plateName === 'white')) {
    return document.createTextNode(username);
  }
  const n = badge.name;
  if (n.type === 'wave') {
    const span = document.createElement('span');
    span.className = 'wave-name';
    span.textContent = username;
    span.style.setProperty('--wave-left', n.left);
    span.style.setProperty('--wave-right', n.right);
    return span;
  }
  if (n.type === 'gradient') {
    const span = document.createElement('span');
    span.className = 'grad-name';
    span.textContent = username;
    span.style.setProperty('--grad-from', n.from);
    span.style.setProperty('--grad-to', n.to);
    return span;
  }
  return document.createTextNode(username);
}

// Ник на самой плашке
function createPlateName(username, badge) {
  const span = document.createElement('span');
  span.className = 'bp-name' + (badge.plateName === 'white' ? ' is-white' : '');
  span.appendChild(nameNodeFor(username, badge, true));
  return span;
}

// Карточка внизу слева: у пользователя с плашкой подложка, иконка и ник,
// у остальных просто ник.
function renderMyFooter() {
  meUsername.innerHTML = '';
  clearPlate(sidebarFooter);
  sidebarFooter.classList.remove('footer-card');

  const badge = badgeOf(myUsername);
  if (badge) {
    sidebarFooter.classList.add('footer-card');
    applyPlate(sidebarFooter, badge);
    meUsername.appendChild(createBadgeIcon(badge));
    meUsername.appendChild(createPlateName(myUsername, badge));
  } else {
    meUsername.appendChild(document.createTextNode(myUsername));
  }
  applyFooterAvatar();
}

// --- адрес сервера — зашит намертво, поле ввода убрали из форм.
// Когда настроится nginx + SSL на fnlink.duckdns.org, поменять здесь
// на 'https://fnlink.duckdns.org' — больше нигде трогать не придётся. ---
const SERVER_ADDRESS = 'https://fnlink.duckdns.org';

// Аватар приходит с сервера строкой и попадает в CSS: пускаем только обычный
// растровый data:image, остальное отбрасываем.
function safeAvatarCss(avatar) {
  if (typeof avatar !== 'string') return '';
  if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) return '';
  return 'url("' + avatar + '")';
}

// Сообщения без шифрования (остались от старых версий) помечаем явно:
// иначе сервер мог бы подсунуть любой текст "от имени" друга.
const LEGACY_PLAIN_PREFIX = '⚠️ (не зашифровано) ';

// --- состояние ---
let serverHttp = null;   // http://host:port
let serverWs = null;     // ws://host:port
let token = null;
let myUsername = null;
let ws = null;
let currentChat = null;
let contacts = [];             // друзья, кроме меня
let onlineUsers = new Set();
let folders = [];              // [{ id, name, members: [username, ...] }]
let currentFolder = 'all';     // 'all' или folder.id
let profilesCache = {};        // username -> { username, handle, about, avatar, joinedAt }
let contactPanelOpen = false;
const messagesByChat = {};     // username -> [сообщения]
const historyLoaded = new Set();

// --- элементы ---
const authScreen = document.getElementById('auth-screen');
const chatScreen = document.getElementById('chat-screen');

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const chatList = document.getElementById('chat-list');
const meUsername = document.getElementById('me-username');
const sidebarFooter = document.getElementById('sidebar-footer');
const currentChatTitle = document.getElementById('current-chat-title');
const messagesEl = document.getElementById('messages');
const sendForm = document.getElementById('send-form');
const messageInput = document.getElementById('message-input');
const logoutBtn = document.getElementById('logout-btn');
const settingsBtn = document.getElementById('settings-btn');
const footerAvatar = document.getElementById('footer-avatar');

const settingsModal = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const settingsAvatarPreview = document.getElementById('settings-avatar-preview');
const avatarUploadBtn = document.getElementById('avatar-upload-btn');
const avatarRemoveBtn = document.getElementById('avatar-remove-btn');
const avatarFileInput = document.getElementById('avatar-file-input');
const aboutMeInput = document.getElementById('about-me-input');
const themeOptions = document.getElementById('theme-options');
const notificationsToggle = document.getElementById('notifications-toggle');
const clearLocalDataBtn = document.getElementById('clear-local-data-btn');
const folderTabsEl = document.getElementById('folder-rail');
const foldersListEl = document.getElementById('folders-list');
const newFolderNameInput = document.getElementById('new-folder-name');
const createFolderBtn = document.getElementById('create-folder-btn');

const contactSearchInput = document.getElementById('contact-search-input');
const contactSearchBtn = document.getElementById('contact-search-btn');
const contactSearchResultEl = document.getElementById('contact-search-result');

const handleInput = document.getElementById('handle-input');
const saveHandleBtn = document.getElementById('save-handle-btn');
const handleError = document.getElementById('handle-error');

const friendRequestsBtn = document.getElementById('friend-requests-btn');
const friendRequestsBadge = document.getElementById('friend-requests-badge');
const friendRequestsModal = document.getElementById('friend-requests-modal');
const friendRequestsCloseBtn = document.getElementById('friend-requests-close-btn');
const friendRequestsListEl = document.getElementById('friend-requests-list');

const contactPanel = document.getElementById('contact-panel');
const contactPanelToggleBtn = document.getElementById('contact-panel-toggle-btn');
const contactPanelAvatarWrap = document.getElementById('contact-panel-avatar-wrap');
const contactPanelName = document.getElementById('contact-panel-name');
const contactPanelHandle = document.getElementById('contact-panel-handle');
const contactPanelStatus = document.getElementById('contact-panel-status');
const contactPanelAbout = document.getElementById('contact-panel-about');
const contactPanelJoinedSection = document.getElementById('contact-panel-joined-section');
const contactPanelJoined = document.getElementById('contact-panel-joined');
const contactPanelNote = document.getElementById('contact-panel-note');

// --- вкладки логин/регистрация ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const isLogin = tab.dataset.tab === 'login';
    loginForm.classList.toggle('hidden', !isLogin);
    registerForm.classList.toggle('hidden', isLogin);
  });
});

function toWs(httpUrl) {
  return httpUrl.replace(/^http/, 'ws');
}

// Общий хелпер для запросов с токеном — поиск, хендл, заявки в друзья.
async function authFetch(path, options = {}) {
  const headers = Object.assign({ Authorization: `Bearer ${token}` }, options.headers || {});
  const res = await fetch(serverHttp + path, { ...options, headers });

  if (!res.ok) {
    let message = `Ошибка запроса (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch {
      // ответ не JSON (например, дефолтная HTML-страница ошибки express
      // при превышении лимита размера тела запроса) — оставляем message как есть
      if (res.status === 413) message = 'Файл слишком большой для отправки на сервер';
    }
    throw new Error(message);
  }

  return res.json().catch(() => ({}));
}

// =====================================================================
// Сквозное (E2E) шифрование сообщений.
//
// Сервер видит и хранит только шифротекст в поле "text" — само сообщение
// шифруется/расшифровывается только здесь, на устройстве. Даже полный
// доступ к файлам сервера не даёт прочитать переписку.
//
// Схема: у каждого юзера своя пара ключей ECDH (кривая P-256). Приватный
// ключ никогда никуда не отправляется — живёт только в localStorage на
// этом устройстве. Публичный ключ выкладывается на сервер (это не секрет,
// в этом и суть асимметричного шифрования). Для переписки с конкретным
// другом оба конца независимо считают один и тот же общий секрет через
// ECDH(мой приватный, его публичный) === ECDH(его приватный, мой публичный),
// из него через HKDF получают ключ AES-256-GCM, которым и шифруется текст.
// =====================================================================

let myKeyPair = null; // { publicKey: CryptoKey, privateKey: CryptoKey }
const sharedKeyCache = {}; // username -> CryptoKey (AES-GCM)

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
}

function myKeyStoreKey() {
  return `mm_e2e_keypair_${myUsername}`;
}

// Загружает пару ключей из localStorage или создаёт новую (первый запуск).
async function ensureMyKeyPair() {
  const stored = localStorage.getItem(myKeyStoreKey());

  if (stored) {
    try {
      const { pub, priv } = JSON.parse(stored);
      const publicKey = await crypto.subtle.importKey(
        'jwk', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []
      );
      const privateKey = await crypto.subtle.importKey(
        'jwk', priv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
      );
      myKeyPair = { publicKey, privateKey };

      // Ключ есть локально, но сервер мог его "забыть" (например, если
      // данные сервера когда-то сбрасывались) — сверяем и публикуем
      // заново, если там пусто или лежит не то.
      const myPubJwkString = JSON.stringify(pub);
      const myProfile = await fetchMyProfile();
      if (!myProfile || myProfile.publicKey !== myPubJwkString) {
        try {
          await authFetch('/api/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey: myPubJwkString }),
          });
        } catch (err) {
          console.error('Не удалось republish публичный ключ', err);
        }
      }
      return;
    } catch (err) {
      console.error('Не удалось загрузить ключи шифрования, сгенерирую новые', err);
    }
  }

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  myKeyPair = pair;

  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  localStorage.setItem(myKeyStoreKey(), JSON.stringify({ pub: pubJwk, priv: privJwk }));

  // Публикуем публичный ключ на сервер, чтобы друзья могли писать нам
  try {
    await authFetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: JSON.stringify(pubJwk) }),
    });
  } catch (err) {
    console.error('Не удалось опубликовать публичный ключ', err);
  }
}

// Общий AES-ключ для переписки с конкретным контактом — с кэшем, чтобы не
// пересчитывать на каждое сообщение.
async function getSharedKey(contactUsername) {
  if (sharedKeyCache[contactUsername]) return sharedKeyCache[contactUsername];

  let profile = profilesCache[contactUsername];
  if (!profile || !profile.publicKey) {
    // Кэш профилей мог устареть (например, собеседник опубликовал ключ
    // уже после того, как мы его один раз загрузили) — обновляем и
    // проверяем ещё раз, прежде чем сдаваться.
    await refreshProfilesCache();
    profile = profilesCache[contactUsername];
  }
  if (!profile || !profile.publicKey) {
    throw new Error('У собеседника ещё нет ключа шифрования — попроси его зайти в приложение');
  }

  const theirPublicKey = await crypto.subtle.importKey(
    'jwk', JSON.parse(profile.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: theirPublicKey }, myKeyPair.privateKey, 256
  );

  const hkdfBaseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  // info привязана к паре ников (отсортированы, чтобы обе стороны получили
  // одну и ту же строку независимо от того, кто "я", а кто "собеседник")
  const info = new TextEncoder().encode('mm-e2e-v1:' + [myUsername, contactUsername].sort().join(':'));

  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdfBaseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  sharedKeyCache[contactUsername] = aesKey;
  return aesKey;
}

async function encryptMessage(contactUsername, plaintext) {
  const key = await getSharedKey(contactUsername);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return JSON.stringify({ v: 1, iv: bufToBase64(iv), ct: bufToBase64(ctBuf) });
}

// Возвращает расшифрованный текст, или сам payload как есть, если это
// старое сообщение до включения шифрования (не в формате {v,iv,ct}).
async function decryptMessage(contactUsername, payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return LEGACY_PLAIN_PREFIX + payload; // не JSON — старое незашифрованное сообщение
  }

  if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.ct) {
    return LEGACY_PLAIN_PREFIX + payload;
  }

  try {
    const key = await getSharedKey(contactUsername);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuf(parsed.iv) }, key, base64ToBuf(parsed.ct)
    );
    return new TextDecoder().decode(plainBuf);
  } catch (err) {
    console.error('Не удалось расшифровать сообщение: ' + (err && err.name) + ' — ' + (err && err.message), err);
    return '⚠️ Не удалось расшифровать сообщение';
  }
}

// --- тема оформления (глобально для устройства, не привязана к юзеру) ---
function applyTheme(theme) {
  if (theme && theme !== 'blue') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('.theme-swatch').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.theme || 'blue') === (theme || 'blue'));
  });
}

applyTheme(localStorage.getItem('mm_theme') || 'blue');

themeOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-swatch');
  if (!btn) return;
  const theme = btn.dataset.theme;
  localStorage.setItem('mm_theme', theme);
  applyTheme(theme);
});

// --- вход ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const server = SERVER_ADDRESS;
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch(server + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось войти');

    serverHttp = server;
    serverWs = toWs(server);
    token = data.token;
    myUsername = data.username;

    localStorage.setItem('mm_token', token);
    localStorage.setItem('mm_username', myUsername);

    await enterChat();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

// --- регистрация: «Классический» (ник и пароль) или «Образовательный» (код из школы) ---
let registerMode = 'classic';
try {
  if (localStorage.getItem('mm_reg_mode') === 'edu') registerMode = 'edu';
} catch {
  /* не страшно */
}

function applyRegisterMode() {
  const edu = registerMode === 'edu';
  document.querySelectorAll('.reg-mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === registerMode));
  document.getElementById('register-nick-label').classList.toggle('hidden', edu);
  document.getElementById('register-code-label').classList.toggle('hidden', !edu);
  document.getElementById('register-username').required = !edu;
  document.getElementById('register-code').required = edu;
  document.getElementById('register-mode-hint').textContent = edu
    ? 'Для учеников и учителей школы. Код выдаёт школа, логином станет ваше ФИО.'
    : 'Обычный аккаунт: придумайте ник и пароль.';
  registerError.textContent = '';
}

document.querySelectorAll('.reg-mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    registerMode = tab.dataset.mode === 'edu' ? 'edu' : 'classic';
    try {
      localStorage.setItem('mm_reg_mode', registerMode);
    } catch {
      /* не страшно */
    }
    applyRegisterMode();
  });
});
applyRegisterMode();

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const server = SERVER_ADDRESS;
  const edu = registerMode === 'edu';
  const password = document.getElementById('register-password').value;
  const passwordConfirm = document.getElementById('register-password-confirm').value;

  if (password !== passwordConfirm) {
    registerError.textContent = 'Пароли не совпадают';
    return;
  }

  try {
    let url;
    let body;
    if (edu) {
      const code = document.getElementById('register-code').value.trim();
      if (!code) throw new Error('Введите код регистрации');
      url = '/api/register-code';
      body = { code, password };
    } else {
      const username = document.getElementById('register-username').value.trim();
      if (!username) throw new Error('Введите ник');
      url = '/api/register';
      body = { username, password };
    }

    const res = await fetch(server + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось зарегистрироваться');

    // после успешной регистрации переключаем на вкладку входа с готовым логином
    const login = edu ? data.login || '' : body.username;
    document.querySelector('.tab[data-tab="login"]').click();
    document.getElementById('login-username').value = login;
    document.getElementById('register-code').value = '';
    document.getElementById('register-password').value = '';
    document.getElementById('register-password-confirm').value = '';
    loginError.textContent = edu
      ? 'Готово! Ваш логин: «' + login + '». Войдите с этим паролем'
      : 'Готово! Теперь войдите под ником «' + login + '»';
  } catch (err) {
    registerError.textContent = err.message;
  }
});

// --- автовход, если уже есть сохранённая сессия ---
async function tryAutoLogin() {
  const savedToken = localStorage.getItem('mm_token');
  const savedUsername = localStorage.getItem('mm_username');
  if (!savedToken || !savedUsername) return;

  serverHttp = SERVER_ADDRESS;
  serverWs = toWs(SERVER_ADDRESS);
  token = savedToken;
  myUsername = savedUsername;
  await enterChat();
}

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('mm_token');
  localStorage.removeItem('mm_username');
  if (ws) ws.close();
  location.reload();
});

// --- аватар и "о себе": хранятся на сервере и видны друзьям.
// localStorage тут используется только как мгновенный локальный кэш
// (например, для аватарки в футере без лишнего похода в сеть) — источник
// истины всегда сервер, через /api/profile и /api/profiles.
function avatarKey(username) { return `mm_avatar_${username}`; }
function aboutKey(username) { return `mm_about_${username}`; }
function getAvatar(username) { return localStorage.getItem(avatarKey(username)) || ''; }
function getAboutMe(username) { return localStorage.getItem(aboutKey(username)) || ''; }

// У пользователей с плашкой уже есть иконка в футере — обычный аватар
// им не нужен, показываем кружок только для остальных.
function applyFooterAvatar() {
  const isCustomThemed = !!badgeOf(myUsername);
  if (isCustomThemed) {
    footerAvatar.classList.add('hidden');
    return;
  }
  footerAvatar.classList.remove('hidden');
  const avatar = getAvatar(myUsername);
  if (avatar) {
    footerAvatar.style.backgroundImage = safeAvatarCss(avatar);
    footerAvatar.textContent = '';
  } else {
    footerAvatar.style.backgroundImage = '';
    footerAvatar.textContent = myUsername ? myUsername[0].toUpperCase() : '?';
  }
}

function openSettingsModal() {
  const avatar = getAvatar(myUsername);
  settingsAvatarPreview.style.backgroundImage = safeAvatarCss(avatar);
  aboutMeInput.value = getAboutMe(myUsername);
  notificationsToggle.checked = localStorage.getItem('mm_notifications') === '1';
  renderFoldersSettingsList();
  settingsModal.classList.remove('hidden');

  handleError.textContent = '';
  handleInput.value = '...';

  // Подтягиваем актуальное состояние с сервера (источник истины) —
  // локальный кэш обновляем следом, чтобы совпадало.
  fetchMyProfile().then((profile) => {
    if (!profile) return;
    handleInput.value = profile.handle || '';

    if (profile.avatar !== undefined) {
      localStorage.setItem(avatarKey(myUsername), profile.avatar);
      settingsAvatarPreview.style.backgroundImage = safeAvatarCss(profile.avatar);
      applyFooterAvatar();
    }
    if (profile.about !== undefined) {
      localStorage.setItem(aboutKey(myUsername), profile.about);
      aboutMeInput.value = profile.about;
    }
  });
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettingsModal);
settingsCloseBtn.addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettingsModal();
});

avatarUploadBtn.addEventListener('click', () => avatarFileInput.click());

avatarFileInput.addEventListener('change', () => {
  const file = avatarFileInput.files[0];
  if (!file) return;

  const MAX_AVATAR_BYTES = 1_000_000; // ~1 МБ — с запасом под серверный лимit после base64
  if (file.size > MAX_AVATAR_BYTES) {
    alert(`Файл слишком большой (${(file.size / 1_000_000).toFixed(1)} МБ). Максимум — 1 МБ.`);
    avatarFileInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    localStorage.setItem(avatarKey(myUsername), reader.result);
    settingsAvatarPreview.style.backgroundImage = safeAvatarCss(reader.result);
    applyFooterAvatar();
    try {
      await authFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: reader.result }),
      });
    } catch (err) {
      alert('Не удалось сохранить аватар на сервере: ' + err.message);
    }
  };
  reader.readAsDataURL(file);
});

avatarRemoveBtn.addEventListener('click', async () => {
  localStorage.removeItem(avatarKey(myUsername));
  settingsAvatarPreview.style.backgroundImage = '';
  applyFooterAvatar();
  try {
    await authFetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatar: '' }),
    });
  } catch (err) {
    console.error('Не удалось убрать аватар на сервере', err);
  }
});

let aboutSyncTimer = null;
aboutMeInput.addEventListener('input', () => {
  localStorage.setItem(aboutKey(myUsername), aboutMeInput.value);

  // Не долбим сервер на каждую нажатую клавишу — ждём паузы в наборе
  clearTimeout(aboutSyncTimer);
  const value = aboutMeInput.value;
  aboutSyncTimer = setTimeout(async () => {
    try {
      await authFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ about: value }),
      });
    } catch (err) {
      console.error('Не удалось сохранить "о себе" на сервере', err);
    }
  }, 700);
});

notificationsToggle.addEventListener('change', () => {
  localStorage.setItem('mm_notifications', notificationsToggle.checked ? '1' : '0');
  if (notificationsToggle.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }
});

clearLocalDataBtn.addEventListener('click', () => {
  // Аватар и "о себе" теперь хранятся на сервере и видны друзьям — сюда
  // их специально не включаю, чтобы кнопка "локальных" настроек случайно
  // не стирала то, что видят другие люди. Чистим только то, что реально
  // живёт только на этом устройстве.
  localStorage.removeItem('mm_theme');
  localStorage.removeItem('mm_notifications');
  localStorage.removeItem(foldersKey(myUsername));
  applyTheme('blue');
  notificationsToggle.checked = false;
  folders = [];
  currentFolder = 'all';
  folders = [];
  currentFolder = 'all';
  renderFoldersSettingsList();
  renderFolderTabs();
  renderChatList();
});

// --- папки чатов: только локально на этом устройстве, привязаны к нику ---
function foldersKey(username) { return `mm_folders_${username}`; }

function loadFolders() {
  try {
    return JSON.parse(localStorage.getItem(foldersKey(myUsername)) || '[]');
  } catch {
    return [];
  }
}

function saveFolders() {
  localStorage.setItem(foldersKey(myUsername), JSON.stringify(folders));
}

function switchFolder(folderId) {
  currentFolder = folderId;
  renderFolderTabs();
  renderChatList();
}

// Иконки для колонки папок: пузырь для "Все", обычная папка для остальных
const ALL_CHATS_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
  </svg>
`;
const FOLDER_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
  </svg>
`;

// Один пункт колонки папок: иконка сверху, подпись снизу, вертикально.
// Название папки — от юзера, поэтому оно всегда через textContent, не innerHTML.
function buildFolderRailItem(iconSvg, label, isActive, onClick) {
  const btn = document.createElement('button');
  btn.className = 'folder-rail-item' + (isActive ? ' active' : '');

  const icon = document.createElement('span');
  icon.className = 'folder-rail-icon';
  icon.innerHTML = iconSvg; // константа, не пользовательский ввод

  const text = document.createElement('span');
  text.className = 'folder-rail-label';
  text.textContent = label;

  btn.appendChild(icon);
  btn.appendChild(text);
  btn.addEventListener('click', onClick);
  return btn;
}

function renderFolderTabs() {
  folderTabsEl.innerHTML = '';

  folderTabsEl.appendChild(
    buildFolderRailItem(ALL_CHATS_ICON_SVG, 'Все', currentFolder === 'all', () => switchFolder('all'))
  );

  folders.forEach((folder) => {
    folderTabsEl.appendChild(
      buildFolderRailItem(FOLDER_ICON_SVG, folder.name, currentFolder === folder.id, () => switchFolder(folder.id))
    );
  });
}

// Список контактов в настройках — с чекбоксами, кого в какую папку включить
function renderFoldersSettingsList() {
  foldersListEl.innerHTML = '';

  folders.forEach((folder) => {
    const item = document.createElement('div');
    item.className = 'folder-item';

    const header = document.createElement('div');
    header.className = 'folder-item-header';

    const name = document.createElement('span');
    name.className = 'folder-item-name';
    name.textContent = folder.name;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-text';
    deleteBtn.textContent = 'Удалить';
    deleteBtn.addEventListener('click', () => {
      folders = folders.filter((f) => f.id !== folder.id);
      saveFolders();
      if (currentFolder === folder.id) currentFolder = 'all';
      renderFoldersSettingsList();
      renderFolderTabs();
      renderChatList();
    });

    header.appendChild(name);
    header.appendChild(deleteBtn);
    item.appendChild(header);

    const membersWrap = document.createElement('div');
    membersWrap.className = 'folder-members';

    if (contacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-members-empty';
      empty.textContent = 'Пока нет контактов';
      membersWrap.appendChild(empty);
    }

    contacts.forEach((username) => {
      const label = document.createElement('label');
      label.className = 'folder-member-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = folder.members.includes(username);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (!folder.members.includes(username)) folder.members.push(username);
        } else {
          folder.members = folder.members.filter((u) => u !== username);
        }
        saveFolders();
        if (currentFolder === folder.id) renderChatList();
      });

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(username));
      membersWrap.appendChild(label);
    });

    item.appendChild(membersWrap);
    foldersListEl.appendChild(item);
  });
}

createFolderBtn.addEventListener('click', () => {
  const name = newFolderNameInput.value.trim();
  if (!name) return;
  const id = 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  folders.push({ id, name, members: [] });
  saveFolders();
  newFolderNameInput.value = '';
  renderFoldersSettingsList();
  renderFolderTabs();
});

// --- поиск людей по @юзернейму ---
contactSearchBtn.addEventListener('click', doContactSearch);
contactSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doContactSearch();
  }
});

async function doContactSearch() {
  const query = contactSearchInput.value.trim().replace(/^@/, '');
  contactSearchResultEl.innerHTML = '';

  if (!query) {
    contactSearchResultEl.classList.add('hidden');
    return;
  }

  contactSearchResultEl.classList.remove('hidden');

  try {
    const data = await authFetch(`/api/search?handle=${encodeURIComponent(query)}`);
    renderSearchResult(data.user, data.status);
  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'contact-search-error';
    errEl.textContent = err.message;
    contactSearchResultEl.appendChild(errEl);
  }
}

// Карточка результата поиска — иконка-тема, если это один из троих
// кастомных юзеров, иначе обычный аватар-кружок с инициалом.
function renderSearchResult(user, status) {
  contactSearchResultEl.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'search-result-card';

  const identity = document.createElement('div');
  identity.className = 'search-result-identity';

  const badgeDef = badgeOf(user.username, user);

  if (badgeDef) {
    const badge = document.createElement('span');
    badge.className = 'chat-item-badge';
    applyPlate(badge, badgeDef);
    badge.appendChild(createBadgeIcon(badgeDef));
    badge.appendChild(createPlateName(user.username, badgeDef));
    identity.appendChild(badge);
  } else {
    const avatar = document.createElement('span');
    avatar.className = 'footer-avatar';
    if (user.avatar) {
      avatar.style.backgroundImage = safeAvatarCss(user.avatar);
    } else {
      avatar.textContent = user.username ? user.username[0].toUpperCase() : '?';
    }

    const name = document.createElement('span');
    name.className = 'search-result-name';
    name.textContent = user.username;

    identity.appendChild(avatar);
    identity.appendChild(name);
  }

  card.appendChild(identity);

  const handleLine = document.createElement('div');
  handleLine.className = 'search-result-handle';
  handleLine.textContent = '@' + user.handle;
  card.appendChild(handleLine);

  if (user.about) {
    const about = document.createElement('div');
    about.className = 'search-result-about';
    about.textContent = user.about;
    card.appendChild(about);
  }

  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'btn-secondary search-result-action';

  if (status === 'friends') {
    actionBtn.textContent = 'Уже в друзьях — открыть чат';
    actionBtn.addEventListener('click', () => switchChat(user.username, user.username));
  } else if (status === 'pending_sent') {
    actionBtn.textContent = 'Заявка отправлена';
    actionBtn.disabled = true;
  } else if (status === 'pending_received') {
    actionBtn.textContent = 'Уже прислал(а) вам заявку — смотри 🔔 сверху';
    actionBtn.disabled = true;
  } else {
    actionBtn.textContent = 'Попроситься в друзья';
    actionBtn.addEventListener('click', async () => {
      actionBtn.disabled = true;
      try {
        await authFetch('/api/friend-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toHandle: user.handle }),
        });
        actionBtn.textContent = 'Заявка отправлена';
      } catch (err) {
        actionBtn.disabled = false;
        actionBtn.textContent = err.message;
      }
    });
  }

  card.appendChild(actionBtn);
  contactSearchResultEl.appendChild(card);
}

// --- свой @юзернейм в настройках ---
async function fetchMyProfile() {
  try {
    const data = await authFetch('/api/profiles');
    return (data.profiles || []).find((p) => p.username === myUsername) || null;
  } catch {
    return null;
  }
}

saveHandleBtn.addEventListener('click', async () => {
  handleError.textContent = '';
  try {
    const data = await authFetch('/api/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handleInput.value.trim() }),
    });
    handleInput.value = data.handle;
  } catch (err) {
    handleError.textContent = err.message;
  }
});

// --- заявки в друзья ---
function openFriendRequestsModal() {
  friendRequestsModal.classList.remove('hidden');
  loadFriendRequests();
}

function closeFriendRequestsModal() {
  friendRequestsModal.classList.add('hidden');
}

friendRequestsBtn.addEventListener('click', openFriendRequestsModal);
friendRequestsCloseBtn.addEventListener('click', closeFriendRequestsModal);
friendRequestsModal.addEventListener('click', (e) => {
  if (e.target === friendRequestsModal) closeFriendRequestsModal();
});

async function loadFriendRequests() {
  try {
    const data = await authFetch('/api/friend-requests');
    const requests = data.requests || [];
    renderFriendRequestsList(requests);
    updateFriendRequestsBadge(requests.length);
  } catch (err) {
    console.error('Не удалось загрузить заявки в друзья', err);
  }
}

function updateFriendRequestsBadge(count) {
  if (count > 0) {
    friendRequestsBadge.textContent = String(count);
    friendRequestsBadge.classList.remove('hidden');
  } else {
    friendRequestsBadge.classList.add('hidden');
  }
}

function renderFriendRequestsList(requests) {
  friendRequestsListEl.innerHTML = '';

  if (requests.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'folder-members-empty';
    empty.textContent = 'Пока нет новых заявок';
    friendRequestsListEl.appendChild(empty);
    return;
  }

  requests.forEach((req) => {
    const row = document.createElement('div');
    row.className = 'friend-request-row';

    const info = document.createElement('div');
    info.className = 'friend-request-info';

    const handleLine = document.createElement('div');
    handleLine.className = 'friend-request-handle';
    handleLine.textContent = '@' + req.from.handle;

    const nickLine = document.createElement('div');
    nickLine.className = 'friend-request-nick';
    nickLine.appendChild(createNameNode(req.from.username, false, req.from));

    info.appendChild(handleLine);
    info.appendChild(nickLine);

    const actions = document.createElement('div');
    actions.className = 'friend-request-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'btn-secondary';
    acceptBtn.textContent = 'Принять';
    acceptBtn.addEventListener('click', () => respondToFriendRequest(req.id, true));

    const declineBtn = document.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'btn-text';
    declineBtn.textContent = 'Отклонить';
    declineBtn.addEventListener('click', () => respondToFriendRequest(req.id, false));

    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);

    row.appendChild(info);
    row.appendChild(actions);
    friendRequestsListEl.appendChild(row);
  });
}

async function respondToFriendRequest(id, accept) {
  try {
    await authFetch(`/api/friend-requests/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept }),
    });
    await loadFriendRequests();
    if (accept) await loadContacts();
  } catch (err) {
    console.error('Не удалось обработать заявку', err);
  }
}

// --- панель инфо о собеседнике (как в Discord) ---
async function refreshProfilesCache() {
  try {
    const data = await authFetch('/api/profiles');
    profilesCache = {};
    (data.profiles || []).forEach((p) => { profilesCache[p.username] = p; });
  } catch (err) {
    console.error('Не удалось загрузить профили', err);
  }
}

function contactNoteKey(me, contact) {
  return `mm_note_${me}_${contact}`;
}

function getContactNote(contact) {
  return localStorage.getItem(contactNoteKey(myUsername, contact)) || '';
}

contactPanelNote.addEventListener('input', () => {
  if (!currentChat) return;
  localStorage.setItem(contactNoteKey(myUsername, currentChat), contactPanelNote.value);
});

function formatJoinedDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// --- баннер сверху в панели собеседника ---
// У плашки может быть баннер: видео, которое проигрывается один раз при
// открытии панели и остаётся на последнем кадре, и картинка-заглушка.
// Файлы лежат на сервере и раздаются по /badge-assets/<имя>.
let bannerEl = null;
let bannerKey = null; // какой баннер сейчас показан (ник + файлы)

function bannerUrl(name) {
  return serverHttp + '/badge-assets/' + encodeURIComponent(name);
}

function clearBanner() {
  bannerKey = null;
  if (bannerEl) bannerEl.innerHTML = ''; // заодно останавливает видео
}

function renderBanner(username, badge) {
  const header = contactPanel.querySelector('.contact-panel-header');
  const banner = badge && badge.banner;
  if (header) header.classList.toggle('has-banner', !!banner);
  if (!banner || !header) {
    clearBanner();
    return;
  }

  // панель перерисовывается и от смены статуса «в сети», видео при этом
  // не должно запускаться заново: перезапуск только при смене контакта или файлов
  const key = username + '|' + banner.video + '|' + banner.poster;
  if (bannerKey === key) return;
  bannerKey = key;

  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'contact-panel-banner';
    header.insertBefore(bannerEl, header.firstChild);
  }
  bannerEl.innerHTML = '';
  bannerEl.style.setProperty('--bp-bg', plateGradient(badge));

  const reduceMotion =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (banner.video && !reduceMotion) {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = false;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    if (banner.poster) video.poster = bannerUrl(banner.poster);
    video.src = bannerUrl(banner.video);
    bannerEl.appendChild(video);
    const started = video.play();
    if (started && typeof started.catch === 'function') {
      started.catch(() => {
        /* автозапуск не разрешён: остаётся картинка-заглушка */
      });
    }
  } else if (banner.poster) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = bannerUrl(banner.poster);
    bannerEl.appendChild(img);
  }
}

function renderContactPanel(username) {
  const profile = profilesCache[username] || { username, handle: '', about: '', avatar: '', joinedAt: null };

  contactPanelAvatarWrap.innerHTML = '';

  const badgeDef = badgeOf(username);

  if (badgeDef) {
    const wrap = document.createElement('span');
    wrap.className = 'contact-panel-theme-avatar';
    applyPlate(wrap, badgeDef);
    wrap.appendChild(createBadgeIcon(badgeDef));
    contactPanelAvatarWrap.appendChild(wrap);
  } else {
    const avatar = document.createElement('span');
    avatar.className = 'contact-panel-avatar';
    if (profile.avatar) {
      avatar.style.backgroundImage = safeAvatarCss(profile.avatar);
    } else {
      avatar.textContent = username ? username[0].toUpperCase() : '?';
    }
    contactPanelAvatarWrap.appendChild(avatar);
  }

  renderBanner(username, badgeDef);

  contactPanelName.innerHTML = '';
  contactPanelName.appendChild(createNameNode(username));

  contactPanelHandle.textContent = profile.handle ? '@' + profile.handle : '';

  const online = onlineUsers.has(username);
  contactPanelStatus.textContent = online ? 'В сети' : 'Не в сети';
  contactPanelStatus.classList.toggle('online', online);

  contactPanelAbout.textContent = profile.about || 'Пока ничего не написал(а) о себе';

  if (profile.joinedAt) {
    contactPanelJoinedSection.classList.remove('hidden');
    contactPanelJoined.textContent = formatJoinedDate(profile.joinedAt);
  } else {
    contactPanelJoinedSection.classList.add('hidden');
  }

  contactPanelNote.value = getContactNote(username);
}

function updateContactPanelVisibility() {
  if (contactPanelOpen && currentChat) {
    renderContactPanel(currentChat);
    contactPanel.classList.remove('hidden');
  } else {
    contactPanel.classList.add('hidden');
    clearBanner(); // при следующем открытии баннер проиграется снова
  }
}

contactPanelToggleBtn.addEventListener('click', () => {
  contactPanelOpen = !contactPanelOpen;
  contactPanelToggleBtn.classList.toggle('active', contactPanelOpen);
  updateContactPanelVisibility();
});

// --- переход к экрану чата ---
async function enterChat() {
  authScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  renderMyFooter();

  currentChat = null;
  currentChatTitle.textContent = 'Выбери чат';
  sendForm.classList.add('hidden');
  contactPanelOpen = false;
  contactPanelToggleBtn.classList.remove('active');
  contactPanel.classList.add('hidden');

  folders = loadFolders();
  currentFolder = 'all';
  renderFolderTabs();
  renderMessages();

  if (localStorage.getItem('mm_notifications') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  await loadContacts();
  loadFriendRequests();
  await loadBadges();
  await refreshProfilesCache();
  renderMyFooter();
  renderChatList();
  await ensureMyKeyPair();
  connectWs();
}

async function loadContacts() {
  try {
    const res = await fetch(serverHttp + '/api/contacts', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    contacts = (data.users || []).filter((u) => u !== myUsername);
    renderChatList();
  } catch (err) {
    console.error('Не удалось загрузить список друзей', err);
  }
}

function renderChatList() {
  chatList.innerHTML = '';

  let visibleContacts = contacts;
  if (currentFolder !== 'all') {
    const folder = folders.find((f) => f.id === currentFolder);
    const members = folder ? folder.members : [];
    visibleContacts = contacts.filter((username) => members.includes(username));
  }

  if (visibleContacts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-list-empty';
    empty.textContent = currentFolder === 'all'
      ? 'Пока нет друзей — найди кого-нибудь через поиск выше'
      : 'В этой папке пока никого нет';
    chatList.appendChild(empty);
    return;
  }

  for (const username of visibleContacts) {
    chatList.appendChild(makeChatItem(username, username, true));
  }
}

function makeChatItem(chatId, label, showPresence) {
  const btn = document.createElement('button');
  btn.className = 'chat-item' + (chatId === currentChat ? ' active' : '');
  btn.dataset.chat = chatId;

  const badge = null; // плашки в списке чатов рисует chat-list.js

  if (badge) {
    btn.appendChild(badge);
  } else {
    if (showPresence) {
      const dot = document.createElement('span');
      dot.className = 'chat-item-dot' + (onlineUsers.has(chatId) ? ' online' : '');
      btn.appendChild(dot);
    }

    const name = document.createElement('span');
    name.className = 'chat-item-name';
    if (showPresence) {
      name.appendChild(createNameNode(label));
    } else {
      name.textContent = label;
    }
    btn.appendChild(name);
  }

  btn.addEventListener('click', () => switchChat(chatId, label));
  return btn;
}

function switchChat(chatId, label) {
  currentChat = chatId;
  currentChatTitle.innerHTML = '';
  currentChatTitle.appendChild(createNameNode(label));
  sendForm.classList.remove('hidden');
  renderChatList();
  renderMessages();
  updateContactPanelVisibility();

  if (!historyLoaded.has(chatId) && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'history', chat: chatId }));
  }
}

// --- WebSocket ---
function connectWs() {
  setStatus(false, 'подключение...');
  // токен первым сообщением, а не в адресе: адрес попадает в логи nginx
  ws = new WebSocket(`${serverWs}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
    setStatus(true, 'онлайн');
    if (currentChat) {
      ws.send(JSON.stringify({ type: 'history', chat: currentChat }));
      historyLoaded.add(currentChat);
    }
  };

  ws.onclose = () => {
    setStatus(false, 'нет соединения, переподключение...');
    setTimeout(connectWs, 2000);
  };

  ws.onerror = () => {
    setStatus(false, 'ошибка соединения');
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'presence') {
      onlineUsers = new Set(data.online.filter((u) => u !== myUsername));
      renderChatList();
      if (contactPanelOpen && currentChat) renderContactPanel(currentChat);
      return;
    }

    if (data.type === 'profile') {
      profilesCache[data.username] = {
        username: data.username,
        handle: data.handle,
        about: data.about,
        avatar: data.avatar,
        joinedAt: data.joinedAt,
        badge: data.badge,
      };
      if (contactPanelOpen && currentChat === data.username) renderContactPanel(currentChat);
      return;
    }

    if (data.type === 'badges_changed') {
      // на сервере изменили плашки: перечитываем определения и профили
      loadBadges()
        .then(refreshProfilesCache)
        .then(() => {
          renderMyFooter();
          renderChatList();
          renderMessages();
          if (currentChat) updateContactPanelVisibility();
        });
      return;
    }

    if (data.type === 'history') {
      messagesByChat[data.chat] = data.messages;
      historyLoaded.add(data.chat);
      if (data.chat === currentChat) renderMessages();
      return;
    }

    if (data.type === 'message') {
      const chatId = data.chat;
      if (!messagesByChat[chatId]) messagesByChat[chatId] = [];
      messagesByChat[chatId].push(data.message);
      if (chatId === currentChat) renderMessages();
      notifyIncomingMessage(chatId, data.message);
      return;
    }

    if (data.type === 'friend_request') {
      loadFriendRequests();
      return;
    }

    if (data.type === 'friend_accepted') {
      loadContacts();
      return;
    }

    if (data.type === 'error') {
      console.error('Сервер:', data.message);
      // токен истёк или недействителен: выходим, чтобы не переподключаться бесконечно
      if (typeof data.message === 'string' && data.message.startsWith('Неверный токен')) {
        localStorage.removeItem('mm_token');
        localStorage.removeItem('mm_username');
        location.reload();
      }
    }
  };
}

function setStatus(online, text) {
  statusDot.classList.toggle('online', online);
  statusText.textContent = text;
}

// Нативное уведомление на новое сообщение — только когда окно не в фокусе
// (свёрнуто/на заднем плане) и юзер сам включил это в настройках.
async function notifyIncomingMessage(contactUsername, message) {
  if (message.from === myUsername) return;
  if (localStorage.getItem('mm_notifications') !== '1') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;

  const plain = await decryptMessage(contactUsername, message.text, message.from);
  new Notification(message.from, { body: plain });
}

// --- отрисовка сообщений ---
// Заголовок сообщения. У кастомных юзеров — полоска сверху (как бейдж
// в списке ЛС: иконка + имя + время). У обычных — прежний плоский текст.
function buildMessageHeader(username, ts) {
  const time = new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const badgeDef = badgeOf(username);

  if (!badgeDef) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.appendChild(document.createTextNode(username));
    meta.appendChild(document.createTextNode(` · ${time}`));
    return meta;
  }

  const strip = document.createElement('div');
  strip.className = 'msg-strip';
  applyPlate(strip, badgeDef);

  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-strip-time';
  timeSpan.textContent = time;

  strip.appendChild(createBadgeIcon(badgeDef));
  strip.appendChild(createPlateName(username, badgeDef));
  strip.appendChild(timeSpan);
  return strip;
}

let renderMessagesToken = 0;

async function renderMessages() {
  const myToken = ++renderMessagesToken;
  messagesEl.innerHTML = '';

  if (!currentChat) {
    const empty = document.createElement('div');
    empty.className = 'msg-empty';
    empty.textContent = 'Выбери чат слева, чтобы начать переписку';
    messagesEl.appendChild(empty);
    return;
  }

  const list = messagesByChat[currentChat] || [];

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'msg-empty';
    empty.textContent = 'Сообщений пока нет';
    messagesEl.appendChild(empty);
    return;
  }

  // Расшифровываем всё разом; результат кэшируем прямо на объекте
  // сообщения (_plain), чтобы не перешифровывать заново при каждой
  // перерисовке. Ключ общий для переписки и не зависит от того, кто
  // из двоих отправитель, поэтому контакт для расшифровки — всегда currentChat.
  await Promise.all(
    list.map(async (msg) => {
      if (msg._plain === undefined) {
        msg._plain = await decryptMessage(currentChat, msg.text, msg.from);
      }
    })
  );

  if (myToken !== renderMessagesToken) return; // чат уже переключили — эта отрисовка устарела

  messagesEl.innerHTML = '';

  list.forEach((msg) => {
    const el = document.createElement('div');
    el.className = 'msg' + (msg.from === myUsername ? ' own' : '');

    el.appendChild(buildMessageHeader(msg.from, msg.ts));

    const body = document.createElement('div');
    body.className = 'msg-body';
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = msg._plain;
    body.appendChild(text);
    el.appendChild(body);

    messagesEl.appendChild(el);
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}


// --- отправка сообщений ---
sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentChat || !ws || ws.readyState !== WebSocket.OPEN) return;

  messageInput.value = '';

  try {
    const encrypted = await encryptMessage(currentChat, text);
    ws.send(JSON.stringify({ type: 'send', chat: currentChat, text: encrypted }));
  } catch (err) {
    messageInput.value = text; // вернуть текст обратно в поле, раз не ушло
    alert(err.message);
  }
});

tryAutoLogin();

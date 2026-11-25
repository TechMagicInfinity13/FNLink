// Один ключ шифрования на аккаунт, который можно перенести между устройствами.
//
// Раньше каждое устройство создавало СВОЮ пару ключей и при каждом запуске
// перезаписывало ключ аккаунта на сервере. Получалось «кто запустился
// последним, тот и прав»: второе устройство переставало читать переписку.
//
// Теперь:
//  - устройство без ключа НЕ создаёт новый ключ, если у аккаунта он уже есть,
//    а просит перенести его с другого устройства;
//  - ключ другого устройства на сервере НЕ затирается молча;
//  - пока ключи не совпадают, отправка отключена (иначе собеседник получил бы
//    сообщение, которое не сможет прочитать);
//  - в Настройках появился раздел «Шифрование»: экспорт и импорт ключа
//    под паролем, отпечаток ключа.
//
// Подключается ПОСЛЕ renderer.js. Сам renderer.js не меняется: подменяются
// функции ensureMyKeyPair и encryptMessage.
//
// Перенос ключа на новое устройство делается автоматически: на новом устройстве
// после входа появляется окно «подтвердите на другом устройстве», на старом
// устройстве приходит запрос, и после подтверждения показывается код из 6
// символов, который нужно ввести на новом. Сервер ключа прочитать не может.
(() => {
  const FAIL_TEXT = '⚠️ Не удалось расшифровать сообщение';
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const KDF_ITER = 600000;
  const KEY_PREFIX = 'FNKEY1.';

  // ok: всё в порядке; mismatch: на сервере ключ другого устройства;
  // missing: у аккаунта ключ есть, а на этом устройстве его нет; error: нет связи
  let keyState = { status: 'ok', hasLocal: false, fingerprint: '' };

  // ---------- вспомогательное ----------

  function sameKey(a, b) {
    try {
      const x = typeof a === 'string' ? JSON.parse(a) : a;
      const y = typeof b === 'string' ? JSON.parse(b) : b;
      return !!x && !!y && x.x === y.x && x.y === y.y;
    } catch {
      return false;
    }
  }

  // короткий «отпечаток» публичного ключа: по нему можно убедиться, что на двух
  // устройствах один и тот же ключ
  async function fingerprintOf(pub) {
    const data = new TextEncoder().encode(pub.x + '.' + pub.y);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const hex = Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    return hex.match(/.{4}/g).join(' ');
  }

  async function loadLocalPair() {
    const stored = localStorage.getItem(myKeyStoreKey());
    if (!stored) return null;
    try {
      const { pub, priv } = JSON.parse(stored);
      const publicKey = await crypto.subtle.importKey('jwk', pub, CURVE, true, []);
      const privateKey = await crypto.subtle.importKey('jwk', priv, CURVE, true, ['deriveBits']);
      return { pub, priv, pair: { publicKey, privateKey } };
    } catch (err) {
      console.error('Не удалось прочитать ключ шифрования на этом устройстве', err);
      return null;
    }
  }

  function storeLocal(pub, priv) {
    const current = localStorage.getItem(myKeyStoreKey());
    // страховка: прежний ключ остаётся рядом, если импорт был ошибкой
    if (current) localStorage.setItem(myKeyStoreKey() + '_backup', current);
    localStorage.setItem(myKeyStoreKey(), JSON.stringify({ pub, priv }));
  }

  async function generateNewKey() {
    const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return { pub, priv, pair };
  }

  // replace=true только в явных сценариях (импорт, «сделать основным», «создать новый»):
  // сервер не даёт молча заменить ключ аккаунта.
  async function publishPub(pub, replace) {
    await authFetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: JSON.stringify(pub), replaceKey: !!replace }),
    });
  }

  // ---------- экспорт / импорт ключа под паролем ----------

  async function deriveWrapKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function exportKeyString(password) {
    const stored = localStorage.getItem(myKeyStoreKey());
    if (!stored) throw new Error('На этом устройстве нет ключа, который можно экспортировать');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveWrapKey(password, salt, KDF_ITER);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(stored));
    const box = { i: KDF_ITER, s: bufToBase64(salt), v: bufToBase64(iv), c: bufToBase64(ct) };
    return KEY_PREFIX + btoa(JSON.stringify(box));
  }

  async function importKeyString(text, password) {
    const clean = String(text).replace(/\s+/g, '');
    if (!clean.startsWith(KEY_PREFIX)) throw new Error('Это не похоже на ключ FNLink');

    let box;
    try {
      box = JSON.parse(atob(clean.slice(KEY_PREFIX.length)));
    } catch {
      throw new Error('Ключ повреждён: скопируйте его целиком, без пропусков');
    }
    if (!box || !(box.i >= 100000 && box.i <= 2000000) || !box.s || !box.v || !box.c) {
      throw new Error('Ключ повреждён: скопируйте его целиком, без пропусков');
    }

    const key = await deriveWrapKey(password, new Uint8Array(base64ToBuf(box.s)), box.i);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(box.v)) }, key, base64ToBuf(box.c)
      );
    } catch {
      throw new Error('Неверный пароль или ключ повреждён');
    }

    return validateBundle(JSON.parse(new TextDecoder().decode(plain)));
  }

  // проверяем, что оба ключа импортируются и принадлежат одной паре
  async function validateBundle(obj) {
    if (!obj || !obj.pub || !obj.priv) throw new Error('В ключе не хватает данных');
    await crypto.subtle.importKey('jwk', obj.priv, CURVE, true, ['deriveBits']);
    await crypto.subtle.importKey('jwk', obj.pub, CURVE, true, []);
    if (obj.priv.x !== obj.pub.x || obj.priv.y !== obj.pub.y) throw new Error('Ключ повреждён');
    return { pub: obj.pub, priv: obj.priv };
  }

  // ---------- резервная копия ключа по коду восстановления ----------
  // Код придумывает приложение (20 знаков, около 100 бит), человек сохраняет его сам.
  // Ключ шифруется этим кодом на устройстве (формат FNKEY1, как у экспорта) и уходит
  // на сервер как непрозрачный набор байт: без кода его не прочитать ни серверу, ни
  // тому, кто получит доступ к данным сервера.

  const RECOVERY_LEN = 20;
  const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 знака без I, O, 0, 1

  function generateRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_LEN));
    return Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31]).join(''); // 256 делится на 32: без перекоса
  }

  function formatRecovery(code) {
    return code.match(/.{5}/g).join('-');
  }

  function normalizeRecovery(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function isValidRecovery(code) {
    return code.length === RECOVERY_LEN && Array.from(code).every((c) => RECOVERY_ALPHABET.includes(c));
  }

  async function buildBackup(code) {
    const local = await loadLocalPair();
    if (!local) throw new Error('На этом устройстве нет ключа');
    return { blob: await exportKeyString(code), fp: await fingerprintOf(local.pub) };
  }

  async function openBackup(blob, code) {
    try {
      return await importKeyString(blob, code);
    } catch (err) {
      if (/Неверный пароль/.test(err.message)) throw new Error('Код не подходит. Проверьте, нет ли опечаток.');
      throw err;
    }
  }

  const fetchBackupStatus = () => authFetch('/api/key-backup');
  const uploadBackup = (blob, fp) =>
    authFetch('/api/key-backup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob, fp }),
    });
  const deleteBackup = () => authFetch('/api/key-backup', { method: 'DELETE' });

  // ---------- перенос ключа по коду (криптография) ----------
  // Старое устройство шифрует ключ под временным ECDH-секретом с новым
  // устройством; сервер видит только шифротекст.

  const SAS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const SAS_LEN = 10; // длина кода (50 бит); такая же на сервере в transfer.js

  // Код из 6 символов; такая же функция на сервере (transfer.js)
  async function sasCode(id, nPubStr, oPubStr) {
    const data = new TextEncoder().encode('fnlink-sas-v2|' + id + '|' + nPubStr + '|' + oPubStr);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let out = '';
    for (let i = 0; i < SAS_LEN; i++) {
      let value = 0;
      for (let j = 0; j < 5; j++) {
        const bit = i * 5 + j;
        value = (value << 1) | ((hash[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      out += SAS_ALPHABET[value];
    }
    return out;
  }

  function normalizeCode(text) {
    return String(text || '').toUpperCase().replace(/[\s-]/g, '');
  }

  async function transferWrapKey(sharedBits, id) {
    const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('fnlink-transfer-v1:' + id),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function minimalJwk(jwk) {
    return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  }

  // Новое устройство: временная пара ключей для этого переноса
  async function makeTransferKeys() {
    const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, pubStr: minimalJwk(jwk) };
  }

  // Старое устройство: зашифровать свой ключ для нового
  async function buildTransfer(nPubStr, id, bundleStr) {
    const nPub = await crypto.subtle.importKey('jwk', JSON.parse(nPubStr), CURVE, true, []);
    const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const oJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: nPub }, eph.privateKey, 256);
    const key = await transferWrapKey(shared, id);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(bundleStr));
    return { oPubStr: minimalJwk(oJwk), ct: bufToBase64(ct), iv: bufToBase64(iv) };
  }

  // Новое устройство: расшифровать присланный ключ
  async function openTransfer(nPrivateKey, oPubStr, id, ctB64, ivB64) {
    const oPub = await crypto.subtle.importKey('jwk', JSON.parse(oPubStr), CURVE, true, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: oPub }, nPrivateKey, 256);
    const key = await transferWrapKey(shared, id);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(ivB64)) }, key, base64ToBuf(ctB64)
      );
    } catch {
      throw new Error('Не удалось расшифровать ключ: перенос нужно повторить');
    }
    return validateBundle(JSON.parse(new TextDecoder().decode(plain)));
  }

  // ---------- состояние ключа ----------

  async function fetchServerKey() {
    try {
      const data = await authFetch('/api/profiles');
      const mine = (data.profiles || []).find((p) => p.username === myUsername);
      return { ok: true, key: mine && mine.publicKey ? mine.publicKey : '' };
    } catch (err) {
      return { ok: false, key: '' };
    }
  }

  // isStartup=true: при входе (можно создать первый ключ или вернуть серверу
  // «забытый» ключ). false: только проверка, без побочных действий.
  async function evaluate(isStartup) {
    const server = await fetchServerKey();
    let local = await loadLocalPair();
    if (local) myKeyPair = local.pair; // старые сообщения этим ключом читаются

    let status;
    let freshKey = false; // ключ создан прямо сейчас: сразу предложим резервную копию
    if (!server.ok) {
      status = local ? 'ok' : 'error';
    } else if (local) {
      if (!server.key) {
        // сервер «забыл» ключ (например, его данные сбрасывали): возвращаем
        if (isStartup) {
          try { await publishPub(local.pub); } catch (err) { console.error('Не удалось опубликовать ключ', err); }
        }
        status = 'ok';
      } else {
        status = sameKey(server.key, local.pub) ? 'ok' : 'mismatch';
      }
    } else if (server.key) {
      status = 'missing'; // новое устройство: ключ нужно перенести, а не создавать
    } else if (isStartup) {
      // совсем новый аккаунт: ключа нет нигде, создаём первый
      const fresh = await generateNewKey();
      storeLocal(fresh.pub, fresh.priv);
      myKeyPair = fresh.pair;
      try { await publishPub(fresh.pub); } catch (err) { console.error('Не удалось опубликовать ключ', err); }
      local = fresh;
      status = 'ok';
      freshKey = true;
    } else {
      status = 'missing';
    }

    keyState = {
      status,
      hasLocal: !!local,
      fingerprint: local ? await fingerprintOf(local.pub) : '',
    };
    if (typeof document !== 'undefined') {
      refreshUi();
      // новое устройство: сразу предлагаем подтвердить вход на другом
      if (isStartup && status === 'missing') startTransferFlow();
      if (status !== 'error') refreshBackupStatus();
      if (freshKey) setTimeout(() => startBackupFlow(true), 800);
    }
  }

  const SEND_ERRORS = {
    mismatch:
      'Ключ этого устройства не совпадает с ключом аккаунта. Откройте Настройки → Шифрование: ' +
      'импортируйте ключ с другого устройства или сделайте этот ключ основным.',
    missing:
      'На этом устройстве нет ключа шифрования. Откройте Настройки → Шифрование ' +
      'и импортируйте ключ с другого устройства.',
    error: 'Не удалось проверить ключ шифрования. Проверьте связь и перезапустите приложение.',
  };

  // подмена функций из renderer.js
  window.ensureMyKeyPair = () => evaluate(true);

  const originalEncrypt = window.encryptMessage;
  window.encryptMessage = async function (contactUsername, plaintext) {
    if (keyState.status !== 'ok') throw new Error(SEND_ERRORS[keyState.status] || SEND_ERRORS.error);
    return originalEncrypt(contactUsername, plaintext);
  };

  // для проверки без браузера
  if (window.__FNLINK_TEST__) {
    window.__e2e = {
      exportKeyString, importKeyString, sameKey, fingerprintOf,
      sasCode, makeTransferKeys, buildTransfer, openTransfer, normalizeCode,
    };
  }

  if (typeof document === 'undefined') return;

  // ---------- интерфейс ----------

  const style = document.createElement('style');
  style.textContent =
    '#key-warning{margin:8px 8px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.4;' +
    'background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.5);color:var(--text)}' +
    '#key-warning button{margin-top:6px;display:block}' +
    '#e2e-section input,#e2e-section textarea{width:100%;box-sizing:border-box;background:var(--bg-2);' +
    'border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;' +
    'font-family:var(--font-sans)}' +
    '#e2e-section textarea{resize:vertical;margin-top:8px}' +
    '#e2e-section .e2e-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
    '#e2e-section label.settings-field{margin-top:10px}';
  document.head.appendChild(style);

  // плашка-предупреждение в боковой колонке
  const warning = document.createElement('div');
  warning.id = 'key-warning';
  warning.className = 'hidden';
  warning.innerHTML = '<span id="key-warning-text"></span>';
  const warningBtn = document.createElement('button');
  warningBtn.type = 'button';
  warningBtn.className = 'btn-secondary';
  warningBtn.textContent = 'Открыть настройки шифрования';
  const warningTransferBtn = document.createElement('button');
  warningTransferBtn.type = 'button';
  warningTransferBtn.className = 'btn-secondary';
  warningTransferBtn.textContent = 'Подтвердить на другом устройстве';
  warning.appendChild(warningTransferBtn);
  warning.appendChild(warningBtn);
  const sidebar = document.querySelector('.sidebar');
  const search = document.querySelector('.contact-search');
  if (sidebar && search) sidebar.insertBefore(warning, search);
  warningBtn.addEventListener('click', () => settingsBtn.click());
  warningTransferBtn.addEventListener('click', () => startTransferFlow());

  // раздел «Шифрование» в Настройках
  const body = document.querySelector('#settings-modal .modal-body');
  const section = document.createElement('section');
  section.className = 'settings-section';
  section.id = 'e2e-section';
  section.innerHTML =
    '<h3>Шифрование</h3>' +
    '<p class="settings-hint" id="e2e-status"></p>' +
    '<p class="settings-hint">Отпечаток ключа этого устройства: <b id="e2e-fp">нет</b></p>' +
    '<label class="settings-field">Пароль для переноса ключа (придумайте сами, не короче 8 символов; ' +
    'тот же пароль понадобится на другом устройстве)' +
    '<input type="password" id="e2e-pass" autocomplete="new-password" /></label>' +
    '<div class="e2e-row"><button type="button" class="btn-secondary" id="e2e-export-btn">Экспортировать ключ</button></div>' +
    '<textarea id="e2e-export-out" rows="3" readonly placeholder="Здесь появится ключ для переноса"></textarea>' +
    '<label class="settings-field">Ключ с другого устройства' +
    '<textarea id="e2e-import-in" rows="3" placeholder="Вставьте сюда ключ (начинается с FNKEY1.)"></textarea></label>' +
    '<div class="e2e-row"><button type="button" class="btn-secondary" id="e2e-import-btn">Импортировать ключ</button></div>' +
    '<div class="e2e-row"><button type="button" class="btn-secondary hidden" id="e2e-transfer-btn">' +
    'Подтвердить вход на другом устройстве</button></div>' +
    '<div class="e2e-row">' +
    '<button type="button" class="btn-text hidden" id="e2e-takeover-btn">Сделать ключ этого устройства основным</button>' +
    '<button type="button" class="btn-text hidden" id="e2e-create-btn">Создать новый ключ на этом устройстве</button>' +
    '</div>' +
    '<p class="settings-hint">Ключ открывает доступ ко всей вашей переписке. Переносите его только ' +
    'на свои устройства и никому не показывайте.</p>' +
    '<div class="auth-error" id="e2e-msg"></div>';
  if (body) body.appendChild(section);

  const $ = (id) => document.getElementById(id);
  const statusEl = $('e2e-status');
  const fpEl = $('e2e-fp');
  const passEl = $('e2e-pass');
  const exportOut = $('e2e-export-out');
  const importIn = $('e2e-import-in');
  const msgEl = $('e2e-msg');
  const takeoverBtn = $('e2e-takeover-btn');
  const createBtn = $('e2e-create-btn');
  const transferBtn = $('e2e-transfer-btn');
  transferBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    startTransferFlow();
  });

  function setMsg(text, isError = true) {
    msgEl.textContent = text;
    msgEl.style.color = isError ? '' : 'var(--accent)';
  }

  const STATUS_TEXT = {
    ok: 'Ключ этого устройства совпадает с ключом аккаунта: сообщения читаются и отправляются.',
    mismatch:
      '⚠️ На сервере ключ другого устройства, поэтому отправка здесь отключена (собеседники ' +
      'получили бы сообщения, которые не смогут прочитать). Импортируйте ключ с того устройства ' +
      'или сделайте ключ этого устройства основным.',
    missing:
      '⚠️ У аккаунта уже есть ключ, но он на другом устройстве. Нажмите «Подтвердить вход на ' +
      'другом устройстве» (проще всего), восстановите ключ по коду восстановления или импортируйте его вручную.',
    error: 'Не удалось проверить ключ на сервере. Проверьте связь и перезапустите приложение.',
  };

  function refreshUi() {
    const st = keyState.status;
    statusEl.textContent = STATUS_TEXT[st] || '';
    fpEl.textContent = keyState.fingerprint || 'нет';
    takeoverBtn.classList.toggle('hidden', !(st === 'mismatch' && keyState.hasLocal));
    createBtn.classList.toggle('hidden', st !== 'missing');
    transferBtn.classList.toggle('hidden', !(st === 'missing' || st === 'mismatch'));
    warningTransferBtn.classList.toggle('hidden', !(st === 'missing' || st === 'mismatch'));

    const bad = st === 'mismatch' || st === 'missing';
    warning.classList.toggle('hidden', !bad);
    $('key-warning-text').textContent =
      st === 'missing'
        ? 'На этом устройстве нет ключа шифрования: сообщения не читаются и не отправляются.'
        : 'Ключ шифрования этого устройства не совпадает с ключом аккаунта: отправка отключена.';
    refreshBackupUi();
  }

  settingsBtn.addEventListener('click', () => {
    setMsg('');
    evaluate(false);
  });

  $('e2e-export-btn').addEventListener('click', async () => {
    setMsg('');
    if (passEl.value.length < 8) return setMsg('Пароль должен быть не короче 8 символов');
    try {
      const str = await exportKeyString(passEl.value);
      exportOut.value = str;
      exportOut.focus();
      exportOut.select();
      try {
        await navigator.clipboard.writeText(str);
        setMsg('Ключ скопирован. Вставьте его на другом устройстве и введите тот же пароль.', false);
      } catch {
        setMsg('Ключ показан ниже: скопируйте его вручную.', false);
      }
    } catch (err) {
      setMsg(err.message);
    }
  });

  $('e2e-import-btn').addEventListener('click', async () => {
    setMsg('');
    if (!importIn.value.trim()) return setMsg('Вставьте ключ');
    if (!passEl.value) return setMsg('Введите пароль, который вы задали при экспорте');
    try {
      const obj = await importKeyString(importIn.value, passEl.value);
      const current = await loadLocalPair();
      if (current && !sameKey(current.pub, obj.pub)) {
        if (!confirm('Ключ на этом устройстве будет заменён. Сообщения, зашифрованные прежним ключом, ' +
          'перестанут читаться (копия прежнего ключа сохранится на устройстве). Продолжить?')) return;
      }
      storeLocal(obj.pub, obj.priv);
      await publishPub(obj.pub, true);
      location.reload();
    } catch (err) {
      setMsg(err.message);
    }
  });

  takeoverBtn.addEventListener('click', async () => {
    setMsg('');
    if (!confirm('Собеседники смогут писать только на это устройство. Сообщения, зашифрованные ключом ' +
      'другого устройства, перестанут читаться. Продолжить?')) return;
    try {
      const local = await loadLocalPair();
      if (!local) return setMsg('На этом устройстве нет ключа');
      await publishPub(local.pub, true);
      location.reload();
    } catch (err) {
      setMsg('Не удалось обновить ключ на сервере: ' + err.message);
    }
  });

  createBtn.addEventListener('click', async () => {
    setMsg('');
    if (!confirm('Будет создан новый ключ. Прежняя переписка станет нечитаемой на всех устройствах, ' +
      'пока вы не вернёте старый ключ. Если у вас есть код восстановления, нажмите «Отмена» и ' +
      'используйте «Восстановить по коду». Продолжить?')) return;
    try {
      const fresh = await generateNewKey();
      storeLocal(fresh.pub, fresh.priv);
      await publishPub(fresh.pub, true);
      location.reload();
    } catch (err) {
      setMsg('Не удалось создать ключ: ' + err.message);
    }
  });


  // ---------- перенос ключа на новое устройство: экраны ----------

  const ktStyle = document.createElement('style');
  ktStyle.textContent =
    '#kt-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;padding:16px;background:rgba(0,0,0,.72)}' +
    '#kt-card{width:100%;max-width:420px;max-height:100%;overflow-y:auto;box-sizing:border-box;' +
    'background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;color:var(--text)}' +
    '#kt-card h3{margin:0 0 12px;font-size:16px}' +
    '#kt-card p{margin:0 0 12px;font-size:13px;line-height:1.5;color:var(--text-dim)}' +
    '#kt-card .kt-device{color:var(--text);font-weight:600}' +
    '#kt-card .kt-code{margin:8px 0 14px;text-align:center;font-family:var(--font-mono);font-size:34px;' +
    'font-weight:700;letter-spacing:6px;color:var(--accent)}' +
    '#kt-card input{width:100%;box-sizing:border-box;margin-bottom:8px;background:var(--bg-2);' +
    'border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);' +
    'font-family:var(--font-mono);font-size:22px;letter-spacing:5px;text-align:center;text-transform:uppercase}' +
    '#kt-card .kt-error{min-height:18px;margin-bottom:8px;font-size:12px;color:var(--danger)}' +
    '#kt-card .kt-buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}';
  document.head.appendChild(ktStyle);

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text; // только textContent: имя устройства приходит с сервера
    return el;
  }

  function ktShow(title, nodes, buttons) {
    let overlay = document.getElementById('kt-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kt-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '';
    const card = document.createElement('div');
    card.id = 'kt-card';
    card.appendChild(h('h3', '', title));
    nodes.forEach((n) => card.appendChild(n));
    const row = h('div', 'kt-buttons');
    buttons.forEach((b) => {
      const btn = h('button', b.className || 'btn-secondary', b.text);
      btn.type = 'button';
      btn.addEventListener('click', b.onClick);
      row.appendChild(btn);
    });
    card.appendChild(row);
    overlay.appendChild(card);
    return card;
  }

  function ktClose() {
    const overlay = document.getElementById('kt-overlay');
    if (overlay) overlay.remove();
  }

  function deviceName() {
    const ua = navigator.userAgent || '';
    if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function' &&
        window.Capacitor.getPlatform() === 'android') return 'Телефон (Android)';
    if (/Windows/i.test(ua)) return 'Компьютер (Windows)';
    if (/Mac OS X/i.test(ua)) return 'Компьютер (macOS)';
    if (/Linux/i.test(ua)) return 'Компьютер (Linux)';
    return 'Новое устройство';
  }

  function formatCode(code) {
    return code.slice(0, 5) + '-' + code.slice(5);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- новое устройство ---
  let transferRun = null;

  async function cancelOwnTransfer(run) {
    run.cancelled = true;
    if (run.id) {
      try {
        await authFetch('/api/key-transfer/' + run.id + '/decline', { method: 'POST' });
      } catch (err) {
        /* запрос и так скоро истечёт */
      }
    }
  }

  function showTransferMessage(title, text, retry) {
    const buttons = [{ text: 'Закрыть', onClick: ktClose }];
    if (retry) buttons.unshift({ text: 'Повторить', className: 'btn-primary', onClick: () => { ktClose(); startTransferFlow(); } });
    buttons.push({
      text: 'Другие способы',
      className: 'btn-text',
      onClick: () => { ktClose(); settingsBtn.click(); },
    });
    ktShow(title, [h('p', '', text)], buttons);
  }

  async function startTransferFlow() {
    if (transferRun) return;
    const run = { cancelled: false, id: null };
    transferRun = run;

    try {
      const keys = await makeTransferKeys();
      const res = await authFetch('/api/key-transfer/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nPub: keys.pubStr, deviceName: deviceName() }),
      });
      run.id = res.id;

      const statusP = h('p', '', 'Ждём подтверждения…');
      ktShow(
        'Подтвердите вход на другом устройстве',
        [
          h('p', '', 'Чтобы читать переписку на этом устройстве, откройте FNLink на другом своём ' +
            'устройстве и нажмите «Подтвердить». Запрос действует 5 минут.'),
          statusP,
        ],
        [
          { text: 'Отмена', onClick: () => { cancelOwnTransfer(run); ktClose(); } },
          {
            text: 'Восстановить по коду',
            onClick: () => { cancelOwnTransfer(run); ktClose(); startRestoreFlow(); },
          },
          {
            text: 'У меня нет другого устройства',
            className: 'btn-text',
            onClick: () => { cancelOwnTransfer(run); ktClose(); settingsBtn.click(); },
          },
        ]
      );

      // ждём, пока старое устройство подтвердит
      let oPubStr = null;
      let failures = 0;
      while (!run.cancelled) {
        await sleep(2000);
        if (run.cancelled) return;
        let st;
        try {
          st = await authFetch('/api/key-transfer/' + run.id);
          failures = 0;
        } catch (err) {
          if (++failures >= 5) throw new Error('Нет связи с сервером');
          continue;
        }
        if (st.status === 'approved') { oPubStr = st.oPub; break; }
        if (st.status === 'declined') {
          return showTransferMessage('Вход отклонён', 'Запрос отклонили на другом устройстве.', true);
        }
        if (st.status === 'expired') {
          return showTransferMessage('Время вышло', 'Запрос не подтвердили за 5 минут.', true);
        }
      }
      if (run.cancelled) return;

      await askForCode(run, keys, oPubStr);
    } catch (err) {
      if (!run.cancelled) showTransferMessage('Не удалось перенести ключ', err.message, true);
    } finally {
      transferRun = null;
    }
  }

  // экран ввода кода; возвращает управление, когда код принят или окно закрыто
  function askForCode(run, keys, oPubStr) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = SAS_LEN + 1;
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
      input.placeholder = 'XXXXX-XXXXX';
      const errorEl = h('div', 'kt-error');
      let localFails = 0;
      let busy = false;

      const finish = () => { run.cancelled = true; resolve(); };

      const submit = async () => {
        if (busy) return;
        const typed = normalizeCode(input.value);
        if (typed.length !== SAS_LEN) { errorEl.textContent = 'Код состоит из ' + SAS_LEN + ' символов'; return; }
        busy = true;
        errorEl.textContent = '';
        try {
          // сверяем код с тем, который получается из ключей, что мы видим сами:
          // если ключи подменили по дороге, код не совпадёт
          const expected = await sasCode(run.id, keys.pubStr, oPubStr);
          if (typed !== expected) {
            localFails += 1;
            if (localFails >= 5) {
              cancelOwnTransfer(run);
              showTransferMessage('Слишком много попыток', 'Код введён неверно 5 раз. Начните заново.', true);
              return finish();
            }
            errorEl.textContent = 'Код не совпадает. Проверьте его на другом устройстве (осталось попыток: ' +
              (5 - localFails) + ')';
            return;
          }

          const res = await authFetch('/api/key-transfer/' + run.id + '/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: typed }),
          });
          if (res.oPub !== oPubStr) throw new Error('Данные переноса изменились по дороге, повторите');
          const bundle = await openTransfer(keys.privateKey, oPubStr, run.id, res.ct, res.iv);
          storeLocal(bundle.pub, bundle.priv);
          ktShow('Готово', [h('p', '', 'Ключ перенесён. Перезапускаем приложение…')], []);
          setTimeout(() => location.reload(), 600);
          return finish();
        } catch (err) {
          errorEl.textContent = err.message;
        } finally {
          busy = false;
        }
      };

      ktShow(
        'Введите код',
        [
          h('p', '', 'На другом устройстве появился код из 10 символов. Введите его здесь.'),
          input,
          errorEl,
        ],
        [
          { text: 'Подтвердить', className: 'btn-primary', onClick: submit },
          { text: 'Отмена', onClick: () => { cancelOwnTransfer(run); ktClose(); finish(); } },
        ]
      );
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      input.focus();
    });
  }

  // --- старое устройство ---
  let approval = null; // { id, step: 'ask' | 'code' }

  function onTransferRequest(msg) {
    // подтверждать можно только с устройства, где ключ в порядке
    if (!(keyState.status === 'ok' && keyState.hasLocal)) return;
    if (approval && approval.id === msg.id) return;
    approval = { id: msg.id, step: 'ask' };

    const deviceEl = h('p', '');
    deviceEl.appendChild(document.createTextNode('Устройство: '));
    deviceEl.appendChild(h('span', 'kt-device', msg.deviceName || 'Новое устройство'));

    ktShow(
      'Новое устройство хочет войти в аккаунт',
      [
        deviceEl,
        h('p', '', 'Если вы сейчас сами входите в FNLink на этом устройстве, нажмите «Подтвердить». ' +
          'Если вы ничего не делали, нажмите «Это не я»: возможно, кто-то узнал ваш пароль.'),
      ],
      [
        {
          text: 'Подтвердить',
          className: 'btn-primary',
          onClick: async () => {
            try {
              const bundleStr = localStorage.getItem(myKeyStoreKey());
              const built = await buildTransfer(msg.nPub, msg.id, bundleStr);
              await authFetch('/api/key-transfer/' + msg.id + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oPub: built.oPubStr, ct: built.ct, iv: built.iv }),
              });
              approval = { id: msg.id, step: 'code' };
              const code = await sasCode(msg.id, msg.nPub, built.oPubStr);
              ktShow(
                'Введите этот код на новом устройстве',
                [
                  h('div', 'kt-code', formatCode(code)),
                  h('p', '', 'Код действует 5 минут. Никому его не говорите и не вводите нигде, кроме ' +
                    'устройства, на котором вы входите.'),
                ],
                [{ text: 'Готово', className: 'btn-primary', onClick: () => { approval = null; ktClose(); } }]
              );
            } catch (err) {
              approval = null;
              ktShow('Не получилось подтвердить', [h('p', '', err.message)], [{ text: 'Закрыть', onClick: ktClose }]);
            }
          },
        },
        {
          text: 'Это не я',
          onClick: async () => {
            approval = null;
            ktClose();
            try {
              await authFetch('/api/key-transfer/' + msg.id + '/decline', { method: 'POST' });
            } catch (err) {
              console.error('Не удалось отклонить запрос', err);
            }
          },
        },
      ]
    );
  }

  // другое устройство уже ответило или запрос истёк: закрываем окно вопроса
  function onTransferClosed(msg) {
    if (approval && approval.id === msg.id && approval.step === 'ask') {
      approval = null;
      ktClose();
    }
  }

  // ---------- когда у собеседника сменился ключ ----------
  // sharedKeyCache хранит общий ключ переписки до перезапуска. Если собеседник
  // сменил ключ, сбрасываем кэш и снова пробуем расшифровать то, что не вышло.
  function retryFailed(chatId) {
    delete sharedKeyCache[chatId];
    const list = messagesByChat[chatId] || [];
    for (const msg of list) {
      if (msg._plain === FAIL_TEXT) msg._plain = undefined;
    }
    if (chatId === currentChat) renderMessages();
  }

  // ---------- резервная копия ключа: экраны ----------

  const bkStyle = document.createElement('style');
  bkStyle.textContent =
    '#backup-banner{margin:8px 8px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.4;' +
    'background:rgba(59,130,246,.14);border:1px solid rgba(59,130,246,.5);color:var(--text)}' +
    '#backup-banner .bk-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
    '#kt-card .kt-reccode{margin:6px 0 14px;text-align:center;font-family:var(--font-mono);font-size:22px;' +
    'font-weight:700;letter-spacing:3px;line-height:1.6;color:var(--accent);user-select:all}' +
    '#kt-card input.kt-rec{font-size:16px;letter-spacing:2px}' +
    '#e2e-backup{margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}';
  document.head.appendChild(bkStyle);

  let backupInfo = null; // { exists, current, updatedAt }; null, пока не узнали
  let backupDismissed = false; // «напомнить позже» действует до перезапуска приложения
  let backupFlowOpen = false;

  const mkButton = (text, className) => {
    const b = h('button', className || 'btn-secondary', text);
    b.type = 'button';
    return b;
  };

  // напоминание в боковой колонке
  const backupBanner = h('div');
  backupBanner.id = 'backup-banner';
  backupBanner.className = 'hidden';
  const backupBannerText = h('span');
  const bannerRow = h('div', 'bk-row');
  const backupBannerBtn = mkButton('Создать код восстановления');
  const backupBannerLater = mkButton('Позже', 'btn-text');
  bannerRow.appendChild(backupBannerBtn);
  bannerRow.appendChild(backupBannerLater);
  backupBanner.appendChild(backupBannerText);
  backupBanner.appendChild(bannerRow);
  if (sidebar && search) sidebar.insertBefore(backupBanner, search);
  backupBannerBtn.addEventListener('click', () => startBackupFlow(false));
  backupBannerLater.addEventListener('click', () => { backupDismissed = true; refreshBackupUi(); });

  // блок в Настройках → Шифрование
  const bkBlock = h('div');
  bkBlock.id = 'e2e-backup';
  const bkTitle = h('p', 'settings-hint');
  bkTitle.appendChild(h('b', '', 'Резервная копия ключа'));
  const bkStatusEl = h('p', 'settings-hint');
  const bkHint = h('p', 'settings-hint',
    'Код восстановления нужен, если вы потеряете все устройства или переустановите приложение: ' +
    'по нему ключ вернётся, и переписка снова откроется. Мы не можем восстановить сам код.');
  const bkButtons = h('div', 'e2e-row');
  const bkCreateBtn = mkButton('Создать код восстановления');
  const bkRestoreBtn = mkButton('Восстановить по коду', 'btn-secondary hidden');
  const bkDeleteBtn = mkButton('Удалить резервную копию', 'btn-text hidden');
  [bkCreateBtn, bkRestoreBtn, bkDeleteBtn].forEach((b) => bkButtons.appendChild(b));
  [bkTitle, bkStatusEl, bkHint, bkButtons].forEach((n) => bkBlock.appendChild(n));
  if (msgEl && msgEl.parentNode) msgEl.parentNode.insertBefore(bkBlock, msgEl);

  function refreshBackupUi() {
    const info = backupInfo;
    const st = keyState.status;
    const canBackup = st === 'ok' && keyState.hasLocal;
    const stale = !!info && info.exists && !info.current;
    const none = !!info && !info.exists;

    const needs = canBackup && (stale || none) && !backupDismissed;
    backupBanner.classList.toggle('hidden', !needs);
    if (needs) {
      backupBannerText.textContent = stale
        ? 'Резервная копия относится к прежнему ключу и уже не поможет. Создайте новый код восстановления.'
        : 'Резервной копии ключа нет. Если потерять устройство, переписка пропадёт навсегда.';
    }

    bkCreateBtn.classList.toggle('hidden', !canBackup);
    bkCreateBtn.textContent = info && info.exists ? 'Создать новый код восстановления' : 'Создать код восстановления';
    bkRestoreBtn.classList.toggle('hidden', !(st === 'missing' || st === 'mismatch'));
    bkDeleteBtn.classList.toggle('hidden', !(info && info.exists));

    let text = '';
    if (info) {
      if (!info.exists) text = 'Резервной копии нет.';
      else if (!info.current) text = 'Копия относится к прежнему ключу и уже не поможет: создайте новую.';
      else {
        text = 'Копия создана' + (info.updatedAt ? ' ' + new Date(info.updatedAt).toLocaleString('ru-RU') : '') +
          '. Код восстановления есть только у вас.';
      }
    }
    bkStatusEl.textContent = text;
  }

  async function refreshBackupStatus() {
    try {
      backupInfo = await fetchBackupStatus();
    } catch (err) {
      return; // нет связи или старый сервер без этих запросов: просто ничего не показываем
    }
    refreshBackupUi();
  }

  // создание копии: показать код, проверить, что его сохранили, зашифровать и отправить
  function startBackupFlow(first) {
    if (backupFlowOpen) return;
    if (!(keyState.status === 'ok' && keyState.hasLocal)) return;
    backupFlowOpen = true;
    settingsModal.classList.add('hidden');

    const code = generateRecoveryCode();
    const shown = formatRecovery(code);
    const close = () => { backupFlowOpen = false; ktClose(); };

    const showCode = () => {
      const box = h('div', 'kt-reccode');
      box.appendChild(h('div', '', shown.slice(0, 11)));
      box.appendChild(h('div', '', shown.slice(12)));
      ktShow(
        first ? 'Сохраните код восстановления' : 'Код восстановления',
        [
          h('p', '', (first ? 'Ваш ключ шифрования создан. ' : '') +
            'Этот код единственный способ вернуть переписку, если вы потеряете телефон или переустановите ' +
            'приложение. Запишите его на бумаге или сохраните в надёжном месте. Он показывается один раз, ' +
            'мы не можем его восстановить.'),
          box,
          h('p', '', 'Никому не показывайте код и не отправляйте его в чатах.'),
        ],
        [
          {
            text: 'Скопировать',
            onClick: async (e) => {
              const btn = e.currentTarget;
              try { await navigator.clipboard.writeText(shown); btn.textContent = 'Скопировано'; }
              catch { btn.textContent = 'Скопируйте вручную'; }
            },
          },
          { text: 'Я сохранил код', className: 'btn-primary', onClick: showCheck },
          { text: 'Позже', className: 'btn-text', onClick: close },
        ]
      );
    };

    const showCheck = () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 8;
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
      input.placeholder = 'XXXX';
      const errorEl = h('div', 'kt-error');
      let busy = false;

      const submit = async () => {
        if (busy) return;
        if (normalizeRecovery(input.value) !== code.slice(-4)) {
          errorEl.textContent = 'Последние 4 знака не совпадают. Проверьте, как вы записали код.';
          return;
        }
        busy = true;
        errorEl.textContent = 'Шифруем и сохраняем…';
        try {
          const { blob, fp } = await buildBackup(code);
          // убеждаемся, что копия открывается этим кодом и содержит именно наш ключ
          const check = await openBackup(blob, code);
          const local = await loadLocalPair();
          if (!local || !sameKey(check.pub, local.pub)) throw new Error('Проверка копии не прошла, попробуйте ещё раз');
          const res = await uploadBackup(blob, fp);
          backupInfo = { exists: true, current: true, updatedAt: res.updatedAt || new Date().toISOString() };
          refreshBackupUi();
          ktShow(
            'Готово',
            [h('p', '', 'Резервная копия сохранена. Код хранится только у вас: сохраните его надёжно.')],
            [{ text: 'Закрыть', className: 'btn-primary', onClick: close }]
          );
        } catch (err) {
          errorEl.textContent = err.message;
          busy = false;
        }
      };

      ktShow(
        'Проверка',
        [h('p', '', 'Чтобы убедиться, что код сохранён, введите его последние 4 знака.'), input, errorEl],
        [
          { text: 'Сохранить копию', className: 'btn-primary', onClick: submit },
          { text: 'Назад', onClick: showCode },
          { text: 'Отмена', className: 'btn-text', onClick: close },
        ]
      );
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      input.focus();
    };

    showCode();
  }

  // восстановление ключа на новом устройстве по коду
  async function startRestoreFlow() {
    if (backupFlowOpen) return;
    backupFlowOpen = true;
    settingsModal.classList.add('hidden');
    const close = () => { backupFlowOpen = false; ktClose(); };
    const closeBtn = { text: 'Закрыть', onClick: close };
    const otherWays = {
      text: 'Другие способы',
      className: 'btn-text',
      onClick: () => { close(); settingsBtn.click(); },
    };

    ktShow('Восстановление по коду', [h('p', '', 'Проверяем резервную копию…')], []);
    let data;
    let server;
    try {
      const info = await fetchBackupStatus();
      if (!info.exists) {
        return ktShow('Резервной копии нет',
          [h('p', '', 'Для этого аккаунта код восстановления не создавался. Остаётся перенос с другого ' +
            'устройства или импорт ключа. Если ничего этого нет, можно создать новый ключ, но прежняя ' +
            'переписка при этом не откроется.')],
          [closeBtn, otherWays]);
      }
      if (!info.current) {
        return ktShow('Копия устарела',
          [h('p', '', 'Резервная копия относится к прежнему ключу аккаунта и не поможет прочитать нынешнюю переписку.')],
          [closeBtn, otherWays]);
      }
      data = await authFetch('/api/key-backup/blob');
      server = await fetchServerKey();
      if (!server.ok || !server.key) throw new Error('Не удалось проверить ключ аккаунта. Проверьте связь.');
    } catch (err) {
      return ktShow('Не удалось восстановить', [h('p', '', err.message)], [closeBtn, otherWays]);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'kt-rec';
    input.maxLength = 30;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'characters');
    input.placeholder = 'XXXXX-XXXXX-XXXXX-XXXXX';
    const errorEl = h('div', 'kt-error');
    let busy = false;

    const submit = async () => {
      if (busy) return;
      const code = normalizeRecovery(input.value);
      if (!isValidRecovery(code)) {
        errorEl.textContent = 'Код состоит из 20 знаков: буквы A–Z (без I и O) и цифры 2–9.';
        return;
      }
      busy = true;
      errorEl.textContent = 'Проверяем код…';
      try {
        const obj = await openBackup(data.blob, code);
        if (!sameKey(server.key, obj.pub)) {
          throw new Error('Копия относится к другому ключу, чем тот, что сейчас у аккаунта.');
        }
        storeLocal(obj.pub, obj.priv);
        ktShow('Готово', [h('p', '', 'Ключ восстановлен. Перезапускаем приложение…')], []);
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        errorEl.textContent = err.message;
        busy = false;
      }
    };

    ktShow(
      'Введите код восстановления',
      [h('p', '', 'Введите 20 знаков, которые вы сохранили при создании резервной копии. ' +
        'Дефисы и регистр не важны.'), input, errorEl],
      [
        { text: 'Восстановить', className: 'btn-primary', onClick: submit },
        { text: 'Отмена', onClick: close },
        otherWays,
      ]
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
  }

  bkCreateBtn.addEventListener('click', () => startBackupFlow(false));
  bkRestoreBtn.addEventListener('click', () => startRestoreFlow());
  bkDeleteBtn.addEventListener('click', async () => {
    if (!confirm('Удалить резервную копию? Без неё при потере устройства переписку вернуть не получится.')) return;
    try {
      await deleteBackup();
      backupInfo = { exists: false, current: false, updatedAt: null };
      backupDismissed = false;
      refreshBackupUi();
      setMsg('Резервная копия удалена.', false);
    } catch (err) {
      setMsg(err.message);
    }
  });

  // ---------- ключи собеседников: предупреждение, если ключ сменился ----------
  // Первый увиденный ключ друга запоминаем (по отпечатку). Если сервер потом
  // отдаёт другой ключ, это либо друг создал новый, либо ключ подменили:
  // отправка ему блокируется, пока человек не подтвердит новый отпечаток.
  const PEER_FP_KEY = () => 'mm_peer_fp_' + myUsername;
  const peerChanged = {}; // username -> { oldFp, newFp }
  const peerPrompted = {}; // username -> newFp, по которому окно уже показывали
  const peerChecked = {}; // username -> строка ключа, которую уже проверили

  function loadPeerFps() {
    try {
      return JSON.parse(localStorage.getItem(PEER_FP_KEY()) || '{}') || {};
    } catch {
      return {};
    }
  }

  function showPeerChangedPrompt(contact, force) {
    const info = peerChanged[contact];
    if (!info) return;
    if (!force && peerPrompted[contact] === info.newFp) return;
    if (document.getElementById('kt-overlay')) return; // уже открыто другое окно
    peerPrompted[contact] = info.newFp;

    ktShow(
      'У собеседника изменился ключ шифрования',
      [
        h('p', '', 'Ключ шифрования пользователя ' + contact + ' изменился. Так бывает, если он создал ' +
          'новый ключ, но так же выглядит и подмена ключа на сервере. Отправка ему сообщений приостановлена.'),
        h('p', '', 'Свяжитесь с ним другим способом (звонок, личная встреча) и попросите назвать отпечаток ' +
          'из Настроек → Шифрование. Если он совпадает с новым, нажмите «Доверять».'),
        h('p', '', 'Был: ' + info.oldFp),
        h('p', '', 'Стал: ' + info.newFp),
      ],
      [
        {
          text: 'Доверять новому ключу',
          className: 'btn-primary',
          onClick: () => {
            const known = loadPeerFps();
            known[contact] = info.newFp;
            localStorage.setItem(PEER_FP_KEY(), JSON.stringify(known));
            delete peerChanged[contact];
            ktClose();
          },
        },
        { text: 'Закрыть', onClick: ktClose },
      ]
    );
  }

  async function checkPeerKey(contact) {
    const profile = profilesCache[contact];
    if (!profile || !profile.publicKey) return;
    if (peerChecked[contact] === profile.publicKey) return;
    peerChecked[contact] = profile.publicKey;

    let jwk;
    try {
      jwk = JSON.parse(profile.publicKey);
    } catch {
      return;
    }
    const fp = await fingerprintOf(jwk);
    const known = loadPeerFps();

    if (!known[contact]) {
      known[contact] = fp;
      localStorage.setItem(PEER_FP_KEY(), JSON.stringify(known));
      delete peerChanged[contact];
    } else if (known[contact] === fp) {
      delete peerChanged[contact];
    } else {
      peerChanged[contact] = { oldFp: known[contact], newFp: fp };
      showPeerChangedPrompt(contact, false);
    }
  }

  const baseGetSharedKey = window.getSharedKey;
  if (typeof baseGetSharedKey === 'function') {
    window.getSharedKey = async function (contact) {
      const key = await baseGetSharedKey(contact);
      try {
        await checkPeerKey(contact);
      } catch (err) {
        console.error('Не удалось проверить ключ собеседника', err);
      }
      return key;
    };
  }

  const baseEncrypt = window.encryptMessage;
  window.encryptMessage = async function (contact, plaintext) {
    if (keyState.status === 'ok') {
      await window.getSharedKey(contact); // заодно проверяет ключ собеседника
      if (peerChanged[contact]) {
        showPeerChangedPrompt(contact, true);
        throw new Error('У собеседника изменился ключ шифрования. Сверьте отпечаток, подтвердите новый ключ ' +
          'и повторите отправку.');
      }
    }
    return baseEncrypt(contact, plaintext);
  };

  const previousConnectWs = window.connectWs;
  if (typeof previousConnectWs === 'function') {
    window.connectWs = function () {
      previousConnectWs();
      if (!ws) return;
      ws.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === 'profile' && data.username && data.username !== myUsername) {
          retryFailed(data.username);
        } else if (data.type === 'key_transfer_request') {
          onTransferRequest(data);
        } else if (data.type === 'key_transfer_closed') {
          onTransferClosed(data);
        }
      });
    };
  }
})();

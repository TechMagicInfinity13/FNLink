// Групповые чаты школьной системы: группы по предметам и классная группа.
// Подключается ПОСЛЕ renderer.js, chat-list.js и e2e-keys.js и сам их не правит:
// подменяет несколько функций (как это делают chat-list.js и e2e-keys.js), а
// группы показывает в списке чатов как обычные контакты. Названием группы
// служит её идентификатор в чате, например «Алгебра · 8 МАТ-ИНФ».
//
// Шифрование (формат v2): сообщение шифруется случайным ключом K (AES-GCM),
// сам K шифруется отдельно для каждого участника ключом пары (ECDH + HKDF).
// В «связанные данные» (AAD) входят группа, отправитель и номер сообщения, поэтому
// сервер не может ни подделать отправителя, ни перенести сообщение в другую группу.
(() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  let groups = []; // [{ name, kind, className, subject, members: [{ username, role, publicKey }] }]
  const byName = new Map();
  const isGroup = (chat) => typeof chat === 'string' && byName.has(chat);

  const BAD = '⚠️ Не удалось расшифровать сообщение';

  // ---------- список групп ----------
  async function loadGroups() {
    try {
      const data = await authFetch('/api/groups');
      groups = Array.isArray(data.groups) ? data.groups : [];
    } catch (err) {
      console.error('Не удалось загрузить группы', err);
      return false;
    }
    byName.clear();
    for (const g of groups) byName.set(g.name, g);
    return true;
  }

  // Группа выглядит в интерфейсе как контакт: профиль-заглушка для панели и списка
  function applyGroupProfiles() {
    for (const g of groups) {
      profilesCache[g.name] = {
        username: g.name,
        handle: '',
        about: 'Участники: ' + g.members.map((m) => m.username).join(', '),
        avatar: '',
        joinedAt: null,
        publicKey: '',
        isGroup: true,
      };
    }
  }

  let groupsLoaded = false;

  // группы идут в списке первыми, дальше люди
  function mergeGroupContacts() {
    if (!groups.length) return;
    contacts = [...groups.map((g) => g.name), ...contacts.filter((c) => !byName.has(c))];
    applyGroupProfiles();
    renderChatList();
  }

  const baseLoadContacts = window.loadContacts;
  window.loadContacts = async function () {
    await baseLoadContacts();
    groupsLoaded = (await loadGroups()) || groupsLoaded;
    mergeGroupContacts();
  };

  // При автовходе renderer.js вызывает loadContacts() ещё ДО того, как этот файл загрузился
  // (tryAutoLogin стоит в конце renderer.js), и подмена его не затрагивает. Поэтому группы
  // добавляем и здесь: refreshProfilesCache() вызывается позже, когда подмена уже есть.
  const baseRefreshProfiles = window.refreshProfilesCache;
  window.refreshProfilesCache = async function () {
    await baseRefreshProfiles(); // базовая функция заменяет весь кэш профилей
    if (!groupsLoaded) groupsLoaded = await loadGroups();
    applyGroupProfiles();
    mergeGroupContacts();
  };

  // состав группы или чьи-то ключи изменились: перечитываем (с паузой, чтобы не частить)
  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(async () => {
      reloadTimer = null;
      try {
        await window.loadContacts();
      } catch (err) {
        console.error(err);
      }
    }, 1500);
  }

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
        if (data.type === 'groups_changed' || data.type === 'profile') scheduleReload();
      });
    };
  }

  // ---------- ключи ----------
  const pairKeys = new Map(); // «ник|ключ» -> AES-ключ пары (для упаковки ключей сообщений)

  async function pairKey(otherName, otherPublicKey) {
    const cacheKey = otherName + '|' + otherPublicKey;
    if (pairKeys.has(cacheKey)) return pairKeys.get(cacheKey);
    const pub = await crypto.subtle.importKey('jwk', JSON.parse(otherPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, myKeyPair.privateKey, 256);
    const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const info = enc.encode('mm-grp-v2-wrap:' + [myUsername, otherName].sort().join(':'));
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    pairKeys.set(cacheKey, key);
    return key;
  }

  const bodyAad = (group, from, mid) => enc.encode(`fnlink-grp-v2|${group}|${from}|${mid}`);
  const wrapAad = (group, from, to, mid) => enc.encode(`fnlink-grp-v2-key|${group}|${from}|${to}|${mid}`);
  const b64url = (bytes) => bufToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Отпечатки ключей участников: запоминаем первый увиденный, о смене предупреждаем
  async function fingerprint(jwk) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${jwk.crv}|${jwk.x}|${jwk.y}`));
    return Array.from(new Uint8Array(digest).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const fpStoreKey = () => 'mm_grp_fps_' + myUsername;

  async function checkMemberKeys(group) {
    let store = {};
    try {
      store = JSON.parse(localStorage.getItem(fpStoreKey()) || '{}') || {};
    } catch {
      store = {};
    }
    const changed = [];
    for (const m of group.members) {
      if (m.username === myUsername || !m.publicKey) continue;
      let jwk;
      try {
        jwk = JSON.parse(m.publicKey);
      } catch {
        continue;
      }
      const fp = await fingerprint(jwk);
      if (!store[m.username]) store[m.username] = fp;
      else if (store[m.username] !== fp) changed.push({ name: m.username, old: store[m.username], fp });
    }
    if (changed.length) {
      const lines = changed.map((c) => `• ${c.name}: был ${c.old}, стал ${c.fp}`).join('\n');
      const ok = window.confirm(
        'У участников группы изменился ключ шифрования:\n' + lines +
        '\n\nТак бывает, если человек вошёл с нового устройства или создал новый ключ. ' +
        'Если не уверены, спросите его другим способом.\n\nДоверять новым ключам и отправить сообщение?'
      );
      if (!ok) throw new Error('Отправка отменена: у участника изменился ключ шифрования');
      for (const c of changed) store[c.name] = c.fp;
    }
    try {
      localStorage.setItem(fpStoreKey(), JSON.stringify(store));
    } catch {
      /* не страшно */
    }
  }

  // ---------- отправка ----------
  let lastKeyRetry = 0;

  async function groupEncrypt(group, plaintext) {
    // Ключ мог ещё не загрузиться (приложение только запустилось) или загрузка оборвалась
    // из-за связи: пробуем инициализировать ещё раз (так же, как при входе).
    if (!myKeyPair && typeof window.ensureMyKeyPair === 'function' && Date.now() - lastKeyRetry > 60000) {
      lastKeyRetry = Date.now(); // не чаще раза в минуту: при «ключ на другом устройстве» откроется окно переноса
      try {
        await window.ensureMyKeyPair();
      } catch (err) {
        console.error('Не удалось загрузить ключ шифрования', err);
      }
    }
    if (!myKeyPair) {
      throw new Error(
        'На этом устройстве нет ключа шифрования. Откройте Настройки → Шифрование: ' +
        'перенесите ключ с другого устройства, где вы входили под этим аккаунтом.'
      );
    }

    // свежие ключи участников перед отправкой
    if (await loadGroups()) group = byName.get(group.name) || group;

    const me = group.members.find((m) => m.username === myUsername);
    if (!me || !me.publicKey) {
      throw new Error('Ваш ключ шифрования ещё не опубликован на сервере. Перезапустите приложение');
    }
    const myPub = await crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
    const serverPub = JSON.parse(me.publicKey);
    if (serverPub.x !== myPub.x || serverPub.y !== myPub.y) {
      throw new Error('Ключ этого устройства не совпадает с ключом вашего аккаунта (Настройки → Шифрование)');
    }

    await checkMemberKeys(group);

    const mid = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const messageKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: bodyAad(group.name, myUsername, mid) },
      messageKey,
      enc.encode(plaintext)
    );

    const keys = {};
    for (const m of group.members) {
      if (!m.publicKey) continue; // человек ещё ни разу не входил: сообщения не получит
      try {
        const pk = await pairKey(m.username, m.publicKey);
        const kiv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: kiv, additionalData: wrapAad(group.name, myUsername, m.username, mid) },
          pk,
          rawKey
        );
        keys[m.username] = { k: bufToBase64(wrapped), kiv: bufToBase64(kiv) };
      } catch (err) {
        console.warn('Не удалось подготовить ключ для ' + m.username, err);
      }
    }
    return JSON.stringify({ v: 2, g: 1, mid, iv: bufToBase64(iv), ct: bufToBase64(ct), keys });
  }

  // ---------- получение ----------
  async function groupDecrypt(group, payload, from) {
    // ключ этого аккаунта на устройстве не загружен (например, нужен перенос ключа)
    if (!myKeyPair) return '🔒 Ключ шифрования на этом устройстве не загружен';
    let p;
    try {
      p = JSON.parse(payload);
    } catch {
      return BAD;
    }
    if (!p || p.v !== 2 || p.g !== 1 || !p.mid || !p.iv || !p.ct || !p.k || !p.kiv || typeof p.from !== 'string') return BAD;

    // отправитель в сообщении и в заголовке должен совпадать, иначе сервер подменил автора
    if (typeof from !== 'string' || p.from !== from) return '⚠️ Автор сообщения не подтверждён';

    let sender = group.members.find((m) => m.username === from);
    if (!sender || !sender.publicKey) {
      if (await loadGroups()) {
        const fresh = byName.get(group.name);
        sender = fresh && fresh.members.find((m) => m.username === from);
      }
    }
    if (!sender || !sender.publicKey) return '⚠️ Нет ключа отправителя';

    try {
      const pk = await pairKey(from, sender.publicKey);
      const rawKey = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuf(p.kiv), additionalData: wrapAad(group.name, from, myUsername, p.mid) },
        pk,
        base64ToBuf(p.k)
      );
      const messageKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuf(p.iv), additionalData: bodyAad(group.name, from, p.mid) },
        messageKey,
        base64ToBuf(p.ct)
      );
      return dec.decode(plain);
    } catch (err) {
      console.error('Не удалось расшифровать групповое сообщение: ' + (err && err.name), err);
      return BAD;
    }
  }

  // ---------- подмена функций renderer.js ----------
  const previousEncrypt = window.encryptMessage;
  window.encryptMessage = async function (contact, plaintext) {
    if (!isGroup(contact)) return previousEncrypt(contact, plaintext);
    return groupEncrypt(byName.get(contact), plaintext);
  };

  const previousDecrypt = window.decryptMessage;
  window.decryptMessage = async function (contact, payload, from) {
    if (!isGroup(contact)) return previousDecrypt(contact, payload);
    return groupDecrypt(byName.get(contact), payload, from);
  };

  // Панель «Инфо»: у группы вместо «В сети» число участников
  const previousRenderPanel = window.renderContactPanel;
  if (typeof previousRenderPanel === 'function') {
    window.renderContactPanel = function (username) {
      previousRenderPanel(username);
      if (!isGroup(username)) return;
      const g = byName.get(username);
      contactPanelStatus.textContent = g.members.length + ' участн.';
      contactPanelStatus.classList.remove('online');
      contactPanelAbout.textContent = 'Участники: ' + g.members.map((m) => m.username).join(', ');
    };
  }

  // для проверки без браузера
  if (window.__FNLINK_TEST__) {
    window.__groups = { loadGroups, groupEncrypt, groupDecrypt, isGroup, applyGroupProfiles, byName };
  }
})();

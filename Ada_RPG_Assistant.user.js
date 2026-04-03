// ==UserScript==
// @name         Ada RPG Assistant (tchat + automation)
// @namespace    galydev.twitch.ada
// @version      2.3.0
// @description  Twitch GQL chat sniffer/sender + Ada RPG bot automation overlay. Auto-quest, auto-heal, auto-potion, auto-revive, inventory/shop/economy tracking with full HUD.
// @match        https://www.twitch.tv/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      gql.twitch.tv
// ==/UserScript==

(() => {
  'use strict';

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 1: tchat — GQL Sniffer + Sender Base Layer            ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const TAG = '[tchat]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const state = {
    debug: false,
    sendHash: null,
    channelID: null,
    sendVarsTemplate: null,
    sendOpName: 'sendChatMessage',
    capturedHeaders: {},
    cooldownMs: 500, // low internal cooldown; real pacing is the 2s queue timer
    lastSendAt: 0,
    lastTransport: null,
    lastGraphQLErrors: null,
  };

  const now = () => Date.now();

  function safeJsonParse(s) {
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  function deepClone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  function lcHeaders(h) {
    const out = {};
    try {
      if (h && typeof h.forEach === 'function') {
        h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
      } else if (h && typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
      }
    } catch (_) {}
    return out;
  }

  function stashCapturedHeaders(h) {
    const allow = [
      'client-id', 'authorization', 'x-device-id',
      'x-twitch-client-integrity', 'client-integrity', 'x-client-integrity',
    ];
    const merged = { ...state.capturedHeaders };
    for (const k of allow) {
      const v = h[k];
      if (v) merged[k] = v;
    }
    state.capturedHeaders = merged;
  }

  function looksLikeGraphQLResponseErrors(text) {
    const j = safeJsonParse(text);
    if (!j) return null;
    const arr = Array.isArray(j) ? j : [j];
    const errors = [];
    for (const item of arr) {
      if (item && Array.isArray(item.errors) && item.errors.length) {
        for (const e of item.errors) errors.push(e);
      }
    }
    return errors.length ? errors : null;
  }

  function findChannelIDDeep(obj) {
    const seen = new Set();
    const isPlausible = (v) => {
      if (v == null) return null;
      if (typeof v === 'number' && Number.isFinite(v)) v = String(Math.trunc(v));
      if (typeof v !== 'string') return null;
      const s = v.trim();
      if (!/^\d{6,12}$/.test(s)) return null;
      return s;
    };
    const KEY_HINTS = new Set([
      'channelid','channel_id','channelid',
      'roomid','room_id','roomid',
      'targetid','target_id','targetid',
      'broadcastid','broadcast_id','broadcastid',
      'ownerid','owner_id','ownerid',
      'senderid','sender_id','senderid',
    ].map(k => k.toLowerCase()));

    function walk(node, depth) {
      if (node == null || depth > 7 || typeof node !== 'object') return null;
      if (seen.has(node)) return null;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const x of node) { const r = walk(x, depth + 1); if (r) return r; }
        return null;
      }
      for (const [kRaw, v] of Object.entries(node)) {
        const k = String(kRaw).toLowerCase();
        if (KEY_HINTS.has(k)) { const p = isPlausible(v); if (p) return p; }
        if (k === 'input' && v && typeof v === 'object') {
          const p1 = isPlausible(v.channelID ?? v.channelId ?? v.channel_id);
          if (p1) return p1;
        }
        if (v && typeof v === 'object') { const r = walk(v, depth + 1); if (r) return r; }
      }
      return null;
    }
    return walk(obj, 0);
  }

  function setMessageInVars(vars, newMessage) {
    if (!vars || typeof vars !== 'object') return false;
    if (vars.input && typeof vars.input === 'object' && 'message' in vars.input) {
      vars.input.message = String(newMessage);
      return true;
    }
    if ('message' in vars) { vars.message = String(newMessage); return true; }
    const seen = new Set();
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 7) return false;
      if (seen.has(node)) return false;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const x of node) if (walk(x, depth + 1)) return true;
        return false;
      }
      for (const [k, v] of Object.entries(node)) {
        if (String(k).toLowerCase() === 'message' && (typeof v === 'string' || v == null)) {
          node[k] = String(newMessage); return true;
        }
        if (v && typeof v === 'object') { if (walk(v, depth + 1)) return true; }
      }
      return false;
    }
    return walk(vars, 0);
  }

  // --- localStorage persistence for captured template ---
  const LS_KEY = 'tchat_sender_template_v1';

  function saveStateToLS() {
    try {
      const payload = {
        sendHash: state.sendHash,
        channelID: state.channelID,
        sendVarsTemplate: state.sendVarsTemplate,
        sendOpName: state.sendOpName,
        capturedHeaders: state.capturedHeaders,
        savedAt: Date.now(),
      };
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
      log('Saved template to localStorage');
    } catch (e) { warn('Failed to save localStorage:', e); }
  }

  function loadStateFromLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const j = JSON.parse(raw);
      if (j.sendHash) state.sendHash = j.sendHash;
      if (j.channelID) state.channelID = j.channelID;
      if (j.sendVarsTemplate) state.sendVarsTemplate = j.sendVarsTemplate;
      if (j.sendOpName) state.sendOpName = j.sendOpName;
      if (j.capturedHeaders) state.capturedHeaders = j.capturedHeaders;
      log('Loaded template from localStorage');
      return true;
    } catch (e) { warn('Failed to load localStorage:', e); return false; }
  }

  // --- Page-context sniffer injection ---
  function injectPageSniffer() {
    const src = `(() => {
      'use strict';
      const post = (type, data) => {
        try { window.postMessage({ __tchat: true, type, data }, '*'); } catch (e) {}
      };
      const tryParse = (body) => {
        try { if (typeof body === 'string') return JSON.parse(body); } catch (e) {}
        return null;
      };
      const lcHeaders = (h) => {
        const out = {};
        try {
          if (h && typeof h.forEach === 'function') {
            h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
          } else if (h && typeof h === 'object') {
            for (const k in h) out[String(k).toLowerCase()] = String(h[k]);
          }
        } catch (e) {}
        return out;
      };
      const findChannelIDDeep = (obj) => {
        const seen = new Set();
        const isPlausible = (v) => {
          if (v == null) return null;
          if (typeof v === 'number' && Number.isFinite(v)) v = String(Math.trunc(v));
          if (typeof v !== 'string') return null;
          const s = v.trim();
          if (!/^\\d{6,12}$/.test(s)) return null;
          return s;
        };
        const KEY_HINTS = new Set([
          'channelid','channel_id','channelId','roomid','room_id','roomId',
          'targetid','target_id','targetId','broadcastid','broadcast_id','broadcastId',
          'ownerid','owner_id','ownerId','senderid','sender_id','senderId',
        ].map(k => k.toLowerCase()));
        function walk(node, depth) {
          if (node == null || depth > 7 || typeof node !== 'object') return null;
          if (seen.has(node)) return null;
          seen.add(node);
          if (Array.isArray(node)) {
            for (const x of node) { const r = walk(x, depth + 1); if (r) return r; }
            return null;
          }
          for (const key of Object.keys(node)) {
            const k = String(key).toLowerCase();
            const v = node[key];
            if (KEY_HINTS.has(k)) { const p = isPlausible(v); if (p) return p; }
            if (k === 'input' && v && typeof v === 'object') {
              const p1 = isPlausible(v.channelID ?? v.channelId ?? v.channel_id);
              if (p1) return p1;
            }
            if (v && typeof v === 'object') { const r = walk(v, depth + 1); if (r) return r; }
          }
          return null;
        }
        return walk(obj, 0);
      };
      const extract = (payload) => {
        const items = Array.isArray(payload) ? payload : [payload];
        let send = null;
        let anyChannelID = null;
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const op = item.operationName;
          if (op) post('opSeen', { op });
          if (!anyChannelID && item.variables) {
            anyChannelID = findChannelIDDeep(item.variables);
          }
          if (String(op || '').toLowerCase() === 'sendchatmessage') {
            const hash = item?.extensions?.persistedQuery?.sha256Hash;
            const vars = item.variables ? item.variables : null;
            const cid = vars ? findChannelIDDeep(vars) : null;
            send = {
              op,
              hash: (typeof hash === 'string' ? hash : null),
              channelID: (cid || anyChannelID || null),
              variables: vars,
            };
          }
        }
        return { send, anyChannelID };
      };
      // patch fetch
      const _fetch = window.fetch;
      if (_fetch) {
        window.fetch = async function(input, init) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
            const isGql = url.includes('gql.twitch.tv') || url.includes('/gql');
            if (isGql) {
              const headers = lcHeaders((init && init.headers) || (input && input.headers));
              const parsed = tryParse(init && init.body);
              if (parsed) {
                const ex = extract(parsed);
                if (ex.anyChannelID || ex.send?.hash) {
                  post('captured', { url, headers, send: ex.send, anyChannelID: ex.anyChannelID });
                }
              }
            }
          } catch (e) {}
          return _fetch.apply(this, arguments);
        };
        post('patched', { which: 'fetch' });
      }
      // patch XHR
      const _open = XMLHttpRequest.prototype.open;
      const _send = XMLHttpRequest.prototype.send;
      const _setReqHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__tchat_url = String(url || '');
        this.__tchat_headers = {};
        return _open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
        try { this.__tchat_headers[String(k).toLowerCase()] = String(v); } catch (e) {}
        return _setReqHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function(body) {
        try {
          const url = this.__tchat_url || '';
          const isGql = url.includes('gql.twitch.tv') || url.includes('/gql');
          if (isGql) {
            const parsed = tryParse(body);
            if (parsed) {
              const ex = extract(parsed);
              if (ex.anyChannelID || ex.send?.hash) {
                post('captured', { url, headers: this.__tchat_headers || {}, send: ex.send, anyChannelID: ex.anyChannelID });
              }
            }
          }
        } catch (e) {}
        return _send.apply(this, arguments);
      };
      post('patched', { which: 'xhr' });
    })();`;
    const s = document.createElement('script');
    s.textContent = src;
    (document.documentElement || document.head).appendChild(s);
    s.remove();
  }

  // --- Message listener from page sniffer ---
  window.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg || msg.__tchat !== true) return;

    if (msg.type === 'patched') {
      if (msg.data?.which === 'fetch') log('Patched fetch');
      if (msg.data?.which === 'xhr') log('Patched XHR');
      return;
    }
    if (msg.type === 'opSeen') {
      if (state.debug && msg.data?.op) log('saw op:', msg.data.op);
      return;
    }
    if (msg.type === 'captured') {
      const { headers, send, anyChannelID } = msg.data || {};
      const h = lcHeaders(headers || {});
      let changed = false;

      stashCapturedHeaders(h);

      if (!state.channelID && anyChannelID && /^\d{6,12}$/.test(String(anyChannelID))) {
        state.channelID = String(anyChannelID);
        log('Captured channelID', state.channelID);
        changed = true;
      }
      if (send && typeof send === 'object') {
        if (send.hash && !state.sendHash) {
          state.sendHash = send.hash;
          log('Captured sendChatMessage hash', state.sendHash);
          changed = true;
        }
        const cid = send.channelID ? String(send.channelID) : null;
        if (cid && !state.channelID && /^\d{6,12}$/.test(cid)) {
          state.channelID = cid;
          log('Captured channelID', state.channelID);
          changed = true;
        }
        if (send.variables && !state.sendVarsTemplate) {
          state.sendVarsTemplate = deepClone(send.variables);
          state.sendOpName = send.op || state.sendOpName;
          log('Captured sendChatMessage variables template');
          changed = true;
        }
      }
      if (changed && state.sendHash && state.sendVarsTemplate) saveStateToLS();
      return;
    }
  });

  // --- Sender ---
  function buildSendPayload(message) {
    if (!state.sendHash) throw new Error('missing_sendHash');
    if (!state.sendVarsTemplate) throw new Error('missing_sendVarsTemplate');
    const vars = deepClone(state.sendVarsTemplate);
    if (state.channelID) {
      if (vars.input && typeof vars.input === 'object' && ('channelID' in vars.input || 'channelId' in vars.input || 'channel_id' in vars.input)) {
        if ('channelID' in vars.input) vars.input.channelID = String(state.channelID);
        else if ('channelId' in vars.input) vars.input.channelId = String(state.channelID);
        else vars.input.channel_id = String(state.channelID);
      } else if ('channelID' in vars) {
        vars.channelID = String(state.channelID);
      }
    }
    const okSet = setMessageInVars(vars, message);
    if (!okSet) throw new Error('could_not_set_message_in_template');
    return [{
      operationName: state.sendOpName || 'sendChatMessage',
      variables: vars,
      extensions: { persistedQuery: { version: 1, sha256Hash: String(state.sendHash) } },
    }];
  }

  function minimalHeadersForGM() {
    const h = { 'content-type': 'text/plain;charset=UTF-8', 'accept': '*/*' };
    for (const k of ['client-id', 'authorization', 'x-device-id', 'x-twitch-client-integrity', 'client-integrity', 'x-client-integrity']) {
      const v = state.capturedHeaders[k];
      if (v) h[k] = v;
    }
    return h;
  }

  function sendViaGM(bodyText) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://gql.twitch.tv/gql',
        headers: minimalHeadersForGM(),
        data: bodyText,
        anonymous: false,
        withCredentials: true,
        onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText || '', transport: 'gm:https' }),
        onerror: (e) => resolve({ ok: false, status: 0, text: String(e && e.error ? e.error : 'GM onerror'), transport: 'gm:https' }),
      });
    });
  }

  async function tSend(message) {
    const msg = String(message || '');
    if (!msg) return { ok: false, reason: 'empty_message', state: tChatState() };
    const t = now();
    const dt = t - state.lastSendAt;
    if (dt < state.cooldownMs) {
      return { ok: false, reason: 'cooldown', waitMs: state.cooldownMs - dt, state: tChatState() };
    }
    state.lastSendAt = t;
    if (!state.sendHash) return { ok: false, reason: 'missing_sendHash', state: tChatState() };
    if (!state.channelID) warn('channelID missing, attempting send with template as-is');
    if (!state.sendVarsTemplate) return { ok: false, reason: 'missing_sendVarsTemplate', state: tChatState() };
    let payload;
    try { payload = buildSendPayload(msg); }
    catch (e) { return { ok: false, reason: String(e && e.message ? e.message : e), state: tChatState() }; }
    const bodyText = JSON.stringify(payload);
    const r = await sendViaGM(bodyText);
    state.lastTransport = r.transport;
    state.lastGraphQLErrors = looksLikeGraphQLResponseErrors(r.text);
    if (!r.ok) return { ok: false, reason: 'http_failed', status: r.status, raw: r.text, state: tChatState() };
    if (state.lastGraphQLErrors) return { ok: false, reason: 'graphql_errors', status: r.status, errors: state.lastGraphQLErrors, raw: r.text, state: tChatState() };
    return { ok: true, via: r.transport, status: r.status, raw: r.text };
  }

  function tChatState() {
    return {
      debug: state.debug,
      hasSendHash: !!state.sendHash,
      sendHashValue: state.sendHash,
      channelID: state.channelID,
      hasSendVarsTemplate: !!state.sendVarsTemplate,
      sendOpName: state.sendOpName,
      capturedHeaders: { ...state.capturedHeaders },
      cooldownMs: state.cooldownMs,
      lastTransport: state.lastTransport,
      lastGraphQLErrors: state.lastGraphQLErrors,
    };
  }

  async function tSelfTest() {
    const r = await tSend('/me test');
    log('SelfTest result:', r);
    return r;
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 2: Chat Log — Timestamped message capture             ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const CHAT_LOG_MAX = 5000;
  const CHAT_LOG_DB_NAME = 'ada_chatlog';
  const CHAT_LOG_STORE = 'messages';
  let chatLog = [];
  let chatLogDB = null;

  // --- IndexedDB persistence for chat log ---
  function openChatLogDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CHAT_LOG_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CHAT_LOG_STORE)) {
          const store = db.createObjectStore(CHAT_LOG_STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
          store.createIndex('sender', 'sender');
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => { warn('IndexedDB open failed:', e); reject(e); };
    });
  }

  async function initChatLogDB() {
    try {
      chatLogDB = await openChatLogDB();
      // Load recent entries into memory
      const tx = chatLogDB.transaction(CHAT_LOG_STORE, 'readonly');
      const store = tx.objectStore(CHAT_LOG_STORE);
      const all = await idbGetAll(store);
      // Keep only last CHAT_LOG_MAX in memory
      chatLog = all.slice(-CHAT_LOG_MAX);
      log(`Chat log loaded: ${chatLog.length} entries from IndexedDB`);

      // Prune old entries if DB is too large
      if (all.length > CHAT_LOG_MAX * 2) {
        pruneOldEntries(all.length - CHAT_LOG_MAX);
      }
    } catch (e) {
      warn('Chat log DB init failed, using memory only:', e);
    }
  }

  function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function pruneOldEntries(count) {
    if (!chatLogDB) return;
    try {
      const tx = chatLogDB.transaction(CHAT_LOG_STORE, 'readwrite');
      const store = tx.objectStore(CHAT_LOG_STORE);
      const req = store.openCursor();
      let deleted = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && deleted < count) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    } catch (e) { /* best effort */ }
  }

  function addChatLog(sender, message) {
    // Deduplication: skip if last entry has same sender, same message, and timestamp within 100ms
    if (chatLog.length > 0) {
      const last = chatLog[chatLog.length - 1];
      if (last.sender === sender && last.message === message) {
        const lastTs = new Date(last.ts).getTime();
        const nowTs = Date.now();
        if (Math.abs(nowTs - lastTs) < 100) return null;
      }
    }
    const entry = {
      ts: new Date().toISOString(),
      time: new Date().toLocaleTimeString('en-US', { hour12: false }),
      sender: sender,
      message: message,
    };
    chatLog.push(entry);
    if (chatLog.length > CHAT_LOG_MAX) chatLog.shift();

    // Persist to IndexedDB
    if (chatLogDB) {
      try {
        const tx = chatLogDB.transaction(CHAT_LOG_STORE, 'readwrite');
        tx.objectStore(CHAT_LOG_STORE).add(entry);
      } catch (e) { /* non-critical */ }
    }

    if (state.debug) console.log(`[chatlog] ${entry.time} <${sender}> ${message}`);
    return entry;
  }

  function getChatLog(count = 50) {
    return chatLog.slice(-count);
  }

  function searchChatLog(pattern, count = 50) {
    const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    const results = [];
    for (let i = chatLog.length - 1; i >= 0 && results.length < count; i--) {
      const e = chatLog[i];
      if (re.test(e.sender) || re.test(e.message)) results.unshift(e);
    }
    return results;
  }

  function dumpChatLog(count = 100) {
    const entries = getChatLog(count);
    console.group(`[Ada] Chat Log (last ${entries.length} messages)`);
    for (const e of entries) {
      console.log(`${e.time} <${e.sender}> ${e.message}`);
    }
    console.groupEnd();
    return entries;
  }

  function exportChatLog() {
    const entries = chatLog.slice();
    const text = entries.map(e => `[${e.ts}] <${e.sender}> ${e.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ada_chatlog_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    return `Exported ${entries.length} entries`;
  }

  function clearChatLog() {
    chatLog = [];
    if (chatLogDB) {
      try {
        const tx = chatLogDB.transaction(CHAT_LOG_STORE, 'readwrite');
        tx.objectStore(CHAT_LOG_STORE).clear();
      } catch (e) { /* best effort */ }
    }
    return 'Chat log cleared';
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 3: Shop Database                                      ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const SHOP_DB = {
    'primitive club':{tier:1,slot:'MainHand',gold:10,plat:0,dice:'1d8',avgDmg:4.5,skill:'None',skillBonus:0},
    'primitive sword':{tier:1,slot:'MainHand',gold:10,plat:0,dice:'1d8',avgDmg:4.5,skill:'None',skillBonus:0},
    'primitive shield':{tier:1,slot:'OffHand',gold:10,plat:0,dice:'1d4',avgDmg:2.5,skill:'None',skillBonus:0},
    'primitive bow':{tier:1,slot:'TwoHanded',gold:25,plat:0,dice:'1d12',avgDmg:6.5,skill:'None',skillBonus:0},
    'primitive greatsword':{tier:1,slot:'TwoHanded',gold:25,plat:0,dice:'1d4, 1d8',avgDmg:7,skill:'None',skillBonus:0},
    'primitive staff':{tier:1,slot:'TwoHanded',gold:10,plat:0,dice:'1d8',avgDmg:4.5,skill:'None',skillBonus:0},
    'iron club':{tier:2,slot:'MainHand',gold:100,plat:0,dice:'1d8, 2d3',avgDmg:8.5,skill:'None',skillBonus:0},
    'iron sword':{tier:2,slot:'MainHand',gold:100,plat:0,dice:'1d8, 2d3',avgDmg:8.5,skill:'None',skillBonus:0},
    'wooden shield':{tier:2,slot:'OffHand',gold:125,plat:0,dice:'2d5',avgDmg:6,skill:'None',skillBonus:0},
    'iron greatsword':{tier:2,slot:'TwoHanded',gold:180,plat:0,dice:'1d8, 2d4, 2d2',avgDmg:12.5,skill:'None',skillBonus:0},
    'wooden longbow':{tier:2,slot:'TwoHanded',gold:150,plat:0,dice:'1d10, 2d4, 1d2',avgDmg:12,skill:'None',skillBonus:0},
    'wooden staff':{tier:2,slot:'TwoHanded',gold:150,plat:0,dice:'1d10, 2d4, 1d2',avgDmg:12,skill:'None',skillBonus:0},
    'steel club':{tier:3,slot:'MainHand',gold:300,plat:0,dice:'1d8, 2d4, 1d3',avgDmg:11.5,skill:'None',skillBonus:0},
    'steel sword':{tier:3,slot:'MainHand',gold:300,plat:0,dice:'1d8, 2d4, 1d3',avgDmg:11.5,skill:'None',skillBonus:0},
    'steel shield':{tier:3,slot:'OffHand',gold:250,plat:0,dice:'3d6',avgDmg:10.5,skill:'None',skillBonus:0},
    'hardwood longbow':{tier:3,slot:'TwoHanded',gold:350,plat:0,dice:'1d12, 3d4',avgDmg:14,skill:'None',skillBonus:0},
    'hardwood staff':{tier:3,slot:'TwoHanded',gold:350,plat:0,dice:'1d12, 3d4',avgDmg:14,skill:'None',skillBonus:0},
    'steel greatsword':{tier:3,slot:'TwoHanded',gold:375,plat:0,dice:'1d8, 3d4, 2d2',avgDmg:15,skill:'None',skillBonus:0},
    'runed steel club':{tier:4,slot:'MainHand',gold:900,plat:0,dice:'1d16, 3d4',avgDmg:16,skill:'None',skillBonus:0},
    'runed steel sword':{tier:4,slot:'MainHand',gold:900,plat:0,dice:'1d16, 3d4',avgDmg:16,skill:'None',skillBonus:0},
    'runed steel shield':{tier:4,slot:'OffHand',gold:500,plat:0,dice:'4d6',avgDmg:14,skill:'None',skillBonus:0},
    'runed hardwood longbow':{tier:4,slot:'TwoHanded',gold:1200,plat:0,dice:'2d10, 2d8',avgDmg:20,skill:'None',skillBonus:0},
    'runed hardwood staff':{tier:4,slot:'TwoHanded',gold:1200,plat:0,dice:'2d10, 1d8, 1d6',avgDmg:19,skill:'None',skillBonus:0},
    'runed steel greatsword':{tier:4,slot:'TwoHanded',gold:1200,plat:0,dice:'1d10, 5d4, 3d2',avgDmg:22.5,skill:'None',skillBonus:0},
    'golden club':{tier:5,slot:'MainHand',gold:2400,plat:0,dice:'1d20, 6d6',avgDmg:31.5,skill:'None',skillBonus:0},
    'golden sword':{tier:5,slot:'MainHand',gold:2400,plat:0,dice:'1d20, 6d6',avgDmg:31.5,skill:'None',skillBonus:0},
    'platinum club':{tier:5,slot:'MainHand',gold:0,plat:400,dice:'1d20, 6d6',avgDmg:31.5,skill:'None',skillBonus:0},
    'platinum sword':{tier:5,slot:'MainHand',gold:0,plat:400,dice:'1d20, 6d6',avgDmg:31.5,skill:'None',skillBonus:0},
    'golden shield':{tier:5,slot:'OffHand',gold:1600,plat:0,dice:'5d6, 1d3',avgDmg:19.5,skill:'None',skillBonus:0},
    'platinum shield':{tier:5,slot:'OffHand',gold:0,plat:200,dice:'5d6, 1d3',avgDmg:19.5,skill:'None',skillBonus:0},
    'golden greatsword':{tier:5,slot:'TwoHanded',gold:3800,plat:0,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'golden longbow':{tier:5,slot:'TwoHanded',gold:3800,plat:0,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'golden staff':{tier:5,slot:'TwoHanded',gold:3800,plat:0,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'platinum greatsword':{tier:5,slot:'TwoHanded',gold:0,plat:600,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'platinum longbow':{tier:5,slot:'TwoHanded',gold:0,plat:600,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'platinum staff':{tier:5,slot:'TwoHanded',gold:0,plat:600,dice:'1d20, 7d6',avgDmg:35,skill:'None',skillBonus:0},
    'emerald club':{tier:6,slot:'MainHand',gold:0,plat:1600,dice:'1d20, 8d6, 1d4, 4d2',avgDmg:47,skill:'None',skillBonus:0},
    'emerald sword':{tier:6,slot:'MainHand',gold:0,plat:1600,dice:'1d20, 8d6, 1d4, 4d2',avgDmg:47,skill:'None',skillBonus:0},
    'emerald shield':{tier:6,slot:'OffHand',gold:0,plat:1600,dice:'1d16, 6d6',avgDmg:29.5,skill:'None',skillBonus:0},
    'emerald greatsword':{tier:6,slot:'TwoHanded',gold:0,plat:3200,dice:'1d20, 8d6, 1d14, 4d2',avgDmg:52,skill:'None',skillBonus:0},
    'emerald longbow':{tier:6,slot:'TwoHanded',gold:0,plat:3200,dice:'1d20, 8d6, 1d14, 4d2',avgDmg:52,skill:'None',skillBonus:0},
    'emerald staff':{tier:6,slot:'TwoHanded',gold:0,plat:3200,dice:'1d20, 8d6, 1d14, 4d2',avgDmg:52,skill:'None',skillBonus:0},
    'darksteel club':{tier:7,slot:'MainHand',gold:0,plat:2960,dice:'1d20, 8d6, 1d15, 8d2',avgDmg:58.5,skill:'None',skillBonus:0},
    'darksteel sword':{tier:7,slot:'MainHand',gold:0,plat:2960,dice:'1d20, 8d6, 1d15, 8d2',avgDmg:58.5,skill:'None',skillBonus:0},
    'darksteel shield':{tier:7,slot:'OffHand',gold:0,plat:2960,dice:'8d8',avgDmg:36,skill:'None',skillBonus:0},
    'darksteel greatsword':{tier:7,slot:'TwoHanded',gold:0,plat:5920,dice:'1d20, 8d6, 1d27, 8d2',avgDmg:64.5,skill:'None',skillBonus:0},
    'darksteel longbow':{tier:7,slot:'TwoHanded',gold:0,plat:5920,dice:'1d20, 8d6, 1d27, 8d2',avgDmg:64.5,skill:'None',skillBonus:0},
    'darksteel staff':{tier:7,slot:'TwoHanded',gold:0,plat:5920,dice:'1d20, 8d6, 1d27, 8d2',avgDmg:64.5,skill:'None',skillBonus:0},
    'obsidian club':{tier:8,slot:'MainHand',gold:0,plat:5476,dice:'1d20, 8d6, 1d24, 12d2',avgDmg:69,skill:'None',skillBonus:0},
    'obsidian sword':{tier:8,slot:'MainHand',gold:0,plat:5476,dice:'1d20, 8d6, 1d24, 12d2',avgDmg:69,skill:'None',skillBonus:0},
    'obsidian shield':{tier:8,slot:'OffHand',gold:0,plat:5476,dice:'9d8',avgDmg:40.5,skill:'None',skillBonus:0},
    'obsidian greatsword':{tier:8,slot:'TwoHanded',gold:0,plat:10952,dice:'1d20, 8d6, 1d40, 12d2',avgDmg:77,skill:'None',skillBonus:0},
    'obsidian longbow':{tier:8,slot:'TwoHanded',gold:0,plat:10952,dice:'1d20, 8d6, 1d40, 12d2',avgDmg:77,skill:'None',skillBonus:0},
    'obsidian staff':{tier:8,slot:'TwoHanded',gold:0,plat:10952,dice:'1d20, 8d6, 1d40, 12d2',avgDmg:77,skill:'None',skillBonus:0},
    'mythril club':{tier:9,slot:'MainHand',gold:0,plat:10131,dice:'1d20, 8d6, 1d38, 20d2',avgDmg:88,skill:'None',skillBonus:0},
    'mythril sword':{tier:9,slot:'MainHand',gold:0,plat:10131,dice:'1d20, 8d6, 1d38, 20d2',avgDmg:88,skill:'None',skillBonus:0},
    'mythril shield':{tier:9,slot:'OffHand',gold:0,plat:10131,dice:'10d8',avgDmg:45,skill:'None',skillBonus:0},
    'mythril greatsword':{tier:9,slot:'TwoHanded',gold:0,plat:20261,dice:'1d20, 8d6, 1d56, 20d2',avgDmg:97,skill:'None',skillBonus:0},
    'mythril longbow':{tier:9,slot:'TwoHanded',gold:0,plat:20261,dice:'1d20, 8d6, 1d56, 20d2',avgDmg:97,skill:'None',skillBonus:0},
    'mythril staff':{tier:9,slot:'TwoHanded',gold:0,plat:20261,dice:'1d20, 8d6, 1d56, 20d2',avgDmg:97,skill:'None',skillBonus:0},
    'starmetal club':{tier:10,slot:'MainHand',gold:0,plat:15196,dice:'1d20, 8d6, 1d52, 26d2',avgDmg:104,skill:'None',skillBonus:0},
    'starmetal sword':{tier:10,slot:'MainHand',gold:0,plat:15196,dice:'1d20, 8d6, 1d52, 26d2',avgDmg:104,skill:'None',skillBonus:0},
    'starmetal shield':{tier:10,slot:'OffHand',gold:0,plat:11398,dice:'11d8',avgDmg:49.5,skill:'None',skillBonus:0},
    'starmetal greatsword':{tier:10,slot:'TwoHanded',gold:0,plat:30392,dice:'1d20, 8d6, 1d71, 26d2',avgDmg:113.5,skill:'None',skillBonus:0},
    'starmetal longbow':{tier:10,slot:'TwoHanded',gold:0,plat:30392,dice:'1d20, 8d6, 1d71, 26d2',avgDmg:113.5,skill:'None',skillBonus:0},
    'starmetal staff':{tier:10,slot:'TwoHanded',gold:0,plat:30392,dice:'1d20, 8d6, 1d71, 26d2',avgDmg:113.5,skill:'None',skillBonus:0},
    'adamantite club':{tier:11,slot:'MainHand',gold:0,plat:20894,dice:'1d20, 8d6, 1d66, 30d2',avgDmg:117,skill:'None',skillBonus:0},
    'adamantite sword':{tier:11,slot:'MainHand',gold:0,plat:20894,dice:'1d20, 8d6, 1d66, 30d2',avgDmg:117,skill:'None',skillBonus:0},
    'adamantite shield':{tier:11,slot:'OffHand',gold:0,plat:18996,dice:'12d8',avgDmg:54,skill:'None',skillBonus:0},
    'adamantite greatsword':{tier:11,slot:'TwoHanded',gold:0,plat:37990,dice:'1d20, 8d6, 1d86, 30d2',avgDmg:127,skill:'None',skillBonus:0},
    'adamantite longbow':{tier:11,slot:'TwoHanded',gold:0,plat:37990,dice:'1d20, 8d6, 1d86, 30d2',avgDmg:127,skill:'None',skillBonus:0},
    'adamantite staff':{tier:11,slot:'TwoHanded',gold:0,plat:37990,dice:'1d20, 8d6, 1d86, 30d2',avgDmg:127,skill:'None',skillBonus:0},
    'dragonsteel club':{tier:12,slot:'MainHand',gold:0,plat:32924,dice:'1d20, 8d6, 1d80, 36d2',avgDmg:133,skill:'None',skillBonus:0},
    'dragonsteel sword':{tier:12,slot:'MainHand',gold:0,plat:32924,dice:'1d20, 8d6, 1d80, 36d2',avgDmg:133,skill:'None',skillBonus:0},
    'dragonsteel shield':{tier:12,slot:'OffHand',gold:0,plat:32924,dice:'13d8',avgDmg:58.5,skill:'None',skillBonus:0},
    'dragonsteel greatsword':{tier:12,slot:'TwoHanded',gold:0,plat:56986,dice:'1d20, 8d6, 1d101, 36d2',avgDmg:143.5,skill:'None',skillBonus:0},
    'dragonsteel longbow':{tier:12,slot:'TwoHanded',gold:0,plat:56986,dice:'1d20, 8d6, 1d101, 36d2',avgDmg:143.5,skill:'None',skillBonus:0},
    'dragonsteel staff':{tier:12,slot:'TwoHanded',gold:0,plat:56986,dice:'1d20, 8d6, 1d101, 36d2',avgDmg:143.5,skill:'None',skillBonus:0},
    'arcanite club':{tier:13,slot:'MainHand',gold:0,plat:50653,dice:'1d20, 8d6, 1d94, 44d2',avgDmg:152,skill:'None',skillBonus:0},
    'arcanite sword':{tier:13,slot:'MainHand',gold:0,plat:50653,dice:'1d20, 8d6, 1d94, 44d2',avgDmg:152,skill:'None',skillBonus:0},
    'arcanite shield':{tier:13,slot:'OffHand',gold:0,plat:50653,dice:'14d8',avgDmg:63,skill:'None',skillBonus:0},
    'arcanite greatsword':{tier:13,slot:'TwoHanded',gold:0,plat:94975,dice:'1d20, 8d6, 1d116, 44d2',avgDmg:163,skill:'None',skillBonus:0},
    'arcanite longbow':{tier:13,slot:'TwoHanded',gold:0,plat:94975,dice:'1d20, 8d6, 1d116, 44d2',avgDmg:163,skill:'None',skillBonus:0},
    'arcanite staff':{tier:13,slot:'TwoHanded',gold:0,plat:94975,dice:'1d20, 8d6, 1d116, 44d2',avgDmg:163,skill:'None',skillBonus:0},
    'etherium club':{tier:14,slot:'MainHand',gold:0,plat:94975,dice:'1d20, 8d6, 1d108, 50d2',avgDmg:168,skill:'None',skillBonus:0},
    'etherium sword':{tier:14,slot:'MainHand',gold:0,plat:94975,dice:'1d20, 8d6, 1d108, 50d2',avgDmg:168,skill:'None',skillBonus:0},
    'etherium shield':{tier:14,slot:'OffHand',gold:0,plat:94975,dice:'15d8',avgDmg:67.5,skill:'None',skillBonus:0},
    'etherium greatsword':{tier:14,slot:'TwoHanded',gold:0,plat:177286,dice:'1d20, 8d6, 1d131, 50d2',avgDmg:179.5,skill:'None',skillBonus:0},
    'etherium longbow':{tier:14,slot:'TwoHanded',gold:0,plat:177286,dice:'1d20, 8d6, 1d131, 50d2',avgDmg:179.5,skill:'None',skillBonus:0},
    'etherium staff':{tier:14,slot:'TwoHanded',gold:0,plat:177286,dice:'1d20, 8d6, 1d131, 50d2',avgDmg:179.5,skill:'None',skillBonus:0},
    'godsteel club':{tier:15,slot:'MainHand',gold:0,plat:200069,dice:'1d20, 8d6, 1d125, 56d2',avgDmg:185.5,skill:'None',skillBonus:0},
    'godsteel sword':{tier:15,slot:'MainHand',gold:0,plat:200069,dice:'1d20, 8d6, 1d125, 56d2',avgDmg:185.5,skill:'None',skillBonus:0},
    'godsteel shield':{tier:15,slot:'OffHand',gold:0,plat:200069,dice:'16d8',avgDmg:72,skill:'None',skillBonus:0},
    'godsteel greatsword':{tier:15,slot:'TwoHanded',gold:0,plat:400069,dice:'1d20, 8d6, 1d160, 56d2',avgDmg:203,skill:'None',skillBonus:0},
    'godsteel longbow':{tier:15,slot:'TwoHanded',gold:0,plat:400069,dice:'1d20, 8d6, 1d160, 56d2',avgDmg:203,skill:'None',skillBonus:0},
    'godsteel staff':{tier:15,slot:'TwoHanded',gold:0,plat:400069,dice:'1d20, 8d6, 1d160, 56d2',avgDmg:203,skill:'None',skillBonus:0},
    'celestial crystal club':{tier:16,slot:'MainHand',gold:0,plat:999999,dice:'1d20, 8d6, 1d180, 90d2',avgDmg:264,skill:'None',skillBonus:0},
    'celestial crystal sword':{tier:16,slot:'MainHand',gold:0,plat:999999,dice:'1d20, 8d6, 1d180, 90d2',avgDmg:264,skill:'None',skillBonus:0},
    'celestial crystal shield':{tier:16,slot:'OffHand',gold:0,plat:999999,dice:'18d8',avgDmg:81,skill:'None',skillBonus:0},
    'celestial crystal greatsword':{tier:16,slot:'TwoHanded',gold:0,plat:1999999,dice:'1d20, 8d6, 1d225, 90d2',avgDmg:286.5,skill:'None',skillBonus:0},
    'celestial crystal longbow':{tier:16,slot:'TwoHanded',gold:0,plat:1999999,dice:'1d20, 8d6, 1d225, 90d2',avgDmg:286.5,skill:'None',skillBonus:0},
    'celestial crystal staff':{tier:16,slot:'TwoHanded',gold:0,plat:1999999,dice:'1d20, 8d6, 1d225, 90d2',avgDmg:286.5,skill:'None',skillBonus:0},
    // Armor
    'leather armor':{tier:1,slot:'Armor',gold:100,plat:0,dice:'1d4',avgDmg:2.5,skill:'None',skillBonus:0},
    'padded armor':{tier:2,slot:'Armor',gold:200,plat:0,dice:'1d6',avgDmg:3.5,skill:'None',skillBonus:0},
    'chainmail armor':{tier:3,slot:'Armor',gold:0,plat:100,dice:'2d4',avgDmg:5,skill:'None',skillBonus:0},
    'scale mail':{tier:4,slot:'Armor',gold:0,plat:200,dice:'4d3',avgDmg:8,skill:'None',skillBonus:0},
    'half plate':{tier:5,slot:'Armor',gold:0,plat:400,dice:'5d3',avgDmg:10,skill:'None',skillBonus:0},
    'full plate':{tier:6,slot:'Armor',gold:0,plat:800,dice:'6d3',avgDmg:12,skill:'None',skillBonus:0},
    'darksteel armor':{tier:7,slot:'Armor',gold:0,plat:2960,dice:'6d3, 1d8',avgDmg:16.5,skill:'None',skillBonus:0},
    'obsidian armor':{tier:8,slot:'Armor',gold:0,plat:5476,dice:'6d3, 3d8',avgDmg:25.5,skill:'None',skillBonus:0},
    'mythril armor':{tier:9,slot:'Armor',gold:0,plat:10131,dice:'6d3, 5d8',avgDmg:34.5,skill:'None',skillBonus:0},
    'starmetal armor':{tier:10,slot:'Armor',gold:0,plat:15196,dice:'6d3, 7d8',avgDmg:43.5,skill:'None',skillBonus:0},
    'adamantite armor':{tier:11,slot:'Armor',gold:0,plat:20894,dice:'6d3, 9d8',avgDmg:52.5,skill:'None',skillBonus:0},
    'dragonsteel armor':{tier:12,slot:'Armor',gold:0,plat:32924,dice:'6d3, 11d8',avgDmg:61.5,skill:'None',skillBonus:0},
    'arcanite armor':{tier:13,slot:'Armor',gold:0,plat:50653,dice:'6d3, 13d8',avgDmg:70.5,skill:'None',skillBonus:0},
    'etherium armor':{tier:14,slot:'Armor',gold:0,plat:94975,dice:'6d3, 15d8',avgDmg:79.5,skill:'None',skillBonus:0},
    'godsteel armor':{tier:15,slot:'Armor',gold:0,plat:200069,dice:'6d3, 17d8',avgDmg:88.5,skill:'None',skillBonus:0},
    'celestial crystal armor':{tier:16,slot:'Armor',gold:0,plat:999999,dice:'6d3, 27d8',avgDmg:133.5,skill:'None',skillBonus:0},
    // Accessories T1
    'eyes of the omniscient':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:1},
    'glasses of keen eyes':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:6},
    'goggles of the skyborne':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:6},
    'mask of the untamed':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:6},
    'mask of whispers':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:6},
    'monocle':{tier:1,slot:'AccessoryFace',gold:500,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:6},
    'spectacles of the scholar':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:6},
    'veil of the enchantress':{tier:1,slot:'AccessoryFace',gold:250,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:6},
    'bandana':{tier:1,slot:'AccessoryHat',gold:500,plat:0,dice:'',avgDmg:0,skill:'Athletics',skillBonus:6},
    'cowl of the swift wind':{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:6},
    'crown of the steadfast':{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Athletics',skillBonus:6},
    "gale warden's helm":{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:1},
    'helm of the watchful':{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:6},
    'mystic circlet':{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:6},
    "sage's cap":{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:6},
    'shadow hood':{tier:1,slot:'AccessoryHat',gold:250,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:6},
    'top hat':{tier:1,slot:'AccessoryHat',gold:500,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:6},
    'amethyst pendant':{tier:1,slot:'AccessoryNeck',gold:500,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:6},
    'amulet of the silver tongue':{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:6},
    'choker of the hidden paths':{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:6},
    "druid's pendant":{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:6},
    "hunter's charm":{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:6},
    "pendant of the dragon's heart":{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:1},
    'purple scarf':{tier:1,slot:'AccessoryNeck',gold:500,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:6},
    'red scarf':{tier:1,slot:'AccessoryNeck',gold:500,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:6},
    "scribe's necklace":{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:6},
    'simple pendant':{tier:1,slot:'AccessoryNeck',gold:500,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:6},
    'star-stone amulet':{tier:1,slot:'AccessoryNeck',gold:500,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:6},
    'talisman of clarity':{tier:1,slot:'AccessoryNeck',gold:250,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:6},
    // Accessories T2
    'eyes of the infinite':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:2},
    'goggles of the sky dancer':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:12},
    'lenses of the eagle':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:12},
    'mask of silent steps':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:12},
    'mask of the wild guardian':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:12},
    'spectacles of arcane wisdom':{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:12},
    "veil of the siren's song":{tier:2,slot:'AccessoryFace',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:12},
    'arcane circlet':{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:12},
    'cowl of the gale rider':{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:12},
    'crown of the mountain king':{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Athletics',skillBonus:12},
    "helm of the eagle's gaze":{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:12},
    'helm of the skyward guardian':{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:2},
    "sage's cap of the ancients":{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:12},
    'shadow veil':{tier:2,slot:'AccessoryHat',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:12},
    'charm of the keen hunter':{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:12},
    "charm of the serpent's voice":{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:12},
    'choker of the silent shadow':{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:12},
    'pendant of the forest warden':{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:12},
    "scribe's amulet of lost knowledge":{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:12},
    'talisman of the eternal flame':{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:2},
    'talisman of the inner eye':{tier:2,slot:'AccessoryNeck',gold:2500,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:12},
    // Accessories T3
    'eyes of the divine':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:3},
    'goggles of the windwalker':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:18},
    'lenses of clarity':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:18},
    'mask of the phantom':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:18},
    'mask of the wilds':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:18},
    'spectacles of the grand archivist':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:18},
    'veil of eternal grace':{tier:3,slot:'AccessoryFace',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:18},
    'cap of the forgotten sage':{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:18},
    'eaglehelm':{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:18},
    'helm of the ancients':{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:3},
    'hood of the nightstalker':{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:18},
    "oracle's circlet":{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:18},
    'tempest cowl':{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Acrobatics',skillBonus:18},
    "titan's crown":{tier:3,slot:'AccessoryHat',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Athletics',skillBonus:18},
    "amulet of the dragon's voice":{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Persuasion',skillBonus:18},
    "archivist's amulet":{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Lore',skillBonus:18},
    "nature's heart pendant":{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Nature',skillBonus:18},
    'necklace of the divine':{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'All',skillBonus:3},
    'necklace of the phantom':{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Stealth',skillBonus:18},
    "seeker's charm":{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Perception',skillBonus:18},
    'talisman of the third eye':{tier:3,slot:'AccessoryNeck',gold:15000,plat:0,dice:'',avgDmg:0,skill:'Insight',skillBonus:18},
  };

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 4: Ada RPG Game State                                 ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const ADA_BOT = 'ada_rpg';

  const ada = {
    // toggles
    autoQuest: false,
    autoHeal: true,
    autoPotion: true,
    autoRevive: true,
    autoPotionThreshold: 0.7,

    // character
    playerName: null,
    level: null,
    playerClass: null,
    xp: null,
    xpMax: null,
    hp: null,
    hpMax: null,
    gold: null,
    plat: null,
    transfers: null,
    stance: null,
    attunement: null,
    equipped: {},
    equippedItems: [],   // flat list: ['mythril sword', 'adamantite shield', ...]

    // panel collapse
    panelCollapsed: false,

    // quest state
    inQuest: false,
    questJoined: false,
    questStartedAt: null,

    // death
    isDead: false,

    // party HP: { name: { hp, hpMax } }
    injuredParty: {},

    // cooldowns
    healCooldownUntil: 0,
    potionCooldownUntil: 0,
    reviveCooldownUntil: 0,

    // inventory: { 'item name': count }
    inventory: {},
    potionCount: 0,

    // shop — only items currently listed by !ada shop
    shopItems: [],       // array of item name strings from the bot response
    shopExpiresAt: null,  // timestamp when shop refreshes

    // token auto-use config — which token types & min levels to auto-use
    autoUseBossTokens: true,
    autoUseQuestTokens: false,
    minBossTokenLevel: 0,   // 0 = use any boss token (highest first)
    maxBossTokenLevel: 999,
    minQuestTokenLevel: 0,
    maxQuestTokenLevel: 999,

    // boss combat tracking (current fight)
    currentBoss: null,       // { name, level, dmgDealt, startedAt }

    // boss HP database: { level: { samples: [hp1, hp2, ...], avg, min, max } }
    bossHPData: {},

    // pending action flags
    pendingHealTarget: null,
    awaitingShop: false,
    awaitingInv: false,
    awaitingChar: false,
    awaitingGold: false,
    awaitingWho: false,
    pendingBuyConfirm: false,
  };

  // --- Persist ada game state across sessions ---
  const ADA_STATE_KEY = 'ada_game_state_v1';

  function saveAdaState() {
    try {
      const persist = {
        playerName: ada.playerName,
        level: ada.level,
        playerClass: ada.playerClass,
        xp: ada.xp,
        xpMax: ada.xpMax,
        hp: ada.hp,
        hpMax: ada.hpMax,
        gold: ada.gold,
        plat: ada.plat,
        transfers: ada.transfers,
        stance: ada.stance,
        attunement: ada.attunement,
        equippedItems: ada.equippedItems,
        inventory: ada.inventory,
        potionCount: ada.potionCount,
        autoUseBossTokens: ada.autoUseBossTokens,
        autoUseQuestTokens: ada.autoUseQuestTokens,
        minBossTokenLevel: ada.minBossTokenLevel,
        maxBossTokenLevel: ada.maxBossTokenLevel,
        minQuestTokenLevel: ada.minQuestTokenLevel,
        maxQuestTokenLevel: ada.maxQuestTokenLevel,
        bossHPData: ada.bossHPData,
        savedAt: Date.now(),
      };
      localStorage.setItem(ADA_STATE_KEY, JSON.stringify(persist));
    } catch (_) {}
  }

  function loadAdaState() {
    try {
      const raw = localStorage.getItem(ADA_STATE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.playerName) ada.playerName = s.playerName;
      if (s.level) ada.level = s.level;
      if (s.playerClass) ada.playerClass = s.playerClass;
      if (s.xp != null) ada.xp = s.xp;
      if (s.xpMax != null) ada.xpMax = s.xpMax;
      if (s.hp != null) ada.hp = s.hp;
      if (s.hpMax != null) ada.hpMax = s.hpMax;
      if (s.gold != null) ada.gold = s.gold;
      if (s.plat != null) ada.plat = s.plat;
      if (s.transfers != null) ada.transfers = s.transfers;
      if (s.stance) ada.stance = s.stance;
      if (s.attunement) ada.attunement = s.attunement;
      if (s.equippedItems) ada.equippedItems = s.equippedItems;
      if (s.inventory) ada.inventory = s.inventory;
      if (s.potionCount != null) ada.potionCount = s.potionCount;
      if (s.autoUseBossTokens != null) ada.autoUseBossTokens = s.autoUseBossTokens;
      if (s.autoUseQuestTokens != null) ada.autoUseQuestTokens = s.autoUseQuestTokens;
      if (s.minBossTokenLevel != null) ada.minBossTokenLevel = s.minBossTokenLevel;
      if (s.maxBossTokenLevel != null) ada.maxBossTokenLevel = s.maxBossTokenLevel;
      if (s.minQuestTokenLevel != null) ada.minQuestTokenLevel = s.minQuestTokenLevel;
      if (s.maxQuestTokenLevel != null) ada.maxQuestTokenLevel = s.maxQuestTokenLevel;
      if (s.bossHPData) ada.bossHPData = s.bossHPData;
      log('Loaded ada game state from localStorage');
    } catch (e) { warn('Failed to load ada state:', e); }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 5: Chat Observer — Read ada_rpg + all messages        ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const QUEST_TIMEOUT_MS = 5 * 60 * 1000;

  function startChatObserver() {
    const chatContainer = document.querySelector('[class*="chat-scrollable-area"]') ||
                          document.querySelector('.chat-list--default') ||
                          document.querySelector('[data-a-target="chat-scroller"]');

    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const lines = node.matches('[class*="chat-line"]') ? [node] : [...node.querySelectorAll('[class*="chat-line"]')];
          for (const line of lines) {
            try { processLine(line); } catch (e) { console.error('[Ada] processLine error:', e); }
          }
        }
      }
    });

    const target = chatContainer || document.body;
    observer.observe(target, { childList: true, subtree: true });
    log('Chat observer started on', target.tagName);
  }

  function processLine(line) {
    const nameEl = line.querySelector('[data-a-target="chat-message-username"]') ||
                   line.querySelector('.chat-author__display-name');
    if (!nameEl) return;
    const sender = (nameEl.textContent || nameEl.innerText || '').trim().toLowerCase();
    const msgEl = line.querySelector('[data-a-target="chat-message-text"]') ||
                  line.querySelector('.text-fragment');
    // get full message text from the line (handles multiple fragments)
    let msgText = '';
    const fragments = line.querySelectorAll('[data-a-target="chat-message-text"], .text-fragment');
    if (fragments.length > 0) {
      msgText = Array.from(fragments).map(f => f.textContent || '').join('').trim();
    } else {
      // fallback: get text from message body
      const body = line.querySelector('[class*="message"]');
      if (body) msgText = (body.textContent || '').trim();
    }
    if (!sender || !msgText) return;

    // Log every message
    addChatLog(sender, msgText);

    // Detect own username from sent messages
    if (!ada.playerName) {
      // Try to detect from the page
      const ownName = document.querySelector('[data-a-target="chat-input"]')?.closest('[class*="chat"]')?.querySelector('[class*="user-name"]');
      // Will be set from !char response instead
    }

    // Process ada_rpg messages
    if (sender === ADA_BOT) {
      processAdaMessage(msgText);
    }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 6: Ada Message Parser + Automation Logic              ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function processAdaMessage(text) {
    const t = text.trim();
    const tl = t.toLowerCase();

    // Only parse gold from !g response when WE asked for it
    if (ada.awaitingGold && /\d+\s*G/i.test(t)) {
      tryParseGold(t);
      ada.awaitingGold = false;
    }

    // --- Quest announcement detection ---
    if (tl.includes('a quest is available') || /has initiated a quest.*type !quest/i.test(t)) {
      if (!ada.questJoined && ada.autoQuest) {
        ada.questJoined = true;
        // Try to use highest-level boss token first, then regular quest
        const tokenToUse = getBestToken();
        if (tokenToUse) {
          queueSend(`!use ${tokenToUse}`, `auto-quest via token: ${tokenToUse}`);
        } else {
          queueSend('!quest', 'auto-quest join');
        }
      }
      return;
    }

    // --- Boss spawn detection ---
    // "opens the Boss Token Lvl35 some rustling is heard nearby and a Agile Ancient Behemoth appears!"
    const bossSpawnM = /Boss Token Lvl(\d+).*?(?:and |a )(.+?)\s*appears?/i.exec(t);
    if (bossSpawnM) {
      ada.currentBoss = {
        name: bossSpawnM[2].trim(),
        level: parseInt(bossSpawnM[1]),
        dmgDealt: 0,
        startedAt: now(),
      };
      log(`Boss spawned: ${ada.currentBoss.name} (Lvl ${ada.currentBoss.level})`);
    }

    // --- Quest start / combat detection ---
    if (/\(Roll:\s*\d+\)/i.test(t) ||
        /swings? at|slashes? at|slams? |attacks? |bites? |casts? |spell hits/i.test(t)) {
      if (!/is defeated/i.test(t)) {
        ada.inQuest = true;
        if (!ada.questStartedAt) ada.questStartedAt = now();
      }
    }

    // --- Track damage dealt TO boss ---
    if (ada.currentBoss) {
      // Track damage TO the boss.
      // Damage to boss: "swings at the Ancient Behemoth for 99 HP." — no "(hp/maxHP)" after
      // Damage to player: "at Player for 78 HP. (282/360HP)." — HAS "(hp/maxHP)" after
      // Also party-wide: "dealing 112 HP." — no player HP after = damage to players, skip
      // Key: if the message has "(digits/digits" anywhere, it's damage TO a player
      if (!/\(\d+\/\d+/.test(t) && !/dealing \d+ HP/i.test(t)) {
        const dmgRe = /for (\d+) HP/gi;
        let dmgMatch;
        while ((dmgMatch = dmgRe.exec(t)) !== null) {
          ada.currentBoss.dmgDealt += parseInt(dmgMatch[1]);
        }
      }
    }

    // --- Quest/Boss end detection ---
    if (/is defeated\.\s*the party gains|the party gains.*xp/i.test(t)) {
      const wasBoss = !!ada.currentBoss;

      // Record boss HP data if we tracked a boss fight
      if (ada.currentBoss && ada.currentBoss.dmgDealt > 0) {
        recordBossHP(ada.currentBoss.level, ada.currentBoss.name, ada.currentBoss.dmgDealt);
        log(`Boss defeated: ${ada.currentBoss.name} Lvl${ada.currentBoss.level} — Total HP: ${ada.currentBoss.dmgDealt}`);
        ada.currentBoss = null;
      }

      endQuest();
      tryParseQuestReward(t);
      playChime(wasBoss ? 'boss' : 'quest');
      return;
    }

    // --- Disband detection ---
    if (/not enough players joined/i.test(t) || /party is disbanded/i.test(t)) {
      endQuest();
      return;
    }

    // --- Total party wipe ---
    if (/party has been defeated/i.test(t)) {
      ada.isDead = true;
      // Record partial boss data if we were tracking
      if (ada.currentBoss && ada.currentBoss.dmgDealt > 0) {
        log(`Boss wipe: ${ada.currentBoss.name} Lvl${ada.currentBoss.level} — Dmg dealt before wipe: ${ada.currentBoss.dmgDealt}`);
        ada.currentBoss = null;
      }
      endQuest();
      playChime('death');
      if (ada.autoRevive) {
        queueSend('!revive', 'auto-revive self');
      }
      return;
    }

    // --- Death detection ---
    if (/has fallen/i.test(t) || /have fallen/i.test(t) || /you're a corpse/i.test(t) || /you are dead/i.test(t)) {
      // Check if WE fell:
      // 1. Message contains our name + "has fallen"
      // 2. Blank name pattern: "HP.  has fallen" or "HP. , Name and Name have fallen"
      //    (two spaces before "has fallen" = blank name = us)
      const isSelfDeath = (ada.playerName && tl.includes(ada.playerName.toLowerCase())) ||
                          /\.\s{2,}has fallen/i.test(t) ||         // "HP.  has fallen"
                          /\.\s{2,}and\s/i.test(t) ||              // "HP.  and Name have fallen"
                          /\.\s+,\s/i.test(t) ||                   // "HP. , Name have fallen"
                          /dealing \d+ HP\.\s+has fallen/i.test(t); // "dealing 252 HP. has fallen"
      if (isSelfDeath) {
        playChime('death');
        ada.isDead = true;
        if (ada.autoRevive) {
          queueSend('!revive', 'auto-revive self');
        }
      }
      return;
    }

    // --- Revival detection ---
    if (/life is returned|life is restored/i.test(t) || /ritual over the body of/i.test(t)) {
      if (ada.playerName && tl.includes(ada.playerName.toLowerCase())) {
        ada.isDead = false;
        log('Revived!');
      }
      return;
    }

    // --- Party health (!w response) ---
    if (/everyone appears healthy/i.test(t)) {
      ada.injuredParty = {};
      ada.pendingHealTarget = null;
      ada.awaitingWho = false;
      renderHUD();
      return;
    }

    // Parse party HP from !whohurt response
    // Real format: "d3v1b33t3r: 45/440, : 14/360, NorgothGaming: 121/460, and m_lucke: 190/200 are injured."
    // No "HP" suffix. Colon + space between name and numbers.
    // Blank name (": 14/360") = your own character.
    if (/are injured|appears? healthy/i.test(t)) {
      ada.injuredParty = {}; // fresh data
      let foundPartyHp = false;

      // Named members: "name: hp/max"
      const partyHpRe = /([a-z_][a-z0-9_]+):\s*(\d+)\s*\/\s*(\d+)/gi;
      let phMatch;
      while ((phMatch = partyHpRe.exec(t)) !== null) {
        const name = phMatch[1].toLowerCase();
        const hp = parseInt(phMatch[2]);
        const hpMax = parseInt(phMatch[3]);
        ada.injuredParty[name] = { hp, hpMax };
        foundPartyHp = true;
        if (ada.playerName && name === ada.playerName.toLowerCase()) {
          ada.hp = hp;
          ada.hpMax = hpMax;
        }
      }

      // Blank name (self): ", : 14/360" or "see : 14/360"
      const blankRe = /(?:,\s*|see\s+):\s*(\d+)\s*\/\s*(\d+)/gi;
      let bnMatch;
      while ((bnMatch = blankRe.exec(t)) !== null) {
        const hp = parseInt(bnMatch[1]);
        const hpMax = parseInt(bnMatch[2]);
        // Only add to party HP if we know our name (otherwise we can't heal ourselves anyway)
        if (ada.playerName) {
          ada.injuredParty[ada.playerName.toLowerCase()] = { hp, hpMax };
        }
        ada.hp = hp;
        ada.hpMax = hpMax;
        foundPartyHp = true;
      }

      if (foundPartyHp) {
        ada.awaitingWho = false;
        tryAutoHeal();
        tryAutoPotion();
      }
      renderHUD();
      return;
    }

    // --- Combat damage HP parsing ---
    // "at <name> for 35 HP. (92/270HP)" or "at  for 78 HP. (282/360HP)" (blank name = self)
    const combatHpRe = /at\s+([a-z_][a-z0-9_]*)\s+for\s+\d+\s+HP\b.*?\((\d+)\s*\/\s*(\d+)\s*HP\)/gi;
    let chMatch;
    while ((chMatch = combatHpRe.exec(t)) !== null) {
      const name = chMatch[1].toLowerCase();
      const hp = parseInt(chMatch[2]);
      const hpMax = parseInt(chMatch[3]);
      ada.injuredParty[name] = { hp, hpMax };
      if (ada.playerName && name === ada.playerName.toLowerCase()) {
        ada.hp = hp;
        ada.hpMax = hpMax;
        tryAutoPotion();
      }
    }
    // Blank name variant: "at  for 78 HP. (282/360HP)" — two spaces before "for", name is empty = player's own character
    const combatBlankRe = /at\s{2,}for\s+(\d+)\s+HP\b.*?\((\d+)\s*\/\s*(\d+)\s*HP\)/gi;
    let cbMatch;
    while ((cbMatch = combatBlankRe.exec(t)) !== null) {
      const hp = parseInt(cbMatch[2]);
      const hpMax = parseInt(cbMatch[3]);
      ada.hp = hp;
      ada.hpMax = hpMax;
      if (ada.playerName) {
        ada.injuredParty[ada.playerName.toLowerCase()] = { hp, hpMax };
      }
      tryAutoPotion();
    }

    // --- Potion cooldown ---
    const potionCdMatch = /cannot drink another potion for (\d+) seconds/i.exec(t);
    if (potionCdMatch) {
      ada.potionCooldownUntil = now() + parseInt(potionCdMatch[1]) * 1000;
      return;
    }

    // "drinks a potion" - potion used successfully
    if (/drinks? a potion/i.test(t) || /chugs? a potion/i.test(t)) {
      if (ada.potionCount > 0) ada.potionCount--;
      ada.potionCooldownUntil = now() + 30000; // ~30s assumed cooldown
    }

    // --- Heal cooldown ---
    const healCdMatch = /transference.*?(\d+)\s*seconds?/i.exec(t);
    if (healCdMatch) {
      ada.healCooldownUntil = now() + parseInt(healCdMatch[1]) * 1000;
    }

    // --- Inventory parsing ---
    if (/in the settlement's warehouse you see/i.test(t)) {
      parseInventory(t);
      ada.awaitingInv = false;
      renderHUD();
      return;
    }
    // Guard: don't wipe inventory on non-inventory messages
    if (/not found in warehouse/i.test(t)) {
      ada.awaitingInv = false;
      return;
    }
    if (/retrieves? a potion from the settlement/i.test(t)) {
      return; // don't let this trigger inventory parse
    }

    // --- Buy confirm detection ---
    if (/confirm your purchase|already have.*equipped|replace.*current/i.test(t)) {
      ada.pendingBuyConfirm = true;
      return;
    }

    // --- Shop response ---
    if (/items? for sale|shop items|store items/i.test(t) || ada.awaitingShop) {
      parseShopResponse(t);
      ada.awaitingShop = false;
      renderHUD();
      return;
    }

    // --- Character response ---
    // Only parse when we explicitly requested it via !char, to avoid
    // capturing other players' character info
    if (ada.awaitingChar && /You see|level \d+/i.test(t)) {
      parseCharResponse(t);
    }

    // --- Gold/plat response from !g ---
    // Handled by tryParseGold above (supports blank name too)

    // --- Plat chest ---
    if (/finds?\s+(\d+)\s+plats?\s+inside/i.test(t)) {
      const cm = /finds?\s+(\d+)\s+plats?\s+inside/i.exec(t);
      if (cm && ada.plat != null) {
        ada.plat += parseInt(cm[1]);
        renderHUD();
      }
    }

    // Quest timeout safety
    if (ada.inQuest && ada.questStartedAt && (now() - ada.questStartedAt > QUEST_TIMEOUT_MS)) {
      endQuest();
    }

    renderHUD();
  }

  function recordBossHP(level, name, totalHP) {
    const key = String(level);
    if (!ada.bossHPData[key]) {
      ada.bossHPData[key] = { samples: [], names: [] };
    }
    const entry = ada.bossHPData[key];
    entry.samples.push(totalHP);
    if (!entry.names.includes(name)) entry.names.push(name);
    // Recalculate stats
    entry.avg = Math.round(entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length);
    entry.min = Math.min(...entry.samples);
    entry.max = Math.max(...entry.samples);
    entry.count = entry.samples.length;
    saveAdaState();
  }

  function endQuest() {
    ada.inQuest = false;
    ada.questJoined = false;
    ada.questStartedAt = null;
  }

  // --- Audio chimes via Web Audio API (no external files) ---
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playChime(type = 'quest') {
    try {
      const ctx = getAudioCtx();
      const now = ctx.currentTime;

      if (type === 'quest') {
        // Pleasant two-note chime: C5 -> E5
        playTone(ctx, 523.25, now, 0.15, 0.3);
        playTone(ctx, 659.25, now + 0.15, 0.2, 0.3);
      } else if (type === 'boss') {
        // Triumphant three-note fanfare: C5 -> E5 -> G5
        playTone(ctx, 523.25, now, 0.15, 0.4);
        playTone(ctx, 659.25, now + 0.15, 0.15, 0.4);
        playTone(ctx, 783.99, now + 0.3, 0.3, 0.5);
      } else if (type === 'death') {
        // Low descending: E4 -> C4
        playTone(ctx, 329.63, now, 0.2, 0.3);
        playTone(ctx, 261.63, now + 0.2, 0.4, 0.25);
      }
    } catch (e) { /* audio not available */ }
  }

  function playTone(ctx, freq, startTime, duration, volume) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  function tryParseGold(t) {
    // "galygious: 904G, 7370P." or ": 32798G, 6231P." (blank name)
    const gm = /(\w+):\s*([\d,]+)\s*G,?\s*([\d,]+)\s*P/i.exec(t);
    if (gm) {
      if (!ada.playerName) ada.playerName = gm[1];
      ada.gold = parseInt(gm[2].replace(/,/g, ''));
      ada.plat = parseInt(gm[3].replace(/,/g, ''));
      return;
    }
    // Fallback: name is blank/missing before colon — ": 32798G, 6231P."
    const gm2 = /:\s*([\d,]+)\s*G,?\s*([\d,]+)\s*P/i.exec(t);
    if (gm2) {
      ada.gold = parseInt(gm2[1].replace(/,/g, ''));
      ada.plat = parseInt(gm2[2].replace(/,/g, ''));
      return;
    }
    // Also match just gold without plat
    const gm3 = /:\s*([\d,]+)\s*G\b/i.exec(t);
    if (gm3) {
      ada.gold = parseInt(gm3[1].replace(/,/g, ''));
    }
  }

  function tryParseQuestReward(t) {
    // "The party gains 79XP, 105G, and 25P"
    // Gold/plat rewards are split among party members (unknown formula),
    // so don't update balances from here — use !g for accurate totals.
    // Just queue a gold check so the HUD updates with the real amount.
    ada.awaitingGold = true;
    queueSend('!g', 'post-quest gold check');
  }

  function parseInventory(text) {
    ada.inventory = {};
    ada.potionCount = 0;
    // Match patterns like: "3 Boss Token Lvl10s" or "1 Health Potion"
    const itemRe = /(\d+)\s+([A-Za-z][A-Za-z0-9' ]+)/g;
    let m;
    while ((m = itemRe.exec(text)) !== null) {
      let count = parseInt(m[1]);
      let name = m[2].trim();
      // Remove trailing 's' for tokens: "Boss Token Lvl10s" -> "Boss Token Lvl10"
      if (/tokens?$/i.test(name)) {
        name = name.replace(/s$/i, '');
      }
      name = name.replace(/\s+/g, ' ').trim();
      if (name.length < 3) continue;
      ada.inventory[name] = (ada.inventory[name] || 0) + count;
      if (/^potions?$|health potion/i.test(name)) ada.potionCount += count;
    }
  }

  function parseShopResponse(text) {
    // Ada lists items like: "iron sword, wooden shield, leather armor"
    // Also may contain "refreshes in X minutes" or "expires in X"
    const newItems = [];
    // Try matching known shop DB items in the text
    const tl = text.toLowerCase();
    for (const name of Object.keys(SHOP_DB)) {
      if (tl.includes(name)) {
        newItems.push(name);
      }
    }
    if (newItems.length > 0) {
      ada.shopItems = newItems;
    }

    // Parse refresh/expiry timer: "refreshes in X minutes" or "expires in Xm"
    const refreshM = /refresh(?:es)?\s+in\s+(\d+)\s*(?:min|minute|m)/i.exec(text);
    if (refreshM) {
      ada.shopExpiresAt = now() + parseInt(refreshM[1]) * 60 * 1000;
    }
    const expiresM = /expires?\s+in\s+(\d+)\s*(?:min|minute|m)/i.exec(text);
    if (expiresM) {
      ada.shopExpiresAt = now() + parseInt(expiresM[1]) * 60 * 1000;
    }
  }

  function parseCharResponse(text) {
    ada.awaitingChar = false;
    // "Level 27 Empath"
    const lvlM = /level\s+(\d+)\s+(\w+)/i.exec(text);
    if (lvlM) {
      ada.level = parseInt(lvlM[1]);
      ada.playerClass = lvlM[2];
    }
    // Gold/Plat: "has 32887G, 6235P"
    const gpM = /has\s+([\d,]+)G,\s*([\d,]+)P/i.exec(text);
    if (gpM) {
      ada.gold = parseInt(gpM[1].replace(/,/g, ''));
      ada.plat = parseInt(gpM[2].replace(/,/g, ''));
    }
    // XP: "312XP. XP to next level: 10026" — current XP and XP to next level (NOT current/max)
    const xpM = /(\d+)\s*XP.*?next level:\s*(\d+)/i.exec(text);
    if (xpM) {
      ada.xp = parseInt(xpM[1]);
      ada.xpMax = parseInt(xpM[2]);
    }
    // HP: "Health: (360/360)"
    const hpM = /Health:\s*\((\d+)\/(\d+)\)/i.exec(text);
    if (hpM) {
      ada.hp = parseInt(hpM[1]);
      ada.hpMax = parseInt(hpM[2]);
    }
    // Transfers: "Transfers: 1"
    const tM = /Transfers:\s*(\d+)/i.exec(text);
    if (tM) ada.transfers = parseInt(tM[1]);
    // Stance
    const stanceM = /Stance:\s*(\w+)/i.exec(text);
    if (stanceM) ada.stance = stanceM[1];
    // Attunement
    const attuneM = /Attune(?:ment)?:\s*(\w+)/i.exec(text);
    if (attuneM) ada.attunement = attuneM[1];

    // Equipment parsing — "Equipped items: mythril sword, adamantite shield, starmetal armor, talisman of the eternal flame."
    // It's a comma-separated list, NOT slot: item format
    const eqM = /Equipped items:\s*(.+?)\.?\s*(?:Transfers|$)/i.exec(text);
    if (eqM) {
      const items = eqM[1].split(',').map(s => s.trim()).filter(s => s.length > 0 && !/none|empty|nothing/i.test(s));
      ada.equippedItems = items;
      // Also populate legacy equipped object from SHOP_DB slot info
      ada.equipped = {};
      for (const itemName of items) {
        const dbItem = SHOP_DB[itemName.toLowerCase()];
        if (dbItem) {
          ada.equipped[dbItem.slot.toLowerCase()] = itemName;
        }
      }
    }

    // player name from the response — "You see , the level 27 Empath" (name may be blank)
    const nameM = /You see\s+(\w+)/i.exec(text);
    if (nameM && nameM[1] && !ada.playerName) ada.playerName = nameM[1];
    // Fallback: try beginning of string
    if (!ada.playerName) {
      const nameM2 = /^(\w+),?\s/i.exec(text);
      if (nameM2) ada.playerName = nameM2[1];
    }

    renderHUD();
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 7: Auto-Actions (Heal, Potion, Revive)                ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const sendQueue = [];       // FIFO: push to end, pop from front
  const QUEUE_TICK_MS = 3000; // process one command every 3 seconds
  let queueTimerStarted = false;
  const recentlySent = {};    // msg -> timestamp, prevents re-queueing within cooldown
  const DEDUP_WINDOW_MS = 10000; // 10s dedup window for same command

  function isTchatReady() {
    return !!(state.sendHash && state.sendVarsTemplate);
  }

  // Add to end of queue (everything goes through here, nothing is independent)
  function queueSend(msg, reason) {
    if (!isTchatReady()) {
      warn(`Cannot queue "${msg}" — tchat not ready`);
      return;
    }
    // Prevent duplicate: check queue AND recently sent
    if (sendQueue.some(item => item.msg === msg)) return;
    if (recentlySent[msg] && (now() - recentlySent[msg]) < DEDUP_WINDOW_MS) return;
    sendQueue.push({ msg, reason, at: now() });
    startQueueTimer();
  }

  // Add to front of queue (priority — retries, urgent)
  function queueSendPriority(msg, reason) {
    if (!isTchatReady()) return;
    sendQueue.unshift({ msg, reason, at: now() });
    startQueueTimer();
  }

  function startQueueTimer() {
    if (queueTimerStarted) return;
    queueTimerStarted = true;
    setInterval(processQueueTick, QUEUE_TICK_MS);
    // Also fire immediately for the first item
    processQueueTick();
  }

  async function processQueueTick() {
    if (sendQueue.length === 0) return;
    if (!isTchatReady()) return;

    // Pop from front (FIFO)
    const item = sendQueue.shift();
    log(`Sending: "${item.msg}" (${item.reason})`);
    addChatLog('>>SELF<<', `${item.msg} [${item.reason}]`);
    recentlySent[item.msg] = now();

    const result = await tSend(item.msg);
    if (!result.ok && result.reason === 'cooldown') {
      sendQueue.unshift(item);
    } else if (!result.ok) {
      warn(`Send failed [${result.reason}]:`, result);
    }

    renderHUD(); // update queue count display
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function tryAutoHeal() {
    if (!ada.autoHeal || ada.isDead || ada.inQuest) return;
    if (now() < ada.healCooldownUntil) return;

    // Find injured party members (not dead, not self, valid name)
    const candidates = [];
    for (const [name, data] of Object.entries(ada.injuredParty)) {
      if (name.length < 2 || /^_/.test(name)) continue; // skip invalid names
      if (data.hp <= 0) continue; // dead, need revive not heal
      if (ada.playerName && name === ada.playerName.toLowerCase()) continue;
      if (data.hp < data.hpMax) {
        candidates.push({ name, ...data, missingHp: data.hpMax - data.hp });
      }
    }

    if (candidates.length === 0) return;

    // Heal the most injured
    candidates.sort((a, b) => b.missingHp - a.missingHp);
    const target = candidates[0];
    ada.pendingHealTarget = target.name;
    queueSend(`!t ${target.name}`, `auto-heal ${target.name} (${target.hp}/${target.hpMax})`);
    ada.healCooldownUntil = now() + 10000; // 10s assumed cooldown
  }

  function tryAutoPotion() {
    if (!ada.autoPotion || ada.isDead) return;
    if (now() < ada.potionCooldownUntil) return;
    if (ada.hp == null || ada.hpMax == null) return;
    if (ada.hp / ada.hpMax > ada.autoPotionThreshold) return;
    if (ada.potionCount <= 0) return;

    queueSend('!heal', `auto-potion (${ada.hp}/${ada.hpMax})`);
    ada.potionCooldownUntil = now() + 30000;
  }

  function getBestToken() {
    // Find highest-level token in inventory that matches config
    let bestName = null;
    let bestLevel = -1;

    for (const [name, count] of Object.entries(ada.inventory)) {
      if (count <= 0) continue;

      const bossM = /Boss Token Lvl(\d+)/i.exec(name);
      if (bossM && ada.autoUseBossTokens) {
        const lvl = parseInt(bossM[1]);
        if (lvl >= ada.minBossTokenLevel && lvl <= ada.maxBossTokenLevel && lvl > bestLevel) {
          bestLevel = lvl;
          bestName = name;
        }
      }

      const questM = /Quest Token Lvl(\d+)/i.exec(name);
      if (questM && ada.autoUseQuestTokens) {
        const lvl = parseInt(questM[1]);
        if (lvl >= ada.minQuestTokenLevel && lvl <= ada.maxQuestTokenLevel && lvl > bestLevel) {
          bestLevel = lvl;
          bestName = name;
        }
      }
    }
    return bestName;
  }

  function consumeInventoryItem(name) {
    if (ada.inventory[name] && ada.inventory[name] > 0) {
      ada.inventory[name]--;
      if (ada.inventory[name] <= 0) delete ada.inventory[name];
    }
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 8: HUD Overlay                                        ║
  // ╚══════════════════════════════════════════════════════════════════╝

  const ADA_WIDTH = 280; // px

  let hudContainer = null;
  let hudVisible = true;
  let hudCollapsed = {}; // track collapsed panels by title
  let adaLayoutStyle = null;
  let adaCollapseBar = null;

  function updateLayoutCSS() {
    if (!adaLayoutStyle) return;
    const adaW = ada.panelCollapsed ? 0 : ADA_WIDTH;
    const barW = 30;
    const adaTotal = barW + adaW; // space Ada needs
    adaLayoutStyle.textContent = `
      /* === Ada fixed panel === */
      #ada-hud {
        position: fixed !important;
        top: 50px;
        right: 0;
        width: ${ADA_WIDTH}px;
        height: calc(100vh - 50px);
        z-index: 9999;
        display: ${ada.panelCollapsed ? 'none' : 'flex'};
      }
      #ada-collapse-bar {
        position: fixed !important;
        top: 50px;
        right: ${adaW}px;
        width: ${barW}px;
        height: calc(100vh - 50px);
        z-index: 10000;
      }
      /* === Push chat left to make room for Ada === */
      .right-column.right-column--beside {
        margin-right: ${adaTotal}px !important;
      }
      .toggle-visibility__right-column--expanded {
        transform: translateX(calc((-34rem - ${adaTotal}px) * var(--writing-dir-flip, -1))) !important;
      }
    `;
  }
  let chatLogPanelRef = null;    // persistent reference to chat log panel-body div
  let chatLogInnerRef = null;    // persistent reference to inner chat-log-panel div
  let lastRenderedLogCount = 0;  // how many log entries have been rendered

  function createHUD() {
    // Load collapse state from localStorage
    try {
      const saved = localStorage.getItem('ada_panel_collapsed');
      if (saved !== null) ada.panelCollapsed = saved === 'true';
    } catch (_) {}

    // Strategy: don't touch Twitch's DOM at all.
    // 1. Add CSS to shrink the stream/player by Ada's width
    // 2. Place Ada as a fixed panel in the gap (right edge of viewport)
    // This avoids all React re-render conflicts.

    hudContainer = document.createElement('div');
    hudContainer.id = 'ada-hud';

    adaCollapseBar = document.createElement('div');
    adaCollapseBar.id = 'ada-collapse-bar';
    adaCollapseBar.innerHTML = '<span class="ada-collapse-arrow">&lt;</span>';
    adaCollapseBar.addEventListener('click', toggleAdaPanelCollapse);

    // Append both to <body> — completely outside Twitch's React tree
    document.body.appendChild(adaCollapseBar);
    document.body.appendChild(hudContainer);

    // Persistent CSS to make room
    adaLayoutStyle = document.createElement('style');
    adaLayoutStyle.id = 'ada-layout-overrides';
    document.head.appendChild(adaLayoutStyle);
    updateLayoutCSS();

    log('HUD injected as fixed panel (right of chat)');

    // Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      #ada-hud {
        font-family: 'Segoe UI', Tahoma, sans-serif;
        font-size: 12px;
        color: #e0e0e0;
        flex-direction: column;
        gap: 0;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #555 transparent;
        border-left: 1px solid #303032;
        background: #18181b;
        box-sizing: border-box;
      }
      #ada-hud::-webkit-scrollbar { width: 4px; }
      #ada-hud::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }
      #ada-hud .panel {
        background: #18181b;
        border-bottom: 1px solid #303032;
        padding: 6px 10px;
      }
      #ada-hud .panel:last-child { border-bottom: none; }
      #ada-hud .panel-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: bold;
        font-size: 12px;
        color: #a0a0ff;
        margin-bottom: 4px;
        cursor: pointer;
        user-select: none;
      }
      #ada-hud .panel-title:hover { color: #c0c0ff; }
      #ada-hud .panel-title .panel-btns {
        display: flex;
        gap: 4px;
        align-items: center;
      }
      #ada-hud .panel-title button {
        background: none;
        border: 1px solid #444;
        color: #aaa;
        border-radius: 3px;
        cursor: pointer;
        padding: 1px 5px;
        font-size: 10px;
      }
      #ada-hud .panel-title button:hover { background: #333; color: #fff; }
      #ada-hud .panel-title .collapse-arrow {
        color: #666;
        font-size: 10px;
        margin-right: 4px;
        transition: transform 0.15s;
      }
      #ada-hud .panel-body { }
      #ada-hud .panel-body.collapsed { display: none; }
      #ada-hud .hp-bar {
        background: #303032;
        border-radius: 3px;
        height: 14px;
        margin: 2px 0;
        position: relative;
        overflow: hidden;
      }
      #ada-hud .hp-bar-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s;
      }
      #ada-hud .hp-bar-text {
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: #fff;
        text-shadow: 1px 1px 1px #000;
      }
      #ada-hud .member-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
      }
      #ada-hud .member-name {
        width: 65px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
      }
      #ada-hud .member-hp-bar { flex: 1; }
      #ada-hud .btn-heal {
        background: #2a5a2a;
        border: 1px solid #4a4;
        color: #8f8;
        border-radius: 3px;
        cursor: pointer;
        padding: 1px 5px;
        font-size: 10px;
        white-space: nowrap;
      }
      #ada-hud .btn-heal:hover { background: #3a7a3a; }
      #ada-hud .btn-heal.dead { background: #5a2a2a; border-color: #a44; color: #f88; }
      #ada-hud .btn-heal.disabled { opacity: 0.5; cursor: not-allowed; }
      #ada-hud .btn-buy {
        background: #3a2a5a;
        border: 1px solid #74a;
        color: #c8f;
        border-radius: 3px;
        cursor: pointer;
        padding: 1px 5px;
        font-size: 10px;
      }
      #ada-hud .btn-buy:hover { background: #4a3a7a; }
      #ada-hud .btn-use {
        background: #2a3a5a;
        border: 1px solid #47a;
        color: #8cf;
        border-radius: 3px;
        cursor: pointer;
        padding: 1px 5px;
        font-size: 10px;
      }
      #ada-hud .btn-use:hover { background: #3a4a7a; }
      #ada-hud .stat-line { margin: 2px 0; font-size: 11px; }
      #ada-hud .stat-label { color: #888; }
      #ada-hud .stat-value { color: #ccc; }
      #ada-hud .gold { color: #ffd700; }
      #ada-hud .plat { color: #b0c4de; }
      #ada-hud .affordable { color: #5f5; }
      #ada-hud .upgrade { color: #ff0; background: rgba(255, 255, 0, 0.08); border-left: 2px solid #ff0; padding-left: 4px; }
      #ada-hud .item-stats { color: #777; font-size: 10px; margin-left: 8px; }
      #ada-hud .status-dot {
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 50%;
        margin-right: 4px;
      }
      #ada-hud .status-green { background: #4a4; }
      #ada-hud .status-red { background: #a44; }
      #ada-hud .status-yellow { background: #aa4; }
      #ada-hud .inv-item {
        padding: 4px 6px;
        margin: 2px 0;
        border-radius: 4px;
        background: rgba(255,255,255,0.03);
        font-size: 11px;
      }
      #ada-hud .inv-item:hover { background: rgba(255,255,255,0.07); }
      #ada-hud .inv-item .item-row1 {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #ada-hud .inv-item .item-name { font-weight: 500; color: #ddd; }
      #ada-hud .inv-item .item-row2 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 10px;
        color: #777;
        margin-top: 1px;
      }
      #ada-hud .inv-item .item-stats { color: #888; }
      #ada-hud .inv-item .item-cost { color: #aaa; white-space: nowrap; }
      #ada-hud .inv-item .item-tier { color: #666; }
      #ada-hud .inv-item .item-upgrade { color: #ff0; font-weight: bold; font-size: 9px; margin-left: 4px; }
      #ada-hud .chat-log-panel {
        max-height: 160px;
        overflow-y: auto;
        font-family: monospace;
        font-size: 10px;
        background: #0e0e10;
        padding: 4px;
        border-radius: 3px;
        scrollbar-width: thin;
      }
      #ada-hud .chat-log-entry { margin: 1px 0; word-break: break-word; }
      #ada-hud .chat-log-time { color: #666; }
      #ada-hud .chat-log-sender { color: #8af; }
      #ada-hud .chat-log-ada { color: #fa8; }
      #ada-hud .chat-log-self { color: #8f8; }
      #ada-hud.ada-collapsed { display: none !important; }
      #ada-collapse-bar {
        background: #18181b;
        border-left: 1px solid #303032;
        display: flex;
        cursor: pointer;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      #ada-collapse-bar:hover { background: #252528; }
      .ada-collapse-arrow {
        color: #a0a0ff;
        font-size: 16px;
        font-weight: bold;
        user-select: none;
        transform: scaleX(-1);
      }
      #ada-hud .ada-collapse-btn {
        background: none;
        border: 1px solid #444;
        color: #aaa;
        border-radius: 3px;
        cursor: pointer;
        padding: 1px 5px;
        font-size: 10px;
        margin-left: auto;
      }
      #ada-hud .ada-collapse-btn:hover { background: #333; color: #fff; }
    `;
    document.head.appendChild(styleEl);

    // Already inserted above via rightCol.parentElement.insertBefore

    renderHUD();
  }

  function hpColor(ratio) {
    if (ratio > 0.6) return '#4a4';
    if (ratio > 0.3) return '#aa4';
    return '#a44';
  }

  function toggleAdaPanelCollapse() {
    ada.panelCollapsed = !ada.panelCollapsed;
    try { localStorage.setItem('ada_panel_collapsed', String(ada.panelCollapsed)); } catch (_) {}
    applyAdaPanelCollapse();
    updateLayoutCSS();
  }

  function applyAdaPanelCollapse() {
    // Display is handled by updateLayoutCSS via the #ada-hud display property.
    // Just update the arrow direction.
    if (adaCollapseBar) {
      const arrow = adaCollapseBar.querySelector('.ada-collapse-arrow');
      if (arrow) arrow.textContent = ada.panelCollapsed ? '>' : '<';
    }
  }

  let renderHUDTimer = null;
  function renderHUD() {
    // Throttle renders to max once per 500ms to prevent scroll resets
    if (renderHUDTimer) return;
    renderHUDTimer = setTimeout(() => { renderHUDTimer = null; }, 500);
    renderHUDImmediate();
  }

  function renderHUDImmediate() {
    if (!hudContainer) return;
    saveAdaState();

    applyAdaPanelCollapse();

    // Save scroll positions before rebuild
    const savedScroll = hudContainer.scrollTop;
    const savedShopScroll = hudContainer.querySelector('.shop-scroll')?.scrollTop || 0;
    const savedInvScroll = hudContainer.querySelector('.inv-scroll')?.scrollTop || 0;
    const savedChatLogScroll = chatLogInnerRef?.scrollTop || 0;
    const chatLogWasAtBottom = chatLogInnerRef
      ? (chatLogInnerRef.scrollTop + chatLogInnerRef.clientHeight >= chatLogInnerRef.scrollHeight - 10)
      : true;

    // Remove old panels (except persistent chat log)
    hudContainer.querySelectorAll('.panel').forEach(p => {
      if (p !== chatLogPanelRef) p.remove();
    });

    // --- Status Panel ---
    const ready = isTchatReady();
    let tchatDetail = '';
    if (ready) {
      tchatDetail = 'Ready';
    } else {
      const missing = [];
      if (!state.sendHash) missing.push('hash');
      if (!state.sendVarsTemplate) missing.push('template');
      tchatDetail = `Need: ${missing.join(', ')} — send a chat msg`;
    }
    const statusPanel = makePanel('Ada RPG Assistant', `
      <div>
        <span class="status-dot ${ready ? 'status-green' : 'status-red'}"></span>
        tchat: ${tchatDetail}
      </div>
      <div>
        <span class="status-dot ${state.channelID ? 'status-green' : 'status-red'}"></span>
        Channel: ${state.channelID || 'detecting...'}
      </div>
      <div>
        <span class="status-dot ${ada.inQuest ? 'status-yellow' : 'status-green'}"></span>
        Quest: ${ada.inQuest ? 'IN COMBAT' : 'Idle'} ${ada.isDead ? '| DEAD' : ''}
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">
        <button class="ada-toggle" data-toggle="autoQuest" style="background:${ada.autoQuest ? '#2a5a2a' : '#3a2020'};border:1px solid ${ada.autoQuest ? '#4a4' : '#844'};color:${ada.autoQuest ? '#8f8' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Quest ${ada.autoQuest ? 'ON' : 'OFF'}</button>
        <button class="ada-toggle" data-toggle="autoHeal" style="background:${ada.autoHeal ? '#2a5a2a' : '#3a2020'};border:1px solid ${ada.autoHeal ? '#4a4' : '#844'};color:${ada.autoHeal ? '#8f8' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Heal ${ada.autoHeal ? 'ON' : 'OFF'}</button>
        <button class="ada-toggle" data-toggle="autoPotion" style="background:${ada.autoPotion ? '#2a5a2a' : '#3a2020'};border:1px solid ${ada.autoPotion ? '#4a4' : '#844'};color:${ada.autoPotion ? '#8f8' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Potion ${ada.autoPotion ? 'ON' : 'OFF'}</button>
        <button class="ada-toggle" data-toggle="autoRevive" style="background:${ada.autoRevive ? '#2a5a2a' : '#3a2020'};border:1px solid ${ada.autoRevive ? '#4a4' : '#844'};color:${ada.autoRevive ? '#8f8' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Revive ${ada.autoRevive ? 'ON' : 'OFF'}</button>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">
        <button class="ada-toggle" data-toggle="autoUseBossTokens" style="background:${ada.autoUseBossTokens ? '#2a3a5a' : '#3a2020'};border:1px solid ${ada.autoUseBossTokens ? '#47a' : '#844'};color:${ada.autoUseBossTokens ? '#8cf' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Boss Tkn ${ada.autoUseBossTokens ? 'ON' : 'OFF'}</button>
        <button class="ada-toggle" data-toggle="autoUseQuestTokens" style="background:${ada.autoUseQuestTokens ? '#2a3a5a' : '#3a2020'};border:1px solid ${ada.autoUseQuestTokens ? '#47a' : '#844'};color:${ada.autoUseQuestTokens ? '#8cf' : '#f88'};border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;">Quest Tkn ${ada.autoUseQuestTokens ? 'ON' : 'OFF'}</button>
      </div>
      <div style="font-size:10px;color:#666;margin-top:2px;">Queue: ${sendQueue.length}</div>
    `, [{ label: '\u25C0 Hide', action: () => toggleAdaPanelCollapse() }]);
    statusPanel.querySelectorAll('.ada-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-toggle');
        ada[key] = !ada[key];
        renderHUD();
      });
    });
    hudContainer.appendChild(statusPanel);

    // --- Economy Panel ---
    const ecoPanel = makePanel('Economy', `
      <div>
        <span class="gold">Gold: ${ada.gold != null ? ada.gold.toLocaleString() : '?'}</span>
        &nbsp;|&nbsp;
        <span class="plat">Plat: ${ada.plat != null ? ada.plat.toLocaleString() : '?'}</span>
      </div>
    `, [{ label: 'Check', action: () => { ada.awaitingGold = true; queueSend('!g', 'manual gold check'); } }]);
    hudContainer.appendChild(ecoPanel);

    // --- Character Panel ---
    {
      let charHtml = '';
      if (ada.playerName) charHtml += `<div class="stat-line"><span class="stat-label">Name:</span> <span class="stat-value">${ada.playerName}</span></div>`;
      if (ada.level) charHtml += `<div class="stat-line"><span class="stat-label">Level:</span> <span class="stat-value">${ada.level} ${ada.playerClass || ''}</span></div>`;
      if (ada.xp != null) charHtml += `<div class="stat-line"><span class="stat-label">XP:</span> <span class="stat-value">${ada.xp}/${ada.xpMax || '?'}</span></div>`;
      if (ada.hp != null) {
        const ratio = ada.hpMax ? ada.hp / ada.hpMax : 1;
        charHtml += `<div class="hp-bar"><div class="hp-bar-fill" style="width:${ratio*100}%;background:${hpColor(ratio)}"></div><div class="hp-bar-text">${ada.hp}/${ada.hpMax} HP</div></div>`;
      }
      if (ada.transfers != null) charHtml += `<div class="stat-line"><span class="stat-label">Transfers:</span> <span class="stat-value">${ada.transfers}</span></div>`;
      if (ada.stance) charHtml += `<div class="stat-line"><span class="stat-label">Stance:</span> <span class="stat-value">${ada.stance}</span></div>`;
      if (ada.attunement) charHtml += `<div class="stat-line"><span class="stat-label">Attunement:</span> <span class="stat-value">${ada.attunement}</span></div>`;
      // Equipped gear — flat list from equippedItems
      if (ada.equippedItems && ada.equippedItems.length > 0) {
        charHtml += '<div style="margin-top:4px;border-top:1px solid #303032;padding-top:3px;font-size:11px;">';
        charHtml += '<div class="stat-line" style="color:#888;margin-bottom:2px;">Equipped:</div>';
        for (const itemName of ada.equippedItems) {
          const dbItem = SHOP_DB[itemName.toLowerCase()];
          let statsStr = '';
          if (dbItem) {
            const parts = [`T${dbItem.tier}`];
            if (dbItem.dice) parts.push(dbItem.dice);
            if (dbItem.avgDmg > 0) parts.push(`avg ${dbItem.avgDmg}`);
            if (dbItem.skill !== 'None' && dbItem.skillBonus > 0) parts.push(`${dbItem.skill}+${dbItem.skillBonus}`);
            statsStr = ` <span style="color:#666">${parts.join(', ')}</span>`;
          }
          charHtml += `<div class="stat-line" style="padding-left:8px;"><span class="stat-value">${itemName}${statsStr}</span></div>`;
        }
        charHtml += '</div>';
      }
      if (!ada.playerName && !ada.level) {
        charHtml = '<div style="color:#666">Send !char to load</div>';
      }
      const charPanel = makePanel('Character', charHtml, [
        { label: 'Check', action: () => { ada.awaitingChar = true; queueSend('!char', 'manual char check'); } }
      ]);
      hudContainer.appendChild(charPanel);
    }

    // --- Party Health Panel ---
    const partyNames = Object.keys(ada.injuredParty);
    if (partyNames.length > 0) {
      let partyHtml = '';
      for (const name of partyNames) {
        const d = ada.injuredParty[name];
        const ratio = d.hpMax ? d.hp / d.hpMax : 1;
        const isDead = d.hp <= 0;
        const btnClass = isDead ? 'btn-heal dead' : (d.hp < d.hpMax ? 'btn-heal' : 'btn-heal disabled');
        const btnLabel = isDead ? 'Revive' : 'Heal';
        const cmd = isDead ? `!revive ${name}` : `!t ${name}`;
        partyHtml += `<div class="member-row">
          <span class="member-name">${name}</span>
          <div class="member-hp-bar hp-bar"><div class="hp-bar-fill" style="width:${Math.max(0,ratio*100)}%;background:${hpColor(ratio)}"></div><div class="hp-bar-text">${d.hp}/${d.hpMax}</div></div>
          <button class="${btnClass}" data-cmd="${cmd}">${btnLabel}</button>
        </div>`;
      }
      const partyPanel = makePanel('Party Health', partyHtml, [
        { label: 'Refresh', action: () => { ada.awaitingWho = true; queueSend('!whohurt', 'manual party check'); } }
      ]);
      partyPanel.querySelectorAll('.btn-heal').forEach(btn => {
        btn.addEventListener('click', () => {
          const cmd = btn.getAttribute('data-cmd');
          if (cmd) queueSend(cmd, 'manual heal/revive');
        });
      });
      hudContainer.appendChild(partyPanel);
    } else {
      const partyPanel = makePanel('Party Health', '<div style="color:#666">No data yet</div>', [
        { label: 'Refresh', action: () => { ada.awaitingWho = true; queueSend('!whohurt', 'manual party check'); } }
      ]);
      hudContainer.appendChild(partyPanel);
    }

    // --- Health Potion Button ---
    const potionReady = now() >= ada.potionCooldownUntil;
    const potionCdLeft = potionReady ? 0 : Math.ceil((ada.potionCooldownUntil - now()) / 1000);
    const potionPanel = makePanel('Potion', `
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="btn-use" id="ada-drink-btn" ${potionReady ? '' : 'disabled style="opacity:0.5"'}>
          ${potionReady ? 'Drink' : `CD: ${potionCdLeft}s`}
        </button>
        <span>Potions: ${ada.potionCount}</span>
      </div>
    `);
    const drinkBtn = potionPanel.querySelector('#ada-drink-btn');
    if (drinkBtn) drinkBtn.addEventListener('click', () => queueSend('!heal', 'manual potion'));
    hudContainer.appendChild(potionPanel);

    // --- Inventory Panel (separated into Boss Tokens, Quest Tokens, Other) ---
    {
      const bossTokens = [];
      const questTokens = [];
      const otherItems = [];

      for (const [name, count] of Object.entries(ada.inventory)) {
        if (count <= 0) continue;
        if (/health potion|potion/i.test(name)) continue; // shown in Potion panel
        if (/Boss Token/i.test(name)) {
          const m = /Lvl(\d+)/i.exec(name);
          bossTokens.push({ name, count, level: m ? parseInt(m[1]) : 0 });
        } else if (/Quest Token/i.test(name)) {
          const m = /Lvl(\d+)/i.exec(name);
          questTokens.push({ name, count, level: m ? parseInt(m[1]) : 0 });
        } else {
          otherItems.push({ name, count });
        }
      }

      // Sort tokens by level descending
      bossTokens.sort((a, b) => b.level - a.level);
      questTokens.sort((a, b) => b.level - a.level);

      const renderTokenSection = (title, tokens) => {
        if (tokens.length === 0) return '';
        let html = `<div style="margin-top:6px;font-size:10px;color:#a0a0ff;font-weight:bold;border-bottom:1px solid #252528;padding-bottom:2px;margin-bottom:2px;">${title}</div>`;
        for (const t of tokens) {
          html += `<div class="inv-item">
            <div class="item-row1">
              <span class="item-name">${t.name}</span>
              <button class="btn-use" data-use="${t.name}">Use</button>
            </div>
            <div class="item-row2">
              <span class="item-stats">Lvl ${t.level}</span>
              <span class="item-cost">${t.count}x</span>
            </div>
          </div>`;
        }
        return html;
      };

      let invHtml = '';
      const hasData = bossTokens.length > 0 || questTokens.length > 0 || otherItems.length > 0;
      if (hasData) {
        invHtml += '<div class="inv-scroll" style="max-height:180px;overflow-y:auto;">';
        invHtml += renderTokenSection('Boss Tokens', bossTokens);
        invHtml += renderTokenSection('Quest Tokens', questTokens);
        if (otherItems.length > 0) {
          invHtml += '<div style="margin-top:6px;font-size:10px;color:#a0a0ff;font-weight:bold;border-bottom:1px solid #252528;padding-bottom:2px;margin-bottom:2px;">Other</div>';
          for (const it of otherItems) {
            const dbItem = SHOP_DB[it.name.toLowerCase()];
            const statsLine = dbItem ? `T${dbItem.tier} ${dbItem.slot}` : '';
            invHtml += `<div class="inv-item">
              <div class="item-row1">
                <span class="item-name">${it.name}</span>
                <button class="btn-use" data-use="${it.name}">Use</button>
              </div>
              ${statsLine ? `<div class="item-row2"><span class="item-stats">${statsLine}</span><span class="item-cost">${it.count}x</span></div>` : `<div class="item-row2"><span class="item-cost">${it.count}x</span></div>`}
            </div>`;
          }
        }
        invHtml += '</div>';
      } else {
        invHtml = '<div style="color:#666">No data yet</div>';
      }

      const invPanel = makePanel('Inventory', invHtml, [
        { label: 'Refresh', action: () => { ada.awaitingInv = true; queueSend('!inv', 'manual inv check'); } }
      ]);
      invPanel.querySelectorAll('.btn-use').forEach(btn => {
        btn.addEventListener('click', () => {
          const itemName = btn.getAttribute('data-use');
          if (itemName) {
            queueSend(`!use ${itemName}`, `use ${itemName}`);
            consumeInventoryItem(itemName);
            renderHUD();
          }
        });
      });
      hudContainer.appendChild(invPanel);
    }

    // --- Shop Panel ---
    // Check if shop data expired
    const shopExpired = ada.shopExpiresAt && now() > ada.shopExpiresAt;
    if (shopExpired) {
      ada.shopItems = [];
      ada.shopExpiresAt = null;
    }

    let shopHtml = '';
    if (ada.shopItems.length === 0) {
      shopHtml = '<div style="color:#666;font-size:11px;">No shop data. Click Refresh to load.</div>';
    } else {
      // Show expiry timer
      if (ada.shopExpiresAt) {
        const secsLeft = Math.max(0, Math.ceil((ada.shopExpiresAt - now()) / 1000));
        const minsLeft = Math.floor(secsLeft / 60);
        const sLeft = secsLeft % 60;
        shopHtml += `<div style="font-size:10px;color:#888;margin-bottom:4px;">Refreshes in ${minsLeft}m ${sLeft}s</div>`;
      }
      // Build a map of equipped slot -> tier for upgrade detection
      // Build equipped tier map, grouping weapon slots together
      const slotGroup = (slot) => {
        if (slot === 'MainHand' || slot === 'TwoHanded') return 'Weapon';
        if (slot === 'OffHand') return 'OffHand';
        return slot; // Armor, AccessoryFace, AccessoryHat, AccessoryNeck
      };
      const equippedTierByGroup = {};
      for (const eqName of (ada.equippedItems || [])) {
        const eqData = SHOP_DB[eqName.toLowerCase()];
        if (eqData) {
          const group = slotGroup(eqData.slot);
          if (!equippedTierByGroup[group] || eqData.tier > equippedTierByGroup[group]) {
            equippedTierByGroup[group] = eqData.tier;
          }
        }
      }

      shopHtml += '<div class="shop-scroll" style="max-height:160px;overflow-y:auto;font-size:10px;">';
      const sortedShopItems = [...ada.shopItems].sort((a, b) => {
        const ta = SHOP_DB[a]?.tier || 0;
        const tb = SHOP_DB[b]?.tier || 0;
        return tb - ta;
      });
      for (const name of sortedShopItems) {
        const item = SHOP_DB[name];
        if (!item) {
          shopHtml += `<div class="inv-item">
            <div class="item-row1"><span class="item-name">${name}</span><button class="btn-buy" data-buy="${name}">Buy</button></div>
          </div>`;
          continue;
        }
        const cost = item.gold > 0 ? `${item.gold.toLocaleString()}G` : `${item.plat.toLocaleString()}P`;
        const canAfford = (item.gold > 0 && ada.gold != null && ada.gold >= item.gold) ||
                          (item.plat > 0 && ada.plat != null && ada.plat >= item.plat);
        const currentTier = equippedTierByGroup[slotGroup(item.slot)] || 0;
        const isUpgrade = item.tier > currentTier;
        const cls = isUpgrade ? 'upgrade' : (canAfford ? 'affordable' : '');
        const upgradeTag = isUpgrade ? '<span class="item-upgrade">UPGRADE</span>' : '';
        const diceStr = item.avgDmg > 0 ? `${item.dice} (avg ${item.avgDmg})` : '';
        const skillStr = item.skill !== 'None' ? `${item.skill} +${item.skillBonus}` : '';
        const statsLine = [diceStr, skillStr].filter(Boolean).join(' | ');
        shopHtml += `<div class="inv-item ${cls}">
          <div class="item-row1">
            <span class="item-name">${name}${upgradeTag}</span>
            <button class="btn-buy" data-buy="${name}">Buy</button>
          </div>
          <div class="item-row2">
            <span class="item-stats"><span class="item-tier">T${item.tier} ${item.slot}</span>${statsLine ? ' · ' + statsLine : ''}</span>
            <span class="item-cost">${cost}</span>
          </div>
        </div>`;
      }
      shopHtml += '</div>';
    }
    const shopPanel = makePanel('Shop', shopHtml, [
      { label: 'Refresh', action: () => { ada.awaitingShop = true; queueSend('!ada shop', 'manual shop check'); } },
    ]);
    shopPanel.querySelectorAll('.btn-buy').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemName = btn.getAttribute('data-buy');
        if (itemName) {
          queueSend(`!ada buy ${itemName}`, `buy ${itemName}`);
          setTimeout(() => {
            if (ada.pendingBuyConfirm) {
              queueSend('!ada buy confirm', `confirm buy ${itemName}`);
              ada.pendingBuyConfirm = false;
            }
          }, 3000);
        }
      });
    });
    hudContainer.appendChild(shopPanel);

    // --- Boss HP Database Panel ---
    {
      const levels = Object.keys(ada.bossHPData).sort((a, b) => parseInt(b) - parseInt(a));
      let bossHtml = '';
      if (levels.length > 0) {
        // Show current fight if active
        if (ada.currentBoss) {
          const knownHP = ada.bossHPData[String(ada.currentBoss.level)];
          const estHP = knownHP ? knownHP.avg : '?';
          const pct = knownHP ? Math.min(100, Math.round((ada.currentBoss.dmgDealt / knownHP.avg) * 100)) : '?';
          bossHtml += `<div style="background:rgba(255,100,100,0.1);padding:4px;border-radius:4px;margin-bottom:4px;">
            <div style="color:#f88;font-weight:bold;">${ada.currentBoss.name} (Lvl ${ada.currentBoss.level})</div>
            <div style="font-size:10px;">Dmg dealt: ${ada.currentBoss.dmgDealt.toLocaleString()} / ~${typeof estHP === 'number' ? estHP.toLocaleString() : estHP} HP (${pct}%)</div>
          </div>`;
        }
        bossHtml += '<div style="max-height:120px;overflow-y:auto;font-size:10px;">';
        for (const lvl of levels) {
          const d = ada.bossHPData[lvl];
          const names = d.names ? d.names.slice(0, 3).join(', ') : '';
          bossHtml += `<div class="inv-item">
            <div class="item-row1"><span class="item-name">Lvl ${lvl}</span><span style="color:#888">${d.count} sample${d.count > 1 ? 's' : ''}</span></div>
            <div class="item-row2">
              <span class="item-stats">avg ${d.avg.toLocaleString()} HP (${d.min.toLocaleString()}-${d.max.toLocaleString()})</span>
            </div>
            ${names ? `<div style="font-size:9px;color:#555;margin-top:1px;">${names}</div>` : ''}
          </div>`;
        }
        bossHtml += '</div>';
      } else {
        bossHtml = '<div style="color:#666;font-size:11px;">No data yet. Defeat bosses to build the database.</div>';
      }
      const bossPanel = makePanel('Boss HP Database', bossHtml);
      hudContainer.appendChild(bossPanel);
    }

    // --- Chat Log Panel (persistent — only append new entries to preserve scroll) ---
    if (!chatLogPanelRef || !chatLogPanelRef.parentElement) {
      // First render or panel was removed — create fresh
      const logPanel = makePanel('Chat Log', '<div class="chat-log-panel"></div>', [
        { label: 'Dump', action: () => dumpChatLog(200) },
        { label: 'Export', action: () => exportChatLog() },
      ]);
      chatLogInnerRef = logPanel.querySelector('.chat-log-panel');
      chatLogPanelRef = logPanel;
      lastRenderedLogCount = 0;
      // Render all current entries
      const logEntries = getChatLog(30);
      for (const e of logEntries) {
        chatLogInnerRef.appendChild(makeChatLogEntryEl(e));
      }
      lastRenderedLogCount = chatLog.length;
      hudContainer.appendChild(logPanel);
    } else {
      // Append only new entries since last render
      const newCount = chatLog.length;
      if (newCount > lastRenderedLogCount) {
        const startIdx = Math.max(0, lastRenderedLogCount);
        for (let i = startIdx; i < newCount; i++) {
          chatLogInnerRef.appendChild(makeChatLogEntryEl(chatLog[i]));
        }
        // Trim old entries from DOM if too many (keep last 30)
        while (chatLogInnerRef.children.length > 30) {
          chatLogInnerRef.removeChild(chatLogInnerRef.firstChild);
        }
        // Only auto-scroll if user was already at the bottom
        if (chatLogWasAtBottom) {
          chatLogInnerRef.scrollTop = chatLogInnerRef.scrollHeight;
        } else {
          chatLogInnerRef.scrollTop = savedChatLogScroll;
        }
        lastRenderedLogCount = newCount;
      }
      // Re-append to ensure it's at the end of the panel list
      hudContainer.appendChild(chatLogPanelRef);
    }

    // Restore scroll positions after rebuild
    hudContainer.scrollTop = savedScroll;
    const shopEl = hudContainer.querySelector('.shop-scroll');
    if (shopEl) shopEl.scrollTop = savedShopScroll;
    const invEl = hudContainer.querySelector('.inv-scroll');
    if (invEl) invEl.scrollTop = savedInvScroll;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function makeChatLogEntryEl(e) {
    const senderClass = e.sender === ADA_BOT ? 'chat-log-ada' : (e.sender === '>>SELF<<' ? 'chat-log-self' : 'chat-log-sender');
    const div = document.createElement('div');
    div.className = 'chat-log-entry';
    div.innerHTML = `<span class="chat-log-time">${e.time}</span> <span class="${senderClass}">&lt;${e.sender}&gt;</span> ${escapeHtml(e.message)}`;
    return div;
  }

  function makePanel(title, bodyHtml, buttons = []) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    const isCollapsed = !!hudCollapsed[title];
    let btnHtml = '';
    for (const b of buttons) {
      btnHtml += `<button class="panel-btn">${b.label}</button>`;
    }
    const arrow = isCollapsed ? '\u25B6' : '\u25BC';
    panel.innerHTML = `
      <div class="panel-title">
        <span><span class="collapse-arrow">${arrow}</span>${title}</span>
        <div class="panel-btns">${btnHtml}</div>
      </div>
      <div class="panel-body${isCollapsed ? ' collapsed' : ''}">${bodyHtml}</div>`;
    // collapse/expand on title click
    const titleEl = panel.querySelector('.panel-title > span');
    titleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      hudCollapsed[title] = !hudCollapsed[title];
      const body = panel.querySelector('.panel-body');
      const arrowEl = panel.querySelector('.collapse-arrow');
      if (hudCollapsed[title]) {
        body.classList.add('collapsed');
        arrowEl.textContent = '\u25B6';
      } else {
        body.classList.remove('collapsed');
        arrowEl.textContent = '\u25BC';
      }
    });
    // wire up buttons
    const btns = panel.querySelectorAll('.panel-btn');
    btns.forEach((btn, i) => {
      if (buttons[i] && buttons[i].action) {
        btn.addEventListener('click', (e) => { e.stopPropagation(); buttons[i].action(); });
      }
    });
    return panel;
  }

  // ╔══════════════════════════════════════════════════════════════════╗
  // ║  SECTION 9: Console API + Boot                                 ║
  // ╚══════════════════════════════════════════════════════════════════╝

  function expose() {
    const api = {
      // tchat
      tChatState,
      tSend,
      tSelfTest,
      tDebug(on = true) { state.debug = !!on; return tChatState(); },
      tCooldown(ms = 1250) { state.cooldownMs = Math.max(0, Number(ms) || 0); return tChatState(); },
      tResetCaptured() {
        state.sendHash = null;
        state.channelID = null;
        state.sendVarsTemplate = null;
        state.sendOpName = 'sendChatMessage';
        state.capturedHeaders = {};
        state.lastTransport = null;
        state.lastGraphQLErrors = null;
        return tChatState();
      },
      tClearSaved() { localStorage.removeItem(LS_KEY); return tChatState(); },

      // ada
      adaState: () => ({ ...ada }),
      adaAutoQuest(on = true) { ada.autoQuest = !!on; renderHUD(); return ada.autoQuest; },
      adaAutoHeal(on = true) { ada.autoHeal = !!on; renderHUD(); return ada.autoHeal; },
      adaAutoPotion(on = true) { ada.autoPotion = !!on; renderHUD(); return ada.autoPotion; },
      adaAutoRevive(on = true) { ada.autoRevive = !!on; renderHUD(); return ada.autoRevive; },
      adaBossTokens(on = true) { ada.autoUseBossTokens = !!on; renderHUD(); return ada.autoUseBossTokens; },
      adaQuestTokens(on = true) { ada.autoUseQuestTokens = !!on; renderHUD(); return ada.autoUseQuestTokens; },
      adaBossTokenRange(min = 0, max = 999) { ada.minBossTokenLevel = min; ada.maxBossTokenLevel = max; return { min, max }; },
      adaQuestTokenRange(min = 0, max = 999) { ada.minQuestTokenLevel = min; ada.maxQuestTokenLevel = max; return { min, max }; },
      adaBossHP: () => ada.bossHPData,
      adaBossHPClear: () => { ada.bossHPData = {}; saveAdaState(); return 'Boss HP data cleared'; },
      adaPotionThreshold(pct = 0.7) { ada.autoPotionThreshold = Math.max(0, Math.min(1, Number(pct) || 0.7)); return ada.autoPotionThreshold; },
      adaShopDB: () => SHOP_DB,
      adaShopLookup: (name) => SHOP_DB[name.toLowerCase()] || null,

      // chat log
      chatLog: getChatLog,
      chatSearch: searchChatLog,
      chatDump: dumpChatLog,
      chatExport: exportChatLog,
      chatClear: clearChatLog,

      // manual commands
      adaSend: (msg) => queueSend(msg, 'manual console'),
      adaBuy: (item, qty = 1) => queueSend(`!ada buy ${item} ${qty}`, `buy ${item} x${qty}`),
      adaUse: (item) => { queueSend(`!use ${item}`, `use ${item}`); consumeInventoryItem(item); },
    };

    try {
      for (const [k, v] of Object.entries(api)) unsafeWindow[k] = v;
    } catch (_) {
      for (const [k, v] of Object.entries(api)) window[k] = v;
    }

    log('Loaded. Watching Twitch GQL (fetch + XHR).');
    log('Send ONE manual chat message, then check tChatState().hasSendVarsTemplate');
    log('Console API: tChatState(), tSend(msg), tSelfTest()');
    log('Ada API: adaState(), chatLog(), chatSearch(pattern), chatDump(), chatExport()');
    log('Toggles: adaAutoQuest(), adaAutoHeal(), adaAutoPotion(), adaAutoRevive()');
  }

  // --- Boot ---
  async function boot() {
    await initChatLogDB();
    loadStateFromLS();
    loadAdaState();
    injectPageSniffer();
    expose();

    // Wait for DOM to be ready for HUD + chat observer
    const waitForChat = () => {
      const chatArea = document.querySelector('[class*="chat-scrollable-area"]') ||
                       document.querySelector('.chat-list--default') ||
                       document.querySelector('[data-a-target="chat-scroller"]');
      if (chatArea) {
        startChatObserver();
        createHUD();
        // Auto-refresh HUD every 5s for cooldown timers
        setInterval(() => renderHUD(), 5000);
      } else {
        setTimeout(waitForChat, 1000);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(waitForChat, 2000);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(waitForChat, 2000));
    }
  }

  boot();
})();

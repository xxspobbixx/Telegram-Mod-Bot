/* Web-Dashboard für den Gruppen-Manager – ohne zusätzliche Pakete (nur Node http). */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const clone = (x) => JSON.parse(JSON.stringify(x));

const ACTS = ['delete', 'warn', 'mute', 'kick', 'ban'];
const ACT_KINDS = ['link', 'word', 'flood', 'repeat', 'caps', 'script', 'mention', 'contact'];
const RUNTIME = ['warns', 'joined', 'locked', 'savedPerms', 'raid', 'stats', 'members', 'events', 'banned', 'title', 'type', 'approved', 'warnTimes', 'delQueue', 'webAccess', 'reportLast'];
const BK_RE = /^data-\d{4}-\d{2}-\d{2}\.json$/;

function start(o) {
  const { bot, db, cfg, save, me } = o;
  if (!db.gbans) db.gbans = {};
  const BK_DIR = path.join(__dirname, 'backups');
  const password = process.env.WEB_PASSWORD || '';
  const tgMode = (process.env.WEB_TELEGRAM || '').toLowerCase();
  const tgLogin = tgMode !== 'off';
  const host = process.env.WEB_HOST || '127.0.0.1';
  const port = parseInt(process.env.WEB_PORT || '3000', 10);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  let pwEnabled = !!password;
  if (pwEnabled && !loopback && password.length < 8) {
    console.log('Passwort-Login aus: WEB_PASSWORD braucht mindestens 8 Zeichen, wenn WEB_HOST nicht 127.0.0.1 ist.');
    pwEnabled = false;
  }
  if (!password && tgMode !== 'on') { console.log('Dashboard aus (WEB_PASSWORD nicht gesetzt und WEB_TELEGRAM nicht auf "on").'); return; }
  if (!pwEnabled && !tgLogin) { console.log('Dashboard aus: keine Anmeldemethode aktiv.'); return; }

  const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const pwHash = sha(password);
  const sessions = new Map();   // Cookie-Token -> { exp, uid, name, username, sup }
  const logins = new Map();     // Telegram-Anmeldungen (Token aus dem Deep-Link)
  const attempts = new Map();   // Passwort-Fehlversuche je IP
  const starts = new Map();     // gestartete Telegram-Anmeldungen je IP
  const roleCache = new Map();
  const listCache = new Map();
  const tg = bot.telegram;
  const OWNERS = o.OWNERS || new Set();
  const SID_RE = /(?:^|;\s*)sid=([a-f0-9]{48})/;
  const SESSION_MS = 12 * 3600 * 1000;
  const COOKIE_FLAGS = 'HttpOnly; SameSite=Strict; Path=/' + (process.env.WEB_SECURE === '1' ? '; Secure' : '');
  const clientIp = (req) => (process.env.WEB_TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

  setInterval(() => {
    const now = Date.now();
    for (const [t, e] of sessions) if (now > e.exp) sessions.delete(t);
    for (const [t, l] of logins) if (now > l.exp + 60000) logins.delete(t);
    for (const [ip, a] of attempts) if (now - a.ts > 600000) attempts.delete(ip);
    for (const [ip, a] of starts) if (now - a.ts > 600000) starts.delete(ip);
    for (const [k, v] of roleCache) if (now - v.t > 300000) roleCache.delete(k);
    for (const [k, v] of listCache) if (now - v.t > 300000) listCache.delete(k);
  }, 300000).unref();

  const getSession = (req) => {
    const m = SID_RE.exec(req.headers.cookie || '');
    const e = m && sessions.get(m[1]);
    if (!e) return null;
    if (Date.now() > e.exp) { sessions.delete(m[1]); return null; }
    return e;
  };
  const mkSession = (data) => {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { exp: Date.now() + SESSION_MS, since: Date.now(), ...data });
    return `sid=${token}; ${COOKIE_FLAGS}; Max-Age=${SESSION_MS / 1000}`;
  };

  /* ---- Rollen: Owner (alles) · Gruppen-Besitzer · Admin (nur eigene Gruppen) ---- */
  async function roleIn(chatId, uid) {
    if (OWNERS.has(uid)) return 'super';
    const key = chatId + ':' + uid;
    const hit = roleCache.get(key);
    if (hit && Date.now() - hit.t < 60000) return hit.v;
    let v = null;
    try {
      const m = await tg.getChatMember(Number(chatId), uid);
      v = m.status === 'creator' ? 'creator' : m.status === 'administrator' ? 'admin' : null;
    } catch (_) {}
    roleCache.set(key, { v, t: Date.now() });
    return v;
  }
  async function roleOf(sess, id) {
    if (sess.sup) return 'super';
    const r = await roleIn(id, sess.uid);
    if (!r) return null;
    const c = db.chats[id];
    if (c && c.webAccess === 'creator' && r !== 'creator') return null;
    return r;
  }
  async function needRole(sess, id) {
    const r = await roleOf(sess, id);
    if (!r) throw bad('Kein Zugriff auf diese Gruppe', 403);
    return r;
  }
  async function visibleIds(sess) {
    const all = Object.keys(db.chats).slice(0, 400);
    if (sess.sup) return all;
    const hit = listCache.get(sess.uid);
    if (hit && Date.now() - hit.t < 30000) return hit.ids.filter((id) => db.chats[id]);
    const ids = [];
    for (let i = 0; i < all.length; i += 8) {
      const part = all.slice(i, i + 8);
      const res = await Promise.all(part.map((id) => roleOf(sess, id)));
      part.forEach((id, j) => { if (res[j]) ids.push(id); });
    }
    listCache.set(sess.uid, { t: Date.now(), ids });
    return ids;
  }

  /* ---- Telegram-Anmeldung: Bot fragt nach der im Browser angezeigten Zahl ---- */
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  async function tgOnStart(ctx, token) {
    if (ctx.chat.type !== 'private') return;
    const r = logins.get(token);
    if (!r || Date.now() > r.exp || r.state !== 'pending') {
      return ctx.reply('❌ Diese Anmeldung ist abgelaufen oder ungültig. Öffne das Web-Panel erneut und starte eine neue Anmeldung.');
    }
    if (r.user && r.user.id !== ctx.from.id) return ctx.reply('❌ Diese Anmeldung wurde bereits von einem anderen Account geöffnet.');
    r.user = { id: ctx.from.id, name: ctx.from.first_name || '', username: ctx.from.username || '' };
    const opts = new Set([r.code]);
    while (opts.size < 3) opts.add(String(1000 + crypto.randomInt(9000)));
    await ctx.reply(
      '🔐 <b>Anmeldung am Web-Panel</b>\n\nTippe die Zahl, die dir <b>im Browser</b> angezeigt wird.\n\nHast du die Anmeldung nicht selbst gestartet? Dann tippe „Abbrechen“ und gib nichts weiter.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
        shuffle([...opts]).map((c) => ({ text: c, callback_data: `wl:${token}:${c}` })),
        [{ text: '❌ Abbrechen', callback_data: `wl:${token}:no` }],
      ] } }
    );
  }
  async function tgOnPick(ctx, token, pick) {
    const r = logins.get(token);
    if (!r || Date.now() > r.exp || r.state !== 'pending' || !r.user || r.user.id !== ctx.from.id) {
      return ctx.answerCbQuery('Abgelaufen oder ungültig.', { show_alert: true }).catch(() => {});
    }
    if (pick === r.code) {
      r.state = 'approved';
      await ctx.editMessageText('✅ Angemeldet. Du kannst jetzt zum Browser zurückkehren.').catch(() => {});
    } else {
      r.state = 'denied';
      await ctx.editMessageText(pick === 'no' ? '❌ Anmeldung abgebrochen.' : '❌ Falsche Zahl – Anmeldung abgebrochen.').catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});
  }

  function send(res, code, obj, extra = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 200000) { reject(bad('Anfrage zu groß', 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(bad('Ungültiges JSON')); }
      });
      req.on('error', reject);
    });
  }
  const fake = (id, c) => ({ chat: { id: Number(id), title: c.title || String(id), type: c.type }, telegram: tg });

  /* ------------------------------ Ansicht ------------------------------ */
  function effectiveAct(c, kind) {
    return (c.act && c.act[kind]) || (kind === 'flood' ? 'mute' : (c.violationWarn ? 'warn' : 'delete'));
  }
  function view(id) {
    const c = cfg(id);
    const s = o.rollStats(c);
    const settings = {};
    for (const k of Object.keys(o.TOGGLES)) settings[k] = !!c[k];
    for (const k of Object.keys(o.NUMS)) settings[k] = c[k];
    const acts = {};
    for (const k of ACT_KINDS) acts[k] = effectiveAct(c, k);
    return {
      id: String(id), title: c.title || String(id), type: c.type || '', webAccess: c.webAccess, joinreq: c.joinreq, reportTime: c.reportTime, reportTo: c.reportTo,
      settings, acts, warnAction: c.warnAction, muteMinutes: c.muteMinutes, floodSeconds: c.floodSeconds,
      floodMuteMinutes: c.floodMuteMinutes, captchaTimeout: c.captchaTimeout,
      welcomeText: c.welcomeText, goodbyeText: c.goodbyeText, welcomeDeleteSec: c.welcomeDeleteSec,
      rules: c.rules, logChat: c.logChat,
      domains: c.domains, blockdomains: c.blockdomains, welcomeButtons: c.welcomeButtons, words: c.words, approved: c.approved, triggers: c.triggers, notes: c.notes,
      schedules: c.schedules, locks: c.locks, scripts: c.scripts, night: c.night,
      locked: !!c.locked, raid: c.raid ? { until: c.raid.until } : null,
      banned: Object.entries(c.banned).map(([uid, b]) => ({ id: uid, name: b.name || '', t: b.t })).sort((a, b) => b.t - a.t),
      stats: {
        today: s.today, total: s.total, hist: s.hist, hours: s.hours,
        top: Object.entries(s.users).map(([uid, u]) => ({ id: uid, name: u.name, n: u.n })).sort((a, b) => b.n - a.n).slice(0, 10),
      },
      warns: Object.entries(c.warns).filter(([, n]) => n > 0).map(([uid, n]) => ({
        id: uid, n, name: (c.members[uid] && c.members[uid].name) || '',
      })),
    };
  }

  /* ---------------------------- Einstellungen ---------------------------- */
  async function applySettings(id, c, b, role) {
    if (b.webAccess !== undefined) {
      if (!['admins', 'creator'].includes(b.webAccess)) throw bad('Ungültiger Zugriffs-Modus');
      if (role !== 'super' && role !== 'creator') throw bad('Nur der Gruppen-Besitzer darf den Web-Zugriff ändern', 403);
      c.webAccess = b.webAccess;
      listCache.clear();
    }
    if (b.joinreq !== undefined) {
      if (!['off', 'approve', 'screen'].includes(b.joinreq)) throw bad('Ungültiger Modus für Beitrittsanfragen');
      c.joinreq = b.joinreq;
    }
    if (b.reportTo !== undefined) {
      if (!['log', 'group'].includes(b.reportTo)) throw bad('Ungültiges Berichts-Ziel');
      c.reportTo = b.reportTo;
    }
    if (b.reportTime !== undefined) {
      const v = String(b.reportTime).trim();
      if (v && !o.normTime(v)) throw bad('Berichtszeit ungültig');
      c.reportTime = v ? o.normTime(v) : '';
    }
    for (const k of Object.keys(o.TOGGLES)) if (typeof b[k] === 'boolean') c[k] = b[k];
    for (const [k, d] of Object.entries(o.NUMS)) {
      if (b[k] === undefined) continue;
      const n = Math.round(Number(b[k]));
      if (!Number.isFinite(n)) throw bad(d.l + ' ist ungültig');
      c[k] = clamp(n, d.min, d.max);
    }
    const intField = (k, a, z) => {
      if (b[k] === undefined) return;
      const n = Math.round(Number(b[k]));
      if (!Number.isFinite(n)) throw bad(k + ' ist ungültig');
      c[k] = clamp(n, a, z);
    };
    intField('muteMinutes', 1, 525600);
    intField('floodSeconds', 1, 120);
    intField('floodMuteMinutes', 1, 1440);
    intField('captchaTimeout', 30, 3600);
    intField('welcomeDeleteSec', 0, 86400);
    if (b.warnAction !== undefined) {
      if (!['mute', 'kick', 'ban'].includes(b.warnAction)) throw bad('Ungültige Aktion');
      c.warnAction = b.warnAction;
    }
    if (b.act && typeof b.act === 'object') {
      for (const k of ACT_KINDS) {
        if (b.act[k] === undefined) continue;
        if (!ACTS.includes(b.act[k])) throw bad('Ungültige Aktion für ' + k);
        c.act[k] = b.act[k];
      }
    }
    if (typeof b.welcomeText === 'string') c.welcomeText = b.welcomeText.slice(0, 500);
    if (typeof b.goodbyeText === 'string') c.goodbyeText = b.goodbyeText.slice(0, 500);
    if (typeof b.rules === 'string') c.rules = b.rules.slice(0, 3000);
    if (b.logChat !== undefined) {
      const v = String(b.logChat).trim();
      if (v && !/^-?\d+$/.test(v)) throw bad('Log-Chat-ID ungültig');
      c.logChat = v;
    }
    if (b.locks && typeof b.locks === 'object') {
      for (const k of Object.keys(o.LOCK_TYPES)) if (typeof b.locks[k] === 'boolean') c.locks[k] = b.locks[k];
    }
    if (b.scripts && typeof b.scripts === 'object') {
      for (const k of Object.keys(o.SCRIPT_LABELS)) if (typeof b.scripts[k] === 'boolean') c.scripts[k] = b.scripts[k];
    }
    if (b.night && typeof b.night === 'object') {
      const n = c.night;
      if (b.night.from !== undefined) { const t = o.normTime(String(b.night.from)); if (!t) throw bad('Startzeit ungültig'); n.from = t; }
      if (b.night.to !== undefined) { const t = o.normTime(String(b.night.to)); if (!t) throw bad('Endzeit ungültig'); n.to = t; }
      if (b.night.tz !== undefined) { const v = Number(b.night.tz); if (!(v >= -12 && v <= 14)) throw bad('Zeitzone ungültig'); n.tz = v; }
      if (typeof b.night.enabled === 'boolean') {
        n.enabled = b.night.enabled;
        if (!n.enabled && n.active) { await o.unlockGroup(tg, Number(id), c); n.active = false; }
      }
    }
    save();
  }

  function listOp(c, b) {
    const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
    switch (b.list) {
      case 'domains':
        if (b.op === 'add') {
          for (const x of str(b.value, 600).split(/[,\s]+/).map((s) => s.toLowerCase()).filter(Boolean)) {
            const h = o.hostOf(x);
            if (h && !c.domains.includes(h) && c.domains.length < 500) c.domains.push(h);
          }
        } else if (b.op === 'remove') c.domains = c.domains.filter((d) => d !== String(b.value));
        break;
      case 'words':
        if (b.op === 'add') {
          for (const w of str(b.value, 2000).split(/[,\n]+/).map((s) => s.trim().slice(0, 200)).map((s) => (s.startsWith('re:') ? s : s.toLowerCase())).filter(Boolean)) {
            if (!c.words.includes(w) && c.words.length < 1000) c.words.push(w);
          }
        } else if (b.op === 'remove') c.words = c.words.filter((w) => w !== String(b.value));
        break;
      case 'blockdomains':
        if (b.op === 'add') {
          for (const x of str(b.value, 600).split(/[,\s]+/).map((s) => s.toLowerCase()).filter(Boolean)) {
            const h = o.hostOf(x);
            if (h && !c.blockdomains.includes(h) && c.blockdomains.length < 500) c.blockdomains.push(h);
          }
        } else if (b.op === 'remove') c.blockdomains = c.blockdomains.filter((d) => d !== String(b.value));
        break;
      case 'wbuttons':
        if (b.op === 'add') {
          const text = str(b.text, 30); const u = str(b.url, 300);
          if (!text || !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('Text und gültige https-URL nötig');
          if (c.welcomeButtons.length >= 6) throw bad('Maximal 6 Buttons');
          c.welcomeButtons.push({ text, url: u });
        } else if (b.op === 'remove') {
          const i = Number(b.index);
          if (Number.isInteger(i) && i >= 0 && i < c.welcomeButtons.length) c.welcomeButtons.splice(i, 1);
        }
        break;
      case 'notes': {
        const name = str(b.name, 32).toLowerCase().replace(/^#/, '');
        if (b.op === 'set') {
          const text = str(b.text, 3500);
          if (!/^[\p{L}\p{N}_]{1,32}$/u.test(name) || !text) throw bad('Name (Buchstaben/Zahlen) und Text nötig');
          c.notes[name] = text;
        } else if (b.op === 'remove') delete c.notes[name];
        break;
      }
      case 'triggers': {
        const key = str(b.key, 100).toLowerCase();
        if (b.op === 'set') {
          const text = str(b.text, 3000);
          if (!key || !text) throw bad('Stichwort und Antwort nötig');
          if (!c.triggers[key] && Object.keys(c.triggers).length >= 50) throw bad('Maximal 50 Trigger');
          c.triggers[key] = text;
        } else if (b.op === 'remove') delete c.triggers[key];
        break;
      }
      case 'schedules':
        if (b.op === 'add') {
          const t = o.normTime(str(b.time, 5));
          const text = str(b.text, 3000);
          if (!t || !text) throw bad('Zeit (HH:MM) und Text nötig');
          if (c.schedules.length >= 10) throw bad('Maximal 10 Zeitpläne');
          const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
          c.schedules.push({ time: t, text, days, pin: !!b.pin, last: '' });
        } else if (b.op === 'remove') {
          const i = Number(b.index);
          if (Number.isInteger(i) && i >= 0 && i < c.schedules.length) c.schedules.splice(i, 1);
        }
        break;
      default: throw bad('Unbekannte Liste');
    }
    save();
  }

  function exportObj(c) {
    const out = {};
    for (const k of Object.keys(c)) if (!RUNTIME.includes(k)) out[k] = c[k];
    return out;
  }
  function importSettings(c, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Ungültige Einstellungs-Datei');
    const active = c.night.active;
    let n = 0;
    for (const k of Object.keys(c)) {
      if (RUNTIME.includes(k) || !(k in data)) continue;
      if (typeof data[k] === typeof c[k] && Array.isArray(data[k]) === Array.isArray(c[k])) { c[k] = clone(data[k]); n++; }
    }
    c.night.active = active;
    if (!n) throw bad('Keine passenden Einstellungen gefunden');
    save();
  }

  async function action(id, c, b, actor) {
    const chatId = Number(id);
    const needUser = () => {
      if (!/^\d{1,15}$/.test(String(b.userId || '').trim())) throw bad('Gültige User-ID nötig');
      return Number(String(b.userId).trim());
    };
    const minutes = clamp(Math.round(Number(b.minutes)) || 0, 0, 525600);
    const fk = fake(id, c);
    switch (b.type) {
      case 'lock': await o.lockGroup(tg, chatId, c); break;
      case 'unlock': await o.unlockGroup(tg, chatId, c); if (c.night) c.night.active = false; save(); break;
      case 'warn': {
        const uid = needUser();
        await o.addWarn(fk, { id: uid, first_name: (c.members[uid] && c.members[uid].name) || String(uid) }, String(b.reason || 'Manuelle Verwarnung').slice(0, 100));
        break;
      }
      case 'unwarn': { const uid = needUser(); c.warns[String(uid)] = Math.max(0, (c.warns[String(uid)] || 0) - 1); save(); break; }
      case 'resetwarns': c.warns[String(needUser())] = 0; save(); break;
      case 'mute': await o.punish(fk, needUser(), 'mute', minutes || c.muteMinutes); break;
      case 'kick': await o.punish(fk, needUser(), 'kick'); break;
      case 'ban': await o.punish(fk, needUser(), 'ban', 0, minutes); break;
      case 'unmute': {
        const uid = needUser();
        let p = o.FULL;
        try { const ch = await tg.getChat(chatId); if (ch.permissions) p = ch.permissions; } catch (_) {}
        await tg.restrictChatMember(chatId, uid, { permissions: p });
        break;
      }
      case 'unban': {
        const uid = needUser();
        await tg.unbanChatMember(chatId, uid, { only_if_banned: true });
        delete c.banned[uid]; save();
        break;
      }
      case 'note': {
        const uid = needUser();
        const text = String(b.text || '').trim().slice(0, 300);
        const e = c.members[uid] || (c.members[uid] = { name: '', user: '', first: Date.now(), last: 0, n: 0 });
        if (text) e.note = text; else delete e.note;
        save();
        break;
      }
      case 'approve': { const uid = needUser(); if (!c.approved.includes(uid)) c.approved.push(uid); save(); break; }
      case 'unapprove': { const uid = needUser(); c.approved = c.approved.filter((x) => x !== uid); save(); break; }
      case 'send': {
        const text = String(b.text || '').trim().slice(0, 4000);
        if (!text) throw bad('Text fehlt');
        const m = await tg.sendMessage(chatId, text, { disable_web_page_preview: true });
        if (b.pin) { try { await tg.pinChatMessage(chatId, m.message_id, { disable_notification: true }); } catch (_) {} }
        break;
      }
      default: throw bad('Unbekannte Aktion');
    }
    if (actor) o.logEvent(id, 'mod', `Web (${actor}): ${b.type}${b.userId ? ' ' + String(b.userId).trim() : ''}`);
  }

  /* -------------------------------- Server -------------------------------- */
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        });
        return res.end(html);
      }
      if (!p.startsWith('/api/')) return send(res, 404, { error: 'Nicht gefunden' });
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'dash') return send(res, 403, { error: 'Verboten' });

      if (req.method === 'GET' && p === '/api/loginmethods') {
        return send(res, 200, { password: pwEnabled, telegram: tgLogin, bot: me.username });
      }
      if (req.method === 'POST' && p === '/api/login') {
        if (!pwEnabled) throw bad('Passwort-Login ist deaktiviert', 404);
        const ip = clientIp(req);
        const a = attempts.get(ip) || { n: 0, ts: Date.now() };
        if (Date.now() - a.ts > 600000) { a.n = 0; a.ts = Date.now(); }
        if (a.n >= 5) return send(res, 429, { error: 'Zu viele Versuche. Bitte 10 Minuten warten.' });
        const b = await readJson(req);
        if (!crypto.timingSafeEqual(sha(b.password || ''), pwHash)) {
          a.n++; attempts.set(ip, a);
          return send(res, 401, { error: 'Falsches Passwort.' });
        }
        attempts.delete(ip);
        return send(res, 200, { ok: true }, { 'Set-Cookie': mkSession({ sup: true, name: 'Owner', ip }) });
      }
      if (req.method === 'POST' && p === '/api/tglogin/start') {
        if (!tgLogin) throw bad('Telegram-Login ist deaktiviert', 404);
        const ip = clientIp(req);
        const a = starts.get(ip) || { n: 0, ts: Date.now() };
        if (Date.now() - a.ts > 600000) { a.n = 0; a.ts = Date.now(); }
        if (++a.n > 10) return send(res, 429, { error: 'Zu viele Versuche. Bitte 10 Minuten warten.' });
        starts.set(ip, a);
        if (logins.size > 500) throw bad('Zu viele offene Anmeldungen, bitte später erneut versuchen', 429);
        const token = crypto.randomBytes(16).toString('hex');
        const poll = crypto.randomBytes(16).toString('hex');
        const code = String(1000 + crypto.randomInt(9000));
        logins.set(token, { poll, code, exp: Date.now() + 300000, state: 'pending', user: null });
        return send(res, 200, { code, poll, link: `https://t.me/${me.username}?start=wl_${token}`, expires: 300 });
      }
      if (req.method === 'GET' && p === '/api/tglogin/poll') {
        const secret = url.searchParams.get('poll') || '';
        if (!/^[a-f0-9]{32}$/.test(secret)) throw bad('Ungültig');
        let found = null;
        for (const [t, r] of logins) if (r.poll === secret) { found = [t, r]; break; }
        if (!found) return send(res, 200, { status: 'expired' });
        const [t, r] = found;
        if (Date.now() > r.exp) { logins.delete(t); return send(res, 200, { status: 'expired' }); }
        if (r.state === 'pending') return send(res, 200, { status: 'pending', claimed: !!r.user });
        logins.delete(t);
        if (r.state !== 'approved') return send(res, 200, { status: 'denied' });
        const cookie = mkSession({ uid: r.user.id, name: r.user.name, username: r.user.username, sup: OWNERS.has(r.user.id), ip: clientIp(req) });
        return send(res, 200, { status: 'ok' }, { 'Set-Cookie': cookie });
      }

      const sess = getSession(req);
      if (!sess) return send(res, 401, { error: 'Nicht angemeldet' });

      if (req.method === 'POST' && p === '/api/logout') {
        const m = SID_RE.exec(req.headers.cookie || '');
        if (m) sessions.delete(m[1]);
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && p === '/api/meta') {
        return send(res, 200, {
          toggles: o.TOGGLES, nums: o.NUMS, locks: o.LOCK_TYPES, scripts: o.SCRIPT_LABELS,
          presets: Object.keys(o.PRESETS || {}), bot: me.username,
        });
      }
      if (req.method === 'GET' && p === '/api/me') {
        return send(res, 200, { uid: sess.uid || null, name: sess.name || '', username: sess.username || '', sup: !!sess.sup });
      }
      if (req.method === 'GET' && p === '/api/overview') {
        const ids = await visibleIds(sess);
        const chats = ids.map((id) => {
          const c = cfg(id);
          return {
            id, title: c.title || id, type: c.type || '', locked: !!c.locked, raid: !!c.raid,
            msgs: (o.rollStats(c).today.msgs) || 0, members: Object.keys(c.members || {}).length,
          };
        });
        const out = { chats };
        if (sess.sup) { out.uptime = Math.round(process.uptime()); out.rss = Math.round(process.memoryUsage().rss / 1048576); out.node = process.version; }
        return send(res, 200, out);
      }
      const superOnly = () => { if (!sess.sup) throw bad('Nur für den Owner', 403); };
      if (req.method === 'GET' && p === '/api/backup') {
        superOnly();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="data.json"', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(db, null, 2));
      }
      if (req.method === 'GET' && p === '/api/gbans') {
        superOnly();
        return send(res, 200, { items: Object.entries(db.gbans).map(([id, g]) => ({ id, t: g.t, reason: g.reason || '' })).sort((a, b) => b.t - a.t) });
      }
      if (req.method === 'POST' && (p === '/api/gban' || p === '/api/ungban')) {
        superOnly();
        const b = await readJson(req);
        const uid = String(b.userId || '').trim();
        if (!/^\d{1,15}$/.test(uid)) throw bad('Gültige User-ID nötig');
        const n = p === '/api/gban' ? await o.gbanUser(tg, uid, b.reason) : await o.ungbanUser(tg, uid);
        return send(res, 200, { ok: n });
      }
      const bm = /^\/api\/backups(?:\/([^/]+))?$/.exec(p);
      if (req.method === 'GET' && bm) {
        superOnly();
        let files = [];
        try { files = fs.readdirSync(BK_DIR).filter((f) => BK_RE.test(f)).sort().reverse(); } catch (_) {}
        if (!bm[1]) {
          return send(res, 200, { items: files.map((f) => ({ name: f, size: fs.statSync(path.join(BK_DIR, f)).size })) });
        }
        if (!BK_RE.test(bm[1]) || !files.includes(bm[1])) throw bad('Backup nicht gefunden', 404);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + bm[1] + '"', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(BK_DIR, bm[1])));
      }
      const sidOf = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
      if (req.method === 'GET' && p === '/api/sessions') {
        superOnly();
        const mine = SID_RE.exec(req.headers.cookie || '');
        const items = [];
        for (const [t, e] of sessions) {
          items.push({ id: sidOf(t), name: e.name || '', username: e.username || '', uid: e.uid || null, sup: !!e.sup, ip: e.ip || '', since: e.since || 0, current: !!(mine && mine[1] === t) });
        }
        return send(res, 200, { items: items.sort((a, b) => b.since - a.since) });
      }
      if (req.method === 'POST' && p === '/api/sessions/revoke') {
        superOnly();
        const b = await readJson(req);
        let n = 0;
        for (const t of [...sessions.keys()]) if (sidOf(t) === String(b.id)) { sessions.delete(t); n++; }
        return send(res, 200, { ok: n });
      }
      if (req.method === 'POST' && p === '/api/restore') {
        superOnly();
        const b = await readJson(req);
        const name = String(b.name || '');
        if (!BK_RE.test(name)) throw bad('Ungültiger Backup-Name');
        const file = path.join(BK_DIR, name);
        if (!fs.existsSync(file)) throw bad('Backup nicht gefunden', 404);
        let data;
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw bad('Backup ist beschädigt'); }
        if (!data || typeof data.chats !== 'object' || Array.isArray(data.chats)) throw bad('Backup hat ein ungültiges Format');
        try {
          fs.mkdirSync(BK_DIR, { recursive: true });
          fs.writeFileSync(path.join(BK_DIR, 'pre-restore-' + Date.now() + '.json'), JSON.stringify(db));
          fs.readdirSync(BK_DIR).filter((f) => /^pre-restore-\d+\.json$/.test(f)).sort().slice(0, -3).forEach((f) => fs.unlinkSync(path.join(BK_DIR, f)));
        } catch (_) {}
        for (const k of Object.keys(db)) delete db[k];
        Object.assign(db, data);
        if (!db.chats) db.chats = {};
        if (!db.gbans) db.gbans = {};
        for (const id of Object.keys(db.chats)) cfg(id);
        listCache.clear();
        save();
        return send(res, 200, { ok: true, chats: Object.keys(db.chats).length });
      }
      if (req.method === 'POST' && p === '/api/broadcast') {
        superOnly();
        const b = await readJson(req);
        const text = String(b.text || '').trim().slice(0, 4000);
        if (!text) throw bad('Text fehlt');
        const ids = Object.keys(db.chats).slice(0, 300);
        let ok = 0;
        for (const id of ids) {
          try { await tg.sendMessage(Number(id), text, { disable_web_page_preview: true }); ok++; } catch (_) {}
          await sleep(80);
        }
        return send(res, 200, { ok, total: ids.length });
      }

      const m = /^\/api\/chat\/(-?\d+)(?:\/([a-z]+))?$/.exec(p);
      if (m) {
        const id = m[1];
        if (!db.chats[id]) throw bad('Gruppe nicht gefunden', 404);
        const role = await needRole(sess, id);
        const actor = sess.uid ? ((sess.name || String(sess.uid)) + (sess.username ? ' @' + sess.username : '')) : 'Owner';
        const c = cfg(id);
        const sub = m[2] || '';
        const full = () => Object.assign(view(id), { role, canOwn: role === 'super' || role === 'creator' });

        if (req.method === 'GET') {
          if (!sub) return send(res, 200, full());
          if (sub === 'rights') {
            try {
              const r = await tg.getChatMember(Number(id), me.id);
              if (r.status !== 'administrator') return send(res, 200, { member: r.status === 'member', admin: false });
              return send(res, 200, { member: true, admin: true, del: !!r.can_delete_messages, restrict: !!r.can_restrict_members, pin: !!r.can_pin_messages });
            } catch (e) { return send(res, 200, { member: false, admin: false, error: e.message }); }
          }
          if (sub === 'info') {
            const [count, adm] = await Promise.all([
              Promise.resolve().then(() => (tg.getChatMemberCount || tg.getChatMembersCount).call(tg, Number(id))).catch(() => null),
              tg.getChatAdministrators(Number(id)).catch(() => []),
            ]);
            return send(res, 200, {
              members: count,
              admins: adm.map((a) => ({ id: a.user.id, name: a.user.first_name || '', user: a.user.username || '', bot: !!a.user.is_bot, status: a.status, title: a.custom_title || '' })),
            });
          }
          if (sub === 'members') {
            const q = (url.searchParams.get('q') || '').trim().toLowerCase();
            const sort = { n: 'n', last: 'last', first: 'first', warns: 'warns' }[url.searchParams.get('sort')] || 'last';
            const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
            let arr = Object.entries(c.members).map(([uid, mm]) => ({
              id: uid, name: mm.name || '', user: mm.user || '', note: mm.note || '', n: mm.n || 0, first: mm.first || 0, last: mm.last || 0,
              warns: c.warns[uid] || 0, approved: c.approved.includes(Number(uid)), banned: !!c.banned[uid],
            }));
            if (q) arr = arr.filter((x) => x.id.includes(q) || x.name.toLowerCase().includes(q) || x.user.toLowerCase().includes(q) || x.note.toLowerCase().includes(q));
            arr.sort((a, b) => b[sort] - a[sort]);
            return send(res, 200, { total: arr.length, page, items: arr.slice(page * 25, page * 25 + 25) });
          }
          if (sub === 'events') return send(res, 200, { items: c.events.slice().reverse() });
          if (sub === 'csv') {
            const type = url.searchParams.get('type') === 'events' ? 'events' : 'members';
            const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
            const iso = (t) => (t ? new Date(t).toISOString() : '');
            const rows = type === 'events'
              ? [['Zeit', 'Typ', 'Text'], ...c.events.slice().reverse().map((e) => [iso(e.t), e.type, e.text])]
              : [['ID', 'Name', 'Username', 'Nachrichten', 'Erster Kontakt', 'Zuletzt aktiv', 'Verwarnungen', 'Ausgenommen', 'Gebannt', 'Notiz'],
                ...Object.entries(c.members).map(([uid, mm]) => [uid, mm.name || '', mm.user || '', mm.n || 0, iso(mm.first), iso(mm.last),
                  c.warns[uid] || 0, c.approved.includes(Number(uid)) ? 'ja' : '', c.banned[uid] ? 'ja' : '', mm.note || ''])];
            res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + type + '-' + id + '.csv"', 'Cache-Control': 'no-store' });
            return res.end('\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n'));
          }
          if (sub === 'export') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="settings' + id + '.json"', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(exportObj(c), null, 2));
          }
          return send(res, 404, { error: 'Nicht gefunden' });
        }

        if (req.method === 'POST') {
          const b = await readJson(req);
          if (sub === 'settings') await applySettings(id, c, b, role);
          else if (sub === 'list') listOp(c, b);
          else if (sub === 'action') await action(id, c, b, actor);
          else if (sub === 'preset') {
            if (!o.PRESETS || !o.PRESETS[b.name]) throw bad('Unbekanntes Preset');
            Object.assign(c, clone(o.PRESETS[b.name])); save();
            o.logEvent(id, 'mod', 'Web (' + actor + '): Preset ' + b.name + ' angewendet');
          } else if (sub === 'copyfrom') {
            const from = String(b.from || '');
            if (!db.chats[from] || from === id) throw bad('Quell-Gruppe ungültig');
            await needRole(sess, from);
            const src = cfg(from);
            const active = c.night.active;
            for (const k of Object.keys(src)) if (!RUNTIME.includes(k)) c[k] = clone(src[k]);
            c.night.active = active; save();
            o.logEvent(id, 'mod', 'Web (' + actor + '): Einstellungen von „' + (src.title || from) + '“ übernommen');
          } else if (sub === 'import') importSettings(c, b.data);
          else if (sub === 'forget') {
            if (role !== 'super' && role !== 'creator') throw bad('Nur der Gruppen-Besitzer darf die Gruppe entfernen', 403);
            delete db.chats[id];
            listCache.clear(); save(); return send(res, 200, { ok: true }); }
          else throw bad('Unbekannt', 404);
          if (['settings', 'list', 'import'].includes(sub)) o.logEvent(id, 'mod', `Web (${actor}): ${sub}`);
          return send(res, 200, full());
        }
      }
      return send(res, 404, { error: 'Nicht gefunden' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('Dashboard-Fehler:', e.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Fehler: ' + e.message : e.message });
    }
  });

  server.on('error', (e) => console.error('Dashboard konnte nicht starten:', e.message));
  server.listen(port, host, () => {
    console.log(`Dashboard läuft: http://${host}:${port}  (Anmeldung: ${[pwEnabled && 'Passwort', tgLogin && 'Telegram'].filter(Boolean).join(' + ')})`);
    if (!loopback) console.log('Achtung: HTTP ohne Verschlüsselung – nur im vertrauenswürdigen Netz nutzen.');
  });
  return { onStart: tgOnStart, onPick: tgOnPick };
}

module.exports = { start };

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('BOT_TOKEN fehlt in der .env Datei!');
  process.exit(1);
}
const OWNERS = new Set(
  (process.env.OWNER_IDS || '').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean)
);
const LOG_CHAT_ID = process.env.LOG_CHAT_ID || '';

const bot = new Telegraf(TOKEN);

// Gruppennamen merken (für das Admin-Panel im Privatchat)
bot.use((ctx, next) => {
  if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    const c = cfg(ctx.chat.id);
    if (c.title !== ctx.chat.title || c.type !== ctx.chat.type) { c.title = ctx.chat.title; c.type = ctx.chat.type; save(); }
  }
  return next();
});

/* ------------------------------ Datenbank ------------------------------ */
const DB_FILE = path.join(__dirname, 'data.json');
let db = { chats: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
if (!db.chats) db.chats = {};
if (!db.gbans) db.gbans = {};
let saveTimer = null;
function writeDb() {
  try {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeDb(); }, 1000);
}
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeDb();
}

const DEFAULTS = {
  domains: [], words: [], approved: [], warns: {},
  antilink: true, wordfilter: true, flood: true, antiforward: false,
  delservice: true, welcome: false, captcha: false, antibot: false,
  violationWarn: true,
  floodLimit: 6, floodSeconds: 8,
  warnLimit: 3, warnAction: 'mute', muteMinutes: 60,
  captchaTimeout: 120,
  welcomeText: 'Willkommen {name} in {chat}!',
  rules: '',
  cleancmd: false, maxMentions: 5, newbieMinutes: 0,
  locks: {}, notes: {}, joined: {}, locked: false, savedPerms: null,
  night: { enabled: false, from: '23:00', to: '07:00', tz: 1, active: false },
  antirepeat: false, anticaps: false, antiraid: false, raidLimit: 8, raid: null,
  scripts: {}, triggers: {}, schedules: [], logChat: '', title: '', type: '',
  stats: { day: '', today: {}, total: {}, users: {}, hist: [] },
  act: {}, floodMuteMinutes: 5, members: {}, events: [], banned: {},
  goodbye: false, goodbyeText: 'Tschüss {name}!', welcomeDeleteSec: 60,
  warnExpireDays: 0, warnTimes: {}, blockdomains: [], namefilter: false, cas: false,
  autodel: 0, delQueue: [], slowSeconds: 0, welcomeButtons: [], welcomeRulesBtn: false,
  antiemail: false, antiphone: false, joinreq: 'off', reportTime: '', reportTo: 'log', reportLast: '',
  webAccess: 'admins',
};
function cfg(chatId) {
  const k = String(chatId);
  if (!db.chats[k]) db.chats[k] = {};
  const c = db.chats[k];
  for (const [key, val] of Object.entries(DEFAULTS)) {
    if (c[key] === undefined) c[key] = JSON.parse(JSON.stringify(val));
  }
  return c;
}

/* ------------------------------- Helfer -------------------------------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mention = (u) => `<a href="tg://user?id=${u.id}">${esc(u.first_name || u.id)}</a>`;
const isGroup = (ctx) => ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
const args = (ctx) => (ctx.message.text || '').split(/\s+/).slice(1);
const argText = (ctx) => (ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();

const FULL = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_invite_users: true,
};
const MUTED = Object.fromEntries(Object.keys(FULL).map((k) => [k, false]));

const adminCache = new Map();
async function isAdminIn(tg, chatId, userId) {
  if (!userId) return false;
  if (OWNERS.has(userId) || userId === 1087968824 || userId === 777000) return true;
  const key = chatId + ':' + userId;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  try {
    const m = await tg.getChatMember(chatId, userId);
    const v = m.status === 'creator' || m.status === 'administrator';
    adminCache.set(key, { v, t: Date.now() });
    return v;
  } catch (_) { return false; }
}
const isAdmin = (ctx, userId = ctx.from && ctx.from.id) => isAdminIn(ctx.telegram, ctx.chat.id, userId);

async function notify(ctx, text, ms = 10000, extra = {}) {
  try {
    const m = await ctx.telegram.sendMessage(ctx.chat.id, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    if (ms) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), ms);
    return m;
  } catch (_) {}
}
async function log(ctx, text) {
  logEvent(ctx.chat.id, 'filter', text);
  const target = cfg(ctx.chat.id).logChat || LOG_CHAT_ID;
  if (!target) return;
  try {
    await ctx.telegram.sendMessage(target, `<b>${esc(ctx.chat.title || ctx.chat.id)}</b>\n${text}`, { parse_mode: 'HTML' });
  } catch (_) {}
}
async function fullPerms(ctx) {
  try { const ch = await ctx.telegram.getChat(ctx.chat.id); return ch.permissions || FULL; } catch (_) { return FULL; }
}

async function punish(ctx, userId, action, minutes, banMinutes) {
  const id = ctx.chat.id;
  stat(id, 'punished');
  logEvent(id, 'punish', `${action} → ${userId}${banMinutes ? ' (' + banMinutes + ' Min)' : ''}`);
  if (action === 'ban') {
    const cc = cfg(id);
    cc.banned[userId] = { name: (cc.members[userId] && cc.members[userId].name) || '', t: Date.now() };
    save();
  }
  if (action === 'ban') {
    await ctx.telegram.banChatMember(id, userId, banMinutes ? Math.floor(Date.now() / 1000) + banMinutes * 60 : undefined);
  } else if (action === 'kick') {
    await ctx.telegram.banChatMember(id, userId);
    await ctx.telegram.unbanChatMember(id, userId, { only_if_banned: true });
  } else {
    await ctx.telegram.restrictChatMember(id, userId, {
      permissions: MUTED,
      until_date: Math.floor(Date.now() / 1000) + Math.max(1, minutes) * 60,
    });
  }
}

async function addWarn(ctx, user, reason) {
  const c = cfg(ctx.chat.id);
  const k = String(user.id);
  expireWarns(c, k);
  c.warns[k] = (c.warns[k] || 0) + 1;
  (c.warnTimes[k] = c.warnTimes[k] || []).push(Date.now());
  stat(ctx.chat.id, 'warns');
  logEvent(ctx.chat.id, 'warn', `${user.first_name || user.id} (${user.id}): ${reason} [${c.warns[k]}/${c.warnLimit}]`);
  const n = c.warns[k];
  if (n >= c.warnLimit) {
    c.warns[k] = 0;
    c.warnTimes[k] = [];
    save();
    try {
      await punish(ctx, user.id, c.warnAction, c.muteMinutes);
      await notify(ctx, `🚫 ${mention(user)} hat ${c.warnLimit} Verwarnungen erreicht → <b>${c.warnAction}</b>.\nGrund: ${esc(reason)}`);
      await log(ctx, `🚫 ${mention(user)} → ${c.warnAction} (${esc(reason)})`);
    } catch (e) {
      await notify(ctx, `❗ Bestrafung fehlgeschlagen (Bot braucht Admin-Rechte): ${esc(e.message)}`);
    }
  } else {
    save();
    await notify(ctx, `⚠️ ${mention(user)} Verwarnung <b>${n}/${c.warnLimit}</b>\nGrund: ${esc(reason)}`);
  }
}

function target(ctx) {
  const r = ctx.message.reply_to_message;
  if (r && r.from && !r.forum_topic_created) return { user: r.from, rest: args(ctx) };
  const a = args(ctx);
  if (/^\d+$/.test(a[0] || '')) return { user: { id: Number(a[0]), first_name: a[0] }, rest: a.slice(1) };
  return null;
}

/* --------------------------- Link / Wort Logik -------------------------- */
function hostOf(raw) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) { return null; }
}
function extractHosts(text, entities) {
  const hosts = new Set();
  for (const e of entities || []) {
    let raw = null;
    if (e.type === 'url') raw = text.substr(e.offset, e.length);
    else if (e.type === 'text_link') raw = e.url;
    if (raw) { const h = hostOf(raw); if (h) hosts.add(h); }
  }
  for (const m of text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || []) {
    const h = hostOf(m); if (h) hosts.add(h);
  }
  return [...hosts];
}
const domainAllowed = (host, list) => list.some((d) => host === d || host.endsWith('.' + d));

const wordCache = new Map();
function wordRegex(w) {
  if (wordCache.has(w)) return wordCache.get(w);
  if (w.startsWith('re:')) {
    let rx;
    try { rx = new RegExp(w.slice(3, 203), 'iu'); } catch (_) { rx = /(?!)/; }
    wordCache.set(w, rx);
    return rx;
  }
  const star = w.endsWith('*');
  const base = w.replace(/\*+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${base}${star ? '' : '(?![\\p{L}\\p{N}])'}`, 'iu');
  wordCache.set(w, re);
  return re;
}

const floodMap = new Map();
function isFlood(chatId, userId, limit, sec) {
  const k = chatId + ':' + userId;
  const now = Date.now();
  const arr = (floodMap.get(k) || []).filter((t) => now - t < sec * 1000);
  arr.push(now);
  floodMap.set(k, arr);
  if (arr.length > limit) { floodMap.delete(k); return true; }
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of floodMap) if (!arr.length || now - arr[arr.length - 1] > 60000) floodMap.delete(k);
}, 300000).unref();

/* ----------------------- Neue Mitglieder / Captcha ---------------------- */
const pending = new Map();
const fmt = (tpl, user, chat) =>
  esc(tpl).replace(/\{name\}/g, mention(user)).replace(/\{chat\}/g, esc(chat.title || '')).replace(/\{id\}/g, user.id);

bot.on('new_chat_members', async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const c = cfg(ctx.chat.id);
  stat(ctx.chat.id, 'joins', ctx.message.new_chat_members.length);
  await raidCheck(ctx, c, ctx.message.new_chat_members.length);
  for (const u of ctx.message.new_chat_members) {
    if (!u.is_bot) { touchMember(c, u); logEvent(ctx.chat.id, 'join', `${u.first_name || u.id} (${u.id}) ist beigetreten`); }
    if (!u.is_bot && (await joinChecks(ctx, c, u))) continue;
    if (c.newbieMinutes > 0 && !u.is_bot) { c.joined[u.id] = Date.now(); save(); }
    try {
      if (u.is_bot) {
        if (c.antibot && u.id !== ctx.botInfo.id && !(await isAdmin(ctx))) {
          await punish(ctx, u.id, 'kick');
          await notify(ctx, `🛡 Bot ${mention(u)} entfernt.`);
        }
        continue;
      }
      if (c.captcha) {
        await ctx.telegram.restrictChatMember(ctx.chat.id, u.id, { permissions: MUTED });
        const m = await ctx.telegram.sendMessage(
          ctx.chat.id,
          `🤖 ${mention(u)}, bitte bestätige innerhalb von ${c.captchaTimeout}s, dass du ein Mensch bist.`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Ich bin kein Bot', `cap:${u.id}`)]]) }
        );
        const key = ctx.chat.id + ':' + u.id;
        const timer = setTimeout(async () => {
          pending.delete(key);
          try {
            await punish(ctx, u.id, 'kick');
            await ctx.telegram.deleteMessage(ctx.chat.id, m.message_id);
          } catch (_) {}
        }, c.captchaTimeout * 1000);
        pending.set(key, { timer, msgId: m.message_id });
      } else if (c.welcome) {
        await notify(ctx, fmt(c.welcomeText, u, ctx.chat), (c.welcomeDeleteSec || 0) * 1000, welcomeExtra(c));
      }
    } catch (e) { console.error('new member:', e.message); }
  }
  return next();
});

bot.action(/^cap:(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (ctx.from.id !== uid) return ctx.answerCbQuery('Dieser Button ist nicht für dich.', { show_alert: true });
  const key = ctx.chat.id + ':' + uid;
  const p = pending.get(key);
  if (p) { clearTimeout(p.timer); pending.delete(key); }
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, uid, { permissions: await fullPerms(ctx) });
    await ctx.deleteMessage().catch(() => {});
    const c = cfg(ctx.chat.id);
    if (c.welcome) await notify(ctx, fmt(c.welcomeText, ctx.from, ctx.chat), (c.welcomeDeleteSec || 0) * 1000, welcomeExtra(c));
    await ctx.answerCbQuery('Verifiziert ✅');
  } catch (e) { await ctx.answerCbQuery('Fehler: ' + e.message, { show_alert: true }); }
});

/* ------------------------------- Befehle -------------------------------- */
const admin = (fn) => async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Dieser Befehl funktioniert nur in Gruppen.');
  if (!(await isAdmin(ctx))) return;
  const c = cfg(ctx.chat.id);
  try { await fn(ctx, c); } catch (e) { await notify(ctx, '❗ ' + esc(e.message)); }
  if (c.cleancmd && ctx.message) ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
};

const HELP = `<b>🛡 Gruppen-Manager</b>

<b>Einstellungen</b>
/settings – Schalter-Panel
/setwarnlimit &lt;n&gt;
/setwarnaction mute|kick|ban
/setmute &lt;minuten&gt; – Standard-Mutedauer
/setflood &lt;nachrichten&gt; &lt;sekunden&gt;
/setwelcome &lt;text&gt; ({name} {chat} {id})
/setrules &lt;text&gt;  ·  /rules

<b>Domain-Whitelist</b>
/adddomain example.com, t.me
/deldomain example.com
/domains

<b>Wortfilter</b>
/addword wort, ein satz, präfix*
/delword wort
/words

<b>Moderation</b> (Antwort auf Nachricht oder User-ID)
/warn [grund]  ·  /unwarn  ·  /warns
/mute [min]  ·  /unmute
/kick  ·  /ban  ·  /unban
/approve  ·  /unapprove – vom Filter ausnehmen
/approved – Liste
/resetwarns  ·  /info

<b>Setup &amp; Schutz</b>
/setup – geführte Einrichtung
/lock &lt;typ&gt;  ·  /unlock &lt;typ&gt;  ·  /locks
/lockgroup  ·  /unlockgroup
/night 23:00 07:00  ·  /night off  ·  /settz 1

<b>Notizen</b>
/save name text  ·  /notes  ·  /clear name  ·  #name

<b>Panel &amp; Statistik</b>
/panel – Verwaltung im Privatchat
/stats  ·  /setlog &lt;chat-id&gt;

<b>Automatik</b>
/trigger wort = antwort  ·  /triggers  ·  /deltrigger wort
/schedule 18:00 text  ·  /schedules  ·  /unschedule nr
/script cyrillic on|off – Schriften blockieren
/mute 2h  ·  /ban 7d – zeitlich begrenzt (m/h/d/w)

<b>Schutz</b>
/blockdomain domain  ·  /unblockdomain  ·  /blockdomains
/slow sek  ·  /autodel min  ·  /warnexpire tage
Wörter mit <code>re:muster</code> = Regex (statt Komma ein |)

<b>Berichte &amp; Notizen</b>
/dailyreport 23:55 [group|log]  ·  /dailyreport off
/usernote text  ·  /usernote -  (Antwort auf einen User)
/menu – Menü  ·  /help – dieses Menü

<b>Owner</b>
/broadcast text  ·  /backup  ·  /status  (Privatchat)
/gban id grund  ·  /ungban id  ·  /gbans  (global)

<b>Tools</b>
/report (Antwort)  ·  /del  ·  /purge  ·  /pin  ·  /unpin
/export – Einstellungen als Datei
/id`;

let webLogin = null;
bot.action(/^wl:([a-f0-9]{32}):(\d{4}|no)$/, async (ctx) => {
  if (!webLogin) return ctx.answerCbQuery('Web-Panel nicht aktiv.');
  return webLogin.onPick(ctx, ctx.match[1], ctx.match[2]);
});
bot.start(async (ctx) => {
  if (isGroup(ctx)) return ctx.reply('Bot aktiv ✅ – Einrichtung mit /setup');
  const pl = ctx.startPayload || '';
  if (/^wl_[a-f0-9]{32}$/.test(pl)) return webLogin ? webLogin.onStart(ctx, pl.slice(3)) : ctx.reply('Das Web-Panel ist nicht aktiv.');
  if (pl === 'panel') return showPanelList(ctx);
  return ctx.reply('👋 Füge mich in deine Supergruppe ein, mach mich zum Admin und starte dort /setup.\n\n/panel – Gruppen hier im Privatchat verwalten\n/help – alle Befehle');
});
bot.command('id', (ctx) => ctx.reply(`Chat: <code>${ctx.chat.id}</code>\nDu: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' }));
bot.command('rules', (ctx) => {
  if (!isGroup(ctx)) return;
  const c = cfg(ctx.chat.id);
  return ctx.reply(c.rules ? `📜 <b>Regeln</b>\n${esc(c.rules)}` : 'Keine Regeln gesetzt.', { parse_mode: 'HTML' });
});

/* Panel */
const TOGGLES = {
  antilink: '🔗 Link-Filter', wordfilter: '🤬 Wortfilter', flood: '🌊 Anti-Flood',
  antiforward: '↪️ Weiterleitungen sperren', delservice: '🧹 Service-Msgs löschen',
  welcome: '👋 Willkommen', captcha: '🤖 Captcha', antibot: '🛡 Bots blockieren',
  violationWarn: '⚠️ Verstoß = Verwarnung',
  cleancmd: '🧽 Admin-Befehle löschen',
  antirepeat: '♻️ Wiederholungen blockieren',
  anticaps: '🔠 CAPS-Filter',
  antiraid: '🚨 Raid-Schutz',
  goodbye: '👋 Abschiedsnachricht',
  namefilter: '🪪 Namens-Filter (Beitritt)',
  cas: '🛰 CAS-Spammer-Check (Beitritt)',
  welcomeRulesBtn: '📜 Regeln-Button im Willkommen',
  antiemail: '✉️ E-Mail-Adressen blockieren',
  antiphone: '📞 Telefonnummern blockieren',
};
const panel = (c) => Markup.inlineKeyboard(
  Object.entries(TOGGLES).map(([k, l]) => [Markup.button.callback(`${c[k] ? '✅' : '❌'} ${l}`, `tg:${k}`)])
);
const status = (c) =>
  `⚙️ <b>Einstellungen</b>\nDomains: ${c.domains.length} · Wörter: ${c.words.length}\n` +
  `Warn-Limit: ${c.warnLimit} → ${c.warnAction} (${c.muteMinutes} min)\n` +
  `Flood: ${c.floodLimit} Nachrichten / ${c.floodSeconds}s`;

bot.command('settings', admin(async (ctx, c) => {
  await ctx.reply(status(c), { parse_mode: 'HTML', ...panel(c) });
}));
bot.action(/^tg:(\w+)$/, async (ctx) => {
  if (!isGroup(ctx) || !(await isAdmin(ctx))) return ctx.answerCbQuery('Nur Admins.', { show_alert: true });
  const k = ctx.match[1];
  if (!(k in TOGGLES)) return ctx.answerCbQuery();
  const c = cfg(ctx.chat.id);
  c[k] = !c[k];
  save();
  await ctx.editMessageReplyMarkup(panel(c).reply_markup).catch(() => {});
  await ctx.answerCbQuery(`${TOGGLES[k]}: ${c[k] ? 'an' : 'aus'}`);
});

/* Setter */
bot.command('setwarnlimit', admin(async (ctx, c) => {
  const n = parseInt(args(ctx)[0], 10);
  if (!(n >= 1 && n <= 20)) return ctx.reply('Nutzung: /setwarnlimit 1-20');
  c.warnLimit = n; save(); ctx.reply('Warn-Limit: ' + n);
}));
bot.command('setwarnaction', admin(async (ctx, c) => {
  const a = (args(ctx)[0] || '').toLowerCase();
  if (!['mute', 'kick', 'ban'].includes(a)) return ctx.reply('Nutzung: /setwarnaction mute|kick|ban');
  c.warnAction = a; save(); ctx.reply('Aktion: ' + a);
}));
bot.command('setmute', admin(async (ctx, c) => {
  const n = parseInt(args(ctx)[0], 10);
  if (!(n >= 1)) return ctx.reply('Nutzung: /setmute <minuten>');
  c.muteMinutes = n; save(); ctx.reply('Standard-Mute: ' + n + ' min');
}));
bot.command('setflood', admin(async (ctx, c) => {
  const [a, b] = args(ctx).map((x) => parseInt(x, 10));
  if (!(a >= 2 && b >= 1)) return ctx.reply('Nutzung: /setflood <nachrichten> <sekunden>');
  c.floodLimit = a; c.floodSeconds = b; save(); ctx.reply(`Flood: ${a} Nachrichten / ${b}s`);
}));
bot.command('setwelcome', admin(async (ctx, c) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Nutzung: /setwelcome Willkommen {name} in {chat}!');
  c.welcomeText = t; save(); ctx.reply('Willkommenstext gespeichert.');
}));
bot.command('setrules', admin(async (ctx, c) => {
  c.rules = argText(ctx); save(); ctx.reply(c.rules ? 'Regeln gespeichert.' : 'Regeln gelöscht.');
}));

/* Domains */
const splitList = (s) => s.split(/[,\n]+|\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
bot.command('adddomain', admin(async (ctx, c) => {
  const added = [];
  for (const raw of splitList(argText(ctx))) {
    const h = hostOf(raw);
    if (h && !c.domains.includes(h)) { c.domains.push(h); added.push(h); }
  }
  save(); ctx.reply(added.length ? '✅ Hinzugefügt: ' + added.join(', ') : 'Nichts hinzugefügt. Nutzung: /adddomain example.com');
}));
bot.command('deldomain', admin(async (ctx, c) => {
  const del = splitList(argText(ctx)).map(hostOf).filter(Boolean);
  const before = c.domains.length;
  c.domains = c.domains.filter((d) => !del.includes(d));
  save(); ctx.reply(`🗑 ${before - c.domains.length} entfernt.`);
}));
bot.command('domains', admin(async (ctx, c) => {
  ctx.reply(c.domains.length ? '🌐 <b>Erlaubte Domains</b>\n' + c.domains.map((d) => '• ' + esc(d)).join('\n') : 'Whitelist leer – alle Links werden gelöscht (wenn Link-Filter an).', { parse_mode: 'HTML' });
}));

/* Wörter */
const splitWords = (s) => s.split(/[,\n]+/).map((x) => { x = x.trim(); return x.startsWith('re:') ? x : x.toLowerCase(); }).filter(Boolean);
bot.command('addword', admin(async (ctx, c) => {
  const added = [];
  for (const w of splitWords(argText(ctx))) if (!c.words.includes(w)) { c.words.push(w); added.push(w); }
  save(); ctx.reply(added.length ? '✅ Hinzugefügt: ' + added.join(', ') : 'Nutzung: /addword wort1, wort2, präfix*');
}));
bot.command('delword', admin(async (ctx, c) => {
  const del = splitWords(argText(ctx));
  const before = c.words.length;
  c.words = c.words.filter((w) => !del.includes(w));
  save(); ctx.reply(`🗑 ${before - c.words.length} entfernt.`);
}));
bot.command('words', admin(async (ctx, c) => {
  ctx.reply(c.words.length ? '🤬 <b>Verbotene Wörter</b>\n' + c.words.map((w) => '• ' + esc(w)).join('\n') : 'Liste leer.', { parse_mode: 'HTML' });
}));

/* Moderation */
function modCmd(handler) {
  return admin(async (ctx, c) => {
    const t = target(ctx);
    if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
    if (await isAdmin(ctx, t.user.id)) return ctx.reply('Admins können nicht bestraft werden.');
    await handler(ctx, c, t.user, t.rest);
  });
}
bot.command('warn', modCmd(async (ctx, c, user, rest) => {
  await addWarn(ctx, user, rest.join(' ') || 'Manuelle Verwarnung');
}));
bot.command('unwarn', admin(async (ctx, c) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  const k = String(t.user.id);
  c.warns[k] = Math.max(0, (c.warns[k] || 0) - 1); save();
  ctx.reply(`Verwarnungen: ${c.warns[k]}/${c.warnLimit}`);
}));
bot.command('warns', admin(async (ctx, c) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  ctx.reply(`Verwarnungen: ${c.warns[String(t.user.id)] || 0}/${c.warnLimit}`);
}));
bot.command('mute', modCmd(async (ctx, c, user, rest) => {
  const min = parseDur(rest[0]) || c.muteMinutes;
  await punish(ctx, user.id, 'mute', min);
  await notify(ctx, `🔇 ${mention(user)} für ${min} min stummgeschaltet.`, 0);
}));
bot.command('unmute', admin(async (ctx) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  await ctx.telegram.restrictChatMember(ctx.chat.id, t.user.id, { permissions: await fullPerms(ctx) });
  ctx.reply('🔈 Stummschaltung aufgehoben.');
}));
bot.command('kick', modCmd(async (ctx, c, user) => {
  await punish(ctx, user.id, 'kick');
  await notify(ctx, `👢 ${mention(user)} wurde gekickt.`, 0);
}));
bot.command('ban', modCmd(async (ctx, c, user, rest) => {
  const min = parseDur(rest[0]);
  await punish(ctx, user.id, 'ban', 0, min);
  await notify(ctx, `🔨 ${mention(user)} wurde ${min ? 'für ' + fmtDur(min) + ' ' : ''}gebannt.`, 0);
}));
bot.command('unban', admin(async (ctx) => {
  const t = target(ctx); if (!t) return ctx.reply('Nutzung: /unban <user-id>');
  await ctx.telegram.unbanChatMember(ctx.chat.id, t.user.id, { only_if_banned: true });
  delete cfg(ctx.chat.id).banned[t.user.id];
  save();
  ctx.reply('✅ Entbannt.');
}));
bot.command('approve', admin(async (ctx, c) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  if (!c.approved.includes(t.user.id)) c.approved.push(t.user.id);
  save(); ctx.reply('✅ User ist vom Filter ausgenommen.');
}));
bot.command('unapprove', admin(async (ctx, c) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  c.approved = c.approved.filter((x) => x !== t.user.id);
  save(); ctx.reply('❌ Ausnahme entfernt.');
}));
bot.command('approved', admin(async (ctx, c) => {
  ctx.reply(c.approved.length ? 'Ausgenommen: ' + c.approved.join(', ') : 'Niemand ausgenommen.');
}));

/* ============================== Erweiterungen ============================== */
const B = Markup.button.callback;
const onoff = (v) => (v ? '✅' : '❌');
const tzStr = (tz) => 'UTC' + (tz >= 0 ? '+' : '') + tz;

const LOCK_TYPES = {
  photo: '🖼 Fotos', video: '🎬 Videos', sticker: '😀 Sticker', gif: '🎞 GIFs',
  voice: '🎤 Sprachnachr.', videonote: '⭕ Videonachr.', audio: '🎵 Audio',
  document: '📎 Dateien', poll: '📊 Umfragen', contact: '👤 Kontakte',
  location: '📍 Standort', dice: '🎲 Würfel/Spiele', viabot: '🤖 Inline-Bots',
};
function mediaTypes(m) {
  const t = [];
  if (m.photo) t.push('photo');
  if (m.video) t.push('video');
  if (m.sticker) t.push('sticker');
  if (m.animation) t.push('gif');
  if (m.voice) t.push('voice');
  if (m.video_note) t.push('videonote');
  if (m.audio) t.push('audio');
  if (m.document && !m.animation) t.push('document');
  if (m.poll) t.push('poll');
  if (m.contact) t.push('contact');
  if (m.location || m.venue) t.push('location');
  if (m.dice || m.game) t.push('dice');
  if (m.via_bot) t.push('viabot');
  return t;
}

/* Gruppe sperren / entsperren */
async function lockGroup(tg, id, c) {
  if (c.locked) return;
  try { const ch = await tg.getChat(id); c.savedPerms = ch.permissions || FULL; } catch (_) { c.savedPerms = FULL; }
  await tg.setChatPermissions(id, MUTED);
  c.locked = true; save();
}
async function unlockGroup(tg, id, c) {
  const p = c.savedPerms && c.savedPerms.can_send_messages ? c.savedPerms : FULL;
  await tg.setChatPermissions(id, p);
  c.locked = false; c.savedPerms = null; save();
}

async function botRights(ctx, chatId = ctx.chat.id) {
  try {
    const m = await ctx.telegram.getChatMember(chatId, ctx.botInfo.id);
    if (m.status !== 'administrator') return { admin: false };
    return { admin: true, del: !!m.can_delete_messages, restrict: !!m.can_restrict_members, pin: !!m.can_pin_messages };
  } catch (_) { return { admin: false }; }
}

/* Zeit-Helfer */
function normTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return m[1].padStart(2, '0') + ':' + m[2];
}
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function shiftTime(s, d) {
  const [h, m] = s.split(':').map(Number);
  return String((h + d + 24) % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/* ------------------------- /setup Wizard & Admin-Panel ------------------------- */
const NUMS = {
  warnLimit: { l: 'Warn-Limit', min: 1, max: 20, step: 1 },
  floodLimit: { l: 'Flood-Msgs', min: 2, max: 30, step: 1 },
  maxMentions: { l: 'Mentions (0=aus)', min: 0, max: 20, step: 1 },
  newbieMinutes: { l: 'Neulinge ohne Links (Min)', min: 0, max: 1440, step: 15 },
  raidLimit: { l: 'Raid: Joins/Min', min: 3, max: 50, step: 1 },
  warnExpireDays: { l: 'Warns verfallen (Tage, 0=nie)', min: 0, max: 365, step: 1 },
  autodel: { l: 'Auto-Löschen (Min, 0=aus)', min: 0, max: 10080, step: 5 },
  slowSeconds: { l: 'Slow-Modus (Sek, 0=aus)', min: 0, max: 3600, step: 5 },
};
const PRESETS = {
  locker: { antilink: false, wordfilter: true, flood: true, floodLimit: 10, antiforward: false, captcha: false, antibot: false, antirepeat: false, anticaps: false, antiraid: false, warnLimit: 5, warnAction: 'mute', muteMinutes: 10, maxMentions: 10, newbieMinutes: 0, delservice: true, violationWarn: true },
  normal: { antilink: true, wordfilter: true, flood: true, floodLimit: 6, antiforward: false, captcha: false, antibot: false, antirepeat: true, anticaps: false, antiraid: false, warnLimit: 3, warnAction: 'mute', muteMinutes: 60, maxMentions: 5, newbieMinutes: 0, delservice: true, violationWarn: true },
  streng: { antilink: true, wordfilter: true, flood: true, floodLimit: 4, antiforward: true, captcha: true, antibot: true, antirepeat: true, anticaps: true, antiraid: true, raidLimit: 5, warnLimit: 2, warnAction: 'kick', muteMinutes: 1440, maxMentions: 3, newbieMinutes: 60, delservice: true, violationWarn: true },
};
const SU_PAGES = ['main', 'protect', 'content', 'presets', 'toggles', 'limits', 'locks', 'night', 'domains', 'words', 'texts', 'scripts', 'stats'];
const SCRIPT_LABELS = { cyrillic: 'Kyrillisch', arabic: 'Arabisch', cjk: 'Chinesisch/Japanisch/Koreanisch', hebrew: 'Hebräisch', thai: 'Thai', devanagari: 'Hindi (Devanagari)' };
const SCRIPTS = {
  cyrillic: /\p{Script=Cyrillic}/u,
  arabic: /\p{Script=Arabic}/u,
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  hebrew: /\p{Script=Hebrew}/u,
  thai: /\p{Script=Thai}/u,
  devanagari: /\p{Script=Devanagari}/u,
};

const panelSel = new Map();   // userId -> chatId (Panel im Privatchat)
const panelInput = new Map(); // userId -> { chatId, kind } (wartet auf Texteingabe)
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const chatObj = (id) => { const c = cfg(id); return { id: Number(id), title: c.title || String(id), type: c.type || 'supergroup', dm: true }; };

async function suRender(ctx, page, chat) {
  const out = await suBuild(ctx, page, chat);
  if (chat.dm) out.text = `📍 <b>${esc(chat.title || '')}</b>\n` + out.text;
  return out;
}

async function suBuild(ctx, page, chat) {
  const c = cfg(chat.id);
  const BACK = { presets: 'protect', toggles: 'protect', limits: 'protect', locks: 'protect', scripts: 'protect', domains: 'protect', words: 'protect', texts: 'content' };
  const back = [B('⬅️ Zurück', 'su:go:' + (BACK[page] || 'main'))];
  const kb = (rows) => Markup.inlineKeyboard(rows);

  if (page === 'protect') {
    return {
      text: '🛡 <b>Schutz</b>\n\nFilter, Limits, Sperren und Listen.',
      kb: kb([
        [B('🎛 Presets', 'su:go:presets'), B('🔧 Filter', 'su:go:toggles')],
        [B('⚖️ Strafen & Limits', 'su:go:limits'), B('🔒 Medien', 'su:go:locks')],
        [B('🌐 Domains', 'su:go:domains'), B('🤬 Wörter', 'su:go:words')],
        [B('🔤 Schriften', 'su:go:scripts')],
        back,
      ]),
    };
  }
  if (page === 'content') {
    return {
      text: '💬 <b>Inhalte</b>\n\nTexte, Regeln und Log-Chat findest du unter „Texte“. Willkommen, Abschied und Captcha schaltest du unter „Filter“ ein.\n\nNotizen, Trigger und Zeitpläne: /save, /trigger, /schedule – oder bequemer im Web-Panel.',
      kb: kb([[B('📝 Texte & Log', 'su:go:texts')], [B('🔧 Willkommen / Captcha / Abschied', 'su:go:toggles')], back]),
    };
  }

  if (page === 'presets') {
    return {
      text: '🎛 <b>Preset wählen</b>\n\n😌 <b>Locker</b> – wenig Filter, hohe Limits\n⚖️ <b>Normal</b> – Links nur von der Whitelist, 3 Verwarnungen\n🔒 <b>Streng</b> – Captcha, Raid-Schutz, Neulinge ohne Links, keine Weiterleitungen, Kick nach 2 Verwarnungen\n\n<i>Überschreibt Schalter und Limits. Domains und Wörter bleiben.</i>',
      kb: kb([[B('😌 Locker', 'su:preset:locker'), B('⚖️ Normal', 'su:preset:normal'), B('🔒 Streng', 'su:preset:streng')], back]),
    };
  }
  if (page === 'toggles') {
    const rows = Object.entries(TOGGLES).map(([k, l]) => [B(`${onoff(c[k])} ${l}`, `su:tg:${k}`)]);
    rows.push(back);
    return { text: '🔧 <b>Filter &amp; Funktionen</b>\n\nTippe zum Umschalten.', kb: kb(rows) };
  }
  if (page === 'limits') {
    const rows = Object.entries(NUMS).map(([k, d]) => [
      B(`${d.l}: ${c[k]}`, 'su:noop'), B('➖', `su:num:${k}:-1`), B('➕', `su:num:${k}:1`),
    ]);
    rows.push(['mute', 'kick', 'ban'].map((a) => B(`${c.warnAction === a ? '✅ ' : ''}${a}`, `su:act:${a}`)));
    rows.push([[10, '10 Min'], [60, '1 Std'], [1440, '1 Tag'], [10080, '7 Tage']].map(([v, l]) =>
      B(`${c.muteMinutes === v ? '✅ ' : ''}${l}`, `su:dur:${v}`)));
    rows.push(back);
    return {
      text: `⚖️ <b>Strafen &amp; Limits</b>\n\nBei ${c.warnLimit} Verwarnungen → <b>${c.warnAction}</b>\nMute-Dauer: ${c.muteMinutes} Min\n\n<i>Vorletzte Zeile: Aktion bei Limit · letzte Zeile: Mute-Dauer</i>`,
      kb: kb(rows),
    };
  }
  if (page === 'locks') {
    const rows = chunk(Object.entries(LOCK_TYPES).map(([k, l]) => B(`${c.locks[k] ? '🚫' : '⚪'} ${l}`, `su:lock:${k}`)), 2);
    rows.push(back);
    return { text: '🔒 <b>Medien-Sperren</b>\n\n🚫 = gesperrt (wird für normale User gelöscht)\n⚪ = erlaubt', kb: kb(rows) };
  }
  if (page === 'scripts') {
    const rows = chunk(Object.entries(SCRIPT_LABELS).map(([k, l]) => B(`${c.scripts[k] ? '🚫' : '⚪'} ${l}`, `su:sc:${k}`)), 2);
    rows.push(back);
    return { text: '🔤 <b>Schrift-Filter</b>\n\nNachrichten mit diesen Schriftzeichen werden gelöscht und verwarnt – hilft gegen Spam-Bots.\n\n🚫 = blockiert · ⚪ = erlaubt', kb: kb(rows) };
  }
  if (page === 'night') {
    const n = c.night;
    return {
      text: `🌙 <b>Nachtmodus</b>\n\nSperrt die Gruppe automatisch (nur Admins können schreiben).\nZeitraum: <b>${n.from} – ${n.to}</b> (${tzStr(n.tz)})\nStatus: ${n.active ? '🌙 gerade aktiv' : '☀️ inaktiv'}\n\n<i>Genaue Zeiten: /night 23:30 06:45 · Zeitzone: /settz 1</i>`,
      kb: kb([
        [B(`${onoff(n.enabled)} Nachtmodus`, 'su:nt:toggle:0')],
        [B(`Start: ${n.from}`, 'su:noop'), B('➖', 'su:nt:from:-1'), B('➕', 'su:nt:from:1')],
        [B(`Ende: ${n.to}`, 'su:noop'), B('➖', 'su:nt:to:-1'), B('➕', 'su:nt:to:1')],
        [B(`Zeitzone: ${tzStr(n.tz)}`, 'su:noop'), B('➖', 'su:nt:tz:-1'), B('➕', 'su:nt:tz:1')],
        back,
      ]),
    };
  }
  if (page === 'domains') {
    const rows = chunk(c.domains.slice(0, 30).map((d, i) => B('🗑 ' + d, `su:dd:${i}`)), 2);
    rows.push([B('➕ Domain hinzufügen', 'su:add:domain')]);
    rows.push(back);
    let t = `🌐 <b>Domain-Whitelist</b> (${c.domains.length})\nLinks zu diesen Domains (inkl. Subdomains) sind erlaubt.\nTippe auf eine Domain, um sie zu entfernen.`;
    if (!c.antilink) t += '\n\n⚠️ Der Link-Filter ist aus.';
    else if (!c.domains.length) t += '\n\n⚠️ Liste leer – jeder Link wird gelöscht.';
    return { text: t, kb: kb(rows) };
  }
  if (page === 'words') {
    const rows = chunk(c.words.slice(0, 30).map((w, i) => B('🗑 ' + w, `su:dw:${i}`)), 2);
    rows.push([B('➕ Wörter hinzufügen', 'su:add:word')]);
    rows.push(back);
    let t = `🤬 <b>Wortfilter</b> (${c.words.length})\nTippe auf ein Wort, um es zu entfernen.\nTipp: <code>wort*</code> trifft auch Endungen.`;
    if (!c.wordfilter) t += '\n\n⚠️ Der Wortfilter ist aus.';
    return { text: t, kb: kb(rows) };
  }
  if (page === 'texts') {
    const cut = (s) => esc(String(s).slice(0, 120)) + (String(s).length > 120 ? '…' : '');
    return {
      text: `📝 <b>Texte &amp; Log</b>\n\n👋 <b>Willkommen:</b>\n<i>${cut(c.welcomeText)}</i>\n\n📜 <b>Regeln:</b>\n<i>${c.rules ? cut(c.rules) : 'nicht gesetzt'}</i>\n\n🗒 <b>Log-Chat:</b> ${c.logChat ? '<code>' + esc(c.logChat) + '</code>' : (LOG_CHAT_ID ? 'globaler Log-Chat' : 'keiner')}`,
      kb: kb([
        [B('✏️ Willkommenstext', 'su:add:welcome')],
        [B('✏️ Regeln', 'su:add:rules')],
        [B('✏️ Log-Chat', 'su:add:log')],
        back,
      ]),
    };
  }
  if (page === 'stats') {
    return { text: statsText(c, ''), kb: kb([[B('🔄 Aktualisieren', 'su:go:stats')], back]) };
  }

  // Hauptseite
  const r = await botRights(ctx, chat.id);
  let t = `🛠 <b>Setup – ${esc(chat.title || '')}</b>\n\n<b>Bot-Rechte</b>\n`;
  if (!r.admin) t += '❌ Ich bin noch kein Admin. Bitte zum Admin machen (Nachrichten löschen, Mitglieder sperren).\n';
  else t += `${onoff(r.del)} Nachrichten löschen\n${onoff(r.restrict)} Mitglieder sperren/bannen\n${onoff(r.pin)} Nachrichten anheften\n`;
  if (chat.type !== 'supergroup') t += '⚠️ Keine Supergruppe – einige Funktionen sind eingeschränkt.\n';
  t += `\n<b>Aktuell</b>\n🔗 Links ${onoff(c.antilink)} (${c.domains.length} Domains)\n🤬 Wortfilter ${onoff(c.wordfilter)} (${c.words.length} Wörter)\n🌊 Flood ${onoff(c.flood)} · 🤖 Captcha ${onoff(c.captcha)} · 🚨 Raid ${onoff(c.antiraid)}\n⚖️ ${c.warnLimit} Verwarnungen → ${c.warnAction}\n🌙 Nachtmodus ${onoff(c.night.enabled)}\n`;
  const todo = [];
  if (c.antilink && !c.domains.length) todo.push('Domains erlauben (🌐 Domains)');
  if (c.wordfilter && !c.words.length) todo.push('Verbotene Wörter eintragen (🤬 Wörter)');
  if (!c.rules) todo.push('Regeln setzen (📝 Texte)');
  if (todo.length) t += '\n<b>Noch offen</b>\n' + todo.map((x) => '• ' + esc(x)).join('\n');
  const rows = [
    [B('🛡 Schutz', 'su:go:protect'), B('💬 Inhalte', 'su:go:content')],
    [B('🌙 Nachtmodus', 'su:go:night'), B('📊 Statistik', 'su:go:stats')],
    [B('📖 Hilfe', 'hp:menu')],
  ];
  if (chat.dm) rows.push([B('🔀 Gruppe wechseln', 'pn:list')]);
  rows.push([B('🔄 Rechte prüfen', 'su:go:main'), B('✅ Fertig', 'su:done')]);
  return { text: t, kb: kb(rows) };
}

bot.command('setup', admin(async (ctx) => {
  const { text, kb } = await suRender(ctx, 'main', ctx.chat);
  await ctx.reply(text, { parse_mode: 'HTML', ...kb });
}));

/* Ziel-Chat der Panel-Aktion: Gruppe selbst oder im Privatchat die gewählte Gruppe */
function suChat(ctx) {
  if (isGroup(ctx)) return ctx.chat;
  const id = panelSel.get(ctx.from.id);
  return id ? chatObj(id) : null;
}

bot.action(/^su:(.+)$/, async (ctx) => {
  const chat = suChat(ctx);
  if (!chat) return ctx.answerCbQuery('Bitte /panel neu öffnen.', { show_alert: true });
  if (!(await isAdminIn(ctx.telegram, chat.id, ctx.from.id))) return ctx.answerCbQuery('Nur Admins.', { show_alert: true });
  const c = cfg(chat.id);
  const [cmd, a, b] = ctx.match[1].split(':');
  let page = 'main';
  let note = '';
  try {
    switch (cmd) {
      case 'noop': return ctx.answerCbQuery();
      case 'done':
        await ctx.editMessageText('✅ <b>Setup abgeschlossen.</b>\n/settings – Schalter\n/help – alle Befehle', { parse_mode: 'HTML' }).catch(() => {});
        return ctx.answerCbQuery();
      case 'go': page = SU_PAGES.includes(a) ? a : 'main'; break;
      case 'preset':
        if (PRESETS[a]) { Object.assign(c, PRESETS[a]); save(); note = 'Preset angewendet ✅'; }
        break;
      case 'tg':
        page = 'toggles';
        if (a in TOGGLES) { c[a] = !c[a]; save(); }
        break;
      case 'num': {
        page = 'limits';
        const d = NUMS[a];
        if (d) { c[a] = Math.min(d.max, Math.max(d.min, c[a] + Number(b) * d.step)); save(); }
        break;
      }
      case 'act':
        page = 'limits';
        if (['mute', 'kick', 'ban'].includes(a)) { c.warnAction = a; save(); }
        break;
      case 'dur':
        page = 'limits';
        c.muteMinutes = Number(a) || c.muteMinutes; save();
        break;
      case 'lock':
        page = 'locks';
        if (a in LOCK_TYPES) { c.locks[a] = !c.locks[a]; save(); }
        break;
      case 'sc':
        page = 'scripts';
        if (a in SCRIPT_LABELS) { c.scripts[a] = !c.scripts[a]; save(); }
        break;
      case 'dd':
        page = 'domains';
        c.domains.splice(Number(a), 1); save();
        break;
      case 'dw':
        page = 'words';
        c.words.splice(Number(a), 1); save();
        break;
      case 'nt': {
        page = 'night';
        const n = c.night;
        if (a === 'toggle') {
          n.enabled = !n.enabled;
          if (!n.enabled && n.active) { await unlockGroup(ctx.telegram, chat.id, c); n.active = false; }
        } else if (a === 'from' || a === 'to') n[a] = shiftTime(n[a], Number(b));
        else if (a === 'tz') n.tz = Math.min(14, Math.max(-12, n.tz + Number(b)));
        save();
        break;
      }
      case 'add': {
        const prompts = {
          domain: 'Sende mir jetzt die Domain(s), z. B. <code>example.com, t.me</code>',
          word: 'Sende mir jetzt die verbotenen Wörter, kommagetrennt (z. B. <code>spam, präfix*</code>)',
          welcome: 'Sende mir jetzt den neuen Willkommenstext. Platzhalter: {name} {chat} {id}',
          rules: 'Sende mir jetzt den Regeltext.',
          log: 'Sende mir jetzt die Chat-ID des Log-Chats (oder <code>off</code>).',
        };
        if (!prompts[a]) break;
        if (!chat.dm) {
          return ctx.answerCbQuery('Texte eintippen geht im Privatchat mit mir: dort /panel öffnen. In der Gruppe nutze die Befehle (/adddomain, /addword, /setwelcome, /setrules, /setlog).', { show_alert: true });
        }
        panelInput.set(ctx.from.id, { chatId: chat.id, kind: a });
        await ctx.reply(prompts[a] + '\n\n/cancel zum Abbrechen', { parse_mode: 'HTML' });
        return ctx.answerCbQuery();
      }
    }
  } catch (e) { note = 'Fehler: ' + e.message; }
  const { text, kb } = await suRender(ctx, page, chat);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
  await ctx.answerCbQuery(note).catch(() => {});
});

/* ----------------------- Admin-Panel im Privatchat ----------------------- */
async function showPanelList(ctx, edit = false) {
  const rows = [];
  for (const id of Object.keys(db.chats).slice(0, 60)) {
    try {
      if (!(await isAdminIn(ctx.telegram, Number(id), ctx.from.id))) continue;
      const me = await ctx.telegram.getChatMember(Number(id), ctx.botInfo.id);
      if (!['member', 'administrator'].includes(me.status)) continue;
      rows.push([B('📍 ' + (db.chats[id].title || id), 'pn:sel:' + id)]);
    } catch (_) {}
  }
  if (!rows.length) {
    return ctx.reply('Keine Gruppen gefunden. Füge mich einer Supergruppe hinzu, mach mich zum Admin und sende dort einmal /setup.');
  }
  const text = '🛠 <b>Admin-Panel</b>\nWähle eine Gruppe:';
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) };
  if (edit) return ctx.editMessageText(text, extra).catch(() => {});
  return ctx.reply(text, extra);
}

bot.command('panel', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    return ctx.reply(`🛠 Das Admin-Panel öffnest du im Privatchat: https://t.me/${ctx.botInfo.username}?start=panel`, { disable_web_page_preview: true });
  }
  return showPanelList(ctx);
});

bot.action(/^pn:(sel|list)(?::(-?\d+))?$/, async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  if (ctx.match[1] === 'list') { await showPanelList(ctx, true); return ctx.answerCbQuery(); }
  const id = Number(ctx.match[2]);
  if (!(await isAdminIn(ctx.telegram, id, ctx.from.id))) return ctx.answerCbQuery('Nur Admins.', { show_alert: true });
  panelSel.set(ctx.from.id, id);
  const { text, kb } = await suRender(ctx, 'main', chatObj(id));
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
  await ctx.answerCbQuery();
});

/* Texteingabe im Privatchat (Domains, Wörter, Willkommen, Regeln, Log) */
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  const inp = panelInput.get(ctx.from.id);
  if (!inp) return next();
  const raw = ctx.message.text;
  if (raw.startsWith('/')) {
    if (/^\/cancel\b/i.test(raw)) { panelInput.delete(ctx.from.id); return ctx.reply('Abgebrochen.'); }
    return next();
  }
  panelInput.delete(ctx.from.id);
  if (!(await isAdminIn(ctx.telegram, inp.chatId, ctx.from.id))) return ctx.reply('Du bist in dieser Gruppe kein Admin mehr.');
  const c = cfg(inp.chatId);
  let page = 'texts';
  let msg = '✅ Gespeichert.';
  if (inp.kind === 'domain') {
    page = 'domains';
    const added = [];
    for (const x of raw.split(/[,\n\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      const h = hostOf(x);
      if (h && !c.domains.includes(h)) { c.domains.push(h); added.push(h); }
    }
    msg = added.length ? '✅ Hinzugefügt: ' + added.join(', ') : 'Nichts hinzugefügt.';
  } else if (inp.kind === 'word') {
    page = 'words';
    const added = [];
    for (const w of raw.split(/[,\n]+/).map((s) => { s = s.trim(); return s.startsWith('re:') ? s : s.toLowerCase(); }).filter(Boolean)) {
      if (!c.words.includes(w)) { c.words.push(w); added.push(w); }
    }
    msg = added.length ? '✅ Hinzugefügt: ' + added.join(', ') : 'Nichts hinzugefügt.';
  } else if (inp.kind === 'welcome') {
    c.welcomeText = raw.slice(0, 500);
  } else if (inp.kind === 'rules') {
    c.rules = raw.slice(0, 3000);
  } else if (inp.kind === 'log') {
    const v = raw.trim();
    if (v.toLowerCase() === 'off') { c.logChat = ''; msg = '✅ Log-Chat entfernt.'; }
    else if (/^-?\d+$/.test(v)) {
      try { await ctx.telegram.sendMessage(v, `✅ Log-Chat für ${c.title || inp.chatId} gesetzt.`); c.logChat = v; }
      catch (e) { msg = '❗ Ich kann dort nicht schreiben: ' + e.message; }
    } else msg = '❗ Ungültige Chat-ID.';
  }
  save();
  const { text, kb } = await suRender(ctx, page, chatObj(inp.chatId));
  await ctx.reply(msg);
  await ctx.reply(text, { parse_mode: 'HTML', ...kb });
});

/* --------------------------- Nachtmodus & Sperren --------------------------- */
bot.command('night', admin(async (ctx, c) => {
  const a = args(ctx);
  const n = c.night;
  if (!a.length) {
    return ctx.reply(`🌙 Nachtmodus: ${n.enabled ? 'an' : 'aus'}\n${n.from} – ${n.to} (${tzStr(n.tz)})\n\n/night 23:00 07:00 · /night on · /night off · /settz 1`);
  }
  if (a[0] === 'off') {
    n.enabled = false;
    if (n.active) { await unlockGroup(ctx.telegram, ctx.chat.id, c); n.active = false; }
    save();
    return ctx.reply('☀️ Nachtmodus aus.');
  }
  if (a[0] === 'on') { n.enabled = true; save(); return ctx.reply(`🌙 Nachtmodus an: ${n.from} – ${n.to} (${tzStr(n.tz)})`); }
  const f = normTime(a[0]); const t = normTime(a[1]);
  if (!f || !t) return ctx.reply('Nutzung: /night 23:00 07:00');
  n.from = f; n.to = t; n.enabled = true; save();
  ctx.reply(`🌙 Nachtmodus an: ${f} – ${t} (${tzStr(n.tz)})`);
}));
bot.command('settz', admin(async (ctx, c) => {
  const v = parseFloat((args(ctx)[0] || '').replace(',', '.'));
  if (!(v >= -12 && v <= 14)) return ctx.reply('Nutzung: /settz 1  (Deutschland: 1 im Winter, 2 im Sommer)');
  c.night.tz = v; save(); ctx.reply('Zeitzone: ' + tzStr(v));
}));
bot.command('lockgroup', admin(async (ctx, c) => {
  await lockGroup(ctx.telegram, ctx.chat.id, c);
  ctx.reply('🔒 Gruppe gesperrt – nur Admins können schreiben. /unlockgroup hebt es auf.');
}));
bot.command('unlockgroup', admin(async (ctx, c) => {
  await unlockGroup(ctx.telegram, ctx.chat.id, c);
  if (c.night) c.night.active = false;
  ctx.reply('🔓 Gruppe entsperrt.');
}));
bot.command('lock', admin(async (ctx, c) => {
  const t = (args(ctx)[0] || '').toLowerCase();
  if (!(t in LOCK_TYPES)) return ctx.reply('Nutzung: /lock <typ>\nTypen: ' + Object.keys(LOCK_TYPES).join(', '));
  c.locks[t] = true; save(); ctx.reply('🚫 Gesperrt: ' + LOCK_TYPES[t]);
}));
bot.command('unlock', admin(async (ctx, c) => {
  const t = (args(ctx)[0] || '').toLowerCase();
  if (!(t in LOCK_TYPES)) return ctx.reply('Nutzung: /unlock <typ>\nTypen: ' + Object.keys(LOCK_TYPES).join(', '));
  c.locks[t] = false; save(); ctx.reply('⚪ Erlaubt: ' + LOCK_TYPES[t]);
}));
bot.command('locks', admin(async (ctx, c) => {
  ctx.reply(Object.entries(LOCK_TYPES).map(([k, l]) => `${c.locks[k] ? '🚫' : '⚪'} ${l} (${k})`).join('\n'));
}));

setInterval(async () => {
  const now = new Date();
  for (const [id, c] of Object.entries(db.chats)) {
    const n = c.night;
    if (!n || !n.enabled) continue;
    const local = new Date(now.getTime() + (n.tz || 0) * 3600000);
    const m = local.getUTCHours() * 60 + local.getUTCMinutes();
    const f = toMin(n.from); const t = toMin(n.to);
    const inNight = f < t ? (m >= f && m < t) : (m >= f || m < t);
    if (inNight === !!n.active) continue;
    try {
      if (inNight) {
        await lockGroup(bot.telegram, id, c);
        await bot.telegram.sendMessage(id, `🌙 Nachtmodus aktiv bis ${n.to}. Gute Nacht!`);
      } else {
        if (c.locked) await unlockGroup(bot.telegram, id, c);
        await bot.telegram.sendMessage(id, '☀️ Nachtmodus beendet. Guten Morgen!');
      }
    } catch (e) {
      bot.telegram.sendMessage(id, '❗ Nachtmodus fehlgeschlagen (Bot braucht das Recht „Mitglieder einschränken“).').catch(() => {});
    }
    n.active = inNight; save();
  }
}, 30000).unref();

/* --------------------------------- Notizen --------------------------------- */
bot.command('save', admin(async (ctx, c) => {
  const m = /^#?([\p{L}\p{N}_]{1,32})\s*([\s\S]*)$/u.exec(argText(ctx));
  if (!m) return ctx.reply('Nutzung: /save name text   (oder als Antwort auf eine Nachricht: /save name)');
  const r = ctx.message.reply_to_message;
  const text = m[2] || (r && (r.text || r.caption)) || '';
  if (!text) return ctx.reply('Kein Text angegeben.');
  c.notes[m[1].toLowerCase()] = text.slice(0, 3500); save();
  ctx.reply(`📝 Notiz gespeichert. Abruf mit #${m[1].toLowerCase()}`);
}));
bot.command('clear', admin(async (ctx, c) => {
  const n = (args(ctx)[0] || '').toLowerCase().replace(/^#/, '');
  if (!c.notes[n]) return ctx.reply('Notiz nicht gefunden.');
  delete c.notes[n]; save(); ctx.reply('🗑 Notiz gelöscht.');
}));
bot.command('notes', (ctx) => {
  if (!isGroup(ctx)) return;
  const c = cfg(ctx.chat.id);
  const k = Object.keys(c.notes);
  ctx.reply(k.length ? '📝 Notizen:\n' + k.map((x) => '#' + x).join('\n') : 'Keine Notizen vorhanden.');
});
bot.command('get', (ctx) => {
  if (!isGroup(ctx)) return;
  const n = (args(ctx)[0] || '').toLowerCase().replace(/^#/, '');
  const c = cfg(ctx.chat.id);
  if (c.notes[n]) ctx.reply(c.notes[n], { disable_web_page_preview: true });
});

/* ------------------------------- Admin-Tools ------------------------------- */
const reportCooldown = new Map();
bot.command('report', async (ctx) => {
  if (!isGroup(ctx)) return;
  const r = ctx.message.reply_to_message;
  if (!r || !r.from) return ctx.reply('Antworte auf die Nachricht, die du melden willst.');
  const key = ctx.chat.id + ':' + ctx.from.id;
  if (Date.now() - (reportCooldown.get(key) || 0) < 60000) return;
  reportCooldown.set(key, Date.now());
  try {
    const admins = (await ctx.telegram.getChatAdministrators(ctx.chat.id)).filter((x) => !x.user.is_bot);
    const hidden = admins.map((x) => `<a href="tg://user?id=${x.user.id}">\u200b</a>`).join('');
    await ctx.telegram.sendMessage(ctx.chat.id, `🚨 ${mention(ctx.from)} hat eine Nachricht von ${mention(r.from)} gemeldet.${hidden}`, {
      parse_mode: 'HTML', reply_parameters: { message_id: r.message_id, allow_sending_without_reply: true },
    });
    await log(ctx, `🚨 Meldung von ${mention(ctx.from)} gegen ${mention(r.from)}`);
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  } catch (_) {}
});

bot.command('del', admin(async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return ctx.reply('Antworte auf die Nachricht, die gelöscht werden soll.');
  await ctx.telegram.deleteMessage(ctx.chat.id, r.message_id).catch(() => {});
  await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}));
bot.command('purge', admin(async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return ctx.reply('Antworte auf die erste Nachricht, ab der gelöscht werden soll.');
  const ids = [];
  for (let i = r.message_id; i <= ctx.message.message_id && ids.length < 200; i++) ids.push(i);
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map((id) => ctx.telegram.deleteMessage(ctx.chat.id, id).catch(() => {})));
  }
  await notify(ctx, `🧹 Bis zu ${ids.length} Nachrichten gelöscht.`, 4000);
}));
bot.command('pin', admin(async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return ctx.reply('Antworte auf die Nachricht, die angeheftet werden soll.');
  await ctx.telegram.pinChatMessage(ctx.chat.id, r.message_id, { disable_notification: args(ctx)[0] === 'silent' });
}));
bot.command('unpin', admin(async (ctx) => {
  const r = ctx.message.reply_to_message;
  await ctx.telegram.unpinChatMessage(ctx.chat.id, r ? r.message_id : undefined);
}));
bot.command('resetwarns', admin(async (ctx, c) => {
  const t = target(ctx); if (!t) return ctx.reply('Antworte auf eine Nachricht oder gib eine User-ID an.');
  c.warns[String(t.user.id)] = 0; save(); ctx.reply('Verwarnungen zurückgesetzt.');
}));
bot.command('info', admin(async (ctx, c) => {
  const t = target(ctx);
  const u = t ? t.user : ctx.from;
  let st = '?';
  try { st = (await ctx.telegram.getChatMember(ctx.chat.id, u.id)).status; } catch (_) {}
  const j = c.joined[u.id] ? new Date(c.joined[u.id]).toLocaleString('de-DE') : '–';
  await ctx.reply(
    `👤 <b>${esc(u.first_name || u.id)}</b>\nID: <code>${u.id}</code>\n` +
    (u.username ? `Username: @${esc(u.username)}\n` : '') +
    `Status: ${st}\nVerwarnungen: ${c.warns[String(u.id)] || 0}/${c.warnLimit}\n` +
    `Ausgenommen: ${c.approved.includes(u.id) ? 'ja' : 'nein'}\nBeigetreten: ${j}` +
    (c.members[u.id] && c.members[u.id].note ? `\nNotiz: ${esc(c.members[u.id].note)}` : ''),
    { parse_mode: 'HTML' }
  );
}));
bot.command('export', admin(async (ctx, c) => {
  const copy = { ...c, warns: undefined, joined: undefined, savedPerms: undefined };
  await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify(copy, null, 2)), filename: `settings_${ctx.chat.id}.json` });
}));

/* Bot wurde zu einer Gruppe hinzugefügt */
bot.on('my_chat_member', async (ctx) => {
  if (!isGroup(ctx)) return;
  const u = ctx.myChatMember;
  const was = ['left', 'kicked'].includes(u.old_chat_member.status);
  const now = ['member', 'administrator'].includes(u.new_chat_member.status);
  if (was && now) {
    ctx.telegram.sendMessage(ctx.chat.id, '👋 Danke fürs Hinzufügen! Bitte mach mich zum Admin (Nachrichten löschen, Mitglieder sperren) und starte dann /setup.').catch(() => {});
  }
});

/* ============================ Weitere Funktionen ============================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACT_DEFAULT = { flood: 'mute' };
function actOf(c, kind) { return (c.act && c.act[kind]) || ACT_DEFAULT[kind] || (c.violationWarn ? 'warn' : 'delete'); }

function parseDur(s) {
  const m = /^(\d+)\s*([mhdw]?)$/i.exec(s || '');
  if (!m) return 0;
  return Number(m[1]) * ({ m: 1, h: 60, d: 1440, w: 10080 }[(m[2] || 'm').toLowerCase()]);
}
function fmtDur(min) {
  if (min % 10080 === 0) return min / 10080 + ' Wo';
  if (min % 1440 === 0) return min / 1440 + ' Tg';
  if (min % 60 === 0) return min / 60 + ' Std';
  return min + ' Min';
}

/* ------------------------------- Statistik ------------------------------- */
function rollStats(c) {
  const s = c.stats;
  if (!s.hours) s.hours = new Array(24).fill(0);
  const day = new Date().toISOString().slice(0, 10);
  if (s.day !== day) {
    if (s.day) { s.hist.push({ day: s.day, ...s.today }); s.hist = s.hist.slice(-30); }
    s.day = day; s.today = {}; s.users = {};
  }
  return s;
}
function stat(chatId, key, n = 1) {
  const s = rollStats(cfg(chatId));
  s.today[key] = (s.today[key] || 0) + n;
  s.total[key] = (s.total[key] || 0) + n;
  save();
}
function touchMember(c, user) {
  const m = c.members;
  let e = m[user.id];
  if (!e) {
    const keys = Object.keys(m);
    if (keys.length >= 5000) keys.sort((a, b) => m[a].last - m[b].last).slice(0, 500).forEach((k) => delete m[k]);
    e = m[user.id] = { name: '', user: '', first: Date.now(), last: 0, n: 0 };
  }
  e.name = user.first_name || e.name || '';
  e.user = user.username || '';
  e.last = Date.now();
  return e;
}
function logEvent(chatId, type, text) {
  const c = cfg(chatId);
  const clean = String(text).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n/g, ' · ');
  c.events.push({ t: Date.now(), type, text: clean.slice(0, 300) });
  if (c.events.length > 200) c.events.splice(0, c.events.length - 200);
  save();
}
function countMsg(chatId, user) {
  const c = cfg(chatId);
  const s = rollStats(c);
  s.today.msgs = (s.today.msgs || 0) + 1;
  s.total.msgs = (s.total.msgs || 0) + 1;
  let u = s.users[user.id];
  if (!u && Object.keys(s.users).length < 2000) u = s.users[user.id] = { n: 0, name: '' };
  if (u) { u.n++; u.name = user.first_name || ''; }
  touchMember(c, user).n++;
  s.hours[Math.floor((new Date().getUTCHours() + ((c.night && c.night.tz) || 0) + 24) % 24)]++;
  save();
}
function statsText(c, title) {
  const s = rollStats(c);
  const t = s.today; const a = s.total;
  const week = s.hist.slice(-6).reduce((x, h) => x + (h.msgs || 0), 0) + (t.msgs || 0);
  const line = (ic, l, k) => `${ic} ${l}: <b>${t[k] || 0}</b> heute · ${a[k] || 0} gesamt`;
  const top = Object.values(s.users).sort((x, y) => y.n - x.n).slice(0, 5);
  return `📊 <b>Statistik${title ? ' – ' + esc(title) : ''}</b>\n\n` + [
    line('💬', 'Nachrichten', 'msgs'), line('🧹', 'Gelöscht', 'deleted'), line('➕', 'Beitritte', 'joins'),
    line('➖', 'Austritte', 'leaves'), line('⚠️', 'Verwarnungen', 'warns'), line('🚫', 'Strafen', 'punished'),
  ].join('\n') + `\n📅 Nachrichten (7 Tage): <b>${week}</b>` +
    (top.length ? '\n\n🏆 <b>Top heute</b>\n' + top.map((u, i) => `${i + 1}. ${esc(u.name || '?')} – ${u.n}`).join('\n') : '');
}
bot.command('stats', admin(async (ctx, c) => {
  await ctx.reply(statsText(c, ctx.chat.title), { parse_mode: 'HTML' });
}));

/* ------------------------------ Raid-Schutz ------------------------------ */
const joinLog = new Map();
async function raidCheck(ctx, c, n) {
  if (!c.antiraid || c.raid) return;
  const now = Date.now();
  const arr = (joinLog.get(ctx.chat.id) || []).filter((t) => now - t < 60000);
  for (let i = 0; i < n; i++) arr.push(now);
  joinLog.set(ctx.chat.id, arr);
  if (arr.length >= c.raidLimit) {
    c.raid = { until: now + 30 * 60000, prev: c.captcha };
    c.captcha = true; save();
    joinLog.delete(ctx.chat.id);
    await notify(ctx, `🚨 <b>Raid-Schutz aktiv:</b> ${arr.length} Beitritte in 60s. Captcha für 30 Minuten eingeschaltet.`, 0);
    await log(ctx, `🚨 Raid erkannt (${arr.length} Beitritte/Min)`);
  }
}
setInterval(async () => {
  const now = new Date();
  for (const [id, c] of Object.entries(db.chats)) {
    if (c.raid && Date.now() > c.raid.until) {
      c.captcha = c.raid.prev; c.raid = null; save();
      bot.telegram.sendMessage(id, '✅ Raid-Schutz beendet, Captcha wieder wie zuvor.').catch(() => {});
    }
    if (!c.schedules || !c.schedules.length) continue;
    const local = new Date(now.getTime() + ((c.night && c.night.tz) || 0) * 3600000);
    const hhmm = local.toISOString().slice(11, 16);
    const day = local.toISOString().slice(0, 10);
    for (const s of c.schedules) {
      if (s.time === hhmm && s.last !== day && (!s.days || !s.days.length || s.days.includes(local.getUTCDay()))) {
        s.last = day; save();
        bot.telegram.sendMessage(id, s.text, { disable_web_page_preview: true })
          .then((m) => { if (s.pin) bot.telegram.pinChatMessage(id, m.message_id, { disable_notification: true }).catch(() => {}); })
          .catch(() => {});
      }
    }
  }
}, 30000).unref();

/* -------------------------------- Trigger -------------------------------- */
bot.command('trigger', admin(async (ctx, c) => {
  const m = /^([^=]+?)\s*=\s*([\s\S]+)$/.exec(argText(ctx));
  if (!m) return ctx.reply('Nutzung: /trigger wort = Antwort\nBeispiel: /trigger preis = Infos findest du mit #preise');
  if (Object.keys(c.triggers).length >= 50) return ctx.reply('Maximal 50 Trigger.');
  c.triggers[m[1].trim().toLowerCase()] = m[2].trim().slice(0, 3000); save();
  ctx.reply('✅ Trigger gespeichert.');
}));
bot.command('triggers', admin(async (ctx, c) => {
  const k = Object.keys(c.triggers);
  ctx.reply(k.length ? '💬 Trigger:\n' + k.map((x) => '• ' + x).join('\n') : 'Keine Trigger vorhanden.');
}));
bot.command('deltrigger', admin(async (ctx, c) => {
  const k = argText(ctx).toLowerCase();
  if (!c.triggers[k]) return ctx.reply('Trigger nicht gefunden.');
  delete c.triggers[k]; save(); ctx.reply('🗑 Trigger gelöscht.');
}));

/* ------------------------ Zeitgesteuerte Nachrichten ------------------------ */
bot.command('schedule', admin(async (ctx, c) => {
  const m = /^(\d{1,2}:\d{2})\s+([\s\S]+)$/.exec(argText(ctx));
  const t = m && normTime(m[1]);
  if (!t) return ctx.reply('Nutzung: /schedule 18:00 Text   (täglich)\n/schedules · /unschedule <nr>');
  if (c.schedules.length >= 10) return ctx.reply('Maximal 10 Zeitpläne.');
  c.schedules.push({ time: t, text: m[2].trim().slice(0, 3000), last: '' }); save();
  ctx.reply(`⏰ Täglich um ${t} (${tzStr(c.night.tz)}) wird die Nachricht gesendet.`);
}));
bot.command('schedules', admin(async (ctx, c) => {
  ctx.reply(c.schedules.length
    ? '⏰ Zeitpläne:\n' + c.schedules.map((s, i) => `${i + 1}. ${s.time} – ${s.text.slice(0, 60)}`).join('\n')
    : 'Keine Zeitpläne vorhanden.');
}));
bot.command('unschedule', admin(async (ctx, c) => {
  const i = parseInt(args(ctx)[0], 10) - 1;
  if (!(i >= 0 && i < c.schedules.length)) return ctx.reply('Nutzung: /unschedule <nr>  (Nummer aus /schedules)');
  c.schedules.splice(i, 1); save(); ctx.reply('🗑 Zeitplan gelöscht.');
}));

/* ------------------------- Log-Chat & Schrift-Filter ------------------------- */
bot.command('setlog', admin(async (ctx, c) => {
  const v = args(ctx)[0] || '';
  if (v === 'off') { c.logChat = ''; save(); return ctx.reply('Log-Chat entfernt.'); }
  if (!/^-?\d+$/.test(v)) return ctx.reply('Nutzung: /setlog <chat-id>  oder  /setlog off\nTipp: /id im Ziel-Chat zeigt die ID. Der Bot muss dort schreiben dürfen.');
  try { await ctx.telegram.sendMessage(v, `✅ Log-Chat für ${ctx.chat.title} gesetzt.`); }
  catch (e) { return ctx.reply('❗ Ich kann dort nicht schreiben: ' + e.message); }
  c.logChat = v; save(); ctx.reply('✅ Log-Chat gesetzt.');
}));
bot.command('script', admin(async (ctx, c) => {
  const [k, v] = args(ctx).map((x) => x.toLowerCase());
  if (!(k in SCRIPT_LABELS) || !['on', 'off'].includes(v)) {
    return ctx.reply('Nutzung: /script <name> on|off\nNamen: ' + Object.keys(SCRIPT_LABELS).join(', ') +
      '\nBlockiert: ' + (Object.keys(c.scripts).filter((x) => c.scripts[x]).join(', ') || 'keine'));
  }
  c.scripts[k] = v === 'on'; save();
  ctx.reply(`${SCRIPT_LABELS[k]}: ${v === 'on' ? '🚫 blockiert' : '⚪ erlaubt'}`);
}));

/* ------------------------------ Owner-Befehle ------------------------------ */
const ownerOnly = (fn) => async (ctx) => {
  if (ctx.chat.type !== 'private' || !OWNERS.has(ctx.from.id)) return;
  try { await fn(ctx); } catch (e) { ctx.reply('❗ ' + e.message).catch(() => {}); }
};
bot.command('broadcast', ownerOnly(async (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Nutzung: /broadcast Text');
  const ids = Object.keys(db.chats);
  let ok = 0;
  for (const id of ids) {
    try { await ctx.telegram.sendMessage(id, t); ok++; } catch (_) {}
    await sleep(80);
  }
  ctx.reply(`📣 Gesendet an ${ok}/${ids.length} Gruppen.`);
}));
bot.command('backup', ownerOnly(async (ctx) => {
  await ctx.replyWithDocument({ source: Buffer.from(JSON.stringify(db, null, 2)), filename: 'data.json' });
}));
bot.command('status', ownerOnly(async (ctx) => {
  const up = process.uptime();
  ctx.reply(`🤖 Laufzeit: ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m\nRAM: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\nGruppen: ${Object.keys(db.chats).length}\nNode ${process.version}`);
}));

/* ===================== Zusätzliche Funktionen (Teil 3) ===================== */
const BK_DIR = path.join(__dirname, 'backups');
const slowMap = new Map();
const casCache = new Map();

/* Verwarnungen verfallen nach X Tagen */
function expireWarns(c, k) {
  if (!c.warnExpireDays) return;
  let t = c.warnTimes[k];
  if (!t || !t.length) return;
  const w = c.warns[k] || 0;
  if (t.length > w) t = c.warnTimes[k] = t.slice(t.length - w);
  const lim = Date.now() - c.warnExpireDays * 86400000;
  const keep = t.filter((x) => x >= lim);
  if (keep.length !== t.length) {
    c.warns[k] = Math.max(0, w - (t.length - keep.length));
    c.warnTimes[k] = keep;
  }
}

/* Hintergrund-Aufgaben */
setInterval(() => {
  const now = Date.now();
  for (const c of Object.values(db.chats)) {
    if (c.warnExpireDays) for (const k of Object.keys(c.warnTimes || {})) expireWarns(c, k);
  }
  for (const [k, t] of slowMap) if (now - t > 3600000) slowMap.delete(k);
  for (const [k, v] of casCache) if (now - v.t > 3600000) casCache.delete(k);
  save();
}, 600000).unref();

setInterval(async () => {
  const now = Date.now();
  for (const [id, c] of Object.entries(db.chats)) {
    if (!c.delQueue || !c.delQueue.length) continue;
    const due = c.delQueue.filter((x) => x.at <= now).slice(0, 40);
    if (!due.length) continue;
    c.delQueue = c.delQueue.filter((x) => !due.includes(x));
    save();
    for (const x of due) await bot.telegram.deleteMessage(Number(id), x.m).catch(() => {});
  }
}, 20000).unref();

function backupNow() {
  try {
    flushSave();
    if (!fs.existsSync(DB_FILE)) return;
    fs.mkdirSync(BK_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, path.join(BK_DIR, 'data-' + new Date().toISOString().slice(0, 10) + '.json'));
    const files = fs.readdirSync(BK_DIR).filter((f) => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    files.slice(0, -7).forEach((f) => fs.unlinkSync(path.join(BK_DIR, f)));
  } catch (e) { console.error('Backup fehlgeschlagen:', e.message); }
}
setTimeout(backupNow, 15000).unref();
setInterval(backupNow, 6 * 3600 * 1000).unref();

/* ------------------- Prüfungen beim Beitritt (gban, Name, CAS) ------------------- */
async function casBanned(id) {
  const hit = casCache.get(id);
  if (hit && Date.now() - hit.t < 3600000) return hit.v;
  let v = false;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('https://api.cas.chat/check?user_id=' + id, { signal: ctl.signal });
    clearTimeout(to);
    const j = await r.json();
    v = !!(j && j.ok === true);
  } catch (_) {}
  casCache.set(id, { v, t: Date.now() });
  return v;
}

async function joinChecks(ctx, c, u) {
  try {
    const sc = await screenUser(c, u);
    if (!sc) return false;
    await punish(ctx, u.id, sc.act);
    await notify(ctx, `🛡 ${mention(u)} entfernt (${esc(sc.reason)}).`, 15000);
    await log(ctx, `🛡 ${mention(u)}: ${esc(sc.reason)}`);
    return true;
  } catch (_) { return false; }
}

/* ------------------------------- Globaler Bann ------------------------------- */
async function gbanUser(tg, uid, reason) {
  db.gbans[uid] = { t: Date.now(), reason: String(reason || '').slice(0, 100) };
  save();
  let n = 0;
  for (const id of Object.keys(db.chats)) {
    try { await tg.banChatMember(Number(id), Number(uid)); n++; } catch (_) {}
    await sleep(60);
  }
  return n;
}
async function ungbanUser(tg, uid) {
  delete db.gbans[uid];
  save();
  let n = 0;
  for (const id of Object.keys(db.chats)) {
    try { await tg.unbanChatMember(Number(id), Number(uid), { only_if_banned: true }); n++; } catch (_) {}
    await sleep(60);
  }
  return n;
}
const ownerAny = (fn) => async (ctx) => {
  if (!ctx.from || !OWNERS.has(ctx.from.id)) return;
  try { await fn(ctx); } catch (e) { ctx.reply('❗ ' + e.message).catch(() => {}); }
};
bot.command('gban', ownerAny(async (ctx) => {
  const t = target(ctx);
  if (!t) return ctx.reply('Nutzung: /gban <user-id> [grund]  (oder als Antwort auf eine Nachricht)');
  const n = await gbanUser(ctx.telegram, t.user.id, t.rest.join(' '));
  ctx.reply(`🌍 ${t.user.id} in ${n} Gruppen gebannt und auf die globale Liste gesetzt.`);
}));
bot.command('ungban', ownerAny(async (ctx) => {
  const t = target(ctx);
  if (!t) return ctx.reply('Nutzung: /ungban <user-id>');
  const n = await ungbanUser(ctx.telegram, t.user.id);
  ctx.reply(`♻️ ${t.user.id} von der globalen Liste entfernt (${n} Gruppen entbannt).`);
}));
bot.command('gbans', ownerAny(async (ctx) => {
  const k = Object.entries(db.gbans);
  ctx.reply(k.length ? '🌍 Globale Bann-Liste:\n' + k.map(([id, g]) => `${id}${g.reason ? ' – ' + g.reason : ''}`).join('\n') : 'Liste leer.');
}));

/* ------------------------------ Domain-Blacklist ------------------------------ */
bot.command('blockdomain', admin(async (ctx, c) => {
  const added = [];
  for (const raw of splitList(argText(ctx))) {
    const h = hostOf(raw);
    if (h && !c.blockdomains.includes(h)) { c.blockdomains.push(h); added.push(h); }
  }
  save();
  ctx.reply(added.length ? '⛔ Gesperrt: ' + added.join(', ') : 'Nutzung: /blockdomain spam.com');
}));
bot.command('unblockdomain', admin(async (ctx, c) => {
  const del = splitList(argText(ctx)).map(hostOf).filter(Boolean);
  const before = c.blockdomains.length;
  c.blockdomains = c.blockdomains.filter((d) => !del.includes(d));
  save();
  ctx.reply(`🗑 ${before - c.blockdomains.length} entfernt.`);
}));
bot.command('blockdomains', admin(async (ctx, c) => {
  ctx.reply(c.blockdomains.length ? '⛔ Gesperrte Domains:\n' + c.blockdomains.map((d) => '• ' + d).join('\n') : 'Blacklist leer.');
}));

/* ------------------------- Schnell-Setter (Zahlenwerte) ------------------------- */
function numCmd(name, key, min, max, label, unit) {
  bot.command(name, admin(async (ctx, c) => {
    const n = parseInt(args(ctx)[0], 10);
    if (!(n >= min && n <= max)) return ctx.reply(`Nutzung: /${name} <${unit}>  (${min}–${max}, 0 = aus)`);
    c[key] = n; save();
    ctx.reply(`${label}: ${n ? n + ' ' + unit : 'aus'}`);
  }));
}
numCmd('slow', 'slowSeconds', 0, 3600, 'Slow-Modus', 'Sek');
numCmd('autodel', 'autodel', 0, 10080, 'Nachrichten automatisch löschen nach', 'Min');
numCmd('warnexpire', 'warnExpireDays', 0, 365, 'Verwarnungen verfallen nach', 'Tage');

/* --------------- Willkommens-Buttons (URL-Buttons + Regeln-Button) --------------- */
function welcomeExtra(c) {
  const rows = (c.welcomeButtons || [])
    .filter((b) => b && typeof b.text === 'string' && /^https?:\/\/\S+$/i.test(b.url || ''))
    .slice(0, 6).map((b) => [Markup.button.url(b.text, b.url)]);
  if (c.rules && c.welcomeRulesBtn) rows.push([Markup.button.callback('📜 Regeln', 'rulesbtn')]);
  return rows.length ? Markup.inlineKeyboard(rows) : {};
}
bot.action('rulesbtn', async (ctx) => {
  if (!isGroup(ctx)) return ctx.answerCbQuery();
  const c = cfg(ctx.chat.id);
  const t = c.rules ? c.rules.slice(0, 150) + (c.rules.length > 150 ? '… (siehe /rules)' : '') : 'Keine Regeln gesetzt.';
  await ctx.answerCbQuery(t, { show_alert: true }).catch(() => {});
});

/* ===================== Zusätzliche Funktionen (Teil 4) ===================== */

/* ------ Beitritts-Prüfung: gemeinsame Logik (Beitritt + Beitrittsanfragen) ------ */
async function screenUser(c, u) {
  const g = db.gbans[u.id];
  if (g) return { reason: 'Globaler Bann' + (g.reason ? ': ' + g.reason : ''), act: 'ban' };
  if (c.namefilter && c.words.length) {
    const nm = [u.first_name, u.last_name, u.username].filter(Boolean).join(' ');
    if (c.words.some((w) => wordRegex(w).test(nm))) return { reason: 'Name enthält verbotenes Wort', act: 'kick' };
  }
  if (c.cas && (await casBanned(u.id))) return { reason: 'CAS-Spammer', act: 'ban' };
  return null;
}

/* Beitrittsanfragen (Gruppen mit „Admin-Genehmigung“) automatisch bearbeiten */
bot.on('chat_join_request', async (ctx) => {
  const r = ctx.chatJoinRequest;
  if (!r) return;
  const c = cfg(r.chat.id);
  if (c.joinreq === 'off') return;
  const u = r.from;
  const nm = u.first_name || u.id;
  let s = null;
  try { s = c.joinreq === 'screen' ? await screenUser(c, u) : (db.gbans[u.id] ? { reason: 'Globaler Bann' } : null); } catch (_) {}
  try {
    if (s) {
      await ctx.telegram.declineChatJoinRequest(r.chat.id, u.id);
      logEvent(r.chat.id, 'join', `${nm} (${u.id}) Beitrittsanfrage abgelehnt: ${s.reason}`);
    } else {
      await ctx.telegram.approveChatJoinRequest(r.chat.id, u.id);
      logEvent(r.chat.id, 'join', `${nm} (${u.id}) Beitrittsanfrage angenommen`);
    }
  } catch (e) { logEvent(r.chat.id, 'mod', 'Beitrittsanfrage fehlgeschlagen: ' + e.message); }
});

/* --------------------------------- Tagesbericht --------------------------------- */
setInterval(() => {
  const now = new Date();
  for (const [id, c] of Object.entries(db.chats)) {
    if (!c.reportTime) continue;
    const local = new Date(now.getTime() + ((c.night && c.night.tz) || 0) * 3600000);
    const hhmm = local.toISOString().slice(11, 16);
    const day = local.toISOString().slice(0, 10);
    if (hhmm !== c.reportTime || c.reportLast === day) continue;
    c.reportLast = day; save();
    const target = c.reportTo === 'group' ? Number(id) : (c.logChat || LOG_CHAT_ID);
    if (!target) continue;
    bot.telegram.sendMessage(target, statsText(c, c.title || id), { parse_mode: 'HTML' }).catch(() => {});
  }
}, 30000).unref();

bot.command('dailyreport', admin(async (ctx, c) => {
  const a = args(ctx);
  if (!a.length) {
    return ctx.reply(`📰 Tagesbericht: ${c.reportTime ? c.reportTime + ' (' + tzStr(c.night.tz) + ') → ' + (c.reportTo === 'group' ? 'Gruppe' : 'Log-Chat') : 'aus'}\n\n/dailyreport 23:55 [group|log]  ·  /dailyreport off`);
  }
  if (a[0] === 'off') { c.reportTime = ''; save(); return ctx.reply('Tagesbericht aus.'); }
  const t = normTime(a[0]);
  if (!t) return ctx.reply('Nutzung: /dailyreport 23:55 [group|log]');
  const to = (a[1] || c.reportTo || 'log').toLowerCase();
  if (!['group', 'log'].includes(to)) return ctx.reply('Ziel: group oder log');
  c.reportTime = t; c.reportTo = to; save();
  ctx.reply(`📰 Tagesbericht täglich um ${t} → ${to === 'group' ? 'Gruppe' : 'Log-Chat'}.`);
}));

/* ------------------------------ Mod-Notizen zu Usern ------------------------------ */
bot.command('usernote', admin(async (ctx, c) => {
  const t = target(ctx);
  if (!t) return ctx.reply('Nutzung (Antwort auf Nachricht): /usernote <text>  ·  /usernote -  (löschen)  ·  /usernote  (anzeigen)\nOder: /usernote <user-id> <text>');
  const e = c.members[t.user.id] || (c.members[t.user.id] = { name: t.user.first_name || '', user: t.user.username || '', first: Date.now(), last: 0, n: 0 });
  const text = t.rest.join(' ').trim().slice(0, 300);
  if (!text) return ctx.reply(e.note ? `📝 Notiz: ${e.note}` : 'Keine Notiz vorhanden.');
  if (text === '-') { delete e.note; save(); return ctx.reply('🗑 Notiz gelöscht.'); }
  e.note = text; save();
  ctx.reply('📝 Notiz gespeichert.');
}));

/* ------------------------- Hilfe als Menü (aus HELP erzeugt) ------------------------- */
const HELP_BLOCKS = HELP.split('\n\n').slice(1);
const helpTitle = (b) => b.split('\n')[0].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const HELP_HEAD = '📖 <b>Hilfe</b>\nWähle einen Bereich:';
function helpKb() {
  return Markup.inlineKeyboard([
    ...chunk(HELP_BLOCKS.map((b, i) => B(helpTitle(b), 'hp:' + i)), 2),
    [B('📋 Alles', 'hp:all')],
  ]);
}
bot.help((ctx) => ctx.reply(HELP_HEAD, { parse_mode: 'HTML', ...helpKb() }));
bot.action(/^hp:(menu|all|\d+)$/, async (ctx) => {
  const k = ctx.match[1];
  let text = HELP_HEAD;
  let kb = helpKb();
  if (k === 'all') { text = HELP; kb = Markup.inlineKeyboard([[B('⬅️ Zurück', 'hp:menu')]]); }
  else if (k !== 'menu') {
    const b = HELP_BLOCKS[Number(k)];
    if (!b) return ctx.answerCbQuery();
    text = b; kb = Markup.inlineKeyboard([[B('⬅️ Zurück', 'hp:menu')]]);
  }
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
});

/* /menu: Admins landen im Setup-Menü, alle anderen in der Hilfe */
bot.command('menu', async (ctx) => {
  if (isGroup(ctx) && (await isAdmin(ctx))) {
    const { text, kb } = await suRender(ctx, 'main', ctx.chat);
    return ctx.reply(text, { parse_mode: 'HTML', ...kb });
  }
  return ctx.reply(HELP_HEAD, { parse_mode: 'HTML', ...helpKb() });
});

/* Telegram-Befehlsmenü („/“-Button) je nach Rolle */
async function setupCommands() {
  const tgm = bot.telegram;
  const set = (cmds, scope) => tgm.setMyCommands(cmds, scope ? { scope } : undefined).catch(() => {});
  await set([
    { command: 'menu', description: 'Menü & Hilfe' }, { command: 'help', description: 'Hilfe' },
    { command: 'rules', description: 'Gruppenregeln' }, { command: 'notes', description: 'Notizen anzeigen' },
    { command: 'report', description: 'Nachricht melden (Antwort)' }, { command: 'id', description: 'Chat- und User-ID' },
  ]);
  await set([
    { command: 'panel', description: 'Admin-Panel öffnen' }, { command: 'help', description: 'Hilfe' },
  ], { type: 'all_private_chats' });
  await set([
    { command: 'setup', description: 'Einrichtung (Menü)' }, { command: 'menu', description: 'Menü & Hilfe' },
    { command: 'settings', description: 'Schalter' }, { command: 'stats', description: 'Statistik' },
    { command: 'warn', description: 'Verwarnen (Antwort)' }, { command: 'mute', description: 'Stummschalten (Antwort)' },
    { command: 'ban', description: 'Bannen (Antwort)' }, { command: 'kick', description: 'Kicken (Antwort)' },
    { command: 'info', description: 'User-Infos (Antwort)' }, { command: 'rules', description: 'Gruppenregeln' },
  ], { type: 'all_chat_administrators' });
}

/* ---------------------------- Nachrichten-Filter ------------------------ */
const repeatMap = new Map();
const trigCool = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, r] of repeatMap) if (now - r.ts > 120000) repeatMap.delete(k);
  for (const [k, t] of trigCool) if (now - t > 120000) trigCool.delete(k);
}, 120000).unref();

bot.on(['message', 'edited_message'], async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const msg = ctx.msg;
  const c = cfg(ctx.chat.id);

  // Service-Nachrichten (Beitritt, Austritt, Titel, Foto ...)
  if (msg.new_chat_members || msg.left_chat_member || msg.new_chat_title || msg.new_chat_photo ||
      msg.delete_chat_photo || msg.group_chat_created || msg.pinned_message || msg.video_chat_started ||
      msg.video_chat_ended || msg.video_chat_participants_invited) {
    if (msg.left_chat_member && !msg.left_chat_member.is_bot) {
      const lu = msg.left_chat_member;
      stat(ctx.chat.id, 'leaves');
      logEvent(ctx.chat.id, 'leave', `${lu.first_name || lu.id} (${lu.id}) hat die Gruppe verlassen`);
      if (c.goodbye) notify(ctx, fmt(c.goodbyeText, lu, ctx.chat), (c.welcomeDeleteSec || 0) * 1000);
    }
    if (c.delservice) ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    return;
  }

  if (!ctx.from || msg.sender_chat || msg.is_automatic_forward) return next();

  const text = (msg.text || msg.caption || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const entities = msg.entities || msg.caption_entities || [];
  const isEdit = !!ctx.editedMessage;

  if (!isEdit) countMsg(ctx.chat.id, ctx.from);

  // Notizen (#name) und Trigger – für alle User
  if (!isEdit && text) {
    if (text.startsWith('#')) {
      const n = text.slice(1).split(/\s/)[0].toLowerCase();
      if (c.notes[n]) {
        ctx.reply(c.notes[n], {
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
          disable_web_page_preview: true,
        }).catch(() => {});
      }
    }
    for (const [kw, reply] of Object.entries(c.triggers)) {
      const key = ctx.chat.id + ':' + kw;
      if (Date.now() - (trigCool.get(key) || 0) < 30000) continue;
      if (wordRegex(kw).test(text)) {
        trigCool.set(key, Date.now());
        ctx.reply(reply, {
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
          disable_web_page_preview: true,
        }).catch(() => {});
        break;
      }
    }
  }

  if (c.approved.includes(ctx.from.id) || (await isAdmin(ctx))) return next();

  const del = () => { stat(ctx.chat.id, 'deleted'); return ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}); };
  const violate = async (kind, reason, shortMsg, icon) => {
    await del();
    await log(ctx, `${icon} ${mention(ctx.from)}: ${esc(reason)}${text ? '\n„' + esc(text.slice(0, 120)) + '“' : ''}`);
    const act = actOf(c, kind);
    if (act === 'warn') await addWarn(ctx, ctx.from, reason);
    else if (act === 'delete') await notify(ctx, `${icon} ${mention(ctx.from)}, ${shortMsg}`, 6000);
    else {
      try {
        await punish(ctx, ctx.from.id, act, c.muteMinutes);
        await notify(ctx, `🚫 ${mention(ctx.from)} → <b>${act}</b> (${esc(reason)})`);
      } catch (e) { await notify(ctx, `❗ ${esc(e.message)}`); }
    }
  };

  // Slow-Modus (Bot-intern)
  if (c.slowSeconds > 0 && !isEdit) {
    const sk = ctx.chat.id + ':' + ctx.from.id;
    if (Date.now() - (slowMap.get(sk) || 0) < c.slowSeconds * 1000) { await del(); return; }
    slowMap.set(sk, Date.now());
  }

  // Auto-Löschen nach X Minuten
  if (c.autodel > 0 && !isEdit) {
    c.delQueue.push({ m: msg.message_id, at: Date.now() + c.autodel * 60000 });
    if (c.delQueue.length > 3000) c.delQueue.splice(0, c.delQueue.length - 3000);
  }

  // Weiterleitungen
  if (c.antiforward && (msg.forward_origin || msg.forward_date)) {
    await del();
    await notify(ctx, `↪️ ${mention(ctx.from)}, Weiterleitungen sind hier nicht erlaubt.`, 6000);
    return;
  }

  // Medien-Sperren
  const lockedTypes = mediaTypes(msg).filter((t) => c.locks[t]);
  if (lockedTypes.length) {
    await del();
    await notify(ctx, `🚫 ${mention(ctx.from)}, ${LOCK_TYPES[lockedTypes[0]]} sind hier gesperrt.`, 6000);
    return;
  }

  // Flood
  if (c.flood && !isEdit && isFlood(ctx.chat.id, ctx.from.id, c.floodLimit, c.floodSeconds)) {
    await del();
    const fa = actOf(c, 'flood');
    try {
      if (fa === 'warn') await addWarn(ctx, ctx.from, 'Flood');
      else if (fa !== 'delete') {
        await punish(ctx, ctx.from.id, fa, c.floodMuteMinutes);
        await notify(ctx, fa === 'mute' ? `🌊 ${mention(ctx.from)} wegen Spam für ${c.floodMuteMinutes} min stummgeschaltet.` : `🌊 ${mention(ctx.from)} wegen Spam → <b>${fa}</b>`);
      }
    } catch (_) {}
    await log(ctx, `🌊 Flood: ${mention(ctx.from)}`);
    return;
  }

  // Wiederholte Nachrichten
  if (c.antirepeat && !isEdit && text.length >= 4) {
    const key = ctx.chat.id + ':' + ctx.from.id;
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const now = Date.now();
    let r = repeatMap.get(key);
    if (r && r.t === norm && now - r.ts < 60000) r.n++;
    else r = { t: norm, n: 1, warned: false };
    r.ts = now;
    repeatMap.set(key, r);
    if (r.n >= 3) {
      if (r.warned) { await del(); return; }
      r.warned = true;
      return violate('repeat', 'Wiederholte Nachricht', 'bitte keine Wiederholungen.', '♻️');
    }
  }

  // Schrift-Filter
  if (text) {
    const blocked = Object.keys(c.scripts).filter((k) => c.scripts[k] && SCRIPTS[k] && SCRIPTS[k].test(text));
    if (blocked.length) return violate('script', 'Nicht erlaubte Schrift (' + SCRIPT_LABELS[blocked[0]] + ')', 'diese Schrift ist hier nicht erlaubt.', '🔤');
  }

  // CAPS
  if (c.anticaps && text) {
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 12) {
      const up = letters.replace(/[^\p{Lu}]/gu, '').length;
      if (up / letters.length > 0.7) return violate('caps', 'Zu viele Großbuchstaben', 'bitte nicht schreien.', '🔠');
    }
  }

  const hosts = text ? extractHosts(text, entities) : [];

  // Domain-Blacklist (immer aktiv, auch wenn der Link-Filter aus ist)
  if (hosts.length && c.blockdomains.length) {
    const bd = hosts.find((h) => domainAllowed(h, c.blockdomains));
    if (bd) return violate('link', 'Gesperrte Domain (' + bd + ')', 'diese Domain ist gesperrt.', '⛔');
  }

  // Neulinge dürfen (zeitlich begrenzt) keine Links posten
  const joinedAt = c.joined[ctx.from.id];
  if (joinedAt) {
    if (!c.newbieMinutes || Date.now() - joinedAt > c.newbieMinutes * 60000) {
      delete c.joined[ctx.from.id]; save();
    } else if (hosts.length) {
      await del();
      await notify(ctx, `🔗 ${mention(ctx.from)}, neue Mitglieder dürfen noch keine Links senden.`, 8000);
      return;
    }
  }

  // Links (Whitelist)
  if (c.antilink && hosts.length) {
    const bad = hosts.filter((h) => !domainAllowed(h, c.domains));
    if (bad.length) return violate('link', 'Nicht erlaubter Link (' + bad.join(', ') + ')', 'dieser Link ist nicht erlaubt.', '🔗');
  }

  // Erwähnungs-Spam
  if (c.maxMentions > 0) {
    const cnt = entities.filter((e) => e.type === 'mention' || e.type === 'text_mention').length;
    if (cnt > c.maxMentions) return violate('mention', 'Zu viele Erwähnungen', 'bitte keine Erwähnungs-Spams.', '📢');
  }

  // E-Mail / Telefonnummern
  if ((c.antiemail || c.antiphone) && entities.some((e) => (c.antiemail && e.type === 'email') || (c.antiphone && e.type === 'phone_number'))) {
    return violate('contact', 'Kontaktdaten', 'bitte keine Kontaktdaten posten.', '📞');
  }

  // Wortfilter
  if (c.wordfilter && text && c.words.length) {
    const hit = c.words.find((w) => wordRegex(w).test(text));
    if (hit) return violate('word', 'Verbotenes Wort', 'bitte achte auf deine Wortwahl.', '🤬');
  }

  return next();
});

/* -------------------------------- Start --------------------------------- */
bot.catch((err, ctx) => console.error(`Fehler bei ${ctx.updateType}:`, err.message));

(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log(`Bot gestartet als @${me.username}`);
    for (const id of Object.keys(db.chats)) cfg(id);
    await setupCommands();
    try {
      webLogin = require('./dashboard').start({
        bot, db, cfg, save, me, TOGGLES, NUMS, LOCK_TYPES, SCRIPT_LABELS, MUTED, FULL,
        lockGroup, unlockGroup, rollStats, hostOf, normTime, PRESETS, punish, addWarn, logEvent, gbanUser, ungbanUser, OWNERS,
      }) || null;
    } catch (e) { console.error('Dashboard-Fehler:', e.message); }
    await bot.launch({ dropPendingUpdates: true });
  } catch (e) {
    console.error('Start fehlgeschlagen:', e.message);
    process.exit(1);
  }
})();

const stop = (sig) => { flushSave(); bot.stop(sig); setTimeout(() => process.exit(0), 600); };
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

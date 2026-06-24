// ==========================================
// odrp4.ru AUTO-AUTH — серверный прогон Steam OpenID
// ==========================================
// odrp4 отдаёт статистику фастов через /api/faststats под session-токеном.
// session-токен (живёт ~7ч) можно получить ТОЛЬКО прогнав Steam OpenID:
//   1. POST /api/steam/auth      → { ok, url }  (Steam OpenID-ссылка)
//   2. пройти OpenID по cookie steamLoginSecure → редирект на /api/steam/callback
//   3. /api/steam/callback       → HTML с одноразовым tempToken
//   4. POST /api/steam/verify { tempToken }  → { ok, sessionToken, user }
//
// Сервер повторяет шаги 1–4 сам через fetch с cookie-jar: Steam признаёт
// сессию по steamLoginSecure и сразу редиректит callback (без интерактива).
// Настройка — единственная: env STEAM_LOGIN_SECURE (cookie steamcommunity.com).
// По желанию можно добавить STEAM_SESSIONID (если Steam запросит sessionid).

const ODRP4_BASE = 'https://odrp4.ru';
const STEAM_OPENID_HOST = 'steamcommunity.com';

const DEFAULT_TIMEOUT = 20000;

// ── env-конфигурация Steam-сессии ─────────────────────────────────────
const getSteamCookie = () => {
  const parts = [];
  const loginSecure = (process.env.STEAM_LOGIN_SECURE || '').trim();
  const sessionid = (process.env.STEAM_SESSIONID || '').trim();
  if (sessionid) parts.push(`sessionid=${sessionid}`);
  if (loginSecure) parts.push(`steamLoginSecure=${loginSecure}`);
  return parts.join('; ').trim();
};

/** Включён ли авто-режим (задан STEAM_LOGIN_SECURE). */
const isAutoEnabled = () => !!getSteamCookie();

// ── утилиты fetch ─────────────────────────────────────────────────────

/** fetch с таймаутом (AbortController). */
const fetchJson = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
};

// ── Шаг 1: получить Steam OpenID-ссылку ───────────────────────────────
/**
 * POST /api/steam/auth → { ok, url }.
 * @returns {Promise<string>} openid-ссылка steamcommunity.com
 */
const getOpenIdUrl = async () => {
  const res = await fetchJson(`${ODRP4_BASE}/api/steam/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok || !data.url) {
    throw new Error(`steam/auth: ${data?.error || res.status}`);
  }
  return data.url;
};

// ── Шаг 2–3: пройти OpenID и достать tempToken ────────────────────────
/**
 * Проходит Steam OpenID: GET openid-ссылки с cookie steamLoginSecure.
 * Steam признаёт сессию и редиректит (302) на /api/steam/callback с
 * подписанными openid-параметрами. Бэкенд odrp4 верифицирует подпись,
 * создаёт tempToken и отдаёт его в HTML (localStorage / postMessage).
 *
 * @param {string} openidUrl — ссылка из getOpenIdUrl()
 * @returns {Promise<string>} одноразовый tempToken
 */
const completeSteamOpenId = async (openidUrl) => {
  const cookie = getSteamCookie();
  if (!cookie) {
    throw new Error('Не задан STEAM_LOGIN_SECURE (cookie steamcommunity.com)');
  }

  // Проходим OpenID вручную, по шагам, без следования за редиректами.
  // Цепочка: steamcommunity.com/openid/login → (несколько 302) → odrp4.ru/api/steam/callback
  let currentUrl = openidUrl;
  let callbackUrl = null;
  const cookieHeader = cookie;

  for (let i = 0; i < 10; i++) {
    const res = await fetchJson(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) admin-panel-bot',
        'Accept': 'text/html,application/json',
      },
    });

    const location = res.headers.get('location');

    // Дошли до callback odrp4 — это终点: tempToken будет в теле.
    if (currentUrl.includes('/api/steam/callback') || (location || '').includes('/api/steam/callback')) {
      callbackUrl = location && location.startsWith('http')
        ? location
        : (location ? new URL(location, currentUrl).href : currentUrl);
      // Если callback — это текущий URL, читаем тело сразу.
      if (!location || currentUrl.includes('/api/steam/callback')) {
        const html = await res.text().catch(() => '');
        const tempToken = parseTempToken(html);
        if (tempToken) return tempToken;
      }
      break;
    }

    // Редирект внутри steamcommunity.com — следуем по нему с тем же cookie.
    if (location) {
      currentUrl = location.startsWith('http')
        ? location
        : new URL(location, currentUrl).href;
      continue;
    }

    // Нет редиректа — возможно Steam вернул страницу выбора/ошибки или финал.
    // Если это страница Steam с openid-формой автосабмита — данных tempToken тут нет,
    // но мог прийти JSON-ответ напрямую. Пробуем распарсить как запасной путь.
    const text = await res.text().catch(() => '');
    const tempToken = parseTempToken(text);
    if (tempToken) return tempToken;

    // Steam может вернуть 200 со страницей «вы не авторизованы».
    if (currentUrl.includes(STEAM_OPENID_HOST)) {
      throw new Error('Steam не признал сессию (steamLoginSecure невалиден или истёк)');
    }
    break;
  }

  // Если есть отложенный callback-URL — запросим его и достанем tempToken.
  if (callbackUrl) {
    const res = await fetchJson(callbackUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) admin-panel-bot',
        'Accept': 'text/html,application/json',
      },
    });
    const html = await res.text().catch(() => '');
    const tempToken = parseTempToken(html);
    if (tempToken) return tempToken;
  }

  throw new Error('Не удалось получить tempToken: OpenID не дошёл до callback');
};

// ── Парсер tempToken из HTML callback ─────────────────────────────────
/**
 * odrp4 callback встраивает tempToken в HTML двумя способами:
 *   • localStorage.setItem('steam_temp_token', '<TOKEN>')
 *   • postMessage({ type:'steam_auth', ok:true, tempToken:'<TOKEN>' }, ...)
 * Покрываем оба + запасной: любой 32–128-символьный hex рядом с tempToken.
 * @param {string} html
 * @returns {string|null}
 */
const parseTempToken = (html) => {
  if (!html || typeof html !== 'string') return null;

  // 1) localStorage.setItem('steam_temp_token', '...')
  const lsMatch = html.match(/steam_temp_token['"]?\s*,\s*['"]([A-Za-z0-9_\-]{16,})['"]/i);
  if (lsMatch[1]) return lsMatch[1];

  // 2) postMessage({ ... tempToken: '...' })
  const pmMatch = html.match(/tempToken['"]?\s*:\s*['"]([A-Za-z0-9_\-]{16,})['"]/i);
  if (pmMatch[1]) return pmMatch[1];

  // 3) Запасной: JSON { tempToken: "..." }
  const jsonMatch = html.match(/"tempToken"\s*:\s*"([A-Za-z0-9_\-]{16,})"/i);
  if (jsonMatch[1]) return jsonMatch[1];

  return null;
};

// ── Шаг 4: обмен tempToken → sessionToken ─────────────────────────────
/**
 * POST /api/steam/verify { tempToken } → { ok, sessionToken, user }.
 * @param {string} tempToken
 * @returns {Promise<{ sessionToken: string, steam64?: string }>}
 */
const exchangeTempToken = async (tempToken) => {
  const res = await fetchJson(`${ODRP4_BASE}/api/steam/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok || !data.sessionToken) {
    throw new Error(`steam/verify: ${data?.error || res.status}`);
  }
  return {
    sessionToken: data.sessionToken,
    steam64: data.user?.steam64 || null,
  };
};

// ── Оркестрация: полный прогон ────────────────────────────────────────
/**
 * Полный авто-вход в odrp4: auth → OpenID → callback → verify.
 * @returns {Promise<{ sessionToken: string, steam64?: string }>}
 * @throws {Error} с читаемым сообщением при сбое любого шага.
 */
const refreshOdrp4Session = async () => {
  if (!isAutoEnabled()) {
    throw new Error('Авто-режим выключен: не задан STEAM_LOGIN_SECURE');
  }

  let openidUrl;
  try {
    openidUrl = await getOpenIdUrl();
  } catch (err) {
    throw new Error(`Шаг 1 (steam/auth) не удался: ${err.message}`);
  }

  let tempToken;
  try {
    tempToken = await completeSteamOpenId(openidUrl);
  } catch (err) {
    throw new Error(`Шаг 2–3 (OpenID/callback) не удался: ${err.message}`);
  }

  try {
    return await exchangeTempToken(tempToken);
  } catch (err) {
    throw new Error(`Шаг 4 (steam/verify) не удался: ${err.message}`);
  }
};

/**
 * Полный прогон + сохранение токена в БД (одна точка для cron и ручного эндпоинта).
 * @returns {Promise<{ token: string, expiresAt: Date, steam64?: string }>}
 */
const refreshAndPersist = async () => {
  const { sessionToken, steam64 } = await refreshOdrp4Session();
  if (!sessionToken) throw new Error('refreshOdrp4Session: пустой sessionToken');
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6ч с запасом (token живёт ~7ч)
  // getDB тянем лениво, чтобы модуль грузился без БД (удобно для require-тестов).
  const { getDB } = require('../db');
  const db = getDB();
  await db.query('DELETE FROM odrp4_sessions');
  await db.query(
    `INSERT INTO odrp4_sessions (session_token, steam64, expires_at)
     VALUES ($1, $2, $3)`,
    [sessionToken, steam64 || null, expiresAt]
  );
  return { token: sessionToken, expiresAt, steam64 };
};

// ── Фасты за неделю: чистая логика tally (без БД) ─────────────────────
// odrp4 отдаёт ВСЮ историю: { logs: [{ name, helpers:[{name}], created_at }] }.
// Норма фастов считается за неделю → фильтруем логи по неделе и считаем по имени.

/**
 * Чистый tally фастов из списка логов за указанную неделю.
 * Повторяет клиентский алгоритм сайта odrp4 (loadRoster):
 *   организатор (log.name) + каждый помощник (log.helpers[].name) → +1.
 * Ключ — имя в нижнем регистре; фронтом матчится с real_name.toLowerCase().
 *
 * @param {Array} logs — массив логов из /api/faststats
 * @param {string} weekStart — 'YYYY-MM-DD' (понедельник недели). Если null — все логи.
 * @returns {{ fasts: Object, total: number }}
 */
const tallyFastsForWeek = (logs, weekStart) => {
  const all = Array.isArray(logs) ? logs : [];
  const weekStartStr = weekStart ? `${weekStart} 00:00:00` : null;

  const fasts = {};
  let total = 0;
  for (const log of all) {
    // created_at = "2026-06-24 20:45:02" — лексикографическое сравнение отсекает прошлое.
    if (weekStartStr && (typeof log?.created_at !== 'string' || log.created_at < weekStartStr)) {
      continue;
    }
    total++;
    const org = (log?.name || '').trim().toLowerCase();
    if (org) fasts[org] = (fasts[org] || 0) + 1;
    const helpers = Array.isArray(log?.helpers) ? log.helpers : [];
    for (const helper of helpers) {
      const hn = (helper?.name || '').trim().toLowerCase();
      if (hn) fasts[hn] = (fasts[hn] || 0) + 1;
    }
  }
  return { fasts, total };
};

/**
 * Загружает /api/faststats через сохранённый session-токен.
 * @returns {Promise<Array>} logs (пустой массив при любой ошибке)
 */
const fetchFastsLogs = async () => {
  const { getDB } = require('../db');
  const db = getDB();
  const result = await db.query(
    `SELECT session_token FROM odrp4_sessions
     WHERE expires_at IS NULL OR expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`
  );
  const sessionToken = result.rows[0]?.session_token;
  if (!sessionToken) throw new Error('Нет активной сессии odrp4.ru');

  const res = await fetch(`${ODRP4_BASE}/api/faststats`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': sessionToken,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`odrp4.ru ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data || data.ok === false) {
    throw new Error(data?.error || 'odrp4.ru вернул ошибку');
  }
  return Array.isArray(data?.logs) ? data.logs : [];
};

/**
 * Для списка старших { steam64, real_name } считает фасты за неделю и
 * возвращает словарь { [steam64]: fastCount } — для снимка недели (cron 'end').
 * Матчинг: tally[real_name.toLowerCase()].
 *
 * @param {Array<{steam64:string, realName?:string}>} seniors
 * @param {string} weekStart — 'YYYY-MM-DD' (понедельник)
 * @returns {Promise<{ [steam64]: number }>} пустой объект при ошибке upstream
 */
const getFastsSnapshot = async (seniors, weekStart) => {
  let logs;
  try {
    logs = await fetchFastsLogs();
  } catch (err) {
    console.error('[odrp4] getFastsSnapshot: не удалось получить логи:', err.message);
    return {};
  }
  const { fasts } = tallyFastsForWeek(logs, weekStart);
  const result = {};
  for (const s of seniors) {
    const nameKey = (s?.realName || '').trim().toLowerCase();
    if (nameKey && typeof fasts[nameKey] === 'number') {
      result[s.steam64] = fasts[nameKey];
    }
  }
  return result;
};

module.exports = {
  ODRP4_BASE,
  isAutoEnabled,
  getOpenIdUrl,
  completeSteamOpenId,
  exchangeTempToken,
  refreshOdrp4Session,
  refreshAndPersist,
  parseTempToken, // экспорт для тестов
  tallyFastsForWeek,
  fetchFastsLogs,
  getFastsSnapshot,
};

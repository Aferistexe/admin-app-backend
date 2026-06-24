// ==========================================
// odrp4.ru AUTH + FASTS — обмен tempToken и подсчёт фастов
// ==========================================
// odrp4 отдаёт статистику фастов через /api/faststats под session-токеном.
//
// ВАЖНО: Steam привязывает steamLoginSecure к IP входа (поля ip_subject/ip_confirmer
// в JWT-токене). С серверного IP вход всегда даёт 403 — серверно OpenID не пройти.
// Поэтому session-токен получается В БРАУЗЕРЕ пользователя:
//   1. фронт открывает popup входа Steam (POST /api/steam/auth → url),
//   2. человек входит в Steam со своего IP → Steam редиректит на /api/steam/callback,
//   3. callback (odrp4) через postMessage/localStorage отдаёт ОДНОРАЗОВЫЙ tempToken,
//   4. фронт шлёт tempToken на POST /api/seniors/fasts/verify → бэкенд обменивает его
//      через /api/steam/verify на постоянный sessionToken (~7ч) и сохраняет в БД.
// Шаг 4 — единственная серверная часть; OpenID-флоу целиком в браузере.

const ODRP4_BASE = 'https://odrp4.ru';

const DEFAULT_TIMEOUT = 20000;

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

// ── Steam OpenID-ссылка (для popup на фронте) ─────────────────────────
/**
 * POST /api/steam/auth → { ok, url }. Ссылка открывается в popup на фронте.
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

// ── Обмен tempToken → sessionToken (шаг, исполняемый на сервере) ──────
/**
 * POST /api/steam/verify { tempToken } → { ok, sessionToken, user }.
 * tempToken — одноразовый, получен в браузере после входа Steam.
 * @param {string} tempToken
 * @returns {Promise<{ sessionToken: string, steam64?: string }>}
 */
const exchangeToken = async (tempToken) => {
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

/**
 * Сохраняет session-токен в БД (одна точка для verify-эндпоинта).
 * @returns {Promise<{ token: string, expiresAt: Date, steam64?: string }>}
 */
const persistSession = async (sessionToken, steam64) => {
  if (!sessionToken) throw new Error('persistSession: пустой sessionToken');
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6ч с запасом (token живёт ~7ч)
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

/**
 * Обмен tempToken на sessionToken + сохранение (одна серверная операция для фронта).
 * @param {string} tempToken — одноразовый, из браузера после входа Steam.
 * @returns {Promise<{ token: string, expiresAt: Date, steam64?: string }>}
 */
const verifyAndPersist = async (tempToken) => {
  const { sessionToken, steam64 } = await exchangeToken(tempToken);
  return persistSession(sessionToken, steam64);
};

// ── Фасты за неделю: чистая логика tally (без БД) ─────────────────────
// odrp4 отдаёт ВСЮ историю: { logs: [{ name, helpers:[{name}], created_at }] }.
// Норма фастов считается за неделю → фильтруем логи по неделе и считаем по имени.

/**
 * Чистый tally фастов из списка логов за указанную неделю.
 * Считаем только ОРГАНИЗАТОРА (log.name) — «сколько фастов провёл».
 * Помощников (log.helpers) НЕ учитываем.
 *
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
 * Для списка старших { steam64, realName } считает фасты за неделю и
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
  getOpenIdUrl,
  exchangeToken,
  persistSession,
  verifyAndPersist,
  tallyFastsForWeek,
  fetchFastsLogs,
  getFastsSnapshot,
};

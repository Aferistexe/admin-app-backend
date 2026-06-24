// ==========================================
// SENIORS — статистика старших администраторов
// ==========================================
// Метрики (выходы на смену, фасты) — редактируемые per-старший, хранятся в БД.
// Часы — тянутся парсингом Livewire с unionteams.ru (см. lib/livewireHours).
// Фасты за неделю — проксируются с odrp4.ru/api/faststats.
//
// Роут монтируется под authenticateToken БЕЗ csrfProtection:
// фронт работает по Bearer-токену из localStorage, CSRF для него избыточен.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDB, logAction } = require('../db');
const { fetchPlayerHours, fetchHoursBatch } = require('../lib/livewireHours');
const {
  setManualStart,
  batchSnapshot,
  getWeeklyData,
  getWeekSnapshot,
  getCurrentWeekStart,
  upsertWeekMetrics,
} = require('../lib/weeklyHours');

const {
  isAutoEnabled,
  refreshAndPersist,
} = require('../lib/odrp4Auth');

const router = express.Router();

// steam64 — 17 цифр.
const STEAM64_RE = /^\d{17}$/;

// Отдельный лимитер на hours-эндпоинты: livewire тяжёлый.
const hoursLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Слишком много запросов часов. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Нормализация и проверка steam64.
const sanitizeSteam64 = (v) => (typeof v === 'string' ? v.trim() : '');
const isValidSteam64 = (v) => STEAM64_RE.test(sanitizeSteam64(v));

// ==========================================
// GET /api/seniors/metrics — все метрики одним словарём
// Возвращает: { metrics: { [steam64_id]: { shifts, fasts, reports } } }
// ==========================================
router.get('/metrics', async (req, res) => {
  const db = getDB();
  try {
    const result = await db.query(
      'SELECT steam64_id, shifts, fasts, reports FROM senior_metrics ORDER BY updated_at DESC'
    );
    const metrics = {};
    for (const row of result.rows) {
      metrics[row.steam64_id] = { shifts: row.shifts, fasts: row.fasts, reports: row.reports };
    }
    res.json({ metrics });
  } catch (err) {
    console.error('GET /api/seniors/metrics error:', err);
    res.status(500).json({ error: 'Ошибка загрузки метрик' });
  }
});

// ==========================================
// PUT /api/seniors/metrics/:steam64Id — upsert метрик
// Body: { shifts?: number, fasts?: number, reports?: number } — только переданные поля обновляются.
// Метрики синхронно пишутся и в senior_metrics, и в строку текущей недели
// senior_weekly_hours (shifts/reports/fasts), чтобы навигация по неделям видела
// актуальные значения уже сейчас, до закрытия недели cron'ом.
// Возвращает обновлённую запись.
// ==========================================
router.put('/metrics/:steam64Id', async (req, res) => {
  const { steam64Id } = req.params;
  const db = getDB();

  if (!isValidSteam64(steam64Id)) {
    return res.status(400).json({ error: 'Некорректный steam64_id' });
  }
  const id = sanitizeSteam64(steam64Id);

  const { shifts, fasts, reports } = req.body || {};
  const nextShifts = Number.isInteger(shifts) && shifts >= 0 ? shifts : null;
  const nextFasts = Number.isInteger(fasts) && fasts >= 0 ? fasts : null;
  const nextReports = Number.isInteger(reports) && reports >= 0 ? reports : null;

  if (nextShifts === null && nextFasts === null && nextReports === null) {
    return res.status(400).json({ error: 'Нужно указать shifts, fasts или reports (целое ≥ 0)' });
  }

  try {
    // Upsert в senior_metrics: обновляем только переданные поля (COALESCE).
    const result = await db.query(
      `INSERT INTO senior_metrics (steam64_id, shifts, fasts, reports, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (steam64_id) DO UPDATE
         SET shifts  = COALESCE($2, senior_metrics.shifts),
             fasts   = COALESCE($3, senior_metrics.fasts),
             reports = COALESCE($4, senior_metrics.reports),
             updated_by = $5,
             updated_at = CURRENT_TIMESTAMP
       RETURNING steam64_id, shifts, fasts, reports, updated_at`,
      [id, nextShifts, nextFasts, nextReports, req.user?.id || null]
    );

    const row = result.rows[0];

    // Синхронизация метрик текущей недели в senior_weekly_hours.
    const weekPatch = {};
    if (nextShifts !== null) weekPatch.shifts = nextShifts;
    if (nextReports !== null) weekPatch.reports = nextReports;
    if (nextFasts !== null) weekPatch.fasts = nextFasts;
    if (Object.keys(weekPatch).length > 0) {
      await upsertWeekMetrics(id, weekPatch, req.user?.id || null).catch((e) =>
        console.warn('upsertWeekMetrics failed:', e?.message)
      );
    }

    await logAction(
      req.user?.id || null,
      'senior_metric_updated',
      'senior_metric',
      null,
      { steam64_id: id, shifts: row.shifts, fasts: row.fasts, reports: row.reports },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      steam64_id: row.steam64_id,
      shifts: row.shifts,
      fasts: row.fasts,
      reports: row.reports,
      updated_at: row.updated_at,
    });
  } catch (err) {
    console.error('PUT /api/seniors/metrics error:', err);
    res.status(500).json({ error: 'Ошибка сохранения метрики' });
  }
});

// ==========================================
// GET /api/seniors/weekly/week — снимок текущей недели
// Query: ?ids=steam64,steam64,...
// Возвращает: { week, metrics: { [steam64]: { tickets, hours, shifts, reports, fasts } } }
// ==========================================
router.get('/weekly/week', async (req, res) => {
  const rawIds = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  const ids = rawIds.filter(isValidSteam64).map(sanitizeSteam64);

  if (ids.length === 0) {
    return res.json({ week: getCurrentWeekStart(), metrics: {} });
  }

  try {
    const data = await getWeekSnapshot(null, ids);
    res.json(data);
  } catch (err) {
    console.error('GET /api/seniors/weekly/week error:', err);
    res.status(500).json({ error: 'Ошибка загрузки недельного снимка' });
  }
});

// ==========================================
// GET /api/seniors/weekly/week/:weekStart — снимок конкретной недели
// Query: ?ids=steam64,steam64,...
// :weekStart — 'YYYY-MM-DD' (понедельник).
// Возвращает: { week, metrics: { [steam64]: { tickets, hours, shifts, reports, fasts } } }
// ==========================================
router.get('/weekly/week/:weekStart', async (req, res) => {
  const rawIds = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  const ids = rawIds.filter(isValidSteam64).map(sanitizeSteam64);
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(req.params.weekStart) ? req.params.weekStart : null;

  if (ids.length === 0) {
    return res.json({ week: weekStart || getCurrentWeekStart(), metrics: {} });
  }

  try {
    const data = await getWeekSnapshot(weekStart, ids);
    res.json(data);
  } catch (err) {
    console.error('GET /api/seniors/weekly/week/:weekStart error:', err);
    res.status(500).json({ error: 'Ошибка загрузки недельного снимка' });
  }
});

// ==========================================
// GET /api/seniors/hours/:steam64Id — часы одного игрока (из livewire)
// Возвращает: { hours, source, steam64_id } (source: cache|live|error)
// ==========================================
router.get('/hours/:steam64Id', hoursLimiter, async (req, res) => {
  const { steam64Id } = req.params;

  if (!isValidSteam64(steam64Id)) {
    return res.status(400).json({ error: 'Некорректный steam64_id' });
  }

  try {
    const r = await fetchPlayerHours(sanitizeSteam64(steam64Id));
    res.json({ steam64_id: sanitizeSteam64(steam64Id), hours: r.hours, source: r.source });
  } catch (err) {
    console.error('GET /api/seniors/hours/:steam64Id error:', err);
    res.status(502).json({ error: 'Не удалось получить часы' });
  }
});

// ==========================================
// POST /api/seniors/hours/batch — часы нескольких игроков
// Body: { ids: string[] }  →  { hours: { [steam64]: number } }
// Часы грузятся параллельно чанками по 5; ошибки не валят весь батч (часы=0).
// ==========================================
router.post('/hours/batch', hoursLimiter, async (req, res) => {
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Требуется массив ids' });
  }
  if (ids.length > 50) {
    return res.status(400).json({ error: 'Максимум 50 id за запрос' });
  }

  // Фильтруем невалидные — не делаем по ним запросов.
  const validIds = ids.filter(isValidSteam64).map(sanitizeSteam64);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'Нет валидных steam64_id' });
  }

  try {
    const hours = await fetchHoursBatch(validIds, 5);
    res.json({ hours });
  } catch (err) {
    console.error('POST /api/seniors/hours/batch error:', err);
    res.status(502).json({ error: 'Не удалось получить часы' });
  }
});

// ==========================================
// GET /api/seniors/weekly — недельные часы + история
// Query: ?ids=steam64,steam64,...  (если не указано — пустой ответ)
// Возвращает: { weekStart, current: { steam64: { startHours, endHours } }, history: [...] }
// ==========================================
router.get('/weekly', async (req, res) => {
  const rawIds = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  const ids = rawIds.filter(isValidSteam64).map(sanitizeSteam64);

  if (ids.length === 0) {
    return res.json({ weekStart: getCurrentWeekStart(), current: {}, history: [] });
  }

  try {
    const data = await getWeeklyData(ids, 8);
    res.json({ weekStart: getCurrentWeekStart(), ...data });
  } catch (err) {
    console.error('GET /api/seniors/weekly error:', err);
    res.status(500).json({ error: 'Ошибка загрузки недельных часов' });
  }
});

// ==========================================
// POST /api/seniors/weekly/start — ручной ввод старта недели
// Body: { entries: [{ steam64, hours }] }
// Конвертация часы→часы (как есть), upsert. userId — из токена.
// Возвращает: { saved: number, weekStart }
// ==========================================
router.post('/weekly/start', async (req, res) => {
  const { entries } = req.body || {};

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'Требуется массив entries' });
  }
  if (entries.length > 100) {
    return res.status(400).json({ error: 'Максимум 100 записей за запрос' });
  }

  let saved = 0;
  try {
    for (const e of entries) {
      const id = sanitizeSteam64(e?.steam64);
      if (!isValidSteam64(id)) continue;
      const hours = Number(e?.hours);
      if (!Number.isFinite(hours) || hours < 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await setManualStart(id, Math.floor(hours), req.user?.id || null);
      saved++;
    }
    res.json({ saved, weekStart: getCurrentWeekStart() });
  } catch (err) {
    console.error('POST /api/seniors/weekly/start error:', err);
    res.status(500).json({ error: 'Ошибка сохранения старта недели' });
  }
});

// ==========================================
// POST /api/seniors/weekly/snapshot — ручной триггер снимка
// Body: { ids: string[], when: 'start' | 'end' }
// Дёргает Livewire и сохраняет снимок. Запасной путь, если cron пропустил.
// Возвращает: { results: [{ steam64, ok, hours, error }] }
// ==========================================
router.post('/weekly/snapshot', hoursLimiter, async (req, res) => {
  const { ids, when } = req.body || {};

  if (when !== 'start' && when !== 'end') {
    return res.status(400).json({ error: "when должен быть 'start' или 'end'" });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Требуется массив ids' });
  }
  if (ids.length > 50) {
    return res.status(400).json({ error: 'Максимум 50 id за запрос' });
  }

  const validIds = ids.filter(isValidSteam64).map(sanitizeSteam64);
  if (validIds.length === 0) {
    return res.status(400).json({ error: 'Нет валидных steam64_id' });
  }

  try {
    const results = await batchSnapshot(validIds, when, req.user?.id || null, 5);
    res.json({ results });
  } catch (err) {
    console.error('POST /api/seniors/weekly/snapshot error:', err);
    res.status(502).json({ error: 'Не удалось сделать снимок' });
  }
});

// ==========================================
// odrp4.ru PROXY — фасты за неделю
// ==========================================
// odrp4 отдаёт фасты через /api/faststats под session-токеном.
// Токен нельзя получить серверно (Steam OpenID-валидация привязана к домену odrp4),
// поэтому его вводит пользователь вручную (POST /fasts/token) — он хранится в БД.
// GET /fasts делает запрос к odrp4 от лица сохранённого токена.

const ODRP4_BASE = 'https://odrp4.ru';

/** Активная сессия из БД (не просроченная) или null. */
const getOdrp4SessionRow = async () => {
  const db = getDB();
  const result = await db.query(
    `SELECT session_token, steam64, expires_at FROM odrp4_sessions
     WHERE expires_at IS NULL OR expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
};

/** Активный session_token из БД (не просроченный) или null. */
const getOdrp4Session = async () => (await getOdrp4SessionRow())?.session_token || null;

/** Сохраняет session_token в БД (удаляет старые, вставляет новый). */
const saveOdrp4Session = async (token, steam64) => {
  const db = getDB();
  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6ч с запасом (token живёт ~7ч)
  await db.query('DELETE FROM odrp4_sessions');
  await db.query(
    `INSERT INTO odrp4_sessions (session_token, steam64, expires_at)
     VALUES ($1, $2, $3)`,
    [token, steam64, expiresAt]
  );
  return expiresAt;
};

/**
 * Прогоняет авто-вход odrp4 (Steam OpenID → sessionToken) и сохраняет токен в БД.
 * Работает только при заданном STEAM_LOGIN_SECURE. Возвращает { token, expiresAt } или кидает.
 * Делегирует персистентность в lib/odrp4Auth.refreshAndPersist (общая точка с cron).
 */
const runAutoRefresh = async () => {
  if (!isAutoEnabled()) {
    throw new Error('Авто-режим выключен (STEAM_LOGIN_SECURE не задан)');
  }
  return refreshAndPersist();
};

/** Делает запрос к odrp4.ru с авторизацией через X-Session-Token. */
const odrp4Request = async (path, options = {}) => {
  let sessionToken = await getOdrp4Session();
  if (!sessionToken) {
    throw new Error('Нет активной сессии odrp4.ru');
  }

  const doFetch = (token) =>
    fetch(ODRP4_BASE + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token,
        ...(options.headers || {}),
      },
    });

  let res = await doFetch(sessionToken);

  // 401/403 — сессия истекла. В авто-режиме обновляем один раз и ретраим.
  if ((res.status === 401 || res.status === 403) && isAutoEnabled()) {
    try {
      const refreshed = await runAutoRefresh();
      if (refreshed?.token) {
        sessionToken = refreshed.token;
        res = await doFetch(sessionToken);
      }
    } catch (err) {
      console.error('odrp4 auto-refresh failed:', err.message);
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`odrp4.ru ${res.status}: ${text}`);
  }

  return res.json();
};

// ==========================================
// POST /api/seniors/fasts/token — сохранение sessionToken odrp4 (ручной ввод)
// Body: { sessionToken: string }
// Перед сохранением валидирует токен тестовым запросом к odrp4.
// ==========================================
router.post('/fasts/token', async (req, res) => {
  const { sessionToken } = req.body || {};

  if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.length < 16) {
    return res.status(400).json({ ok: false, error: 'Некорректный sessionToken' });
  }

  // Валидация: пробуем сделать запрос к odrp4 с этим токеном.
  try {
    const test = await fetch(`${ODRP4_BASE}/api/faststats`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken,
      },
    });

    if (test.status === 401 || test.status === 403) {
      return res.status(401).json({ ok: false, error: 'Токен отклонён odrp4.ru (невалиден или истёк)' });
    }
    if (!test.ok) {
      return res.status(502).json({ ok: false, error: `odrp4.ru ответил ${test.status}` });
    }
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Не удалось связаться с odrp4.ru' });
  }

  try {
    await saveOdrp4Session(sessionToken.trim(), req.user?.id || null);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/seniors/fasts/token error:', err.message);
    res.status(500).json({ ok: false, error: 'Не удалось сохранить токен' });
  }
});

// ==========================================
// GET /api/seniors/fasts/status — статус подключения odrp4
// Возвращает: { connected, auto, expiresAt }
//   auto — задан ли STEAM_LOGIN_SECURE (сервер сам обновляет токен по cron).
//   expiresAt — ISO-время истечения текущего токена (или null).
// ==========================================
router.get('/fasts/status', async (req, res) => {
  const auto = isAutoEnabled();
  try {
    const row = await getOdrp4SessionRow();
    res.json({
      connected: !!row?.session_token,
      auto,
      expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null,
    });
  } catch {
    res.json({ connected: false, auto, expiresAt: null });
  }
});

// ==========================================
// POST /api/seniors/fasts/refresh — ручной запуск авто-обновления токена
// Работает только в авто-режиме (STEAM_LOGIN_SECURE задан).
// Прогоняет Steam OpenID → новый sessionToken → сохраняет в БД.
// Возвращает: { ok, connected, expiresAt } или { ok:false, error }.
// ==========================================
router.post('/fasts/refresh', async (req, res) => {
  if (!isAutoEnabled()) {
    return res.status(400).json({
      ok: false,
      error: 'Авто-режим выключен: задайте STEAM_LOGIN_SECURE на сервере',
    });
  }
  try {
    const { expiresAt } = await runAutoRefresh();
    console.log('[odrp4] ручное обновление токена успешно, истекает', expiresAt.toISOString());
    res.json({ ok: true, connected: true, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    console.error('POST /api/seniors/fasts/refresh error:', err.message);
    res.status(502).json({ ok: false, error: err.message || 'Не удалось обновить токен odrp4' });
  }
});

// ==========================================
// GET /api/seniors/fasts — фасты за неделю (прокси odrp4.ru/api/faststats)
// Возвращает: { fasts: { [name_lower]: count } }
// ------------------------------------------
// odrp4 отдаёт { logs: [{ name, helpers: [{name}] }] } — фасты НЕ индексируются
// по steam64, а учитываются по отображаемому имени (ориганизатор + каждый хелпер).
// Это в точности повторяет клиентский tally сайта odrp4 (loadRoster):
//   fastTally[name.toLowerCase()] += 1  для log.name и каждого log.helpers[].name
// Фронтенд матчит имя (lower) с real_name старшего. Поэтому ключи — имена, не steam64.
// ==========================================
router.get('/fasts', async (req, res) => {
  try {
    const data = await odrp4Request('/api/faststats');

    if (!data || data.ok === false) {
      return res.status(502).json({
        fasts: {},
        error: data?.error || 'odrp4.ru вернул ошибку',
      });
    }

    // Tally по отображаемому имени (как на самом сайте odrp4).
    const fasts = {};
    const logs = Array.isArray(data?.logs) ? data.logs : [];
    for (const log of logs) {
      const org = (log?.name || '').trim().toLowerCase();
      if (org) fasts[org] = (fasts[org] || 0) + 1;
      const helpers = Array.isArray(log?.helpers) ? log.helpers : [];
      for (const helper of helpers) {
        const hn = (helper?.name || '').trim().toLowerCase();
        if (hn) fasts[hn] = (fasts[hn] || 0) + 1;
      }
    }

    res.json({ fasts, total: logs.length });
  } catch (err) {
    console.error('GET /api/seniors/fasts error:', err.message);
    res.status(502).json({
      fasts: {},
      total: 0,
      error: err.message || 'Не удалось получить фасты',
    });
  }
});

module.exports = router;

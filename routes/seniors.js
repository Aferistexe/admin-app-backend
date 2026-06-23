// ==========================================
// SENIORS — статистика старших администраторов
// ==========================================
// Метрики (выходы на смену, фасты) — редактируемые per-старший, хранятся в БД.
// Часы — тянутся парсингом Livewire с unionteams.ru (см. lib/livewireHours).
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
// GET /api/seniors/weekly/week/:weekStart? — снимок одной недели
// Query: ?ids=steam64,steam64,...
// :weekStart — 'YYYY-MM-DD' (понедельник). Можно опустить → текущая неделя.
// Возвращает: { week, metrics: { [steam64]: { tickets, hours, shifts, reports, fasts } } }
// ==========================================
router.get('/weekly/week/:weekStart?', async (req, res) => {
  const rawIds = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  const ids = rawIds.filter(isValidSteam64).map(sanitizeSteam64);
  const weekStart = typeof req.params.weekStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.params.weekStart)
    ? req.params.weekStart
    : null;

  if (ids.length === 0) {
    return res.json({ week: weekStart || getCurrentWeekStart(), metrics: {} });
  }

  try {
    const data = await getWeekSnapshot(weekStart, ids);
    res.json(data);
  } catch (err) {
    console.error('GET /api/seniors/weekly/week error:', err);
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

module.exports = router;

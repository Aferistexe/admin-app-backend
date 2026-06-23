// ==========================================
// WEEKLY HOURS — недельные часы старших через дельту снимков
// ==========================================
// Сайт отдаёт только ОБЩЕЕ наигранное время (часы за всё время). Чтобы узнать
// часы ЗА НЕДЕЛЮ, храним два снимка общего времени — на понедельник (старт) и
// на воскресенье 23:59 (финиш). Дельта = наигранное за неделю.
//
// Снимки делает cron (см. scheduler.js): пн 00:05 и вс 23:55 МСК.
// Ручной ввод старта недели — через POST /seniors/weekly/start.
// Храним сразу в ЧАСАХ (не секундах) — по требованию.

const { getDB, logAction } = require('../db');
const { fetchPlayerHours } = require('./livewireHours');

// Понедельник текущей недели (МСК) как DATE.
// Логика та же, что в StatsEditorModal.getDynamicWeeklyNorm на фронте.
const getCurrentWeekStart = () => {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=вс ... 1=пн
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  monday.setHours(0, 0, 0, 0);
  // Формат YYYY-MM-DD для DATE-колонки Postgres.
  return monday.toISOString().slice(0, 10);
};

// ------------------------------------
// Сохраняет снимок общего времени для старшего на указанную фазу недели.
// when: 'start' (понедельник) | 'end' (воскресенье).
// hours — общее наигранное время в часах (из Livewire).
// metricsSnap — { tickets, shifts, reports, fasts } опционально, пишется при
// закрытии недели (when='end') как полный снимок метрик недели.
// ------------------------------------
async function snapshotForWeek(steam64Id, hours, when, userId = null, metricsSnap = null) {
  const db = getDB();
  const weekStart = getCurrentWeekStart();
  const safeHours = Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : null;

  const snap = metricsSnap || {};
  const snapTickets = Number.isFinite(Number(snap.tickets)) ? Number(snap.tickets) : null;
  const snapShifts = Number.isFinite(Number(snap.shifts)) ? Number(snap.shifts) : null;
  const snapReports = Number.isFinite(Number(snap.reports)) ? Number(snap.reports) : null;
  const snapFasts = Number.isFinite(Number(snap.fasts)) ? Number(snap.fasts) : null;

  // 1) Upsert в senior_weekly_hours (история по неделям).
  const startCol = when === 'start' ? 'start_hours' : null;
  const endCol = when === 'end' ? 'end_hours' : null;

  if (when === 'start') {
    await db.query(
      `INSERT INTO senior_weekly_hours (steam64_id, week_start, start_hours, status)
       VALUES ($1, $2, $3, 'open')
       ON CONFLICT (steam64_id, week_start) DO UPDATE
         SET start_hours = COALESCE(EXCLUDED.start_hours, senior_weekly_hours.start_hours)`,
      [steam64Id, weekStart, safeHours]
    );
  } else {
    // end: если записи за неделю ещё нет — создаём, потом закрываем.
    await db.query(
      `INSERT INTO senior_weekly_hours (steam64_id, week_start, end_hours, status)
       VALUES ($1, $2, $3, 'closed')
       ON CONFLICT (steam64_id, week_start) DO UPDATE
         SET end_hours = COALESCE(EXCLUDED.end_hours, senior_weekly_hours.end_hours),
             status = 'closed'`,
      [steam64Id, weekStart, safeHours]
    );

    // Финализируем hours при закрытии недели.
    await db.query(
      `UPDATE senior_weekly_hours
         SET hours = CASE
            WHEN start_hours IS NOT NULL AND end_hours IS NOT NULL AND end_hours >= start_hours
            THEN end_hours - start_hours
            ELSE hours END
       WHERE steam64_id = $1 AND week_start = $2`,
      [steam64Id, weekStart]
    );

    // Полный снимок метрик недели (tickets/shifts/reports/fasts).
    await db.query(
      `UPDATE senior_weekly_hours
         SET tickets = COALESCE($3, tickets),
             shifts  = COALESCE($4, shifts),
             reports = COALESCE($5, reports),
             fasts   = COALESCE($6, fasts)
       WHERE steam64_id = $1 AND week_start = $2`,
      [steam64Id, weekStart, snapTickets, snapShifts, snapReports, snapFasts]
    );
  }

  // 2) Денормализация в senior_metrics (быстрый доступ к последним снимкам).
  const metricsCol = when === 'start' ? 'week_start_hours' : 'week_end_hours';
  await db.query(
    `INSERT INTO senior_metrics (steam64_id, ${metricsCol}, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (steam64_id) DO UPDATE
       SET ${metricsCol} = $2,
           updated_by = $3,
           updated_at = CURRENT_TIMESTAMP`,
    [steam64Id, safeHours, userId]
  );

  void startCol; void endCol; // (для будущего расширения,suppress lint)
  return { steam64_id: steam64Id, week_start: weekStart, when, hours: safeHours };
}

// ------------------------------------
// Ручной ввод старта недели: hours сразу сохраняются как week_start_hours.
// userId — кто внёс (для лога).
// ------------------------------------
async function setManualStart(steam64Id, hours, userId = null) {
  const safeHours = Number.isFinite(Number(hours)) ? Math.floor(Number(hours)) : null;
  if (safeHours === null || safeHours < 0) {
    throw new Error('hours должен быть целым ≥ 0');
  }
  const res = await snapshotForWeek(steam64Id, safeHours, 'start', userId);
  await logAction(
    userId,
    'senior_week_start_manual',
    'senior_weekly_hours',
    null,
    { steam64_id: steam64Id, hours: safeHours },
    null,
    null
  );
  return res;
}

// ------------------------------------
// Вычисляет недельные часы для старшего по текущему общему времени.
// Если есть снимок старта текущей недели → дельта (текущее - старт).
// Иначе null (снимка нет, норма часов неизвестна).
// ------------------------------------
function computeWeeklyHours(startHours, currentHours) {
  if (startHours === null || startHours === undefined) return null;
  if (currentHours === null || currentHours === undefined) return null;
  const delta = currentHours - startHours;
  return delta > 0 ? Math.floor(delta) : 0;
}

// ------------------------------------
// Батчевый снимок для списка steam64: дёргает Livewire и сохраняет.
// Используется cron'ом и ручным триггером.
// items может быть:
//   - массивом steam64 (строки), либо
//   - массивом { steam64, tickets } — tickets берётся из публичного API
//     и пишется в снимок метрик недели при закрытии (when='end').
// При when='end' тянем shifts/reports/fasts из senior_metrics, чтобы сохранить
// полный снимок недели. limit — размер чанка конкурентности.
// Возвращает массив результатов [{ steam64, ok, hours, error }].
// ------------------------------------
async function batchSnapshot(items, when, userId = null, limit = 5) {
  const db = getDB();
  const norm = (x) => Array.isArray(x) ? x.map((i) => (i && typeof i === 'object' ? i : { steam64: i })) : x;
  const raw = norm(items);
  const list = (Array.isArray(raw) ? raw : []).filter((it) => /^\d{17}$/.test(String(it.steam64)));
  const ids = list.map((it) => it.steam64);
  const ticketsBy = {};
  for (const it of list) {
    ticketsBy[it.steam64] = Number.isFinite(Number(it.tickets)) ? Number(it.tickets) : null;
  }

  // При закрытии недели тянем текущие метрики для полного снимка.
  let metricsBy = {};
  if (when === 'end' && ids.length > 0) {
    const mRes = await db.query(
      'SELECT steam64_id, shifts, reports, fasts FROM senior_metrics WHERE steam64_id = ANY($1)',
      [ids]
    );
    for (const r of mRes.rows) {
      metricsBy[r.steam64_id] = {
        shifts: r.shifts,
        reports: r.reports,
        fasts: r.fasts,
      };
    }
  }

  const results = [];

  for (let i = 0; i < ids.length; i += limit) {
    const chunk = ids.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.all(
      chunk.map(async (id) => {
        try {
          const r = await fetchPlayerHours(id);
          if (r.source === 'error' || r.hours == null) {
            return { steam64: id, ok: false, error: r.error || 'no hours' };
          }
          const snap = when === 'end'
            ? { tickets: ticketsBy[id], ...(metricsBy[id] || {}) }
            : null;
          await snapshotForWeek(id, r.hours, when, userId, snap);
          return { steam64: id, ok: true, hours: r.hours };
        } catch (err) {
          return { steam64: id, ok: false, error: err.message };
        }
      })
    );
    results.push(...settled);
  }
  return results;
}

// ------------------------------------
// Возвращает недельные часы + историю для списка steam64.
// current: { [steam64]: { weeklyHours, startHours } } — по текущей неделе.
// history: [{ steam64_id, week_start, start_hours, end_hours, hours, status }]
//          — последние N недель.
// ------------------------------------
async function getWeeklyData(steam64Ids, historyLimit = 8) {
  const db = getDB();
  const ids = (Array.isArray(steam64Ids) ? steam64Ids : [])
    .filter((id) => /^\d{17}$/.test(String(id)));

  if (ids.length === 0) return { current: {}, history: [] };

  // Текущие снимки из senior_metrics.
  const metricsRes = await db.query(
    `SELECT steam64_id, week_start_hours, week_end_hours
       FROM senior_metrics
      WHERE steam64_id = ANY($1)`,
    [ids]
  );
  const current = {};
  for (const row of metricsRes.rows) {
    current[row.steam64_id] = {
      startHours: row.week_start_hours,
      endHours: row.week_end_hours,
    };
  }

  // История из senior_weekly_hours.
  const histRes = await db.query(
    `SELECT steam64_id, week_start, start_hours, end_hours, hours, tickets, shifts, reports, fasts, status
       FROM senior_weekly_hours
      WHERE steam64_id = ANY($1)
      ORDER BY week_start DESC
      LIMIT $2`,
    [ids, ids.length * historyLimit]
  );

  return { current, history: histRes.rows };
}

// ------------------------------------
// Снимок одной недели для списка steam64 (для навигации по неделям на фронте).
// Если weekStart не передан — текущая неделя (live-значения из senior_metrics +
// свежие часы из computeWeeklyHours). Иначе — строка из senior_weekly_hours.
// Возвращает: { week, metrics: { [steam64]: { tickets, hours, shifts, reports, fasts } } }
// ------------------------------------
async function getWeekSnapshot(weekStart, steam64Ids) {
  const db = getDB();
  const ids = (Array.isArray(steam64Ids) ? steam64Ids : [])
    .filter((id) => /^\d{17}$/.test(String(id)));
  const week = weekStart || getCurrentWeekStart();
  const metrics = {};

  if (ids.length === 0) return { week, metrics };

  if (!weekStart || weekStart === getCurrentWeekStart()) {
    // Текущая неделя — живые значения.
    const res = await db.query(
      `SELECT steam64_id, shifts, reports, fasts, week_start_hours, week_end_hours
         FROM senior_metrics
        WHERE steam64_id = ANY($1)`,
      [ids]
    );
    for (const r of res.rows) {
      metrics[r.steam64_id] = {
        tickets: null,
        hours: computeWeeklyHours(r.week_start_hours, r.week_end_hours),
        shifts: r.shifts,
        reports: r.reports,
        fasts: r.fasts,
      };
    }
    return { week: getCurrentWeekStart(), metrics };
  }

  // Прошлая неделя — снимок из истории.
  const res = await db.query(
    `SELECT steam64_id, hours, tickets, shifts, reports, fasts
       FROM senior_weekly_hours
      WHERE week_start = $1 AND steam64_id = ANY($2)`,
    [weekStart, ids]
  );
  for (const r of res.rows) {
    metrics[r.steam64_id] = {
      tickets: r.tickets,
      hours: r.hours,
      shifts: r.shifts,
      reports: r.reports,
      fasts: r.fasts,
    };
  }
  return { week, metrics };
}

// ------------------------------------
// Upsert метрик текущей недели в senior_weekly_hours (синхронизация при ручном
// редактировании shifts/reports/fasts на текущей неделе). tickets сюда не пишем —
// его снимок делает cron при закрытии недели.
// patch: { shifts?, reports?, fasts? } — только переданные поля обновляются.
// ------------------------------------
async function upsertWeekMetrics(steam64Id, patch, userId = null) {
  const db = getDB();
  const weekStart = getCurrentWeekStart();
  const sets = [];
  const setVals = [];
  let idx = 3;
  for (const key of ['shifts', 'reports', 'fasts']) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      const v = patch[key];
      sets.push(`${key} = $${idx}`);
      setVals.push(Number.isFinite(Number(v)) ? Number(v) : 0);
      idx++;
    }
  }
  if (sets.length === 0) return null;

  await db.query(
    `INSERT INTO senior_weekly_hours (steam64_id, week_start)
     VALUES ($1, $2)
     ON CONFLICT (steam64_id, week_start) DO UPDATE
       SET ${sets.join(', ')}`,
    [steam64Id, weekStart, ...setVals]
  );
  void userId;
  return { steam64_id: steam64Id, week_start: weekStart };
}

module.exports = {
  getCurrentWeekStart,
  snapshotForWeek,
  setManualStart,
  computeWeeklyHours,
  batchSnapshot,
  getWeeklyData,
  getWeekSnapshot,
  upsertWeekMetrics,
};

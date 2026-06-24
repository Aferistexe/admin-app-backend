// ==========================================
// SCHEDULER — cron-задачи для недельных снимков часов старших
// ==========================================
// Делает два снимка общего наигранного времени в неделю:
//   - понедельник 00:05 МСК → старт недели (week_start_hours)
//   - воскресенье 23:55 МСК → финиш недели (week_end_hours), расчёт hours.
// Render free tier засыпает → держать живым через UptimeRobot (ping /api/health).

const cron = require('node-cron');
const { batchSnapshot, getCurrentWeekStart } = require('./weeklyHours');
const { getFastsSnapshot } = require('./odrp4Auth');

const SENIOR_RANK = 'Старший Администратор';

// Получает список {steam64, tickets, realName} всех старших из публичного API.
// tickets — «за последние 7 дней» (server.tickets['7d']), пишется в снимок метрик
// недели при её закрытии (when='end'). realName нужен, чтобы сматчить фасты из
// odrp4 (там счёт по имени, не по steam64). Публичный эндпоинт (без auth).
async function getSeniorSteamIds() {
  try {
    const resp = await fetch('https://admin.unionteams.ru/api/v2/admins/list/4');
    if (!resp.ok) throw new Error(`staff api ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((a) => a?.server?.rang === SENIOR_RANK && a?.steam?.steam64_id && /^\d{17}$/.test(a.steam.steam64_id))
      .map((a) => ({
        steam64: a.steam.steam64_id,
        tickets: Number(a?.server?.tickets?.['7d']) || 0,
        realName: a?.server?.real_name || '',
      }));
  } catch (err) {
    console.error('[scheduler] getSeniorSteamIds error:', err.message);
    return [];
  }
}

// Один снимок: собираем старших, батчем дёргаем Livewire, сохраняем.
// items — массив {steam64, tickets, realName}; для when='end' полный снимок метрик.
// При закрытии недели реальные фасты из odrp4 переопределяют ручные из БД,
// чтобы прошлые недели показывали актуальный счёт фастов.
async function runSnapshot(when) {
  const items = await getSeniorSteamIds();
  if (items.length === 0) {
    console.log(`[scheduler] ${when}: нет старших для снимка`);
    return;
  }
  console.log(`[scheduler] ${when}: снимок для ${items.length} старших...`);

  let extraBy = {};
  if (when === 'end') {
    try {
      const seniors = items.map((it) => ({ steam64: it.steam64, realName: it.realName }));
      // eslint-disable-next-line no-await-in-loop
      extraBy = await getFastsSnapshot(seniors, getCurrentWeekStart());
      console.log(`[scheduler] ${when}: фасты из odrp4 для ${Object.keys(extraBy).length} старших`);
    } catch (err) {
      console.warn(`[scheduler] ${when}: не удалось получить фасты odrp4:`, err.message);
    }
  }

  const results = await batchSnapshot(items, when, null, 5, extraBy);
  const ok = results.filter((r) => r.ok).length;
  console.log(`[scheduler] ${when}: готово, успешно ${ok}/${results.length}`);
}

// Запуск cron-задач. Вызывать один раз после initDB.
function startScheduler() {
  // Пн 00:05 МСК — старт недели.
  cron.schedule('5 0 * * 1', () => {
    runSnapshot('start').catch((e) => console.error('[scheduler] start error:', e.message));
  }, { timezone: 'Europe/Moscow' });

  // Вс 23:55 МСК — финиш недели.
  cron.schedule('55 23 * * 0', () => {
    runSnapshot('end').catch((e) => console.error('[scheduler] end error:', e.message));
  }, { timezone: 'Europe/Moscow' });

  console.log('⏰ Scheduler запущен: пн 00:05 (start), вс 23:55 (end) МСК');
}

module.exports = { startScheduler, runSnapshot, getSeniorSteamIds };

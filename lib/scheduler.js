// ==========================================
// SCHEDULER — cron-задачи для недельных снимков часов старших
// ==========================================
// Делает два снимка общего наигранного времени в неделю:
//   - понедельник 00:05 МСК → старт недели (week_start_hours)
//   - воскресенье 23:55 МСК → финиш недели (week_end_hours), расчёт hours.
// Render free tier засыпает → держать живым через UptimeRobot (ping /api/health).

const cron = require('node-cron');
const { batchSnapshot } = require('./weeklyHours');
const { isAutoEnabled, refreshAndPersist } = require('./odrp4Auth');

const SENIOR_RANK = 'Старший Администратор';

// Получает список {steam64, tickets} всех старших из публичного API.
// tickets — «за последние 7 дней» (server.tickets['7d']), пишется в снимок метрик
// недели при её закрытии (when='end'). Использует публичный эндпоинт (без auth) —
// cron работает вне запроса.
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
      }));
  } catch (err) {
    console.error('[scheduler] getSeniorSteamIds error:', err.message);
    return [];
  }
}

// Один снимок: собираем старших, батчем дёргаем Livewire, сохраняем.
// items — массив {steam64, tickets}; для when='end' полный снимок метрик недели.
async function runSnapshot(when) {
  const items = await getSeniorSteamIds();
  if (items.length === 0) {
    console.log(`[scheduler] ${when}: нет старших для снимка`);
    return;
  }
  console.log(`[scheduler] ${when}: снимок для ${items.length} старших...`);
  const results = await batchSnapshot(items, when, null, 5);
  const ok = results.filter((r) => r.ok).length;
  console.log(`[scheduler] ${when}: готово, успешно ${ok}/${results.length}`);
}

// ==========================================
// odrp4.ru — авто-обновление session-токена
// ==========================================
// session-токен живёт ~7ч. Каждые 5ч прогоняем Steam OpenID и сохраняем свежий
// токен, чтобы прокси фастов (/api/seniors/fasts) работал без ручного ввода.
// Требуется env STEAM_LOGIN_SECURE. Если его нет — задача тихо пропускается.
async function runOdrp4Refresh() {
  if (!isAutoEnabled()) {
    return; // авто-режим выключен — ничего не делаем
  }
  try {
    const { expiresAt } = await refreshAndPersist();
    console.log(`[scheduler] odrp4: токен обновлён, истекает ${expiresAt.toISOString()}`);
  } catch (err) {
    console.error('[scheduler] odrp4 refresh failed:', err.message);
  }
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

  // Каждые 5 часов — авто-обновление токена odrp4 (5ч < 7ч жизни токена).
  if (isAutoEnabled()) {
    cron.schedule('0 */5 * * *', () => {
      runOdrp4Refresh().catch((e) => console.error('[scheduler] odrp4 cron error:', e.message));
    });
    // Стартовый прогон с отложкой — токен появляется сразу после старта сервера.
    setTimeout(() => {
      runOdrp4Refresh().catch((e) => console.error('[scheduler] odrp4 startup error:', e.message));
    }, 15000);
    console.log('⏰ Scheduler запущен: пн 00:05 (start), вс 23:55 (end) МСК, каждые 5ч (odrp4 auto)');
  } else {
    console.log('⏰ Scheduler запущен: пн 00:05 (start), вс 23:55 (end) МСК (odrp4 авто — выключен, нет STEAM_LOGIN_SECURE)');
  }
}

module.exports = { startScheduler, runSnapshot, getSeniorSteamIds, runOdrp4Refresh };

// ==========================================
// SENIORS PUBLIC — публичные роуты odrp4-авторизации
// ==========================================
// Эти роуты НЕ требуют JWT, потому что callback от Steam приходит без токена.
// Роутер монтируется в index.js ПОСЛЕ защищённого seniorRoutes,
// чтобы /fasts/auth, /fasts/callback, /fasts/status были доступны всем.
//
// Защищённый /fasts (запрос фастов) живёт в routes/seniors.js под authenticateToken.

const express = require('express');
const seniorRoutes = require('./seniors');

const router = express.Router();

// Helper-функции из основного роутера (общий доступ к БД-сессии odrp4).
const { ODRP4_BASE, getOdrp4Session, saveOdrp4Session, STEAM64_RE } = seniorRoutes.helpers;

// ==========================================
// GET /api/seniors/fasts/auth — начало Steam-авторизации на odrp4.ru
// Полностью server-side: бэкенд получает Steam OpenID URL у odrp4,
// подменяет return_to/realm на свой callback и возвращает URL для редиректа.
// ==========================================
router.get('/fasts/auth', async (req, res) => {
  try {
    const authRes = await fetch(`${ODRP4_BASE}/api/steam/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const authData = await authRes.json();

    if (!authData?.url) {
      return res.status(502).json({ error: 'Не удалось получить URL авторизации odrp4' });
    }

    // Подменяем return_to и realm, чтобы Steam вернулся к нам на callback.
    const backendUrl = (process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
    const callbackUrl = `${backendUrl}/api/seniors/fasts/callback`;

    const modifiedUrl = authData.url
      .replace(
        'openid.return_to=' + encodeURIComponent('https://odrp4.ru/api/steam/callback'),
        'openid.return_to=' + encodeURIComponent(callbackUrl)
      )
      .replace(
        'openid.realm=' + encodeURIComponent('https://odrp4.ru'),
        'openid.realm=' + encodeURIComponent(backendUrl)
      );

    res.json({ authUrl: modifiedUrl });
  } catch (err) {
    console.error('GET /api/seniors/fasts/auth error:', err.message);
    res.status(500).json({ error: err.message || 'Ошибка инициализации авторизации' });
  }
});

// ==========================================
// GET /api/seniors/fasts/callback — callback от Steam
// Steam возвращает OpenID-параметры. Бэкенд server-side отправляет их
// на odrp4 /api/steam/verify, получает sessionToken и сохраняет в БД.
// Возвращает HTML-страницу с результатом.
// ==========================================
router.get('/fasts/callback', async (req, res) => {
  try {
    // Шаг 1: server-side verify на odrp4 — передаём все параметры Steam OpenID.
    const verifyRes = await fetch(`${ODRP4_BASE}/api/steam/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.query),
    });

    const verifyData = await verifyRes.json();

    if (!verifyData?.ok || !verifyData.sessionToken) {
      console.error('odrp4 verify failed:', verifyData);
      return sendHtml(res, 502, '❌ Ошибка авторизации на odrp4.ru',
        verifyData?.error || 'Не получен sessionToken. Попробуйте ещё раз из приложения.');
    }

    // Шаг 2: сохраняем sessionToken в БД.
    await saveOdrp4Session(
      verifyData.sessionToken,
      verifyData.user?.steam64 || null
    );

    // Шаг 3: успех + авто-закрытие вкладки.
    sendHtml(res, 200, '✅ Сессия odrp4.ru сохранена!',
      'Теперь фасты наборщиков будут подтягиваться автоматически. Можно закрыть вкладку.',
      true);
  } catch (err) {
    console.error('GET /api/seniors/fasts/callback error:', err.message);
    sendHtml(res, 500, '❌ Ошибка', err.message);
  }
});

// ==========================================
// GET /api/seniors/fasts/status — статус сессии odrp4 (без раскрытия токена)
// ==========================================
router.get('/fasts/status', async (req, res) => {
  try {
    const session = await getOdrp4Session();
    res.json({ connected: !!session });
  } catch (err) {
    res.json({ connected: false });
  }
});

/**
 * Отдаёт простую HTML-страницу с результатом авторизации.
 * autoClose — закрыть вкладку через 2 сек (на успехе).
 */
function sendHtml(res, status, title, message, autoClose = false) {
  const color = status >= 400 ? 'red' : 'green';
  const close = autoClose ? '<script>setTimeout(function(){ window.close(); }, 2000);</script>' : '';
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <html><head><meta charset="utf-8"><title>Авторизация odrp4</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px">
    <h2 style="color:${color}">${title}</h2>
    <p>${message}</p>
    ${close}
    </body></html>
  `);
}

module.exports = router;

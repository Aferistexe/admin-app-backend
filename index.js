const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

dotenv.config();

const { initDB } = require('./db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admins');
const teamRoutes = require('./routes/team');
const usersRoutes = require('./routes/users');
const { authenticateToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);

// ✅ ВРЕМЕННО: разрешаем все CORS запросы
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: 'Слишком много запросов, попробуйте позже',
});
app.use('/api/', limiter);

initDB();

// ========== Эндпоинт для получения аватара из Steam ==========
app.get('/api/steam/avatar/:steamid', async (req, res) => {
  const { steamid } = req.params;
  const STEAM_API_KEY = process.env.STEAM_API_KEY;
  
  if (!STEAM_API_KEY) {
    return res.status(500).json({ error: 'Steam API key not configured' });
  }
  
  try {
    const response = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamid}`);
    const data = await response.json();
    
    if (data?.response?.players?.[0]?.avatarmedium) {
      res.json({ avatar: data.response.players[0].avatarmedium });
    } else {
      res.status(404).json({ error: 'Avatar not found' });
    }
  } catch (error) {
    console.error('Steam API error:', error);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ========== Эндпоинт для отправки в Discord (безопасно) ==========
app.post('/api/discord/send', async (req, res) => {
  const { message, username = 'Система' } = req.body;
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  
  if (!DISCORD_WEBHOOK_URL) {
    return res.status(500).json({ error: 'Discord webhook not configured' });
  }
  
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Пустое сообщение' });
  }
  
  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username,
        content: message,
        allowed_mentions: { parse: ['users', 'roles'] }
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Discord error: ${response.status}`);
    }
    
    res.json({ success: true, message: 'Отправлено в Discord' });
  } catch (error) {
    console.error('Discord send error:', error);
    res.status(500).json({ error: error.message || 'Ошибка отправки в Discord' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admins', authenticateToken, adminRoutes);
app.use('/api/team', authenticateToken, teamRoutes);
app.use('/api/users', authenticateToken, usersRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
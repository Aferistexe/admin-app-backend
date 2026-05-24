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
  windowMs: 15 * 60 * 1000,
  max: 100,
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
    // Используем fetch (доступен в Node 18+)
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
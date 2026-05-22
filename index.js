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

// ⚠️ ВАЖНО: доверять прокси (для rate-limit на Render)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://admin-app-frontend.vercel.app'
  ],
  credentials: true,
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Слишком много запросов, попробуйте позже',
});
app.use('/api/', limiter);

// Инициализация БД (асинхронная)
initDB();

// Маршруты
app.use('/api/auth', authRoutes);
app.use('/api/admins', authenticateToken, adminRoutes);
app.use('/api/team', authenticateToken, teamRoutes);
app.use('/api/users', usersRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 обработчик
app.use((req, res) => {
  res.status(404).json({ error: 'Маршрут не найден' });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
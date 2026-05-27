const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const csrf = require('csurf');
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

// ========================
// 1. БЕЗОПАСНАЯ КОНФИГУРАЦИЯ CORS
// ========================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,https://adminpanel.myarena.site').split(',');

const corsOptions = {
    origin: function(origin, callback) {
        // Разрешить запросы без origin (из мобильных приложений, curl и т.д.)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            console.log(`Blocked CORS from: ${origin}`);
            callback(new Error('Не разрешено CORS политикой'));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'CSRF-Token', 'X-CSRF-Token']
};

// ========================
// 2. MIDDLEWARE (порядок ВАЖЕН!)
// ========================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https://steamcdn-a.akamaihd.net", "https://avatars.steamstatic.com"],
            connectSrc: ["'self'", "https://api.steampowered.com", "https://discord.com"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
        },
    },
}));

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ========================
// 3. БЕЗОПАСНАЯ СЕССИЯ (необходима для CSRF)
// ========================
app.use(session({
    secret: process.env.SESSION_SECRET || 'default-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'sessionId',
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 часа
    }
}));

// ========================
// 4. CSRF ЗАЩИТА
// ========================
const csrfProtection = csrf({ 
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        key: 'csrfToken'
    }
});

// Эндпоинт для получения CSRF токена (доступен всем)
app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

// ========================
// 5. GLOBAL RATE LIMITING
// ========================
const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 200,
    message: 'Слишком много запросов, попробуйте позже',
    standardHeaders: true,
    legacyHeaders: false,
});

const sensitiveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Слишком много запросов. Попробуйте через 15 минут.',
    skipSuccessfulRequests: true,
});

app.use('/api/', globalLimiter);

// ========================
// 6. ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ
// ========================
initDB();

// ========================
// 7. HEALTH CHECK (без защиты)
// ========================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// ========================
// 8. STEAM API (защищённый)
// ========================
// ========================
// 8. STEAM API (с запасным вариантом без ключа)
// ========================
app.get('/api/steam/avatar/:steamid', 
    authenticateToken,
    async (req, res) => {
        const { steamid } = req.params;
        const STEAM_API_KEY = process.env.STEAM_API_KEY;
        
        // Валидация steamid
        if (!steamid || steamid.length < 10 || steamid.length > 20) {
            return res.status(400).json({ error: 'Invalid Steam ID format' });
        }
        
        // ✅ Если ключа нет — используем прямой URL (без API)
        if (!STEAM_API_KEY) {
            console.log(`⚠️ Steam API key not configured, using direct URL for ${steamid}`);
            
            // Прямой URL аватарки Steam (работает без ключа!)
            const avatarUrl = `https://avatars.steamstatic.com/${steamid}_medium.jpg`;
            
            // Проверяем, существует ли аватар (опционально)
            try {
                const checkResponse = await fetch(avatarUrl, { method: 'HEAD' });
                if (checkResponse.ok) {
                    return res.json({ avatar: avatarUrl });
                } else {
                    // Стандартная аватарка, если пользователь не найден
                    return res.json({ avatar: 'https://avatars.steamstatic.com/default_avatar_medium.jpg' });
                }
            } catch (error) {
                // В случае ошибки — возвращаем стандартную аватарку
                return res.json({ avatar: 'https://avatars.steamstatic.com/default_avatar_medium.jpg' });
            }
        }
        
        // ✅ Если ключ есть — используем официальное API
        try {
            const response = await fetch(
                `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamid}`
            );
            const data = await response.json();
            
            if (data?.response?.players?.[0]?.avatarmedium) {
                res.json({ avatar: data.response.players[0].avatarmedium });
            } else {
                // Fallback на прямой URL
                const fallbackUrl = `https://avatars.steamstatic.com/${steamid}_medium.jpg`;
                res.json({ avatar: fallbackUrl });
            }
        } catch (error) {
            console.error('Steam API error:', error);
            // Fallback на прямой URL при ошибке API
            const fallbackUrl = `https://avatars.steamstatic.com/${steamid}_medium.jpg`;
            res.json({ avatar: fallbackUrl });
        }
    }
);

// ========================
// 9. DISCORD WEBHOOK (защищённый)
// ========================
app.post('/api/discord/send', 
    authenticateToken,
    csrfProtection,
    sensitiveLimiter,
    async (req, res) => {
        const { message, username = 'Система', avatar_url } = req.body;
        const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
        
        if (!DISCORD_WEBHOOK_URL) {
            return res.status(500).json({ error: 'Discord webhook not configured' });
        }
        
        // Валидация сообщения
        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Пустое сообщение' });
        }
        
        if (message.length > 2000) {
            return res.status(400).json({ error: 'Сообщение слишком длинное (макс. 2000 символов)' });
        }
        
        // Защита от упоминаний @everyone и @here
        const sanitizedMessage = message
            .replace(/@everyone/g, '@everyone\u200B')
            .replace(/@here/g, '@here\u200B');
        
        try {
            const payload = {
                username: username.substring(0, 32),
                content: sanitizedMessage.substring(0, 2000),
                allowed_mentions: { parse: [] } // Отключаем упоминания
            };
            
            if (avatar_url && avatar_url.startsWith('https://')) {
                payload.avatar_url = avatar_url;
            }
            
            const response = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
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
    }
);

// ========================
// 10. ЗАЩИЩЁННЫЕ РОУТЫ
// ========================
app.use('/api/auth', authRoutes);
app.use('/api/admins', authenticateToken, csrfProtection, adminRoutes);
app.use('/api/team', authenticateToken, csrfProtection, teamRoutes);
app.use('/api/users', authenticateToken, csrfProtection, usersRoutes);

// ========================
// 11. ОБРАБОТЧИКИ ОШИБОК
// ========================

// Обработка CSRF ошибок
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        console.warn('CSRF token validation failed:', req.method, req.path);
        return res.status(403).json({ error: 'Неверный CSRF токен. Обновите страницу и попробуйте снова.' });
    }
    next(err);
});

// 404 - маршрут не найден
app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

// Глобальная обработка ошибок
app.use((err, req, res, next) => {
    console.error('Server error:', {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        url: req.url,
        method: req.method
    });
    
    const message = process.env.NODE_ENV === 'production' 
        ? 'Внутренняя ошибка сервера' 
        : err.message;
    
    res.status(500).json({ error: message });
});

// ========================
// 12. ЗАПУСК СЕРВЕРА
// ========================
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`🌍 Режим: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔒 CSRF защита: Включена`);
    console.log(`🍪 Cookie security: ${process.env.NODE_ENV === 'production' ? 'Secure' : 'Development'}`);
});

module.exports = app;

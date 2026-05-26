const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');

dotenv.config();

const { initDB, getUserById, updatePassword, updateEmail } = require('./db');
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
const allowedOrigins = [
    'https://adminpanel.myarena.site',
    'https://myarena.site',
    'http://localhost:3000'  // для разработки (убрать в production)
];

const corsOptions = {
    origin: function(origin, callback) {
        // Разрешить запросы без origin (например, из мобильных приложений)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            callback(new Error('Не разрешено CORS политикой'));
        }
    },
    credentials: true,  // Разрешить отправку cookies
    optionsSuccessStatus: 200,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'CSRF-Token']
};

// ========================
// 2. MIDDLEWARE (порядок важен!)
// ========================
app.use(helmet());  // Защита HTTP заголовков

// Настройка Content Security Policy
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],  // Убрать 'unsafe-inline' в production
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https://steamcdn-a.akamaihd.net", "https://avatars.steamstatic.com"],
            connectSrc: ["'self'", "https://api.steampowered.com", "https://discord.com"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
        },
    })
);

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ========================
// 3. БЕЗОПАСНАЯ СЕССИЯ
// ========================
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-super-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',  // HTTPS только в production
        httpOnly: true,   // Защита от XSS
        sameSite: 'strict', // Защита от CSRF
        maxAge: 24 * 60 * 60 * 1000  // 24 часа
    }
}));

// ========================
// 4. CSRF ЗАЩИТА
// ========================
const csrfProtection = csrf({ 
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    }
});

// Эндпоинт для получения CSRF токена
app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

// ========================
// 5. RATE LIMITING
// ========================
const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 минут
    max: 200,
    message: 'Слишком много запросов, попробуйте позже',
    standardHeaders: true,
    legacyHeaders: false,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5,
    message: 'Слишком много попыток входа. Попробуйте через 15 минут.',
    skipSuccessfulRequests: true,
});

const discordLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 5,
    message: 'Слишком много запросов в Discord. Подождите минуту.',
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
        environment: process.env.NODE_ENV
    });
});

// ========================
// 8. STEAM API (защищённый)
// ========================
app.get('/api/steam/avatar/:steamid', 
    authenticateToken,
    async (req, res) => {
        const { steamid } = req.params;
        const STEAM_API_KEY = process.env.STEAM_API_KEY;
        
        if (!STEAM_API_KEY) {
            return res.status(500).json({ error: 'Steam API key not configured' });
        }
        
        // Валидация steamid
        if (!steamid || steamid.length < 10) {
            return res.status(400).json({ error: 'Invalid Steam ID' });
        }
        
        try {
            const response = await fetch(
                `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamid}`
            );
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
    }
);

// ========================
// 9. DISCORD WEBHOOK (защищённый)
// ========================
app.post('/api/discord/send', 
    authenticateToken,
    csrfProtection,
    discordLimiter,
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
        
        try {
            const payload = {
                username: username.substring(0, 32), // Discord лимит
                content: message.substring(0, 2000),
                allowed_mentions: { parse: [] } // Отключаем упоминания для безопасности
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
// 10. СМЕНА EMAIL (защищённый)
// ========================
app.post('/api/user/email',
    authenticateToken,
    csrfProtection,
    async (req, res) => {
        const { email } = req.body;
        const userId = req.user.id;
        
        // Валидация email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) {
            return res.status(400).json({ error: 'Неверный формат email' });
        }
        
        try {
            // Проверка, не занят ли email
            const existingUser = await getUserByEmail(email);
            if (existingUser && existingUser.id !== userId) {
                return res.status(409).json({ error: 'Email уже используется' });
            }
            
            await updateEmail(userId, email);
            
            // Отправить уведомление на старый email
            await sendEmailNotification(req.user.email, 'Email изменён', `Ваш email изменён на ${email}`);
            
            res.json({ success: true, message: 'Email успешно изменён' });
        } catch (error) {
            console.error('Email change error:', error);
            res.status(500).json({ error: 'Ошибка изменения email' });
        }
    }
);

// ========================
// 11. СМЕНА ПАРОЛЯ (защищённый)
// ========================
app.post('/api/auth/change-password',
    authenticateToken,
    csrfProtection,
    authLimiter,
    async (req, res) => {
        const { old_password, new_password } = req.body;
        const userId = req.user.id;
        
        // Валидация пароля
        if (!old_password || !new_password) {
            return res.status(400).json({ error: 'Все поля обязательны' });
        }
        
        if (new_password.length < 8) {
            return res.status(400).json({ error: 'Новый пароль должен быть не менее 8 символов' });
        }
        
        if (new_password.length > 128) {
            return res.status(400).json({ error: 'Пароль слишком длинный' });
        }
        
        try {
            // 1. Получить пользователя с текущим паролем
            const user = await getUserById(userId);
            if (!user) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
            
            // 2. Проверить старый пароль
            const isValid = await bcrypt.compare(old_password, user.password_hash);
            if (!isValid) {
                return res.status(401).json({ error: 'Неверный текущий пароль' });
            }
            
            // 3. Проверить, не совпадает ли новый пароль со старым
            const isSame = await bcrypt.compare(new_password, user.password_hash);
            if (isSame) {
                return res.status(400).json({ error: 'Новый пароль должен отличаться от текущего' });
            }
            
            // 4. Хешировать новый пароль
            const newHash = await bcrypt.hash(new_password, 10);
            
            // 5. Обновить пароль
            await updatePassword(userId, newHash);
            
            // 6. Отправить уведомление
            await sendEmailNotification(user.email, 'Пароль изменён', 
                'Ваш пароль был успешно изменён. Если это были не вы, немедленно свяжитесь с поддержкой.'
            );
            
            res.json({ success: true, message: 'Пароль успешно изменён' });
        } catch (error) {
            console.error('Password change error:', error);
            res.status(500).json({ error: 'Ошибка изменения пароля' });
        }
    }
);

// ========================
// 12. ЗАЩИЩЁННЫЕ РОУТЫ
// ========================
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admins', authenticateToken, csrfProtection, adminRoutes);
app.use('/api/team', authenticateToken, csrfProtection, teamRoutes);
app.use('/api/users', authenticateToken, csrfProtection, usersRoutes);

// ========================
// 13. ОБРАБОТКА ОШИБОК
// ========================

// Обработка CSRF ошибок
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({ error: 'Неверный CSRF токен' });
    }
    next(err);
});

// 404 - маршрут не найден
app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

// Глобальная обработка ошибок
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    console.error(err.stack);
    
    // Не показываем детали ошибки в production
    const message = process.env.NODE_ENV === 'production' 
        ? 'Внутренняя ошибка сервера' 
        : err.message;
    
    res.status(500).json({ error: message });
});

// ========================
// 14. ЗАПУСК СЕРВЕРА
// ========================
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    console.log(`🌍 Режим: ${process.env.NODE_ENV || 'development'}`);
});

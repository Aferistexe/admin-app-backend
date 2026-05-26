const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// ==========================================
// ЛОГИН
// ==========================================

/**
 * POST /api/auth/login
 * Вход в систему, возвращает JWT токен
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDB();

  // Валидация входных данных
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  try {
    // Поиск пользователя в БД
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    // Проверка пароля
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    // Создание JWT токена
    const accessToken = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Отправка ответа
    res.json({
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==========================================
// ПРОВЕРКА ТОКЕНА (НОВЫЙ ЭНДПОИНТ!)
// ==========================================

/**
 * GET /api/auth/verify
 * Проверяет валидность JWT токена
 * Требует заголовок Authorization: Bearer <token>
 */
router.get('/verify', authenticateToken, (req, res) => {
  // Если middleware authenticateToken пропустил запрос — токен валиден
  res.json({ 
    valid: true, 
    user: { 
      id: req.user.id, 
      username: req.user.username,
      role: req.user.role,
      name: req.user.name
    } 
  });
});

// ==========================================
// РЕГИСТРАЦИЯ
// ==========================================

/**
 * POST /api/auth/register
 * Регистрация нового пользователя
 */
router.post('/register', async (req, res) => {
  const { username, email, password, name, role } = req.body;
  const db = getDB();

  // Валидация
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  if (username.length < 3) {
    return res.status(400).json({ error: 'Логин должен быть не менее 3 символов' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
  }

  try {
    // Проверка существования пользователя
    const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    }

    // Хеширование пароля
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Создание пользователя
    const newUserRole = role || 'user';
    const newUserName = name || username;
    const newUserEmail = email || `${username}@local.com`;
    
    await db.query(
      `INSERT INTO users (username, email, password_hash, name, role) 
       VALUES ($1, $2, $3, $4, $5)`,
      [username, newUserEmail, passwordHash, newUserName, newUserRole]
    );

    // Успешный ответ
    res.status(201).json({ 
      message: 'Пользователь создан',
      user: { 
        username, 
        name: newUserName, 
        role: newUserRole 
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка создания пользователя' });
  }
});

// ==========================================
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТЕКУЩЕМ ПОЛЬЗОВАТЕЛЕ
// ==========================================

/**
 * GET /api/auth/me
 * Возвращает информацию о текущем авторизованном пользователе
 */
router.get('/me', authenticateToken, async (req, res) => {
  const db = getDB();
  
  try {
    const result = await db.query(
      'SELECT id, username, name, role, email, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==========================================
// СМЕНА ПАРОЛЯ
// ==========================================

/**
 * POST /api/auth/change-password
 * Смена пароля текущего пользователя
 */
router.post('/change-password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const db = getDB();
  const userId = req.user.id;

  // Валидация
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароль обязательны' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не менее 6 символов' });
  }

  try {
    // Получаем текущий хеш пароля
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем старый пароль
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный старый пароль' });
    }

    // Хешируем новый пароль
    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    
    // Обновляем пароль
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, userId]);

    res.json({ message: 'Пароль успешно изменён' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
<<<<<<< HEAD
const rateLimit = require('express-rate-limit');
const { getDB, logAction } = require('../db');
=======
const { getDB } = require('../db');
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// ==========================================
<<<<<<< HEAD
// RATE LIMITING ДЛЯ ЛОГИНА
// ==========================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// ==========================================
// 🚪 ЛОГИН (с защитой от brute force)
// ==========================================
router.post('/login', loginLimiter, async (req, res) => {
=======
// ЛОГИН (доступен всем)
// ==========================================

router.post('/login', async (req, res) => {
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
  const { username, password } = req.body;
  const db = getDB();
  const ipAddress = req.ip;
  const userAgent = req.get('User-Agent');

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      await logAction(null, 'login_failed', 'user', null, { username, reason: 'user_not_found' }, ipAddress, userAgent);
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    // Проверка блокировки аккаунта
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      await logAction(user.id, 'login_blocked', 'user', user.id, { reason: 'account_locked' }, ipAddress, userAgent);
      return res.status(423).json({ 
        error: `Аккаунт заблокирован. Попробуйте через ${minutesLeft} минут.` 
      });
    }

    // Проверка активности
    if (!user.is_active) {
      await logAction(user.id, 'login_failed', 'user', user.id, { reason: 'account_inactive' }, ipAddress, userAgent);
      return res.status(403).json({ error: 'Аккаунт деактивирован' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      const newAttempts = (user.login_attempts || 0) + 1;
      const lockedUntil = newAttempts >= 5 
        ? new Date(Date.now() + 15 * 60 * 1000)
        : null;

      await db.query(
        'UPDATE users SET login_attempts = $1, locked_until = $2 WHERE id = $3',
        [newAttempts, lockedUntil, user.id]
      );

      await logAction(user.id, 'login_failed', 'user', user.id, { 
        attempts: newAttempts, 
        locked: !!lockedUntil 
      }, ipAddress, userAgent);

      return res.status(401).json({ 
        error: lockedUntil 
          ? `Неверный пароль. Аккаунт заблокирован на 15 минут.`
          : `Неверный пароль. Осталось попыток: ${5 - newAttempts}`
      });
    }

<<<<<<< HEAD
    // Успешный вход — сбрасываем счётчик
    await db.query(
      'UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
=======
    const accessToken = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
    );

    // Генерируем токены
    const accessToken = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Сохраняем refresh token в БД
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        refreshToken,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ipAddress,
        userAgent
      ]
    );

    await logAction(user.id, 'login_success', 'user', user.id, null, ipAddress, userAgent);

    res.json({
      accessToken,
      refreshToken,
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
<<<<<<< HEAD
// 🔄 ОБНОВЛЕНИЕ ACCESS TOKEN (с rotation)
// ==========================================
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  const db = getDB();

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const tokenResult = await db.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND revoked = FALSE AND expires_at > NOW()',
      [refreshToken]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const userResult = await db.query(
      'SELECT id, username, name, role, email FROM users WHERE id = $1 AND is_active = TRUE',
      [decoded.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const user = userResult.rows[0];

    // Генерируем новый access token
    const newAccessToken = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Rotation: создаем новый refresh token
    const newRefreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Отзываем старый refresh token
    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1',
      [refreshToken]
    );

    // Сохраняем новый refresh token
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        newRefreshToken,
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        req.ip,
        req.get('User-Agent')
      ]
    );

    res.json({ 
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired' });
    }
    console.error('Refresh error:', err);
    res.status(401).json({ error: 'Invalid refresh token' });
=======
// ПРОВЕРКА ТОКЕНА
// ==========================================

router.get('/verify', authenticateToken, (req, res) => {
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
// ✅ РЕГИСТРАЦИЯ (ТОЛЬКО ДЛЯ АДМИНОВ)
// ==========================================

router.post('/register', 
  authenticateToken,      // 1. Проверяем, что есть токен
  checkRole(['admin']),   // 2. Проверяем, что роль = admin
  async (req, res) => {
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

      const passwordHash = await bcrypt.hash(password, 10);
      
      // 🔒 Безопасность: не даём создать админа через API
      const newRole = (role === 'admin') ? 'user' : (role || 'user');
      const newUserName = name || username;
      const newUserEmail = email || `${username}@local.com`;
      
      await db.query(
        `INSERT INTO users (username, email, password_hash, name, role) 
         VALUES ($1, $2, $3, $4, $5)`,
        [username, newUserEmail, passwordHash, newUserName, newRole]
      );

      res.status(201).json({ 
        message: 'Пользователь создан',
        user: { 
          username, 
          name: newUserName, 
          role: newRole 
        }
      });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Ошибка создания пользователя' });
    }
  }
);

// ==========================================
// ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТЕКУЩЕМ ПОЛЬЗОВАТЕЛЕ
// ==========================================

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
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
  }
});

// ==========================================
<<<<<<< HEAD
// 🚪 LOGOUT (отзыв refresh token)
// ==========================================
router.post('/logout', authenticateToken, async (req, res) => {
  const { refreshToken } = req.body;
  const db = getDB();

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1 AND user_id = $2',
      [refreshToken, req.user.id]
    );

    await logAction(req.user.id, 'logout', 'user', req.user.id, null, req.ip, req.get('User-Agent'));

    res.json({ message: 'Выход выполнен' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Ошибка выхода' });
  }
});

// ==========================================
// 🔐 СМЕНА ПАРОЛЯ
// ==========================================
router.post('/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const db = getDB();

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Текущий и новый пароль обязательны' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
  }

  try {
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      await logAction(req.user.id, 'password_change_failed', 'user', req.user.id, { reason: 'wrong_current_password' }, req.ip, req.get('User-Agent'));
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

    // Отзываем все refresh токены (требуется повторный вход)
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [req.user.id]);

    await logAction(req.user.id, 'password_changed', 'user', req.user.id, null, req.ip, req.get('User-Agent'));

    res.json({ message: 'Пароль изменён. Требуется повторный вход.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Ошибка смены пароля' });
  }
});

// ==========================================
// ✅ РЕГИСТРАЦИЯ (ТОЛЬКО ДЛЯ АДМИНОВ)
// ==========================================
router.post('/register', 
  authenticateToken,
  checkRole(['admin']),
  async (req, res) => {
    const { username, email, password, name, role } = req.body;
    const db = getDB();

    if (!username || !password) {
      return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Логин должен быть минимум 3 символа' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    // Валидация email
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }

    try {
      const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const newRole = role === 'admin' ? 'user' : (role || 'user');
      
      const result = await db.query(
        `INSERT INTO users (username, email, password_hash, name, role) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [username, email, passwordHash, name || username, newRole]
      );

      await logAction(req.user.id, 'user_created', 'user', result.rows[0].id, { new_username: username, new_role: newRole }, req.ip, req.get('User-Agent'));

      res.status(201).json({ 
        message: 'Пользователь создан',
        user: { username, name: name || username, role: newRole }
      });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Ошибка создания пользователя' });
    }
  }
);

// ==========================================
// ✅ ПРОВЕРКА ТОКЕНА
// ==========================================
router.get('/verify', authenticateToken, (req, res) => {
  res.json({ 
    valid: true, 
    user: { 
      id: req.user.id, 
      username: req.user.username,
      role: req.user.role 
    } 
  });
});

// ==========================================
// ✅ ИНФОРМАЦИЯ О ТЕКУЩЕМ ПОЛЬЗОВАТЕЛЕ
// ==========================================
router.get('/me', authenticateToken, async (req, res) => {
  const db = getDB();
  
  try {
    const result = await db.query(
      'SELECT id, username, name, role, email, created_at, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
=======
// СМЕНА ПАРОЛЯ
// ==========================================

router.post('/change-password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const db = getDB();
  const userId = req.user.id;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароль обязательны' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не менее 6 символов' });
  }

  try {
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Неверный старый пароль' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, userId]);

    res.json({ message: 'Пароль успешно изменён' });
  } catch (err) {
    console.error('Change password error:', err);
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==========================================
<<<<<<< HEAD
// ✅ СПИСОК ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только для админов)
// ==========================================
=======
// ✅ СПИСОК ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только админы)
// ==========================================

>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
router.get('/users', 
  authenticateToken,
  checkRole(['admin']),
  async (req, res) => {
    const db = getDB();
    
    try {
      const result = await db.query(
<<<<<<< HEAD
        'SELECT id, username, name, role, email, created_at, last_login, is_active, login_attempts FROM users ORDER BY id'
=======
        'SELECT id, username, name, role, email, created_at FROM users ORDER BY id'
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
      );
      
      res.json({ users: result.rows });
    } catch (err) {
      console.error('Get users error:', err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ==========================================
<<<<<<< HEAD
// ✅ УДАЛЕНИЕ ПОЛЬЗОВАТЕЛЯ (только для админов)
// ==========================================
=======
// ✅ УДАЛЕНИЕ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
router.delete('/users/:id',
  authenticateToken,
  checkRole(['admin']),
  async (req, res) => {
    const { id } = req.params;
    const db = getDB();
    
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }
    
    try {
<<<<<<< HEAD
      // Получаем информацию о пользователе перед удалением
      const userResult = await db.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
      
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const userToDelete = userResult.rows[0];

      // Проверка: нельзя удалить последнего админа
      if (userToDelete.role === 'admin') {
        const adminCount = await db.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
        if (parseInt(adminCount.rows[0].count) <= 1) {
          return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
        }
      }

      const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id, username', [id]);
      
      await logAction(req.user.id, 'user_deleted', 'user', parseInt(id), { deleted_username: result.rows[0].username }, req.ip, req.get('User-Agent'));
=======
      const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3
      
      res.json({ message: 'Пользователь удалён' });
    } catch (err) {
      console.error('Delete user error:', err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

<<<<<<< HEAD
module.exports = router;
=======
module.exports = router;
>>>>>>> 4bf7ee65154b3ddaea9f07427f0fe342a11143f3

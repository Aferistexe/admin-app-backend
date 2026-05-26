const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// ==========================================
// ЛОГИН (доступен всем)
// ==========================================

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDB();

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

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
// ✅ РЕГИСТРАЦИЯ (ТОЛЬКО ДЛЯ АДМИНОВ)
// ==========================================

/**
 * POST /api/auth/register
 * 🔐 ТОЛЬКО ДЛЯ ПОЛЬЗОВАТЕЛЕЙ С РОЛЬЮ "admin"
 * Создаёт нового пользователя
 */
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
      return res.status(400).json({ error: 'Логин должен быть минимум 3 символа' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    try {
      // Проверка существования пользователя
      const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      
      // Разрешаем создать пользователя с любой ролью (кроме admin, для безопасности)
      const newRole = role === 'admin' ? 'user' : (role || 'user');
      
      await db.query(
        `INSERT INTO users (username, email, password_hash, name, role) 
         VALUES ($1, $2, $3, $4, $5)`,
        [username, email || `${username}@local.com`, passwordHash, name || username, newRole]
      );

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
// ✅ ПРОВЕРКА ТОКЕНА (для клиента)
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
// ✅ СПИСОК ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только для админов)
// ==========================================

router.get('/users', 
  authenticateToken,
  checkRole(['admin']),
  async (req, res) => {
    const db = getDB();
    
    try {
      const result = await db.query(
        'SELECT id, username, name, role, email, created_at FROM users ORDER BY id'
      );
      
      res.json({ users: result.rows });
    } catch (err) {
      console.error('Get users error:', err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

// ==========================================
// ✅ УДАЛЕНИЕ ПОЛЬЗОВАТЕЛЯ (только для админов)
// ==========================================

router.delete('/users/:id',
  authenticateToken,
  checkRole(['admin']),
  async (req, res) => {
    const { id } = req.params;
    const db = getDB();
    
    // Не даём удалить самого себя
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }
    
    try {
      const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      
      res.json({ message: 'Пользователь удалён' });
    } catch (err) {
      console.error('Delete user error:', err);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }
);

module.exports = router;

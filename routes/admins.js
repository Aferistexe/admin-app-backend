const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// ==========================================
// ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только админы)
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
      res.status(500).json({ error: 'Ошибка загрузки пользователей' });
    }
  }
);

// ==========================================
// СОЗДАТЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.post('/users', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { username, email, password, name, role } = req.body;
    const db = getDB();

    // ✅ Валидация
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
      // ✅ Проверка существования пользователя
      const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      
      // ✅ Безопасность: не даём создать админа через API
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
        user: { username, name: newUserName, role: newRole }
      });
    } catch (err) {
      console.error('Create user error:', err);
      res.status(500).json({ error: 'Ошибка создания пользователя' });
    }
  }
);

// ==========================================
// СМЕНИТЬ ПАРОЛЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.put('/users/:id/password', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const db = getDB();

    // ✅ Валидация пароля
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    try {
      // ✅ Проверка, существует ли пользователь
      const userExists = await db.query('SELECT id FROM users WHERE id = $1', [id]);
      if (userExists.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);

      res.json({ message: 'Пароль успешно изменён' });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ error: 'Ошибка смены пароля' });
    }
  }
);

// ==========================================
// УДАЛИТЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.delete('/users/:id', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const db = getDB();

    // ✅ Не даём удалить самого себя
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }

    // ✅ Не даём удалить главного админа (опционально)
    if (parseInt(id) === 1) {
      return res.status(403).json({ error: 'Нельзя удалить главного администратора' });
    }

    try {
      const result = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      res.json({ message: 'Пользователь удалён' });
    } catch (err) {
      console.error('Delete user error:', err);
      res.status(500).json({ error: 'Ошибка удаления пользователя' });
    }
  }
);

// ==========================================
// ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ ПО ID (только админы)
// ==========================================

router.get('/users/:id', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const db = getDB();

    try {
      const result = await db.query(
        'SELECT id, username, name, role, email, created_at FROM users WHERE id = $1',
        [id]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      res.json({ user: result.rows[0] });
    } catch (err) {
      console.error('Get user error:', err);
      res.status(500).json({ error: 'Ошибка загрузки пользователя' });
    }
  }
);

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// ==========================================
// ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ (только админы)
// ==========================================

router.get('/', 
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
      console.error('GET /api/users error:', err);
      res.status(500).json({ error: 'Ошибка загрузки пользователей' });
    }
  }
);

// ==========================================
// УДАЛИТЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.delete('/:id', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const db = getDB();

    // ✅ Не даём удалить самого себя
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }

    // ✅ Не даём удалить главного админа (id=1)
    if (parseInt(id) === 1) {
      return res.status(403).json({ error: 'Нельзя удалить главного администратора' });
    }

    try {
      // ✅ Проверяем, существует ли пользователь, и удаляем
      const result = await db.query(
        'DELETE FROM users WHERE id = $1 AND username != $2 RETURNING id',
        [id, 'admin']
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      res.json({ message: 'Пользователь удалён' });
    } catch (err) {
      console.error('DELETE /api/users error:', err);
      res.status(500).json({ error: 'Ошибка удаления пользователя' });
    }
  }
);

// ==========================================
// СМЕНИТЬ ПАРОЛЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.put('/:id/password', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const db = getDB();

    // ✅ Более строгая валидация пароля
    if (!password) {
      return res.status(400).json({ error: 'Пароль обязателен' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    // ✅ Проверка на сложность пароля (опционально)
    if (password === '123456' || password === 'password' || password === 'qwerty') {
      return res.status(400).json({ error: 'Слишком простой пароль' });
    }

    try {
      // ✅ Сначала проверяем, существует ли пользователь
      const userExists = await db.query('SELECT id FROM users WHERE id = $1', [id]);
      if (userExists.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
      
      res.json({ message: 'Пароль успешно изменён' });
    } catch (err) {
      console.error('PUT /api/users/password error:', err);
      res.status(500).json({ error: 'Ошибка смены пароля' });
    }
  }
);

// ==========================================
// ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ ПО ID (только админы)
// ==========================================

router.get('/:id', 
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
      console.error('GET /api/users/:id error:', err);
      res.status(500).json({ error: 'Ошибка загрузки пользователя' });
    }
  }
);

// ==========================================
// СОЗДАТЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================

router.post('/', 
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
      // ✅ Проверка существования
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
      console.error('POST /api/users error:', err);
      res.status(500).json({ error: 'Ошибка создания пользователя' });
    }
  }
);

module.exports = router;

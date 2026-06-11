const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB, logAction } = require('../db');
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
        'SELECT id, username, name, role, email, created_at, last_login, is_active FROM users ORDER BY id'
      );
      res.json({ users: result.rows });
    } catch (err) {
      console.error('GET /api/users error:', err);
      res.status(500).json({ error: 'Ошибка загрузки пользователей' });
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

    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    try {
      const result = await db.query(
        'SELECT id, username, name, role, email, created_at, last_login, is_active FROM users WHERE id = $1',
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

    if (!username || !password) {
      return res.status(400).json({ error: 'Логин и пароль обязательны' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Логин должен быть минимум 3 символа' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

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

      await logAction(req.user.id, 'user_created', 'user', result.rows[0].id, { 
        new_username: username, 
        new_role: newRole 
      }, req.ip, req.get('User-Agent'));

      res.status(201).json({ 
        message: 'Пользователь создан',
        user: { username, name: name || username, role: newRole }
      });
    } catch (err) {
      console.error('POST /api/users error:', err);
      res.status(500).json({ error: 'Ошибка создания пользователя' });
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

    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить самого себя' });
    }

    if (parseInt(id) === 1) {
      return res.status(403).json({ error: 'Нельзя удалить главного администратора' });
    }

    try {
      // Получаем информацию о пользователе
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
      
      await logAction(req.user.id, 'user_deleted', 'user', parseInt(id), { 
        deleted_username: result.rows[0].username 
      }, req.ip, req.get('User-Agent'));
      
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

    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
    }

    try {
      const userExists = await db.query('SELECT id, username FROM users WHERE id = $1', [id]);
      if (userExists.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
      
      // Отзываем все refresh токены (пользователь должен перелогиниться)
      await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [id]);

      await logAction(req.user.id, 'password_changed_by_admin', 'user', parseInt(id), { 
        changed_username: userExists.rows[0].username 
      }, req.ip, req.get('User-Agent'));
      
      res.json({ message: 'Пароль успешно изменён. Пользователь должен войти снова.' });
    } catch (err) {
      console.error('PUT /api/users/:id/password error:', err);
      res.status(500).json({ error: 'Ошибка смены пароля' });
    }
  }
);

// ==========================================
// ИЗМЕНИТЬ РОЛЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================
router.put('/:id/role', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    const db = getDB();

    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    if (!['admin', 'moderator', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Некорректная роль' });
    }

    try {
      const userResult = await db.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
      
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const user = userResult.rows[0];

      // Нельзя понизить последнего админа
      if (user.role === 'admin' && role !== 'admin') {
        const adminCount = await db.query("SELECT COUNT(*) FROM users WHERE role = 'admin'");
        if (parseInt(adminCount.rows[0].count) <= 1) {
          return res.status(400).json({ error: 'Нельзя понизить последнего администратора' });
        }
      }

      await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);

      await logAction(req.user.id, 'role_changed', 'user', parseInt(id), { 
        username: user.username,
        old_role: user.role,
        new_role: role
      }, req.ip, req.get('User-Agent'));

      res.json({ message: 'Роль изменена', user: { id, username: user.username, role } });
    } catch (err) {
      console.error('PUT /api/users/:id/role error:', err);
      res.status(500).json({ error: 'Ошибка изменения роли' });
    }
  }
);

// ==========================================
// АКТИВИРОВАТЬ/ДЕАКТИВИРОВАТЬ ПОЛЬЗОВАТЕЛЯ (только админы)
// ==========================================
router.put('/:id/status', 
  authenticateToken, 
  checkRole(['admin']), 
  async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;
    const db = getDB();

    if (isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active должен быть boolean' });
    }

    try {
      const userResult = await db.query('SELECT id, username, is_active FROM users WHERE id = $1', [id]);
      
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const user = userResult.rows[0];

      // Нельзя деактивировать главного админа
      if (parseInt(id) === 1 && !is_active) {
        return res.status(403).json({ error: 'Нельзя деактивировать главного администратора' });
      }

      await db.query('UPDATE users SET is_active = $1 WHERE id = $2', [is_active, id]);

      // Если деактивируем — отзываем все токены
      if (!is_active) {
        await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [id]);
      }

      await logAction(req.user.id, 'status_changed', 'user', parseInt(id), { 
        username: user.username,
        old_status: user.is_active,
        new_status: is_active
      }, req.ip, req.get('User-Agent'));

      res.json({ 
        message: is_active ? 'Пользователь активирован' : 'Пользователь деактивирован',
        user: { id, username: user.username, is_active }
      });
    } catch (err) {
      console.error('PUT /api/users/:id/status error:', err);
      res.status(500).json({ error: 'Ошибка изменения статуса' });
    }
  }
);

module.exports = router;
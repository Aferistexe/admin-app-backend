const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// Получить всех пользователей (только для админов)
router.get('/', authenticateToken, checkRole(['admin']), async (req, res) => {
  const db = getDB();
  
  try {
    const result = await db.query('SELECT id, username, name, role, created_at FROM users');
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// Удалить пользователя (только для админов)
router.delete('/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  
  try {
    await db.query('DELETE FROM users WHERE id = $1 AND username != $2', [id, 'admin']);
    res.json({ message: 'Пользователь удалён' });
  } catch (err) {
    console.error('DELETE /api/users error:', err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// Сменить пароль (только для админов)
router.put('/:id/password', authenticateToken, checkRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const db = getDB();
  
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 4 символа' });
  }
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    res.json({ message: 'Пароль изменён' });
  } catch (err) {
    console.error('PUT /api/users/password error:', err);
    res.status(500).json({ error: 'Ошибка смены пароля' });
  }
});

module.exports = router;
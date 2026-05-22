const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// Получить всех пользователей (только для админов)
router.get('/', authenticateToken, checkRole(['admin']), async (req, res) => {
  const db = getDB();
  
  try {
    const users = await new Promise((resolve, reject) => {
      db.all('SELECT id, username, name, role, created_at FROM users', (err, rows) => {
        if (err) reject(err);
        resolve(rows);
      });
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// Удалить пользователя (только для админов)
router.delete('/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  
  try {
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM users WHERE id = ? AND username != "admin"', [id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });
    
    res.json({ message: 'Пользователь удалён' });
  } catch (err) {
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
    
    await new Promise((resolve, reject) => {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id], (err) => {
        if (err) reject(err);
        resolve();
      });
    });
    
    res.json({ message: 'Пароль изменён' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка смены пароля' });
  }
});

module.exports = router;
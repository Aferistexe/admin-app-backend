const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// Получить всех пользователей (только для админов)
router.get('/users', authenticateToken, checkRole(['admin']), async (req, res) => {
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

// Создать пользователя (только для админов)
router.post('/users', authenticateToken, checkRole(['admin']), async (req, res) => {
  const { username, email, password, name, role } = req.body;
  const db = getDB();
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (username, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)',
        [username, email || `${username}@local.com`, passwordHash, name || username, role || 'user'],
        (err) => {
          if (err) reject(err);
          resolve();
        }
      );
    });
    
    res.status(201).json({ message: 'Пользователь создан' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Пользователь уже существует' });
    } else {
      res.status(500).json({ error: 'Ошибка создания' });
    }
  }
});

// Сменить пароль (только для админов)
router.put('/users/:id/password', authenticateToken, checkRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  const db = getDB();
  
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

// Удалить пользователя (только для админов)
router.delete('/users/:id', authenticateToken, checkRole(['admin']), async (req, res) => {
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

module.exports = router;
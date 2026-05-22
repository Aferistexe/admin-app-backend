const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');

const router = express.Router();

// Логин (уже есть)
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDB();

  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const accessToken = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
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

// 🔥 НОВЫЙ ЭНДПОИНТ: Регистрация (только для админов)
router.post('/register', async (req, res) => {
  const { username, email, password, name, role } = req.body;
  const db = getDB();

  // Проверка обязательных полей
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  try {
    // Проверка, существует ли пользователь
    const existingUser = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        resolve(row);
      });
    });

    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    }

    // Хеширование пароля
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Создание пользователя
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (username, email, password_hash, name, role) 
         VALUES (?, ?, ?, ?, ?)`,
        [username, email || `${username}@local.com`, passwordHash, name || username, role || 'user'],
        function(err) {
          if (err) reject(err);
          resolve(this.lastID);
        }
      );
    });

    res.status(201).json({ 
      message: 'Пользователь создан',
      user: { username, name: name || username, role: role || 'user' }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка создания пользователя' });
  }
});

module.exports = router;
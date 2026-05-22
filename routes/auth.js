const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../db');

const router = express.Router();

// Логин
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDB();

  try {
    // PostgreSQL использует query, а не get
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

// Регистрация
router.post('/register', async (req, res) => {
  const { username, email, password, name, role } = req.body;
  const db = getDB();

  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  try {
    // Проверка существования пользователя
    const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    
    await db.query(
      `INSERT INTO users (username, email, password_hash, name, role) 
       VALUES ($1, $2, $3, $4, $5)`,
      [username, email || `${username}@local.com`, passwordHash, name || username, role || 'user']
    );

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
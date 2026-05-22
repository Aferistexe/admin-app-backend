const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    // Таблица users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP
      )
    `);

    // Таблица refresh_tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE
      )
    `);

    // Создаём тестового пользователя admin / admin123
    const testPasswordHash = await bcrypt.hash('admin123', 10);
    await client.query(`
      INSERT INTO users (username, email, password_hash, name, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username) DO NOTHING
    `, ['admin', 'admin@example.com', testPasswordHash, 'Администратор', 'admin']);

    // Создаём пользователя manisule / 123456
    const manisulePasswordHash = await bcrypt.hash('123456', 10);
    await client.query(`
      INSERT INTO users (username, email, password_hash, name, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username) DO NOTHING
    `, ['manisule', 'manisule@example.com', manisulePasswordHash, 'Манисул', 'admin']);

    console.log('✅ База данных PostgreSQL инициализирована');
  } catch (err) {
    console.error('DB init error:', err);
  } finally {
    client.release();
  }
};

const getDB = () => pool;

module.exports = { pool, initDB, getDB };
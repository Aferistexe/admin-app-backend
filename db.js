const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    console.log('🔄 Инициализация базы данных...');

    // 1. Таблица users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'moderator', 'user')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP,
        two_factor_secret TEXT,
        two_factor_enabled BOOLEAN DEFAULT FALSE
      )
    `);

    // 2. Таблица refresh_tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        revoked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address INET,
        user_agent TEXT
      )
    `);

    // 3. Таблица audit_logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id INTEGER,
        details JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. Таблица api_keys
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        permissions TEXT[] DEFAULT '{}',
        is_active BOOLEAN DEFAULT TRUE,
        last_used TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);

    // 5. Индексы для производительности
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
      CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login DESC);
      
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
      
      CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
      
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    `);

    // 6. Функция для очистки старых токенов
    await client.query(`
      CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
      RETURNS INTEGER AS $$
      DECLARE
        deleted_count INTEGER;
      BEGIN
        DELETE FROM refresh_tokens
        WHERE expires_at < NOW() OR revoked = TRUE;
        
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        RETURN deleted_count;
      END;
      $$ LANGUAGE plpgsql;
    `);

    console.log('✅ База данных PostgreSQL инициализирована');
    console.log('📊 Таблицы: users, refresh_tokens, audit_logs, api_keys');
    console.log('🔍 Индексы: созданы для оптимизации запросов');
  } catch (err) {
    console.error('❌ DB init error:', err);
    throw err;
  } finally {
    client.release();
  }
};

const getDB = () => pool;

// Функция для логирования действий
const logAction = async (userId, action, targetType = null, targetId = null, details = null, ipAddress = null, userAgent = null) => {
  try {
    await pool.query(`
      INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [userId, action, targetType, targetId, details ? JSON.stringify(details) : null, ipAddress, userAgent]);
  } catch (err) {
    console.error('Failed to log action:', err);
  }
};

module.exports = { pool, initDB, getDB, logAction };
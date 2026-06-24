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

// Функция для миграции существующей таблицы refresh_tokens
const migrateRefreshTokens = async (client) => {
  try {
    console.log('🔄 Проверка структуры таблицы refresh_tokens...');
    
    // Проверяем существование колонки ip_address
    const checkColumn = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'refresh_tokens' AND column_name = 'ip_address'
    `);
    
    if (checkColumn.rows.length === 0) {
      console.log('📦 Добавляем недостающие колонки в refresh_tokens...');
      
      // Добавляем колонку ip_address
      try {
        await client.query(`
          ALTER TABLE refresh_tokens 
          ADD COLUMN ip_address INET
        `);
        console.log('  ✓ Добавлена колонка ip_address');
      } catch (err) {
        if (!err.message.includes('duplicate column')) {
          console.warn('  ⚠ Не удалось добавить ip_address:', err.message);
        }
      }
      
      // Добавляем колонку user_agent
      try {
        await client.query(`
          ALTER TABLE refresh_tokens 
          ADD COLUMN user_agent TEXT
        `);
        console.log('  ✓ Добавлена колонка user_agent');
      } catch (err) {
        if (!err.message.includes('duplicate column')) {
          console.warn('  ⚠ Не удалось добавить user_agent:', err.message);
        }
      }
      
      // Добавляем колонку expires_at (если нет)
      const checkExpires = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'refresh_tokens' AND column_name = 'expires_at'
      `);
      
      if (checkExpires.rows.length === 0) {
        await client.query(`
          ALTER TABLE refresh_tokens 
          ADD COLUMN expires_at TIMESTAMP
        `);
        console.log('  ✓ Добавлена колонка expires_at');
      }
      
      // Добавляем колонку revoked (если нет)
      const checkRevoked = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'refresh_tokens' AND column_name = 'revoked'
      `);
      
      if (checkRevoked.rows.length === 0) {
        await client.query(`
          ALTER TABLE refresh_tokens 
          ADD COLUMN revoked BOOLEAN DEFAULT FALSE
        `);
        console.log('  ✓ Добавлена колонка revoked');
      }
      
      console.log('✅ Миграция refresh_tokens завершена');
    } else {
      console.log('✅ Таблица refresh_tokens уже имеет правильную структуру');
    }
  } catch (err) {
    console.error('❌ Ошибка миграции:', err.message);
    // Не выбрасываем ошибку, чтобы сервер продолжил работу
  }
};

// Функция для проверки и создания функции cleanup_expired_tokens
const ensureCleanupFunction = async (client) => {
  try {
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
    console.log('✅ Функция cleanup_expired_tokens создана');
  } catch (err) {
    console.error('❌ Ошибка создания функции:', err.message);
  }
};

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
    console.log('✓ Таблица users проверена/создана');

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
    console.log('✓ Таблица refresh_tokens проверена/создана');

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
    console.log('✓ Таблица audit_logs проверена/создана');

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
    console.log('✓ Таблица api_keys проверена/создана');

    // 5. Таблица senior_metrics — редактируемые значения статистики старших
    //     (выходы на смену, фасты, отчёты) + недельные снимки часов. Нормы НЕ хранятся —
    //     они фиксированы по категории на фронте. Часы храним сразу в часах (не секундах).
    await client.query(`
      CREATE TABLE IF NOT EXISTS senior_metrics (
        steam64_id TEXT PRIMARY KEY,
        shifts INTEGER NOT NULL DEFAULT 0,
        fasts INTEGER NOT NULL DEFAULT 0,
        reports INTEGER NOT NULL DEFAULT 0,
        week_start_hours INTEGER,
        week_end_hours INTEGER,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log('✓ Таблица senior_metrics проверена/создана');

    // 5.1 Миграция: добавляем недельные колонки к существующей senior_metrics.
    await client.query(`
      ALTER TABLE senior_metrics
        ADD COLUMN IF NOT EXISTS week_start_hours INTEGER,
        ADD COLUMN IF NOT EXISTS week_end_hours INTEGER,
        ADD COLUMN IF NOT EXISTS reports INTEGER NOT NULL DEFAULT 0
    `);
    console.log('✓ Колонки week_start_hours/week_end_hours/reports проверены');

    // 5.1.1 Миграция: колонки снимков метрик в senior_weekly_hours
    // (tickets/shifts/reports/fasts за конкретную неделю; NULL = снимка нет).
    await client.query(`
      ALTER TABLE senior_weekly_hours
        ADD COLUMN IF NOT EXISTS tickets INTEGER,
        ADD COLUMN IF NOT EXISTS shifts INTEGER,
        ADD COLUMN IF NOT EXISTS reports INTEGER,
        ADD COLUMN IF NOT EXISTS fasts INTEGER
    `);
    console.log('✓ Колонки tickets/shifts/reports/fasts в senior_weekly_hours проверены');

    // 5.2 История недельных часов по неделям (понедельник недели как ключ).
    //     При закрытии недели (вс 23:55) пишем полный снимок: tickets/shifts/reports/fasts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS senior_weekly_hours (
        id SERIAL PRIMARY KEY,
        steam64_id TEXT NOT NULL,
        week_start DATE NOT NULL,
        start_hours INTEGER,
        end_hours INTEGER,
        hours INTEGER,
        tickets INTEGER,
        shifts INTEGER,
        reports INTEGER,
        fasts INTEGER,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(steam64_id, week_start)
      )
    `);
    console.log('✓ Таблица senior_weekly_hours проверена/создана');

    // 6. Выполняем миграцию для существующей таблицы (добавляем недостающие колонки)
    await migrateRefreshTokens(client);

    // 7. Создаем функцию очистки токенов
    await ensureCleanupFunction(client);

    // 8. Индексы для производительности
    console.log('🔍 Создание индексов...');
    
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
      
      CREATE INDEX IF NOT EXISTS idx_senior_metrics_steam64_id ON senior_metrics(steam64_id);
      
      CREATE INDEX IF NOT EXISTS idx_senior_weekly_steam_week ON senior_weekly_hours(steam64_id, week_start DESC);
    `);
    console.log('✓ Индексы созданы');

    // 8.1 Таблица odrp4_sessions — хранение session_token для проксирования запросов к odrp4.ru
    await client.query(`
      CREATE TABLE IF NOT EXISTS odrp4_sessions (
        id SERIAL PRIMARY KEY,
        session_token TEXT NOT NULL,
        steam64 TEXT,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Таблица odrp4_sessions проверена/создана');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_odrp4_sessions_expires ON odrp4_sessions(expires_at)
    `);

    // 9. Создаем администратора по умолчанию (если нет ни одного пользователя)
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
      const bcrypt = require('bcryptjs');
      const defaultPassword = 'admin123';
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      
      await client.query(`
        INSERT INTO users (username, email, password_hash, name, role, is_active)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, ['admin', 'admin@localhost.com', passwordHash, 'Administrator', 'admin', true]);
      
      console.log('✓ Создан пользователь admin (пароль: admin123)');
    }

    console.log('✅ База данных PostgreSQL успешно инициализирована');
    console.log('📊 Таблицы: users, refresh_tokens, audit_logs, api_keys, senior_metrics, senior_weekly_hours');
    
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
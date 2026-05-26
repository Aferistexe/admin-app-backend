const jwt = require('jsonwebtoken');

/**
 * Middleware для аутентификации JWT токена.
 * Проверяет наличие и валидность токена в заголовке Authorization.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const authenticateToken = (req, res, next) => {
  // Получаем заголовок Authorization
  const authHeader = req.headers['authorization'];
  
  // Ожидаем формат: "Bearer <token>"
  const token = authHeader && authHeader.split(' ')[1];

  // Нет токена
  if (!token) {
    return res.status(401).json({ 
      error: 'Токен не предоставлен',
      code: 'TOKEN_MISSING'
    });
  }

  try {
    // Проверяем токен с секретным ключом
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Сохраняем декодированные данные в req.user
    req.user = decoded;
    
    // Передаём управление дальше
    next();
  } catch (err) {
    // Обработка разных типов ошибок JWT
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Токен истёк. Пожалуйста, войдите снова.',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (err.name === 'JsonWebTokenError') {
      return res.status(403).json({ 
        error: 'Недействительный токен. Подпись не совпадает.',
        code: 'TOKEN_INVALID_SIGNATURE'
      });
    }
    
    if (err.name === 'NotBeforeError') {
      return res.status(403).json({ 
        error: 'Токен ещё не активен.',
        code: 'TOKEN_NOT_ACTIVE'
      });
    }
    
    // Любая другая ошибка
    console.error('JWT verification error:', err.message);
    return res.status(403).json({ 
      error: 'Недействительный токен',
      code: 'TOKEN_INVALID'
    });
  }
};

/**
 * Middleware для проверки роли пользователя.
 * Должен использоваться после authenticateToken.
 * 
 * @param {string|string[]} roles - Одна роль или массив разрешённых ролей
 * @returns {Function} Express middleware
 * 
 * @example
 * // Одна роль
 * app.get('/admin', checkRole('admin'), handler)
 * 
 * // Несколько ролей
 * app.get('/moderator', checkRole(['admin', 'moderator']), handler)
 */
const checkRole = (roles) => {
  // Нормализуем входные данные в массив
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  
  return (req, res, next) => {
    // Проверяем, прошёл ли пользователь аутентификацию
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Не авторизован. Требуется аутентификация.',
        code: 'UNAUTHORIZED'
      });
    }
    
    // Получаем роль пользователя
    const userRole = req.user.role;
    
    // Проверяем, есть ли у пользователя нужная роль
    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).json({ 
        error: `Недостаточно прав. Требуются роли: ${allowedRoles.join(', ')}`,
        code: 'FORBIDDEN',
        requiredRoles: allowedRoles,
        userRole: userRole || 'none'
      });
    }
    
    // Всё хорошо — передаём управление дальше
    next();
  };
};

/**
 * Middleware для опциональной аутентификации.
 * Не возвращает ошибку, если токена нет, но если есть — проверяет и добавляет user.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // Нет токена — просто идём дальше без пользователя
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    // Токен невалиден — просто игнорируем, не блокируем запрос
    console.warn('Optional auth failed:', err.message);
  }
  
  next();
};

/**
 * Вспомогательная функция для генерации JWT токена.
 * @param {Object} payload - Данные для токена
 * @param {string} expiresIn - Время жизни токена (например, '24h', '7d')
 * @returns {string} JWT токен
 */
const generateToken = (payload, expiresIn = '24h') => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

/**
 * Вспомогательная функция для декодирования токена (без проверки подписи).
 * @param {string} token - JWT токен
 * @returns {Object|null} Декодированные данные или null
 */
const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (err) {
    console.error('Token decode error:', err.message);
    return null;
  }
};

module.exports = { 
  authenticateToken, 
  checkRole, 
  optionalAuth,
  generateToken,
  decodeToken
};

const jwt = require('jsonwebtoken');

// Проверка токена
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Недействительный токен' });
  }
}

// Проверка роли
function checkRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Пользователь не авторизован' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }

    next();
  };
}

// ⚠️ ВАЖНО: экспортировать ОБЕ функции объектом
module.exports = {
  authenticateToken,
  checkRole
};

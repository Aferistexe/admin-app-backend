const express = require('express');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Кэш для данных (чтобы не дергать внешний API каждый раз)
let staffCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 минут

// Функция получения данных с кэшированием
const getStaffData = async () => {
  const now = Date.now();
  
  // Если кэш актуален — возвращаем его
  if (staffCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return staffCache;
  }
  
  // Иначе запрашиваем с внешнего API
  const response = await fetch('https://admin.unionteams.ru/api/v2/admins/list/4');
  if (!response.ok) {
    throw new Error('Failed to fetch staff data');
  }
  
  staffCache = await response.json();
  cacheTimestamp = now;
  return staffCache;
};

// ==========================================
// ✅ ПОЛУЧИТЬ КОМАНДУ SENIOR (по Steam64 ID)
// ==========================================
router.get('/:seniorId', authenticateToken, async (req, res) => {
  const seniorId = req.params.seniorId;
  
  try {
    const staff = await getStaffData();
    
    // Ищем senior'а по steam64_id
    const senior = staff.find(member => member.steam.steam64_id === seniorId);
    
    if (!senior) {
      return res.status(404).json({ error: 'Senior не найден' });
    }
    
    // Ищем всех подчиненных (у кого server.senior === seniorId)
    const members = staff.filter(member => {
      const memberSenior = member.server.senior?.trim();
      return memberSenior === seniorId;
    });
    
    // Форматируем ответ
    const formattedSenior = {
      steam64_id: senior.steam.steam64_id,
      steam_id: senior.steam.steamid,
      profile_name: senior.steam.profile_name,
      real_name: senior.server.real_name,
      rang: senior.server.rang,
      department: senior.server.department,
      status: senior.server.status,
      online: senior.server.online,
      tickets_30d: senior.tickets['30d'],
      salary_30d: senior.salary['30d'],
      salary_bonus: senior.salary.bonus
    };
    
    const formattedMembers = members.map(member => ({
      steam64_id: member.steam.steam64_id,
      steam_id: member.steam.steamid,
      profile_name: member.steam.profile_name,
      real_name: member.server.real_name,
      rang: member.server.rang,
      department: member.server.department,
      status: member.server.status,
      online: member.server.online,
      tickets_30d: member.tickets['30d'],
      salary_30d: member.salary['30d'],
      salary_bonus: member.salary.bonus
    }));
    
    res.json({
      senior: formattedSenior,
      members: formattedMembers,
      total: formattedMembers.length
    });
    
  } catch (err) {
    console.error('Get team error:', err);
    res.status(500).json({ error: 'Ошибка получения данных команды' });
  }
});

// ==========================================
// ✅ ВСЕ КОМАНДЫ (дерево структуры)
// ==========================================
router.get('/structure/all', authenticateToken, async (req, res) => {
  try {
    const staff = await getStaffData();
    
    // Находим всех senior'ов (у кого senior пустой или "0")
    const seniors = staff.filter(member => {
      const senior = member.server.senior?.trim();
      return !senior || senior === '0';
    });
    
    // Для каждого senior'а находим подчиненных
    const tree = seniors.map(senior => {
      const members = staff.filter(member => {
        const memberSenior = member.server.senior?.trim();
        return memberSenior === senior.steam.steam64_id;
      });
      
      return {
        senior: {
          steam64_id: senior.steam.steam64_id,
          profile_name: senior.steam.profile_name,
          real_name: senior.server.real_name,
          rang: senior.server.rang,
          department: senior.server.department,
          status: senior.server.status
        },
        members: members.map(m => ({
          steam64_id: m.steam.steam64_id,
          profile_name: m.steam.profile_name,
          real_name: m.server.real_name,
          rang: m.server.rang,
          status: m.server.status
        })),
        total: members.length
      };
    });
    
    res.json({ tree });
    
  } catch (err) {
    console.error('Get structure error:', err);
    res.status(500).json({ error: 'Ошибка получения структуры' });
  }
});

module.exports = router;
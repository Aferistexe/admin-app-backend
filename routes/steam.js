const express = require('express');
const router = express.Router();

// ==========================================
// ПОЛУЧИТЬ АВАТАР ПО STEAM ID (публичный)
// ==========================================
router.get('/avatar/:steamId', async (req, res) => {
  const { steamId } = req.params;
  
  try {
    // Проверяем, есть ли API ключ
    if (!process.env.STEAM_API_KEY) {
      console.error('STEAM_API_KEY not configured');
      return res.status(500).json({ error: 'Steam API not configured' });
    }

    // Запрашиваем данные пользователя из Steam API
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${process.env.STEAM_API_KEY}&steamids=${steamId}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.response && data.response.players && data.response.players.length > 0) {
      const player = data.response.players[0];
      // Возвращаем URL аватара (можно avatar, avatarmedium или avatarfull)
      const avatarUrl = player.avatarfull || player.avatarmedium || player.avatar;
      
      // Редиректим на реальный URL аватара от Steam
      return res.redirect(avatarUrl);
    } else {
      return res.status(404).json({ error: 'Player not found' });
    }
  } catch (error) {
    console.error('Steam avatar error:', error);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

module.exports = router;
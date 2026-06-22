// ==========================================
// LIVEWIRE HOURS — парсер часов игрока с unionteams.ru
// ==========================================
// Сайт защищён vDDoS (R3ACTLB AES-128-CBC челлендж), а счётчик часов
// отрисован Livewire-компонентом animated-counter, который грузится
// лениво через POST /livewire/update. Поэтому полный цикл получения часов:
//
//   1. GET /player/{steam64} → страница с R3ACTLB-челленджем
//   2. solveChallenge(html) → AES-расшифровка → cookie R3ACTLB
//   3. GET /player/{steam64} с cookie → реальная страница (wire:snapshot lk)
//   4. POST /livewire/update со snapshot + __lazyLoad → JSON
//   5. Парсинг effects.html / serverMemo.data → animated-counter.count = часы
//
// Всё это нельзя делать из браузера (CORS + AES), поэтому живёт на бэкенде.
// Внутри Node используем встроенный https + crypto (без внешних зависимостей).

const https = require('https');
const crypto = require('crypto');

const HOST = 'unionteams.ru';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// TTL кеша в памяти: livewire-запрос тяжёлый, часы меняются медленно.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут
const hoursCache = new Map(); // steam64 → { hours, source, ts }

// ------------------------------------
// Низкоуровневый https-запрос с сбором cookie
// ------------------------------------
function request(opts, bodyData) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (d) => chunks.push(d));
      resp.on('end', () => {
        const headers = resp.headers || {};
        const cookies = [];
        if (headers['set-cookie']) {
          (Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']])
            .forEach((c) => cookies.push(c.split(';')[0]));
        }
        resolve({
          status: resp.statusCode,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
          cookies,
        });
      });
    });
    req.on('error', reject);
    // Таймаут — чтобы не висеть на медленном/упавшем upstream.
    req.setTimeout(15000, () => {
      req.destroy(new Error('livewire request timeout'));
    });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ------------------------------------
// Декодер PHP-массива из челленджа (буквально из _probe_player.js)
// ------------------------------------
function decodeArray(raw) {
  const items = [];
  let cur = '';
  let inq = false;
  let esc = false;
  for (const ch of raw) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"' || ch === "'") { inq = !inq; cur += ch; continue; }
    if (ch === ',' && !inq) { items.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) items.push(cur);
  return items.map((s) => s
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

// ------------------------------------
// Решение R3ACTLB-челленджа vDDoS.
// Возвращает hex-строку для cookie R3ACTLB или null, если челленджа нет.
// ------------------------------------
function solveChallenge(html) {
  const arrMatch = html.match(/_0x70a6\s*=\s*\[([\s\S]*?)\]/);
  if (!arrMatch) return null;
  const arr = decodeArray(arrMatch[1]);
  if (arr.length < 10) return null;
  const key = Buffer.from(arr[7], 'hex');
  const iv = Buffer.from(arr[8], 'hex');
  const enc = Buffer.from(arr[9], 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('hex');
}

// Декодер HTML-entity для атрибутов wire:snapshot / wire:initial-data.
const decodeAttr = (s) => s
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#039;/g, "'")
  .replace(/&#x27;/g, "'");

// ------------------------------------
// Полный цикл: получить сессию (с обходом челленджа) + финальную страницу
// ------------------------------------
async function getSessionPage(path) {
  // 1. Первый запрос — отдаёт челлендж (или сразу страницу, если челленджа нет).
  const r1 = await request({
    hostname: HOST,
    path,
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });

  const solved = solveChallenge(r1.body);
  if (!solved) {
    // Челленджа нет — возможно, страница уже реальная.
    return { jar: r1.cookies, body: r1.body };
  }

  // 2. Повторяем GET с решённым cookie.
  const jar = [`R3ACTLB=${solved}`];
  const r2 = await request({
    hostname: HOST,
    path,
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', Cookie: jar.join('; ') },
  });
  jar.push(...r2.cookies);

  // 3. Следуем за редиректами (если есть), до 4 прыжков.
  let final = r2;
  for (let i = 0; i < 4 && final.status >= 300 && final.status < 400 && final.headers.location; i++) {
    let loc = final.headers.location;
    let p;
    try {
      const u = new URL(loc, `https://${HOST}`);
      p = u.pathname + u.search;
    } catch {
      p = loc;
    }
    final = await request({
      hostname: HOST,
      path: p,
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', Cookie: jar.join('; ') },
    });
    jar.push(...final.cookies);
  }

  return { jar, body: final.body };
}

// ------------------------------------
// Извлекает часы из Livewire-ответа (effects.html / serverMemo.data)
// ------------------------------------
function extractHoursFromLivewire(payload) {
  // payload — распарсенный JSON ответа /livewire/update
  const components = payload.components || [];
  for (const comp of components) {
    const effects = comp.effects || {};
    const html = effects.html || '';

    // В HTML-фрагменте animated-counter содержит data.count.
    // wire:snapshot="..." — HTML-encoded JSON с data.count.
    const snapMatches = [...html.matchAll(/wire:snapshot="([^"]*)"/g)];
    for (const m of snapMatches) {
      try {
        const decoded = decodeAttr(m[1]);
        const obj = JSON.parse(decoded);
        if (obj.memo?.name === 'animated-counter' && typeof obj.data?.count === 'number') {
          return obj.data.count;
        }
      } catch {
        // частичный/битый атрибут — пропускаем
      }
    }

    // Запасной путь: serverMemo.data (Livewire может вернуть данные без html).
    const serverMemo = comp.serverMemo || {};
    const data = serverMemo.data || {};
    if (typeof data.count === 'number' && (serverMemo.name === 'animated-counter' || comp.memo?.name === 'animated-counter')) {
      return data.count;
    }

    // Самый грубый fallback: последнее число "count":N во всём html.
    if (html) {
      const counts = [...html.matchAll(/"count":\s*(\d+)/g)].map((m) => parseInt(m[1], 10));
      if (counts.length > 0) {
        return counts[counts.length - 1];
      }
    }
  }
  return null;
}

// ------------------------------------
// Извлекает snapshot компонента lk и _token из HTML страницы игрока
// ------------------------------------
function extractLivewireInputs(html) {
  // wire:snapshot компонента lk (личный кабинет игрока).
  const snapMatch = html.match(/wire:snapshot="([^"]*)"/);
  let snapshot = null;
  if (snapMatch) {
    try {
      snapshot = decodeAttr(snapMatch[1]);
      JSON.parse(snapshot); // проверка валидности
    } catch {
      snapshot = null;
    }
  }

  // CSRF-токен (Livewire требует _token в теле POST).
  const tokenMatch =
    html.match(/"csrf":"([a-zA-Z0-9]{40})"/) ||
    html.match(/name="_token"\s+value="([^"]+)"/) ||
    html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  const token = tokenMatch ? tokenMatch[1] : '';

  return { snapshot, token };
}

// ------------------------------------
// Главная функция: получить часы одного игрока по steam64.
// Возвращает { hours, source } — source: 'cache' | 'live' | 'error'
// ------------------------------------
async function fetchPlayerHours(steam64Id) {
  const key = String(steam64Id || '').trim();
  if (!/^\d{17}$/.test(key)) {
    return { hours: 0, source: 'error', error: 'invalid steam64 id' };
  }

  // Кеш
  const cached = hoursCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { hours: cached.hours, source: 'cache' };
  }

  const path = `/player/${key}`;

  try {
    // 1+2+3: Получаем страницу с cookie-сессией.
    const { jar, body } = await getSessionPage(path);
    if (!body || body.length === 0) {
      throw new Error('empty page body');
    }

    // 4: Извлекаем snapshot + token.
    const { snapshot, token } = extractLivewireInputs(body);
    if (!snapshot) {
      throw new Error('lk snapshot not found on page');
    }

    // 5: POST /livewire/update с __lazyLoad.
    const livewireBody = JSON.stringify({
      _token: token,
      components: [
        {
          snapshot,
          updates: {},
          calls: [{ path: '', method: '__lazyLoad', params: [] }],
        },
      ],
    });

    const lr = await request({
      hostname: HOST,
      path: '/livewire/update',
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Content-Type': 'application/json',
        Cookie: jar.join('; '),
        Origin: `https://${HOST}`,
        Referer: `https://${HOST}${path}`,
        'X-Livewire': 'true',
        'X-CSRF-TOKEN': token,
        'Content-Length': Buffer.byteLength(livewireBody),
      },
    }, livewireBody);

    const ct = lr.headers['content-type'] || '';
    if (!ct.includes('json') || lr.status >= 400) {
      throw new Error(`livewire bad response: status=${lr.status} ct=${ct}`);
    }

    const payload = JSON.parse(lr.body);
    const hours = extractHoursFromLivewire(payload);
    if (hours === null || typeof hours !== 'number') {
      throw new Error('animated-counter count not found in livewire response');
    }

    hoursCache.set(key, { hours, ts: Date.now() });
    return { hours, source: 'live' };
  } catch (err) {
    // Graceful fallback: не валить батч, отдаём 0 + пометку источника.
    // Кеш НЕ пишем при ошибке — следующий запрос попробует снова.
    return { hours: 0, source: 'error', error: err.message };
  }
}

// ------------------------------------
// Батчевое получение часов с ограничением параллельности.
// livewire тяжёлый, поэтому concurrently не больше limit.
// Возвращает { [steam64]: hours }.
// ------------------------------------
async function fetchHoursBatch(steam64Ids, limit = 5) {
  const ids = (Array.isArray(steam64Ids) ? steam64Ids : []).filter((id) => /^\d{17}$/.test(String(id)));
  const result = {};

  // Обрабатываем чанками по limit.
  for (let i = 0; i < ids.length; i += limit) {
    const chunk = ids.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop
    const settled = await Promise.all(
      chunk.map(async (id) => {
        const r = await fetchPlayerHours(id);
        return [id, r.hours];
      })
    );
    for (const [id, hours] of settled) {
      result[id] = hours;
    }
  }
  return result;
}

// Очистка кеша (для тестов / ручного управления).
function clearHoursCache() {
  hoursCache.clear();
}

module.exports = {
  fetchPlayerHours,
  fetchHoursBatch,
  clearHoursCache,
  // Экспортируем внутренние функции для возможного тестирования/дебага:
  solveChallenge,
  extractHoursFromLivewire,
  extractLivewireInputs,
};

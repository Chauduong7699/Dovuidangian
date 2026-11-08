const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { URL } = require('url');

const questionsPrimary = require('./questions.js');
const questionsExtra = require('./questions-extra.js');
const allQuestions = [...questionsPrimary, ...questionsExtra];

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const rooms = new Map();
const MAX_PLAYERS = 50;
const QUESTION_COUNT = 30;
const QUESTION_TIME_MS = 30000;
const REVEAL_TIME_MS = 3000;
const ROOM_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 giờ không hoạt động thì tự giải phóng

// Bộ đệm tĩnh trong bộ nhớ (Gzip + ETag) để tối ưu tốc độ tối đa
const staticCache = new Map();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Tự động dọn dẹp phòng cũ định kỳ mỗi 15 phút
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.updatedAt || 0) > ROOM_EXPIRE_MS) {
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000).unref();

function send(res, status, data, type = 'application/json; charset=utf-8', req = null) {
  const isJson = type.startsWith('application/json');
  const rawBody = isJson ? JSON.stringify(data) : data;
  const buffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf-8');

  const headers = {
    'Content-Type': type,
    'Cache-Control': isJson ? 'no-store' : 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'Vary': 'Accept-Encoding'
  };

  // Nén Gzip nếu client hỗ trợ và payload > 1KB
  const acceptEncoding = (req && req.headers['accept-encoding']) || '';
  if (acceptEncoding.includes('gzip') && buffer.length > 1024) {
    zlib.gzip(buffer, (err, compressed) => {
      if (!err) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = compressed.length;
        res.writeHead(status, headers);
        return res.end(compressed);
      }
      headers['Content-Length'] = buffer.length;
      res.writeHead(status, headers);
      res.end(buffer);
    });
    return;
  }

  headers['Content-Length'] = buffer.length;
  res.writeHead(status, headers);
  res.end(buffer);
}

function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanAnswer(str) {
  return String(str || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAnswer(userAnswer, q) {
  const u = cleanAnswer(userAnswer);
  if (!u) return false;
  const target = cleanAnswer(q.answer);
  if (u === target) return true;
  if (Array.isArray(q.accepted)) {
    for (const alt of q.accepted) {
      if (u === cleanAnswer(alt)) return true;
    }
  }
  return false;
}

function pickRandomQuestions(pool, count) {
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function computeLeaderboard(room) {
  const list = [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    score: p.score || 0,
    correct: p.correct || 0,
    host: p.host,
    done: p.done
  }));
  list.sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name, 'vi'));
  return list.map((p, idx) => ({ ...p, rank: idx + 1 }));
}

function updatePlayerPhase(player, room) {
  if (room.status !== 'playing' || player.done) return;
  const now = Date.now();

  // Đang ở popup xem đáp án: kiểm tra hết 3 giây chưa
  if (player.phase === 'reveal') {
    if (player.popup && now >= player.popup.nextAt) {
      player.currentQuestionIdx += 1;
      if (player.currentQuestionIdx >= room.questions.length) {
        player.done = true;
        player.phase = 'done';
        player.popup = null;
      } else {
        player.phase = 'question';
        player.popup = null;
        player.questionStartedAt = now;
        player.questionExpiresAt = now + QUESTION_TIME_MS;
      }
      room.updatedAt = now;
    }
    return;
  }

  // Đang trong thời gian trả lời: kiểm tra hết 30 giây chưa
  if (player.phase === 'question') {
    if (now >= player.questionExpiresAt) {
      const q = room.questions[player.currentQuestionIdx];
      player.phase = 'reveal';
      player.popup = {
        number: player.currentQuestionIdx + 1,
        timedOut: true,
        correct: false,
        points: 0,
        answer: q ? q.answer : '',
        text: '',
        nextAt: now + REVEAL_TIME_MS
      };
      room.updatedAt = now;
    }
  }
}

function updateRoom(room) {
  for (const player of room.players.values()) {
    updatePlayerPhase(player, room);
  }
  if (room.status === 'playing' && room.players.size > 0) {
    const allDone = [...room.players.values()].every(p => p.done);
    if (allDone) {
      room.status = 'finished';
      room.updatedAt = Date.now();
      room.cachedLeaderboard = computeLeaderboard(room);
    }
  }
}

function getLeaderboard(room) {
  // Dùng cache nếu chưa có thay đổi
  if (!room.cachedLeaderboard || room.status === 'finished') {
    room.cachedLeaderboard = computeLeaderboard(room);
  }
  return room.cachedLeaderboard;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    totalQuestions: room.questions ? room.questions.length : QUESTION_COUNT,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      correct: p.correct || 0,
      host: p.host,
      done: p.done
    })),
    leaderboard: getLeaderboard(room),
    finalLeaderboard: getLeaderboard(room),
    updatedAt: room.updatedAt
  };
}

function playerState(player, room) {
  if (!player) return null;
  const currentQ = (room.status === 'playing' && player.phase === 'question' && room.questions[player.currentQuestionIdx])
    ? {
        category: room.questions[player.currentQuestionIdx].category,
        prompt: room.questions[player.currentQuestionIdx].prompt,
        number: player.currentQuestionIdx + 1,
        total: room.questions.length,
        expiresAt: player.questionExpiresAt
      }
    : null;

  return {
    id: player.id,
    name: player.name,
    host: player.host,
    score: player.score || 0,
    correct: player.correct || 0,
    done: player.done,
    phase: player.phase,
    popup: player.popup,
    question: currentQ
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) req.destroy();
    });

    req.on('end', () => {
      let data = {};
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        return send(res, 400, { error: 'Dữ liệu không hợp lệ.' }, 'application/json', req);
      }

      // POST /api/rooms - Tạo phòng mới
      if (req.method === 'POST' && parts[1] === 'rooms' && parts.length === 2) {
        const hostName = cleanText(data.name, 24);
        if (!hostName) return send(res, 400, { error: 'Hãy nhập tên hiển thị của bạn.' }, 'application/json', req);

        const code = roomCode();
        const hostId = `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const room = {
          code,
          status: 'waiting',
          questions: [],
          players: new Map(),
          hostId,
          cachedLeaderboard: null,
          updatedAt: Date.now()
        };

        const hostPlayer = {
          id: hostId,
          name: hostName,
          host: true,
          score: 0,
          correct: 0,
          currentQuestionIdx: 0,
          questionStartedAt: 0,
          questionExpiresAt: 0,
          phase: 'waiting',
          popup: null,
          done: false
        };

        room.players.set(hostId, hostPlayer);
        rooms.set(code, room);
        room.cachedLeaderboard = computeLeaderboard(room);

        return send(res, 201, { room: publicRoom(room), playerId: hostId, host: true }, 'application/json', req);
      }

      // POST /api/join - Tham gia phòng
      if (req.method === 'POST' && parts[1] === 'join' && parts.length === 2) {
        const code = cleanText(data.code, 8).toUpperCase();
        const name = cleanText(data.name, 24);
        const room = rooms.get(code);

        if (!room) return send(res, 404, { error: 'Không tìm thấy phòng. Kiểm tra lại mã nhé.' }, 'application/json', req);
        if (!name) return send(res, 400, { error: 'Hãy nhập tên của bạn.' }, 'application/json', req);
        if (room.status === 'finished') return send(res, 409, { error: 'Ván chơi đã kết thúc.' }, 'application/json', req);
        if (room.players.size >= MAX_PLAYERS) return send(res, 409, { error: 'Phòng đã đủ 50 người.' }, 'application/json', req);

        const id = `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const isPlaying = room.status === 'playing';

        const player = {
          id,
          name,
          host: false,
          score: 0,
          correct: 0,
          currentQuestionIdx: 0,
          questionStartedAt: isPlaying ? Date.now() : 0,
          questionExpiresAt: isPlaying ? Date.now() + QUESTION_TIME_MS : 0,
          phase: isPlaying ? 'question' : 'waiting',
          popup: null,
          done: false
        };

        room.players.set(id, player);
        room.updatedAt = Date.now();
        room.cachedLeaderboard = computeLeaderboard(room);

        return send(res, 201, { room: publicRoom(room), playerId: id, host: false }, 'application/json', req);
      }

      const code = (parts[2] || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(res, 404, { error: 'Không tìm thấy phòng.' }, 'application/json', req);

      // GET /api/rooms/:code/state?playerId=... - Lấy trạng thái phòng & người chơi
      if (req.method === 'GET' && parts[3] === 'state') {
        updateRoom(room);
        const playerId = url.searchParams.get('playerId');
        const player = room.players.get(String(playerId || ''));
        return send(res, 200, {
          room: publicRoom(room),
          player: playerState(player, room)
        }, 'application/json', req);
      }

      // POST /api/rooms/:code/start - Host bắt đầu ván chơi
      if (req.method === 'POST' && parts[3] === 'start') {
        if (data.playerId !== room.hostId) return send(res, 403, { error: 'Chỉ host mới có thể bắt đầu.' }, 'application/json', req);
        if (room.status !== 'waiting') return send(res, 409, { error: 'Ván chơi đã bắt đầu.' }, 'application/json', req);

        room.status = 'playing';
        room.questions = pickRandomQuestions(allQuestions, QUESTION_COUNT);
        const now = Date.now();

        for (const p of room.players.values()) {
          p.score = 0;
          p.correct = 0;
          p.currentQuestionIdx = 0;
          p.questionStartedAt = now;
          p.questionExpiresAt = now + QUESTION_TIME_MS;
          p.phase = 'question';
          p.popup = null;
          p.done = false;
        }

        room.updatedAt = now;
        room.cachedLeaderboard = computeLeaderboard(room);
        return send(res, 200, { room: publicRoom(room) }, 'application/json', req);
      }

      // POST /api/rooms/:code/answer - Người chơi gửi câu trả lời
      if (req.method === 'POST' && parts[3] === 'answer') {
        updateRoom(room);
        const player = room.players.get(String(data.playerId || ''));
        if (!player) return send(res, 403, { error: 'Không nhận diện được người chơi.' }, 'application/json', req);
        if (room.status !== 'playing') return send(res, 409, { error: 'Ván chơi chưa bắt đầu hoặc đã kết thúc.' }, 'application/json', req);
        if (player.done) return send(res, 409, { error: 'Bạn đã hoàn thành các câu hỏi.' }, 'application/json', req);
        if (player.phase !== 'question') return send(res, 409, { error: 'Câu hỏi đang ở trạng thái xem kết quả.' }, 'application/json', req);

        const q = room.questions[player.currentQuestionIdx];
        if (!q) {
          player.done = true;
          player.phase = 'done';
          return send(res, 200, { room: publicRoom(room), player: playerState(player, room) }, 'application/json', req);
        }

        const now = Date.now();
        const elapsedSeconds = Math.max(0, Math.floor((now - player.questionStartedAt) / 1000));
        const timedOut = now > player.questionExpiresAt;
        const rawAnswer = cleanText(data.answer, 120);
        const isCorrect = !timedOut && checkAnswer(rawAnswer, q);

        let points = 0;
        if (isCorrect) {
          // Trả lời đúng: 100 điểm trừ 3 điểm cho mỗi giây trôi qua, tối thiểu 10 điểm
          points = Math.max(10, 100 - elapsedSeconds * 3);
          player.score += points;
          player.correct += 1;
        }

        player.phase = 'reveal';
        player.popup = {
          number: player.currentQuestionIdx + 1,
          timedOut: timedOut,
          correct: isCorrect,
          points: points,
          answer: q.answer,
          text: rawAnswer,
          nextAt: now + REVEAL_TIME_MS
        };

        room.updatedAt = now;
        room.cachedLeaderboard = computeLeaderboard(room);
        updateRoom(room);

        return send(res, 200, {
          room: publicRoom(room),
          player: playerState(player, room)
        }, 'application/json', req);
      }

      // POST /api/rooms/:code/finish - Host kết thúc ván sớm
      if (req.method === 'POST' && parts[3] === 'finish') {
        if (data.playerId !== room.hostId) return send(res, 403, { error: 'Chỉ host mới có thể kết thúc ván.' }, 'application/json', req);
        room.status = 'finished';
        for (const p of room.players.values()) {
          p.done = true;
          p.phase = 'done';
          p.popup = null;
        }
        room.updatedAt = Date.now();
        room.cachedLeaderboard = computeLeaderboard(room);
        return send(res, 200, { room: publicRoom(room) }, 'application/json', req);
      }

      // POST /api/rooms/:code/restart - Host chơi lại ván mới
      if (req.method === 'POST' && parts[3] === 'restart') {
        if (data.playerId !== room.hostId) return send(res, 403, { error: 'Chỉ host mới có thể bắt đầu lại.' }, 'application/json', req);
        room.status = 'playing';
        room.questions = pickRandomQuestions(allQuestions, QUESTION_COUNT);
        const now = Date.now();
        for (const p of room.players.values()) {
          p.score = 0;
          p.correct = 0;
          p.currentQuestionIdx = 0;
          p.questionStartedAt = now;
          p.questionExpiresAt = now + QUESTION_TIME_MS;
          p.phase = 'question';
          p.popup = null;
          p.done = false;
        }
        room.updatedAt = now;
        room.cachedLeaderboard = computeLeaderboard(room);
        return send(res, 200, { room: publicRoom(room) }, 'application/json', req);
      }

      return send(res, 404, { error: 'Không tìm thấy đường dẫn API.' }, 'application/json', req);
    });
    return;
  }

  // Phục vụ tệp tĩnh (HTML, CSS, JS, hình ảnh, icon) với ETag và Cache trong bộ nhớ
  const safePath = path.normalize(parts.length ? path.join(...parts) : 'index.html');
  const file = path.join(ROOT, safePath);

  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8', req);

  // Kiểm tra cache trong bộ nhớ
  const cached = staticCache.get(file);
  if (cached) {
    if (req.headers['if-none-match'] === cached.etag) {
      res.writeHead(304, { 'ETag': cached.etag });
      return res.end();
    }
    return send(res, 200, cached.bytes, cached.type, req);
  }

  fs.stat(file, (err, stats) => {
    if (err || !stats.isFile()) return send(res, 404, 'Không tìm thấy trang.', 'text/plain; charset=utf-8', req);

    const etag = `"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag });
      return res.end();
    }

    fs.readFile(file, (readErr, bytes) => {
      if (readErr) return send(res, 404, 'Không tìm thấy trang.', 'text/plain; charset=utf-8', req);
      const ext = path.extname(file).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      const type = mimeTypes[ext] || 'application/octet-stream';
      // Lưu vào bộ đệm tĩnh
      staticCache.set(file, { bytes, type, etag });
      res.setHeader('ETag', etag);
      send(res, 200, bytes, type, req);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`\n✦ ĐỐ VUI DÂN GIAN ĐANG CHẠY!`);
  console.log(`- Trình duyệt máy này: http://localhost:${PORT}`);
  if (localIp) {
    console.log(`- Điện thoại / máy khác (cùng WiFi): http://${localIp}:${PORT}`);
  }
  console.log('');
});

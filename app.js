const $ = selector => document.querySelector(selector);
const state = { code: null, playerId: null, host: false, room: null, player: null, poll: null, clock: null, currentQuestionNo: null };
const home = $('#home');
const lobby = $('#lobby');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Có lỗi xảy ra.');
  return data;
}
function showHomeError(message) { const el = $('#homeError'); el.textContent = message; el.classList.remove('hidden'); }
function setTab(tabName) {
  document.querySelectorAll('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tabName));
  $('#joinForm').classList.toggle('hidden', tabName !== 'join');
  $('#createForm').classList.toggle('hidden', tabName !== 'create');
  $('#homeError').classList.add('hidden');
}
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));

function enterRoom(data) {
  state.code = data.room.code; state.playerId = data.playerId; state.host = data.host;
  home.classList.add('hidden'); lobby.classList.remove('hidden');
  history.replaceState({}, '', `/?room=${state.code}`);
  const shareUrl = `${location.origin}/?room=${state.code}`;
  $('#shareLink').value = shareUrl; $('#roomCodeLabel').textContent = state.code; $('#qrCodeText').textContent = state.code;
  $('#qrImage').classList.remove('hidden'); $('#qrFallback').style.display = 'none';
  $('#qrImage').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareUrl)}`;
  $('#qrImage').onerror = () => { $('#qrImage').classList.add('hidden'); $('#qrFallback').style.display = 'block'; };
  $('#hostControls').classList.toggle('hidden', !state.host);
  $('#hostGameControls').classList.toggle('hidden', !state.host);
  refresh(); clearInterval(state.poll); clearInterval(state.clock);
  state.poll = setInterval(refresh, 1000);
  state.clock = setInterval(renderClock, 200);
}
$('#createForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#homeError').classList.add('hidden');
  try { enterRoom(await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name: $('#hostName').value }) })); }
  catch (error) { showHomeError(error.message); }
});
$('#joinForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#homeError').classList.add('hidden');
  try { enterRoom(await api('/api/join', { method: 'POST', body: JSON.stringify({ name: $('#joinName').value, code: $('#roomCode').value }) })); }
  catch (error) { showHomeError(error.message); }
});

function renderPlayers(players) {
  $('#playerCount').textContent = `${players.length} / 50`;
  $('#playerList').innerHTML = players.map(player => `<li><span>${escapeHtml(player.name)}${player.host ? ' 👑' : ''}${player.id === state.playerId ? ' <b>(bạn)</b>' : ''}</span><small>${player.score} điểm</small></li>`).join('');
}
function renderLeaderboard(players, target) {
  target.innerHTML = players.length
    ? players.slice(0, 3).map(player => `<li class="rank-${player.rank}"><span class="rank-number">${player.rank}</span><span class="rank-name">${escapeHtml(player.name)}${player.id === state.playerId ? ' <b>(bạn)</b>' : ''}<small>${player.correct} câu đúng</small></span><strong>${player.score} điểm</strong></li>`).join('')
    : '<li class="empty-rank">Chưa có điểm nào</li>';
}
function renderClock() {
  const player = state.player;
  if (player?.phase === 'reveal' && player.popup) {
    const seconds = Math.max(0, Math.ceil((player.popup.nextAt - Date.now()) / 1000));
    $('#popupCountdown').textContent = seconds ? `Câu tiếp theo sau ${seconds} giây` : 'Đang chuyển sang câu tiếp theo…';
    return;
  }
  const question = player?.question;
  if (!question) return;
  const remaining = Math.max(0, question.expiresAt - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  $('#timer').textContent = seconds;
  $('#timerBar').style.width = `${Math.max(0, remaining / 30000 * 100)}%`;
  $('#timerBadge').classList.toggle('urgent', seconds <= 8);
}
async function refresh() {
  if (!state.code) return;
  try {
    const data = await api(`/api/rooms/${state.code}/state?playerId=${encodeURIComponent(state.playerId)}`);
    state.room = data.room; state.player = data.player;
    const room = data.room;
    renderPlayers(room.players);
    renderLeaderboard(room.leaderboard, $('#leaderboardList'));
    $('#myScore').textContent = `${data.player?.score || 0} điểm`;
    const waiting = room.status === 'waiting';
    $('#roomStatus').textContent = waiting ? 'PHÒNG CHỜ' : room.status === 'playing' ? 'ĐANG ĐỐ VUI' : 'ĐÃ KẾT THÚC';
    $('#roomHint').textContent = waiting ? 'Mời mọi người vào phòng rồi bắt đầu nhé.' : room.status === 'playing' ? 'Mỗi người trả lời theo nhịp riêng; sau mỗi câu sẽ có 3 giây xem đáp án.' : 'Cảm ơn mọi người đã cùng chơi!';
    $('#startBtn').classList.toggle('hidden', !state.host || !waiting);
    $('#finishBtn').classList.toggle('hidden', !state.host || room.status !== 'playing');
    $('#lobbyGrid').classList.toggle('hidden', room.status !== 'waiting');
    $('#gamePanel').classList.toggle('hidden', room.status !== 'playing');
    $('#resultPanel').classList.toggle('hidden', room.status !== 'finished');
    if (room.status === 'playing' && data.player) {
      const player = data.player;
      const inReveal = player.phase === 'reveal' && player.popup;
      $('#answerPopup').classList.toggle('hidden', !inReveal);
      $('#questionView').classList.toggle('hidden', player.done || !!inReveal);
      $('#doneView').classList.toggle('hidden', !player.done);
      $('#hostGameControls').classList.toggle('hidden', !state.host);
      if (inReveal) {
        const popup = player.popup;
        $('#popupQuestionNumber').textContent = `CÂU ${popup.number} / 30`;
        $('#popupStatus').textContent = popup.timedOut ? 'Hết giờ!' : popup.correct ? `Chính xác! +${popup.points} điểm` : 'Chưa đúng';
        $('#popupStatus').className = `popup-status ${popup.timedOut ? 'timeout' : popup.correct ? 'good' : 'wrong'}`;
        $('#popupAnswer').textContent = popup.answer;
        $('#popupYourAnswer').textContent = popup.timedOut ? 'Bạn chưa kịp trả lời câu này.' : `Bạn đã trả lời: ${popup.text}`;
      } else if (player.question) {
        const question = player.question;
        $('#questionCategory').textContent = question.category.toLocaleUpperCase('vi');
        $('#questionNumber').textContent = `CÂU ${question.number} / ${question.total}`;
        $('#questionText').textContent = question.prompt;
        $('#answerInput').disabled = false;
        $('#answerButton').disabled = false;
        $('#answerInput').placeholder = 'Tự gõ câu trả lời của bạn…';
        if (state.currentQuestionNo !== question.number) {
          $('#answerInput').value = '';
          state.currentQuestionNo = question.number;
          $('#answerInput').focus();
        }
        renderClock();
      }
    }
    if (room.status === 'finished') {
      $('#answerPopup').classList.add('hidden');
      $('#finalSummary').textContent = 'Mọi người đã hoàn thành 30 câu hỏi.';
      renderLeaderboard(room.finalLeaderboard || [], $('#finalLeaderboard'));
      clearInterval(state.poll); clearInterval(state.clock);
    }
  } catch (error) {
    if (error.message.includes('Không tìm thấy')) { clearInterval(state.poll); clearInterval(state.clock); toast(error.message); }
  }
}

$('#startBtn').addEventListener('click', async () => {
  try { await api(`/api/rooms/${state.code}/start`, { method: 'POST', body: JSON.stringify({ playerId: state.playerId }) }); await refresh(); }
  catch (error) { toast(error.message); }
});
$('#finishBtn').addEventListener('click', async () => {
  try { await api(`/api/rooms/${state.code}/finish`, { method: 'POST', body: JSON.stringify({ playerId: state.playerId }) }); await refresh(); }
  catch (error) { toast(error.message); }
});
$('#finishGameBtn').addEventListener('click', async () => {
  try { await api(`/api/rooms/${state.code}/finish`, { method: 'POST', body: JSON.stringify({ playerId: state.playerId }) }); await refresh(); }
  catch (error) { toast(error.message); }
});
$('#answerForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#answerButton'); button.disabled = true;
  try {
    const result = await api(`/api/rooms/${state.code}/answer`, { method: 'POST', body: JSON.stringify({ playerId: state.playerId, questionNumber: state.player.question.number, answer: $('#answerInput').value }) });
    $('#answerInput').value = '';
    state.currentQuestionNo = result.player?.questionNumber ?? state.currentQuestionNo;
    await refresh();
  } catch (error) { toast(error.message); }
  finally { if (state.player?.phase === 'question') button.disabled = false; }
});
async function copy(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast(text); }
}
$('#copyBtn').addEventListener('click', () => copy($('#shareLink').value, 'Đã sao chép link phòng'));
$('#copyCodeBtn').addEventListener('click', () => copy(state.code, 'Đã sao chép mã phòng'));
$('#leaveBtn').addEventListener('click', () => { clearInterval(state.poll); clearInterval(state.clock); location.href = '/'; });

const initialCode = new URLSearchParams(location.search).get('room');
if (initialCode) { setTab('join'); $('#roomCode').value = initialCode.toUpperCase(); $('#joinName').focus(); }

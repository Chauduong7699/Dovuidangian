const { spawn } = require('child_process');

// 1. Khởi chạy server game (nếu chưa chạy độc lập)
try {
  require('./server.js');
} catch (e) {
  // Bỏ qua nếu port đã có server chạy
}

console.log('🌐 Đang kết nối tạo đường link HTTPS công khai ra Internet (miễn phí)...');

// 2. Kết nối tunnel qua SSH (sử dụng 127.0.0.1 IPv4)
const ssh = spawn('ssh', [
  '-R', '80:127.0.0.1:3000',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'ServerAliveInterval=30',
  'nokey@localhost.run'
], { stdio: ['ignore', 'pipe', 'pipe'] });

let foundLink = false;

function inspectOutput(chunk) {
  const text = chunk.toString();
  const match = text.match(/https:\/\/[a-zA-Z0-9\-_.]+\.lhr\.life/);
  if (match && !foundLink) {
    foundLink = true;
    console.log('\n======================================================');
    console.log('🎉 ĐÃ ĐƯA LÊN MẠNG THÀNH CÔNG!');
    console.log('👉 LINK CÔNG KHAI (HTTPS): ' + match[0]);
    console.log('📱 Bạn bè ở bất kỳ đâu chỉ cần bấm link hoặc quét QR để chơi!');
    console.log('======================================================\n');
  }
}

ssh.stdout.on('data', inspectOutput);
ssh.stderr.on('data', inspectOutput);

ssh.on('error', err => {
  console.log('Lỗi kết nối tunnel:', err.message);
});

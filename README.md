# Đố Vui Dân Gian

Game đố vui theo phòng, tối đa 50 người. Host tạo phòng và chia sẻ mã hoặc link/QR. Người chơi vào bằng tên, tự gõ câu trả lời cho 30 câu hỏi dân gian, câu đố mẹo và ca dao tục ngữ. Mỗi câu có 30 giây; sau khi trả lời hoặc hết giờ, người chơi thấy popup báo đúng/sai và đáp án trong 3 giây rồi tự sang câu tiếp theo. Đáp án đúng được 100 điểm trừ 3 điểm cho mỗi giây đã trôi qua, tối thiểu 10 điểm. Trả lời sai hoặc hết giờ được 0 điểm. Cuối ván hiển thị top 3.

## Chạy trên máy

1. Cài Node.js 18 trở lên.
2. Mở terminal tại thư mục dự án và chạy `npm start`.
3. Truy cập `http://localhost:3000`.

Để người chơi dùng thiết bị khác tham gia, cần đưa ứng dụng lên máy chủ có địa chỉ truy cập công khai. Mã phòng và điểm hiện được giữ trong bộ nhớ máy chủ; khởi động lại server sẽ xóa các phòng. Dùng một máy chủ Node duy nhất để đồng bộ câu hỏi và điểm.

Ngân hàng hiện có 163 câu trong `questions.js` và `questions-extra.js`; mỗi ván chọn ngẫu nhiên 30 câu không lặp. QR tạo qua dịch vụ QR bên ngoài. Người chơi vẫn có thể vào bằng link hoặc mã nếu QR không tải được.

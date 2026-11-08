FROM node:20-alpine

WORKDIR /app

COPY package.json ./

# Dự án chỉ dùng module chuẩn của Node.js (zero external dependencies)
# nên quá trình build siêu nhẹ và nhanh!

COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]

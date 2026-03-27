FROM node:18-slim

RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

RUN mkdir -p uploads outputs music public

EXPOSE 8080
ENV PORT=8080

CMD ["node", "server.js"]
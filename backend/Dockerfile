FROM node:20-slim

# Install Python + yt-dlp (required for audio extraction)
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install yt-dlp --break-system-packages && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]

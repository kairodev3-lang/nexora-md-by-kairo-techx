FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . ./
ENV NODE_ENV=production SESSIONS_DIR=/data/sessions
RUN mkdir -p /data/sessions && chown -R node:node /data /app
EXPOSE 3000
USER node
CMD ["node", "index.js"]

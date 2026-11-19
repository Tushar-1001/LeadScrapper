# ── Stage 1: Build React/Vite Frontend ──
FROM node:20-slim AS client-builder
WORKDIR /app/client

COPY client/package*.json ./
RUN npm install

COPY client/ ./
RUN npm run build

# ── Stage 2: Production Server with Headless Chromium ──
FROM node:20-slim

# Install Chromium and system dependencies required for Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Universal port: 7860 default for Hugging Face (or overridden by PORT env)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=7860

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy server entrypoint
COPY server.js ./

# Copy built frontend assets from stage 1
COPY --from=client-builder /app/client/dist ./client/dist

# Ensure non-root node user (UID 1000) has ownership for Hugging Face Spaces
RUN chown -R node:node /app

USER node

EXPOSE 7860

CMD ["node", "server.js"]

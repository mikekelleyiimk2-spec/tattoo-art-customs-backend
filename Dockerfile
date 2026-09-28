FROM node:20-slim

# better-sqlite3 needs build tools for the native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

COPY . .

# Render provides DATABASE_URL (PostgreSQL). Migrations run automatically at startup.
ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "node src/db/seed.js && node src/index.js"]

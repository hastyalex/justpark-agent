FROM mcr.microsoft.com/playwright:v1.63.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm install tsx
COPY . .
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/server.ts"]

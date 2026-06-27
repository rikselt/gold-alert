FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install only chromium for playwright
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "server/index.js"]

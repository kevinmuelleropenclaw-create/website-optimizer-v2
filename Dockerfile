FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy app
COPY . .

# Create non-root user
USER node

EXPOSE 3000

CMD ["node", "server.js"]
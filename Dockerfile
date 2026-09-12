FROM node:22-alpine
WORKDIR /app
COPY package.json .npmrc ./
RUN npm install --omit=dev --no-audit --no-fund --package-lock=false
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]

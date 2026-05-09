FROM node:20-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 4000
CMD ["node", "src/index.js"]

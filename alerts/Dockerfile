FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
CMD ["node","server.mjs"]

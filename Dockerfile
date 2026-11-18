FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY backend ./backend
COPY frontend ./frontend
USER node
ENV NODE_ENV=production DATA_DIRECTORY=/data PORT=8082 HOST=0.0.0.0
EXPOSE 8082
CMD ["node","backend/server.cjs"]

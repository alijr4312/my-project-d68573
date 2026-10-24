FROM node:22-alpine
WORKDIR /app
COPY . /app/
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY lib ./lib
COPY examples/operations ./examples/operations
COPY deploy/public/server.mjs ./deploy/public/server.mjs
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 4181
CMD ["node", "deploy/public/server.mjs"]

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY bin ./bin
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 4180
ENTRYPOINT ["node", "/app/bin/dygk.js", "serve"]
CMD ["--directory", "/site", "--database", "/data/dygk.sqlite", "--host", "0.0.0.0", "--port", "4180", "--mode", "observe"]

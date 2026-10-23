FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS production
# The commit this image was built from (CI passes --build-arg GIT_SHA=<sha>).
# /health reports it as `version`, so a deploy or rollback can prove what is serving.
ARG GIT_SHA=unknown
ENV APP_VERSION=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY templates ./templates
COPY swagger.yaml ./swagger.yaml
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "./dist/app.js"]

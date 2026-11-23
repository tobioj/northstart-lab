# Generic Node hosting (any container platform or VM). TLS is terminated by the platform
# or a reverse proxy in front of this container. Configuration comes from env vars only.
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN node scripts/build.js
ENV NORTHSTAR_BIND=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "scripts/serve.js"]

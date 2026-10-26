# Upstream cobalt ships Node 24.14.1 and Alpine OpenSSL 3.5.5; swap in a patched runtime until it releases.
FROM ghcr.io/imputnet/cobalt:11.7.1
USER root
RUN apk upgrade --no-cache
COPY --from=node:24.22.1-alpine3.23 /usr/local/bin/node /usr/local/bin/node
USER node

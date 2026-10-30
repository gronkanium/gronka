# Upstream cobalt ships Node 24.14.1 and Alpine OpenSSL 3.5.5; swap in a patched runtime until it releases.
# nftables and contain.sh give it the same egress fence as the bot (compose starts it as root for that).
FROM ghcr.io/imputnet/cobalt:11.7.1
USER root
# BusyBox's setpriv has no --reuid; the real one lands in /usr/bin, which contain.sh prefers.
RUN apk upgrade --no-cache && apk add --no-cache nftables setpriv
COPY --from=node:24.22.1-alpine3.23 /usr/local/bin/node /usr/local/bin/node
COPY scripts/contain.sh /usr/local/bin/contain.sh
RUN chmod +x /usr/local/bin/contain.sh
USER node
ENTRYPOINT ["contain.sh", "docker-entrypoint.sh"]
CMD ["node", "src/cobalt"]

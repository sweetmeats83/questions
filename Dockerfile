FROM node:22-alpine

RUN apk upgrade --no-cache && apk add --no-cache curl su-exec

WORKDIR /app

# Install server dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Download dice-box library assets into the static directory
RUN curl -fsSL "https://registry.npmjs.org/@3d-dice/dice-box/-/dice-box-1.1.4.tgz" \
    | tar -xz -C /tmp \
 && mkdir -p /app/static/dice-box \
 && cp /tmp/package/dist/dice-box.es.js \
       /tmp/package/dist/world.offscreen.js \
       /tmp/package/dist/world.onscreen.js \
       /tmp/package/dist/world.none.js \
       /app/static/dice-box/ \
 && cp -r /tmp/package/dist/assets/. /app/static/dice-box/ \
 && rm -rf /tmp/package \
 && curl -fsSL "https://registry.npmjs.org/@3d-dice/theme-rust/-/theme-rust-0.2.0.tgz" \
    | tar -xz -C /tmp \
 && mkdir -p /app/static/dice-box/themes/rust \
 && cp /tmp/package/theme.config.json \
       /tmp/package/diffuse-light.png \
       /tmp/package/diffuse-dark.png \
       /tmp/package/normal.png \
       /tmp/package/specular.jpg \
       /app/static/dice-box/themes/rust/ \
 && rm -rf /tmp/package

RUN apk del curl

# Copy app static files and server
COPY app/ /app/static/
COPY server.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g nospoon

ENTRYPOINT ["nospoon"]
CMD ["up"]

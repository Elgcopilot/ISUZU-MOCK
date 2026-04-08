FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080
ENV PRISM_PORT=4000

EXPOSE 8080

CMD ["npm", "run", "start:prod"]
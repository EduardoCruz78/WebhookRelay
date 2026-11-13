# WebhookRelay

Reliable event delivery service in TypeScript / Node.js. It receives domain events (for example from
[SchedulingApi](https://github.com/EduardoCruz78/SchedulingApi)), queues them and delivers them to
registered destinations (webhooks, e-mail, Telegram) with retries, idempotency and HMAC signatures.

> Work in progress. This README grows with each milestone.

## Running locally

Requirements: Node.js 24 (see `.nvmrc`) and Docker.

```bash
npm install
npm run check        # lint, format check, typecheck, build and tests
docker compose up --build
```

Then open <http://localhost:3000/health>.

## License

[MIT](LICENSE)

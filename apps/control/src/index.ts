import { buildServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const app = buildServer();

await app.listen({ host: '0.0.0.0', port });
console.log(`opsagent-control listening on :${port}`);

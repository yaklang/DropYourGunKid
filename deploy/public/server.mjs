import { createLab } from '../../examples/operations/server.js';

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const trustedProxies = (process.env.TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean);
const mode = process.env.DYGK_MODE ?? 'block';
if (!['observe', 'block'].includes(mode)) throw new Error('DYGK_MODE must be observe or block');
if (!trustedProxies.length) console.warn('TRUSTED_PROXIES is empty; all clients will appear as the proxy address');

const { server } = createLab({
  mode,
  database: process.env.DYGK_DB ?? '/data/dygk.sqlite',
  eventFile: process.env.DYGK_EVENTS ?? '/data/events.jsonl',
  goal: process.env.DYGK_GOAL,
  maxRequests: Infinity,
  defenseOptions: {
    trustedProxies,
    banTTL: integer('DYGK_BAN_TTL', 900),
    retentionDays: integer('DYGK_RETENTION_DAYS', 7),
    maxEvents: integer('DYGK_MAX_EVENTS', 50000),
    maxSessions: integer('DYGK_MAX_SESSIONS', 10000),
    trace: false,
  },
});
server.listen(4181, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.close(); server.closeAllConnections(); });

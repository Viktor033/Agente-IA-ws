import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, all, run } from './db/db.js';
import { ensureSeeded, resetDatabase } from './db/seed.js';
import { checkConfig } from './config.js';
import { handleMessage, resetConversation, localReply } from './agent/agent.js';
import { registerWhatsAppRoutes } from './channels/whatsapp.js';
import { startWhatsAppBot } from './whatsapp/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
checkConfig();
await getDb();

const seed = await ensureSeeded();
console.log(seed.reset
  ? `🧹 Base reiniciada a cero (messages, leads, visits y handoffs limpiados) con ${seed.count} propiedades iniciales.`
  : seed.seeded
    ? `🌱 Base vacía: se cargaron ${seed.count} propiedades de ejemplo.`
    : `🗄️  Base OK: ${seed.count} propiedades disponibles.`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/chat', async (req, res) => {
  const { phone, text } = req.body || {};
  if (!phone || !text?.trim()) return res.status(400).json({ error: 'phone y text son requeridos' });
  const t0 = Date.now();
  try {
    const out = await handleMessage(String(phone), text.trim());
    const elapsed = Date.now() - t0;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
    res.json(out);
  } catch (e) {
    console.error(e);
    const elapsed = Date.now() - t0;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
    res.json(localReply(String(phone), text.trim()));
  }
});

app.get('/api/history/:phone', (req, res) => {
  res.json(all('SELECT role, content, created_at FROM messages WHERE phone=$p ORDER BY id', { $p: req.params.phone }));
});

app.post('/api/reset/:phone', (req, res) => {
  resetConversation(req.params.phone);
  res.json({ ok: true });
});

app.post('/api/reset-all', async (_req, res) => {
  const count = await resetDatabase();
  res.json({ ok: true, properties: count });
});

app.get('/api/admin/summary', (_req, res) => {
  res.json({
    leads: all('SELECT * FROM leads ORDER BY updated_at DESC'),
    visits: all(`SELECT v.*, p.title, p.address FROM visits v LEFT JOIN properties p ON p.code=v.property_code ORDER BY v.datetime`),
    handoffs: all('SELECT * FROM handoffs ORDER BY id DESC'),
    properties: all('SELECT code,title,operation,type,neighborhood,price_usd,bedrooms,area_m2 FROM properties ORDER BY code'),
  });
});

app.post('/api/admin/handoffs/:id/resolve', (req, res) => {
  run(`UPDATE handoffs SET status='resuelto' WHERE id=$id`, { $id: Number(req.params.id) });
  res.json({ ok: true });
});

registerWhatsAppRoutes(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏠 Simulador listo en http://localhost:${PORT}`);
  if (process.env.WHATSAPP_ENABLED !== 'false') {
    startWhatsAppBot().catch((e) => console.error('❌ No se pudo iniciar WhatsApp:', e.message));
  }
});
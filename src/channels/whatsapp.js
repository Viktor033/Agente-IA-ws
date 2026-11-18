// Adaptador de canal WhatsApp (pendiente).
// Cuando elijas un proveedor (Meta Cloud API o Twilio), implementá:
//   1) Un webhook POST que reciba { from, text } y llame a handleMessage(from, text)
//   2) sendMessage(to, text) que envíe cada burbuja devuelta en `bubbles`
// La lógica del agente no cambia: es la misma que usa el simulador.
import { handleMessage } from '../agent/agent.js';

export function registerWhatsAppRoutes(app) {
  app.post('/webhook/whatsapp', async (req, res) => {
    // TODO: parsear el payload del proveedor elegido.
    res.sendStatus(501);
  });
}

export async function sendMessage(to, text) {
  throw new Error('Canal WhatsApp aún no configurado');
}

export { handleMessage };

import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { handleMessage, localReply } from '../agent/agent.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

export async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Escanea este código QR con tu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Conexión de WhatsApp cerrada. Reconectando...', shouldReconnect);
      if (shouldReconnect) startWhatsAppBot();
    } else if (connection === 'open') {
      console.log('✅ ¡Bot conectado exitosamente a WhatsApp con tu número!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const phone = msg.key.remoteJid;

      // Ignorar mensajes enviados por ti, sin contenido, o que provengan de grupos (@g.us)
      if (msg.key.fromMe || !msg.message || phone.endsWith('@g.us')) continue;

      const text = 
        msg.message.conversation || 
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption;

      if (!text) continue;

      console.log(`📩 Mensaje privado de ${phone}: "${text}"`);

      let response;
      try {
        // handleMessage ya responde desde la base local si Gemini falla
        response = await handleMessage(phone, text);
      } catch (error) {
        console.error('❌ Error procesando mensaje:', error.message);
        response = localReply(phone, text);
      }
      try {
        for (const bubble of response?.bubbles || []) {
          await sock.sendPresenceUpdate('composing', phone).catch(() => {});
          await new Promise((res) => setTimeout(res, 1000));
          await sock.sendMessage(phone, { text: bubble });
        }
        await sock.sendPresenceUpdate('paused', phone).catch(() => {});
      } catch (error) {
        console.error('❌ Error enviando mensaje por WhatsApp:', error.message);
      }
    }
  });
}
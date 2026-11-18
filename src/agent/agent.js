// Bucle del agente: Gemini + function calling + historial por teléfono.
import { GoogleGenAI } from '@google/genai';
import { buildSystemPrompt, CONTACT_PHONE } from './systemPrompt.js';
import { toolDeclarations, makeToolHandlers, handoff, isHandedOff, closestProperty } from './tools.js';
import { all, get, run } from '../db/db.js';
import { DEFAULT_MODEL } from '../config.js';

// Modelo configurado primero; si no existe o falla, se prueban los de respaldo.
const MODELS = [...new Set([process.env.GEMINI_MODEL?.trim(), DEFAULT_MODEL, 'gemini-2.0-flash'].filter(Boolean))];
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() }) : null;
let activeModel = MODELS[0];
const MAX_TOOL_STEPS = 10; // búsqueda + disponibilidad + lead + agenda en un mismo turno

// Detector previo de las reglas de oro (red de seguridad además del modelo).
const HUMAN_RE = /(hablar|comunicar|contactar|pasame|pasar).{0,25}(persona|humano|asesor|agente|vendedor|alguien)|persona real|\basesor\b.*(por favor|quiero)/i;
const OFFER_RE = /(ofrezco|oferta(r)?|te doy|les doy|pago|propongo).{0,30}(u\$?s|usd|d[oó]lares|\$|\d{2,3}\.?\d{3})/i;

const HANDOFF_MSG = 'Perfecto, ya le paso tu consulta a un *asesor comercial* 🙌\n---\nTe va a escribir por este mismo chat a la brevedad. ¡Gracias por tu paciencia!';

function history(phone) {
  return all('SELECT role, content FROM messages WHERE phone=$p ORDER BY id DESC LIMIT 30', { $p: phone })
    .reverse()
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
}

function save(phone, role, content) {
  run('INSERT INTO messages (phone, role, content) VALUES ($p,$r,$c)', { $p: phone, $r: role, $c: content });
}

/** Divide la respuesta en burbujas de WhatsApp (por "---" o cada ~10 líneas para no cortar listas semanales). */
function toBubbles(text) {
  return text.split(/\n\s*-{3,}\s*\n/).flatMap((chunk) => {
    const lines = chunk.trim().split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 10) out.push(lines.slice(i, i + 10).join('\n').trim());
    return out;
  }).filter(Boolean);
}

/** Llamada a Gemini SIN timeout; reintenta solo ante saturación real del servicio (429/500/503). */
async function generateWithRetry(aiClient, params, retries = 4, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await aiClient.models.generateContent(params);
    } catch (error) {
      const overloaded = [429, 500, 503].includes(error?.status);
      if (overloaded && attempt < retries) {
        console.warn(`⚠️ API de Gemini saturada (Intento ${attempt}/${retries}). Reintentando en ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Backoff exponencial
      } else {
        throw error;
      }
    }
  }
}

/** Prueba el modelo activo y, si es inválido (404/400) o falla, los de respaldo. */
async function generate(params) {
  let lastErr;
  const order = [activeModel, ...MODELS.filter((m) => m !== activeModel)];
  for (const model of order) {
    try {
      const res = await generateWithRetry(ai, { ...params, model }, model === activeModel ? 3 : 1);
      if (model !== activeModel) { console.warn(`ℹ️  Usando modelo de respaldo: ${model}`); activeModel = model; }
      return res;
    } catch (e) {
      lastErr = e;
      if ([401, 403].includes(e?.status)) break; // clave inválida: no tiene sentido probar otros modelos
    }
  }
  throw lastErr;
}

// ---------- Respuesta local (sin Gemini): consulta directa a la base ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Normalización fonética/tolerante a errores de ortografía en español ("alkilar" -> "alkilar", "b"/"v", "s"/"z"/"c", "ll"/"y", sin "h"). */
function normFlex(s) {
  return norm(s)
    .replace(/[^a-z0-9\s.,$]/g, ' ')
    .replace(/\bh/g, '')
    .replace(/qu|c(?=[aou])|k/g, 'k')
    .replace(/c(?=[ei])|z/g, 's')
    .replace(/ll|y/g, 'y')
    .replace(/v/g, 'b')
    .replace(/(.)\1+/g, '$1');
}

function editDist(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function matchNeighborhood(text) {
  const t = norm(text);
  const tf = normFlex(text);
  const words = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
  const neighborhoods = all('SELECT DISTINCT neighborhood FROM properties').map((r) => r.neighborhood);

  for (const n of neighborhoods) {
    const nn = norm(n);
    const nf = normFlex(n);
    if (t.includes(nn) || tf.includes(nf) || t.includes(nn.replace(/\s+/g, ''))) return n;
    // Coincidencia por palabra principal (p.ej. "urquiza"/"urkisa" -> "Villa Urquiza", "madero" -> "Puerto Madero")
    const parts = nn.split(/\s+/).filter((p) => p.length >= 4);
    for (const part of parts) {
      const pf = normFlex(part);
      if (words.some((w) => normFlex(w) === pf || (part.length >= 5 && editDist(w, part) <= 1))) return n;
    }
  }
  return null;
}

function parseQuery(text) {
  const t = norm(text);
  const tf = normFlex(text);
  const a = {};
  if (/al[kq]u?il|arend|rent/.test(t) || /alkil|rent/.test(tf)) a.operacion = 'alquiler';
  else if (/c[o0][mn]pr|[vb]ent|in[vb]ert|adquir/.test(t) || /konpr|kompr|bent|inbert/.test(tf)) a.operacion = 'venta';
  if (/\b([ck]asa|ph|chalet|duplex)\b/.test(t)) a.tipo = 'casa';
  else if (/d(ep|p)?to|departament|mono\s*a[mn]b|\ba[mn]b/.test(t)) a.tipo = 'departamento';
  else if (/\blo[ck]al\b/.test(t)) a.tipo = 'local';
  else if (/teren|terren|lote/.test(t)) a.tipo = 'terreno';
  const barrio = matchNeighborhood(text);
  if (barrio) a.barrio = barrio;
  const nums = [...t.matchAll(/(\d+(?:[.,]\d{3})*)\s*(mil\b|k\b)?/g)]
    .map((m) => Number(m[1].replace(/[.,]/g, '')) * (m[2] ? 1000 : 1));
  const money = Math.max(0, ...nums);
  if (money >= 100 && /(hasta|max|usd|u\$s|dolar|\$|presup|mil|k\b)/.test(t)) a.precio_max_usd = money;
  const d = /(\d)\s*(dorm|habit|cuart|piez|abita)/.exec(t);
  if (d) a.dormitorios_min = Number(d[1]);
  return a;
}

function formatListings(props) {
  return props.map((p) => {
    const price = p.operation === 'alquiler'
      ? `USD ${p.price_usd.toLocaleString('es-AR')}/mes (alquiler)`
      : `USD ${p.price_usd.toLocaleString('es-AR')} (venta)`;
    return `🏠 *${p.title}* (${p.code})\n📍 ${p.address}, ${p.neighborhood}\n💰 ${price} · ${p.area_m2} m² · ${p.bedrooms} dorm.\n✨ ${p.amenities}`;
  }).join('\n---\n');
}

function formatDetailedProperty(p) {
  const price = `USD ${p.price_usd.toLocaleString('es-AR')}${p.operation === 'alquiler' ? '/mes (alquiler)' : ' (venta)'}`;
  const dorms = p.bedrooms > 0 ? `${p.bedrooms} dorm.` : 'Monoambiente / sin dorm.';
  const baths = p.bathrooms > 0 ? ` · ${p.bathrooms} baño${p.bathrooms > 1 ? 's' : ''}` : '';
  return `🏠 *${p.title}* (${p.code})\n`
    + `📍 *Dirección:* ${p.address}, ${p.neighborhood}\n`
    + `💰 *Precio:* ${price}\n`
    + `📐 *Superficie y ambientes:* ${p.area_m2} m² · ${dorms}${baths}\n`
    + `✨ *Amenities:* ${p.amenities || 'Consultar'}\n`
    + `📝 *Detalles:* ${p.description || 'Excelente ubicación y estado.'}`;
}

const GREETING_RE = /^\s*(h?ola+|buen[oa]s?( d[ií]as| tardes| noches)?|wenas+|qu[eé]\s+tal|k\s+tal|q\s+tal|hey|holis+)[\s!.,¡?¿]*$/i;
const FAREWELL_RE = /\b(gra[cs]ias+|agrade[zs]co|chau+|chao+|hasta\s+(luego|pronto|ma[nñ]ana)|nos\s+[vb]emos|adi[oó]s|saludos|muy\s+amable|que\s+tengas\s+(un\s+)?(buen|excelente)\s+d[ií]a)\b/i;
const SHOW_AVAILABLE_RE = /((\bqu[eé]|\bke?|\bq)\s+(ten[eé]s|tienes|hay|op[cs]iones|propiedades)|mostr[aá]|[vb]er\s+(op[cs]iones|propiedades|todo|cat[aá]logo)|disponi[bv]le|[ck]ual[kq]uiera|todas|lo\s+(que|k|q)\s+tengas|no\s+s[eé])/i;
const MORE_DETAILS_RE = /(m[aá]s\s+(detalles|info|informaci[oó]n|datos)|[ck]ontame\s+m[aá]s|detalle|[ck]aracter[ií]sticas|amenities|[ck]omodidades|direcci[oó]n\s+exacta|[ck]u[aá]ntos\s+ba[nñ]os|descripci[oó]n|me\s+interesa)/i;
const VISIT_INTENT_RE = /([ck]o+rdinemos|a[gj]end(emos|ar)|[vb]isita(r|mos|la|lo)?|(quiero|kiero|qiero)\s+[vb]er(la|lo)?|ir\s+a\s+[vb]er|[ck]ono[cs]er(la|lo)?|[ck]u[aá]ndo\s+puedo\s+[vb]er)/i;
const TIME_REPLY_RE = /(\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|ma[nñ]ana|hoy|pasado\s+ma[nñ]ana)\b|\b\d{4}-\d{2}-\d{2}\b|\b(a\s+las?\s+\d{1,2}|\d{1,2}\s*(hs|horas|:\d{2}))\b)/i;
const ASK_NAME_MSG = '¡Hola! 👋 Bienvenido a nuestra inmobiliaria, soy tu asistente virtual inmobiliario. ¿Cómo estás? Te cuento que nuestro horario de atención para visitas es de *lunes a viernes de 10 a 18 hs* y *sábados de 10 a 13 hs*.\n\n¿En qué zona o barrio te gustaría buscar tu próxima propiedad y cuál es tu presupuesto aproximado en USD?';
const ASK_NEED_MSG = (name) => `¡Mucho gusto ${name}! ¿En qué puedo ayudarte hoy? (¿Buscás comprar o alquilar?)`;
const ASK_OPERATION_MSG = '¡Con gusto! Antes de pasarte las opciones disponibles, ¿estás buscando para *alquilar* o para *comprar*? 🏠';
const ASK_DETAILS_MSG = '¡Genial! ¿En qué zona o barrio te gustaría, y cuál es tu presupuesto aproximado en USD? 🏠';

/** Busca el código de propiedad mencionado en el texto o en los últimos mensajes de la conversación. */
function findRecentPropertyCode(phone, text, leadNotes) {
  const direct = (/\b([a-z]{3}-\d{3})\b/i.exec(text) || [])[1];
  if (direct) return direct.toUpperCase();
  const pending = (/(?:visita_pendiente|viendo):([A-Z]{3}-\d{3})/.exec(leadNotes || '') || [])[1];
  if (pending) return pending;
  const recent = all(`SELECT content FROM messages WHERE phone=$p ORDER BY id DESC LIMIT 6`, { $p: phone });
  for (const m of recent) {
    const codes = [...(m.content || '').matchAll(/\b([A-Z]{3}-\d{3})\b/g)].map((x) => x[1]);
    if (codes.length) return codes[0];
  }
  return null;
}

/** Interpreta día y hora preferidos del usuario y devuelve un slot válido "YYYY-MM-DD HH:00". */
function resolveVisitSlot(text, slots = []) {
  const exact = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):00/.exec(text);
  if (exact) return `${exact[1]} ${String(exact[2]).padStart(2, '0')}:00`;
  const t = norm(text);
  const hourMatch = /(?:a\s+las?\s+|de\s+las?\s+|\b)(\d{1,2})\s*(?::00|hs|horas|h)?\b/.exec(t.replace(/\d{4}-\d{2}-\d{2}/g, ''));
  let hour = hourMatch ? Number(hourMatch[1]) : null;
  if (hour !== null && hour >= 1 && hour <= 7) hour += 12; // "a las 3" -> 15:00
  const dayMap = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  const wantedDay = Object.keys(dayMap).find((d) => t.includes(d));
  const isTomorrow = /manana/.test(t);

  for (const s of slots) {
    const [datePart, timePart] = s.split(' ');
    const slotHour = Number(timePart.split(':')[0]);
    const slotDate = new Date(`${datePart}T12:00:00`);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const dayOk = wantedDay
      ? slotDate.getDay() === dayMap[wantedDay]
      : isTomorrow
        ? slotDate.toDateString() === tomorrow.toDateString()
        : true;
    const hourOk = hour !== null ? slotHour === hour : true;
    if (dayOk && hourOk) return s;
  }
  return slots[0] || null;
}

function formatSlotHuman(slot) {
  const [d, h] = slot.split(' ');
  const date = new Date(`${d}T12:00:00`);
  const dayName = date.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'numeric' });
  return `${dayName} (${d}) a las ${h} hs`;
}

/** Extrae un nombre de respuestas como "Juan", "Soy Juan", "Me llamo Juan Pérez". */
function extractName(text) {
  const m = /^(?:hola[,!\s]*)?(?:soy|me llamo|mi nombre es)?\s*([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+)?)[\s.!]*$/i.exec(text.trim());
  if (!m) return null;
  return m[1].split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/** Extrae una posible dirección, calle o barrio desconocido/con typo cuando no hubo match exacto. */
function detectUnknownPlace(text, knownBarrio) {
  const code = (/\b([a-z]{3}-\d{3})\b/i.exec(text) || [])[1];
  if (code) return { codigo: code };
  const addrNum = /\b((?:av\.?|avenida|calle)\s+)?([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)\s+(\d{2,5})\b/i.exec(text);
  if (addrNum && !/(hasta|usd|\bmil\b|dolar|presupuesto|dormitorio|\bamb|alquil|compr|busco|quiero|tengo|\bde\b|\bpor\b|unos|m2|metros)/i.test(addrNum[0])) {
    return { direccion: `${addrNum[2]} ${addrNum[3]}` };
  }
  if (SHOW_AVAILABLE_RE.test(text)) return null;
  const streetPrefix = /\b(?:av\.?|avenida|calle|paseo|pasaje)\s+([a-záéíóúñ]{3,}(?:\s+[a-záéíóúñ]{3,})?)/i.exec(text);
  if (streetPrefix) return { direccion: streetPrefix[1] };
  if (!knownBarrio) {
    const inPlace = /\b(?:en|por|zona|barrio)\s+([a-záéíóúñ]{4,}(?:\s+[a-záéíóúñ]{3,})?)/i.exec(text);
    const candidate = inPlace?.[1]?.replace(/\b(capital|caba|buenos aires|usd|dolares|alquiler|venta|comprar|alquilar|casa|depto|departamento|local|terreno|cartera|catalogo|catálogo|disponible|donde|dónde|ahora|este|momento|general|total|pesos)\b/gi, '').trim();
    if (candidate && candidate.length >= 4) return { direccion: candidate };
  }
  return null;
}

/** Verifica si el mensaje es un agradecimiento o despedida de cierre sin una nueva consulta inmobiliaria. */
function isFarewellMessage(text) {
  if (!FAREWELL_RE.test(text)) return false;
  const parsed = parseQuery(text);
  return !parsed.operacion && !parsed.barrio && !parsed.precio_max_usd && !parsed.tipo
    && !VISIT_INTENT_RE.test(text) && !MORE_DETAILS_RE.test(text)
    && !TIME_REPLY_RE.test(text) && !SHOW_AVAILABLE_RE.test(text)
    && !/\b([a-z]{3}-\d{3})\b/i.test(text);
}

/** Responde paso a paso usando SQLite (cuando la API de Gemini no está disponible). */
export function localReply(phone, text, { persist = true } = {}) {
  const lastBot = all(`SELECT content FROM messages WHERE phone=$p AND role='model' ORDER BY id DESC LIMIT 1`, { $p: phone })[0]?.content;
  const tools = makeToolHandlers(phone);
  const parsed = parseQuery(text);
  const lead = get('SELECT * FROM leads WHERE phone=$p', { $p: phone }) || {};
  const recentCode = findRecentPropertyCode(phone, text, lead.notes);
  const wantsVisit = VISIT_INTENT_RE.test(text);
  const wantsDetails = MORE_DETAILS_RE.test(text);
  const isGivingTime = TIME_REPLY_RE.test(text) && (wantsVisit || /visita_pendiente:/.test(lead.notes || '') || /qué día y horario/i.test(lastBot || ''));
  const isFarewell = isFarewellMessage(text);
  const unknownPlace = (wantsVisit || isGivingTime || isFarewell) ? null : detectUnknownPlace(text, parsed.barrio);
  let reply;

  if (GREETING_RE.test(text)) {
    reply = ASK_NAME_MSG;                                   // Paso 1: saludo + nombre
  } else if (isFarewell) {
    reply = `¡De nada${lead.name ? `, ${lead.name}` : ''}! Fue un gusto ayudarte. Cualquier otra consulta, quedo a tu disposición. ¡Que tengas un excelente día! 👋`;
  } else if (lastBot === ASK_NAME_MSG && extractName(text) && !parsed.operacion && !parsed.barrio && !unknownPlace) {
    const name = extractName(text);                         // Paso 2: nombre → necesidad
    tools.guardar_lead({ nombre: name });
    reply = ASK_NEED_MSG(name);
  } else if ((wantsVisit || isGivingTime) && recentCode) {
    // Contexto de agendamiento de visita sobre la propiedad recién mostrada
    const prop = get('SELECT code,title,address,neighborhood,price_usd,operation FROM properties WHERE UPPER(code)=$c', { $c: recentCode });
    const disp = prop ? tools.consultar_disponibilidad({ codigo_propiedad: prop.code }) : null;
    const slots = disp?.horarios_libres || [];

    if (prop && isGivingTime && slots.length) {
      const chosenSlot = resolveVisitSlot(text, slots);
      const clientName = lead.name || 'Cliente';
      const booked = tools.agendar_visita({ codigo_propiedad: prop.code, fecha_hora: chosenSlot, nombre: clientName });
      tools.guardar_lead({ notas: `Visita agendada ${prop.code} (${chosenSlot})` });
      reply = booked.ok
        ? `¡Perfecto${lead.name ? `, ${lead.name}` : ''}! 🎉 Ya quedó agendada tu visita para ver *${prop.title}* (${prop.code}):\n📍 ${prop.address}, ${prop.neighborhood}\n🗓️ *${formatSlotHuman(chosenSlot)}*\n\n⚠️ *Recuerda:* Si no puedes asistir, por favor avísanos con al menos 24 hs de anticipación llamando o escribiendo al *${CONTACT_PHONE}*.\n\n¡Muchas gracias! Que tengas un excelente día y nos vemos pronto 🏠✨`
        : `Ese horario no está disponible para *${prop.code}*. 😕\n---\nTe comparto la disponibilidad de los próximos 7 días hábiles:\n${disp.resumen_semanal}\n---\n¿Qué día y horario de esta semana te queda mejor?`;
    } else if (prop) {
      tools.guardar_lead({ notas: `visita_pendiente:${prop.code}` });
      reply = `¡Excelente elección! Coordinemos la visita para ver *${prop.title}* (${prop.code}) en ${prop.address}, ${prop.neighborhood} 🏠\n---\n📅 *Disponibilidad (próximos 7 días hábiles):*\n${disp?.resumen_semanal || '• Lunes a viernes: de 10:00 a 17:00 hs\n• Sábados: de 10:00 a 12:00 hs'}\n---\n¿Qué día y horario te queda más cómodo para agendarla?`;
    } else {
      reply = '¡Claro! Decime el código de la propiedad que te gustó (por ejemplo *SAN-701* o *PMA-801*) y qué día y horario preferís para agendar la visita 🗓️';
    }
  } else if (wantsDetails && recentCode && !unknownPlace?.direccion) {
    // Pedido de más detalles sobre una propiedad específica (p.ej. PMA-801 o SAN-701)
    const r = tools.buscar_propiedades({ codigo: recentCode });
    if (r.total) {
      const p = r.propiedades[0];
      tools.guardar_lead({ notas: `viendo:${p.code}` });
      reply = `¡Por supuesto! Te paso todos los detalles de *${p.code}* 👇\n---\n`
        + formatDetailedProperty(p)
        + '\n---\n¿Te gustaría que coordinemos una visita para conocerla en persona? Decime qué día y horario te queda cómodo 🗓️';
    } else {
      const s = r.sugerencia_cercana || closestProperty({ codigo: recentCode }) || r.alternativas?.[0];
      const sugTxt = s ? `${s.address}, ${s.neighborhood} (${s.code})` : 'alguna de nuestras propiedades en Palermo, Belgrano o Caballito';
      reply = `No encontré esa dirección exacta en este momento. 🔍 ¿Quizás quisiste poner ${sugTxt}?`
        + '\n---\n¿Cuál es tu presupuesto aproximado en USD y qué zona o barrio preferís? Así te guío con opciones reales de nuestro catálogo 🏠';
    }
  } else if (unknownPlace) {
    // Consulta por código, dirección o barrio con typo / inexistente en SQLite
    const r = tools.buscar_propiedades(unknownPlace);
    if (r.total) {
      const p = r.propiedades[0];
      tools.guardar_lead({ notas: `viendo:${p.code}` });
      reply = '¡Claro! Te comparto la ficha completa de la propiedad 👇\n---\n'
        + (r.propiedades.length === 1 ? formatDetailedProperty(p) : formatListings(r.propiedades.slice(0, 2)))
        + '\n---\n¿Te gustaría que coordinemos una visita para conocerla en persona? Decime qué día y horario te queda más cómodo 🗓️';
    } else {
      const s = r.sugerencia_cercana || closestProperty(unknownPlace) || r.alternativas?.[0];
      const sugTxt = s ? `${s.address}, ${s.neighborhood} (${s.code})` : 'alguna de nuestras propiedades en Palermo, Belgrano o Caballito';
      reply = `No encontré esa dirección exacta en este momento. 🔍 ¿Quizás quisiste poner ${sugTxt}?`
        + '\n---\n¿Cuál es tu presupuesto aproximado en USD y qué zona o barrio preferís? Así te guío con opciones reales de nuestro catálogo 🏠';
    }
  } else {
    // Paso 3 en adelante: guardamos datos de calificación acumulados y consultamos SQLite cuando indique qué busca
    if (parsed.operacion || parsed.barrio || parsed.precio_max_usd || parsed.tipo || parsed.dormitorios_min) {
      tools.guardar_lead({
        intencion: parsed.operacion === 'alquiler' ? 'alquilar' : parsed.operacion === 'venta' ? 'comprar' : undefined,
        presupuesto_usd: parsed.precio_max_usd,
        zona: parsed.barrio,
        tipo_propiedad: parsed.tipo,
        dormitorios: parsed.dormitorios_min,
      });
    }
    const lead = get('SELECT * FROM leads WHERE phone=$p', { $p: phone }) || {};
    const searchArgs = {
      operacion: parsed.operacion || (lead.intent === 'alquilar' ? 'alquiler' : lead.intent === 'comprar' ? 'venta' : undefined),
      barrio: parsed.barrio || lead.zone || undefined,
      precio_max_usd: parsed.precio_max_usd || lead.budget_usd || undefined,
      tipo: parsed.tipo || lead.property_type || undefined,
      dormitorios_min: parsed.dormitorios_min ?? lead.bedrooms ?? undefined,
    };

    const wantsCatalog = SHOW_AVAILABLE_RE.test(text) || lastBot === ASK_DETAILS_MSG || lastBot === ASK_NAME_MSG || lastBot === ASK_OPERATION_MSG;

    if (!searchArgs.operacion) {
      reply = ASK_OPERATION_MSG;                              // Pregunta si busca alquilar o comprar antes de listar
    } else if (!searchArgs.barrio && !searchArgs.precio_max_usd && !searchArgs.tipo && !wantsCatalog) {
      reply = ASK_DETAILS_MSG;                              // Pide zona y presupuesto la primera vez
    } else {
      let r = tools.buscar_propiedades(searchArgs);
      let relaxed = false;
      if (!r.total) {
        for (const k of ['precio_max_usd', 'dormitorios_min', 'tipo', 'barrio']) {
          delete searchArgs[k];
          r = tools.buscar_propiedades(searchArgs);
          if (r.total) { relaxed = true; break; }
        }
      }
      const opLabel = searchArgs.operacion === 'venta' ? 'en *venta*' : searchArgs.operacion === 'alquiler' ? 'en *alquiler*' : 'disponibles';
      const barrios = [...new Set(all(
        `SELECT neighborhood FROM properties WHERE available = 1 ${searchArgs.operacion ? 'AND operation = $op' : ''}`,
        searchArgs.operacion ? { $op: searchArgs.operacion } : {}
      ).map((x) => x.neighborhood))].join(', ');

      reply = r.total
        ? (relaxed
            ? 'No encontré algo exacto con todos los filtros, pero estas opciones reales del catálogo se acercan 🏠'
            : wantsCatalog && !searchArgs.barrio && !searchArgs.precio_max_usd
              ? `¡Claro! Te muestro algunas de nuestras opciones ${opLabel} (tenemos en ${barrios}) 🏠`
              : 'Encontré estas propiedades para vos en nuestro catálogo 🏠')
          + '\n---\n' + formatListings(r.propiedades.slice(0, 3))
          + '\n---\n¿Te interesa alguna de estas o preferís que filtremos por otro barrio o presupuesto? Decime el código si querés coordinar una visita 😉'
        : 'Por ahora no tengo propiedades disponibles con esas características 😕 ¿Querés que probemos otra zona o ajustemos el presupuesto?';
    }
  }
  if (persist) save(phone, 'model', reply);
  return { bubbles: toBubbles(reply), local: true };
}

export async function handleMessage(phone, text) {
  save(phone, 'user', text);

  if (isHandedOff(phone)) {
    return { bubbles: [], handedOff: true, note: 'Conversación derivada a un asesor: el bot está en pausa.' };
  }

  const reason = HUMAN_RE.test(text) ? 'pide_humano' : OFFER_RE.test(text) ? 'oferta_firme' : null;
  if (reason) {
    handoff(phone, reason, `Mensaje del cliente: "${text}"`);
    save(phone, 'model', HANDOFF_MSG);
    return { bubbles: toBubbles(HANDOFF_MSG), handedOff: true };
  }

  // Saludo inicial con presentación de rol y horario de atención para visitas.
  if (GREETING_RE.test(text)) {
    save(phone, 'model', ASK_NAME_MSG);
    return { bubbles: toBubbles(ASK_NAME_MSG) };
  }

  // Salvaguarda previa de cierre / despedida / agradecimiento (evita reiniciar el bucle de calificación).
  if (isFarewellMessage(text)) {
    const lead = get('SELECT name FROM leads WHERE phone=$p', { $p: phone });
    const farewell = `¡De nada${lead?.name ? `, ${lead.name}` : ''}! Fue un gusto ayudarte. Cualquier otra consulta, quedo a tu disposición. ¡Que tengas un excelente día! 👋`;
    save(phone, 'model', farewell);
    return { bubbles: toBubbles(farewell) };
  }

  if (!ai) return localReply(phone, text);

  const handlers = makeToolHandlers(phone);
  const contents = history(phone);
  const toolLog = [];
  const config = {
    systemInstruction: buildSystemPrompt(),
    tools: [{ functionDeclarations: toolDeclarations }],
    temperature: 0.4,
  };

  let res;
  try {
    // Sin timeout: el modelo tiene el tiempo que necesite para razonar y usar herramientas.
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      res = await generate({ contents, config });
      const calls = res.functionCalls || [];
      if (!calls.length) break;

      contents.push(res.candidates[0].content);
      const parts = calls.map((c) => {
        const result = handlers[c.name] ? handlers[c.name](c.args || {}) : { error: 'Herramienta desconocida' };
        toolLog.push({ name: c.name, args: c.args, result });
        return { functionResponse: { name: c.name, response: result } };
      });
      contents.push({ role: 'user', parts });
      res = null;
    }

    // Si terminó en herramientas o devolvió texto vacío, pedimos la respuesta final sin herramientas.
    if (!res?.text?.trim()) {
      res = await generate({ contents, config: { ...config, toolConfig: { functionCallingConfig: { mode: 'NONE' } } } });
    }
  } catch (e) {
    // Solo errores reales de la API (clave inválida, cuota agotada, sin red), nunca por lentitud.
    console.error(`❌ Error de la API de Gemini (${e?.status || ''} ${e?.message}). Respondiendo desde la base local.`);
    return { ...localReply(phone, text), tools: toolLog };
  }

  const reply = (res?.text || '').trim();
  if (!reply) return { ...localReply(phone, text), tools: toolLog };
  save(phone, 'model', reply);
  return { bubbles: toBubbles(reply), tools: toolLog, handedOff: isHandedOff(phone) };
}

export function resetConversation(phone) {
  run('DELETE FROM messages WHERE phone=$p', { $p: phone });
  run('DELETE FROM handoffs WHERE phone=$p', { $p: phone });
  run('DELETE FROM leads WHERE phone=$p', { $p: phone });
  run('DELETE FROM visits WHERE phone=$p', { $p: phone });
}
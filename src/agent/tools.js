// Herramientas (function calling) que el agente puede usar.
import { all, get, run } from '../db/db.js';
import { Type } from '@google/genai';

export const toolDeclarations = [
  {
    name: 'buscar_propiedades',
    description: 'Busca propiedades disponibles en la base de datos de la agencia. Única fuente válida de inmuebles.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operacion: { type: Type.STRING, enum: ['venta', 'alquiler'], description: 'venta (comprar) o alquiler. Requerido antes de listar propiedades (salvo búsqueda por código o dirección puntual).' },
        tipo: { type: Type.STRING, enum: ['casa', 'departamento', 'local', 'terreno'] },
        barrio: { type: Type.STRING, description: 'Barrio o zona, p.ej. Palermo, Belgrano' },
        precio_max_usd: { type: Type.NUMBER },
        precio_min_usd: { type: Type.NUMBER },
        dormitorios_min: { type: Type.NUMBER },
        codigo: { type: Type.STRING, description: 'Código exacto de propiedad, p.ej. PAL-101' },
        direccion: { type: Type.STRING, description: 'Calle y/o altura mencionada por el cliente, p.ej. "Gurruchaga 1800" o "Av. Alvear"' },
      },
    },
  },
  {
    name: 'consultar_disponibilidad',
    description: 'Devuelve los horarios disponibles agrupados por día para visitar una propiedad durante los próximos 7 días hábiles.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        codigo_propiedad: { type: Type.STRING },
        fecha: { type: Type.STRING, description: 'Opcional, YYYY-MM-DD. Si se omite, devuelve los próximos 7 días hábiles.' },
      },
      required: ['codigo_propiedad'],
    },
  },
  {
    name: 'agendar_visita',
    description: 'Agenda una visita confirmada por el usuario.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        codigo_propiedad: { type: Type.STRING },
        fecha_hora: { type: Type.STRING, description: 'Formato YYYY-MM-DD HH:00' },
        nombre: { type: Type.STRING },
      },
      required: ['codigo_propiedad', 'fecha_hora', 'nombre'],
    },
  },
  {
    name: 'guardar_lead',
    description: 'Guarda o actualiza los datos de calificación del lead.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        nombre: { type: Type.STRING },
        intencion: { type: Type.STRING, enum: ['comprar', 'alquilar', 'vender'] },
        presupuesto_usd: { type: Type.NUMBER },
        zona: { type: Type.STRING },
        tipo_propiedad: { type: Type.STRING },
        dormitorios: { type: Type.NUMBER },
        notas: { type: Type.STRING },
      },
    },
  },
  {
    name: 'derivar_a_asesor',
    description: 'Deriva la conversación a un asesor comercial humano.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        motivo: { type: Type.STRING, enum: ['pide_humano', 'oferta_firme', 'tasacion', 'otro'] },
        resumen: { type: Type.STRING, description: 'Resumen breve del caso para el asesor' },
      },
      required: ['motivo', 'resumen'],
    },
  },
];

// ---------- Coincidencia aproximada (typos y sin tildes) ----------
const normTxt = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(av(enida)?|calle)\.?\s*/g, '').trim();

const normPhonetic = (s) => normTxt(s)
  .replace(/\bh/g, '')
  .replace(/qu|c(?=[aou])|k/g, 'k')
  .replace(/c(?=[ei])|z/g, 's')
  .replace(/ll|y/g, 'y')
  .replace(/v/g, 'b')
  .replace(/(.)\1+/g, '$1');

function levenshtein(a, b) {
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

/** Resuelve un barrio escrito sin tildes/ñ o con error ortográfico leve al nombre exacto de la base. */
export function resolveCanonicalBarrio(input) {
  if (!input) return null;
  const q = normTxt(input);
  const qf = normPhonetic(input);
  const list = all('SELECT DISTINCT neighborhood FROM properties').map((r) => r.neighborhood);
  for (const n of list) {
    const nn = normTxt(n), nf = normPhonetic(n);
    if (nn.includes(q) || q.includes(nn) || nf.includes(qf) || qf.includes(nf)) return n;
    if (nn.length >= 5 && levenshtein(q, nn) <= 1) return n;
  }
  return null;
}

/** Devuelve la propiedad más parecida al código/dirección/barrio pedido, o null si nada se parece. */
export function closestProperty({ codigo, direccion, barrio } = {}) {
  const props = all('SELECT code,title,operation,type,neighborhood,address,price_usd,bedrooms,area_m2 FROM properties WHERE available = 1');
  let best = null, bestScore = Infinity;
  const placeQuery = direccion || barrio;
  for (const p of props) {
    let score = Infinity;
    if (codigo) score = Math.min(score, levenshtein(normTxt(codigo).replace(/\s/g, ''), p.code.toLowerCase()) / p.code.length);
    if (placeQuery) {
      const q = normTxt(placeQuery), qStreet = q.replace(/\d+/g, '').trim(), addr = normTxt(p.address);
      const street = addr.replace(/\d+/g, '').trim();
      const streetDist = qStreet ? levenshtein(qStreet, street) / Math.max(street.length, 1) : 1;
      const numPenalty = (q.match(/\d+/) || [''])[0] && !addr.includes((q.match(/\d+/) || [''])[0]) ? 0.15 : 0;
      const neighDist = qStreet ? levenshtein(qStreet, normTxt(p.neighborhood)) / Math.max(p.neighborhood.length, 1) : 1;
      score = Math.min(score, streetDist + numPenalty, neighDist);
    }
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return bestScore <= 0.55 ? best : null;
}

// ---------- Agenda (próximos 7 días hábiles agrupados) ----------
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function slotsForDate(d) {
  const day = d.getDay(); // 0 dom, 6 sáb
  if (day === 0) return [];
  const [from, to] = day === 6 ? [10, 13] : [10, 18];
  const out = [];
  for (let h = from; h < to; h++) out.push(`${fmt(d)} ${pad(h)}:00`);
  return out;
}

function isValidSlot(dt) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):00$/.exec(dt || '');
  if (!m) return false;
  const d = new Date(`${m[1]}T12:00:00`);
  return slotsForDate(d).includes(dt) && new Date(`${m[1]}T${m[2]}:00:00`) > new Date();
}

/**
 * Genera y agrupa la disponibilidad en un rango limpio de los próximos 7 días hábiles
 * (lunes a sábado), evitando repetir múltiples turnos del mismo día.
 */
export function getAvailableSlots(codigo_propiedad, fecha) {
  const code = String(codigo_propiedad || '').trim().toUpperCase();
  const prop = get('SELECT code, title, address, neighborhood FROM properties WHERE UPPER(code) = $c AND available = 1', { $c: code });
  if (!prop) return { error: 'Código de propiedad inexistente.' };

  const taken = new Set(
    all('SELECT datetime FROM visits WHERE UPPER(property_code) = $c', { $c: prop.code }).map((r) => r.datetime)
  );
  const now = new Date();
  const days = [];

  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    days.push(new Date(`${fecha}T12:00:00`));
  } else {
    for (let i = 1; days.length < 7 && i <= 14; i++) {
      const x = new Date(now);
      x.setDate(now.getDate() + i);
      if (x.getDay() !== 0) days.push(x); // lunes a sábado (7 días hábiles)
    }
  }

  const agenda_semanal = [];
  const horarios_libres = [];

  for (const d of days) {
    const daySlots = slotsForDate(d).filter((s) => !taken.has(s) && new Date(s.replace(' ', 'T') + ':00') > now);
    if (!daySlots.length) continue;
    horarios_libres.push(...daySlots);

    const hours = daySlots.map((s) => s.split(' ')[1]);
    const firstH = hours[0];
    const lastH = hours[hours.length - 1];
    const diaNombre = cap(d.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit' }));
    const franja = hours.length > 2 ? `de ${firstH} a ${lastH} hs` : hours.map((h) => `${h} hs`).join(', ');

    agenda_semanal.push({
      fecha: fmt(d),
      dia: diaNombre,
      franja,
      horarios: hours,
      primer_turno: daySlots[0],
    });
  }

  const resumen_semanal = agenda_semanal
    .map((d) => `• *${d.dia}*: disponible ${d.franja}`)
    .join('\n');

  return {
    codigo_propiedad: prop.code,
    agenda_semanal,
    resumen_semanal,
    horarios_libres,
    nota: 'Presentá al cliente el rango semanal (agenda_semanal / resumen_semanal) de los próximos 7 días hábiles sin repetir varios turnos del mismo día.',
  };
}

// ---------- Implementaciones ----------
export function makeToolHandlers(phone) {
  return {
    buscar_propiedades(a = {}) {
      const lead = get('SELECT intent FROM leads WHERE phone=$p', { $p: phone }) || {};
      const normOp = (v) => {
        const s = String(v || '').toLowerCase().trim();
        if (s === 'alquiler' || s === 'alquilar' || s === 'rent') return 'alquiler';
        if (s === 'venta' || s === 'compra' || s === 'comprar' || s === 'buy' || s === 'sale') return 'venta';
        return null;
      };
      const op = normOp(a.operacion) || normOp(lead.intent);
      if (!op && !a.codigo && !a.direccion) {
        return {
          total: 0,
          propiedades: [],
          falta_operacion: true,
          nota: 'El cliente aún no especificó si busca ALQUILAR o COMPRAR. Preguntale amablemente si prefiere alquilar o comprar antes de listar propiedades.',
        };
      }

      const where = ['available = 1'];
      const p = {};
      if (op) { where.push('operation = $op'); p.$op = op; }
      if (a.tipo) { where.push('type = $t'); p.$t = a.tipo; }
      const canonicalBarrio = a.barrio ? resolveCanonicalBarrio(a.barrio) : null;
      if (a.barrio) { where.push('LOWER(neighborhood) LIKE $b'); p.$b = `%${(canonicalBarrio || a.barrio).toLowerCase()}%`; }
      if (a.precio_max_usd) { where.push('price_usd <= $max'); p.$max = a.precio_max_usd; }
      if (a.precio_min_usd) { where.push('price_usd >= $min'); p.$min = a.precio_min_usd; }
      if (a.dormitorios_min) { where.push('bedrooms >= $dor'); p.$dor = a.dormitorios_min; }
      if (a.codigo) { where.push('UPPER(code) = $code'); p.$code = String(a.codigo).trim().toUpperCase(); }
      if (a.direccion) {
        // Coincidencia por calle ignorando tildes/mayúsculas/"Av."/"calle" y, si se indicó, por altura exacta.
        const dir = normTxt(a.direccion);
        const street = dir.replace(/\d+/g, '').trim();
        const num = (dir.match(/\d+/) || [])[0];
        const allAddrs = all('SELECT address FROM properties WHERE available = 1').map((r) => r.address);
        const matchedAddr = allAddrs.find((ad) => {
          const nad = normTxt(ad);
          return (!street || nad.includes(street)) && (!num || nad.includes(num));
        });
        if (matchedAddr) {
          where.push('address = $exactAddr');
          p.$exactAddr = matchedAddr;
        } else {
          if (street) { where.push('LOWER(address) LIKE $street'); p.$street = `%${street}%`; }
          if (num) { where.push('address LIKE $num'); p.$num = `%${num}%`; }
        }
      }
      const rows = all(
        `SELECT code,title,operation,type,neighborhood,address,price_usd,bedrooms,bathrooms,area_m2,amenities,description
         FROM properties WHERE ${where.join(' AND ')} ORDER BY price_usd LIMIT 5`, p);
      const barrioInexistente = a.barrio && !canonicalBarrio;
      if (!rows.length && (a.codigo || a.direccion || barrioInexistente)) {
        const sugerencia_cercana = closestProperty(a);
        // Si no hubo coincidencia exacta de barrio pero sí uno parecido (typo), no es "inexistente": se sugiere.
        const alternativas = all(
          `SELECT code,title,operation,type,neighborhood,address,price_usd,bedrooms,area_m2
           FROM properties WHERE available = 1 ${a.operacion ? 'AND operation = $op' : ''} ORDER BY RANDOM() LIMIT 3`,
          a.operacion ? { $op: a.operacion } : {});
        return { total: 0, propiedades: [], no_existe: true, sugerencia_cercana, alternativas,
          nota: 'No hay coincidencia exacta. No inventes ni confirmes la propiedad. Respondé con el formato "No encontré esa dirección exacta en este momento. 🔍 ¿Quizás quisiste poner ...?" usando sugerencia_cercana (o una de las alternativas si es null), y preguntá presupuesto y zona preferida.' };
      }
      return { total: rows.length, propiedades: rows,
        nota: rows.length ? 'Precios de alquiler son mensuales en USD.' : 'Sin resultados. No inventes propiedades.' };
    },

    consultar_disponibilidad({ codigo_propiedad, fecha }) {
      return getAvailableSlots(codigo_propiedad, fecha);
    },

    agendar_visita({ codigo_propiedad, fecha_hora, nombre }) {
      const prop = get('SELECT code,title,address FROM properties WHERE code = $c', { $c: codigo_propiedad });
      if (!prop) return { ok: false, error: 'Código de propiedad inexistente.' };
      if (!isValidSlot(fecha_hora)) return { ok: false, error: 'Horario fuera de la franja de visitas o en el pasado.' };
      if (get('SELECT id FROM visits WHERE property_code=$c AND datetime=$d', { $c: codigo_propiedad, $d: fecha_hora }))
        return { ok: false, error: 'Horario ya ocupado. Consultá disponibilidad de nuevo.' };
      run('INSERT INTO visits (phone,name,property_code,datetime) VALUES ($p,$n,$c,$d)',
        { $p: phone, $n: nombre, $c: codigo_propiedad, $d: fecha_hora });
      run(`INSERT INTO leads (phone,name,status) VALUES ($p,$n,'visita_agendada')
           ON CONFLICT(phone) DO UPDATE SET name=$n, status='visita_agendada', updated_at=datetime('now','localtime')`,
        { $p: phone, $n: nombre });
      return { ok: true, visita: { ...prop, fecha_hora, nombre } };
    },

    guardar_lead(a = {}) {
      const cur = get('SELECT * FROM leads WHERE phone=$p', { $p: phone }) || {};
      const v = {
        $p: phone,
        $name: a.nombre ?? cur.name ?? null,
        $intent: a.intencion ?? cur.intent ?? null,
        $budget: a.presupuesto_usd ?? cur.budget_usd ?? null,
        $zone: a.zona ?? cur.zone ?? null,
        $type: a.tipo_propiedad ?? cur.property_type ?? null,
        $bed: a.dormitorios ?? cur.bedrooms ?? null,
        $notes: a.notas ?? cur.notes ?? null,
      };
      const qualified = v.$intent && v.$budget && v.$zone && v.$type;
      v.$status = cur.status && cur.status !== 'nuevo' && cur.status !== 'calificado' ? cur.status : qualified ? 'calificado' : 'nuevo';
      run(`INSERT INTO leads (phone,name,intent,budget_usd,zone,property_type,bedrooms,notes,status)
           VALUES ($p,$name,$intent,$budget,$zone,$type,$bed,$notes,$status)
           ON CONFLICT(phone) DO UPDATE SET name=$name,intent=$intent,budget_usd=$budget,zone=$zone,
             property_type=$type,bedrooms=$bed,notes=$notes,status=$status,updated_at=datetime('now','localtime')`, v);
      return { ok: true, calificado: !!qualified };
    },

    derivar_a_asesor({ motivo, resumen }) {
      return handoff(phone, motivo, resumen);
    },
  };
}

export function handoff(phone, motivo, resumen) {
  const open = get(`SELECT id FROM handoffs WHERE phone=$p AND status='pendiente'`, { $p: phone });
  if (!open) run('INSERT INTO handoffs (phone,reason,summary) VALUES ($p,$r,$s)', { $p: phone, $r: motivo, $s: resumen });
  run(`INSERT INTO leads (phone,status) VALUES ($p,'derivado')
       ON CONFLICT(phone) DO UPDATE SET status='derivado', updated_at=datetime('now','localtime')`, { $p: phone });
  return { ok: true, mensaje: 'Derivado. Un asesor comercial contactará al cliente.' };
}

export function isHandedOff(phone) {
  return !!get(`SELECT id FROM handoffs WHERE phone=$p AND status='pendiente'`, { $p: phone });
}

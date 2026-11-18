// Carga propiedades de ejemplo (Buenos Aires, USD) y limpia tablas operativas. Ejecutar: npm run seed
// También lo usa server.js automáticamente para inicializar o reiniciar la base a cero.
import { getDb, all, getRawDb, persist, DB_PATH } from './db.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_PROPERTIES = [
  ['PAL-101', 'Depto 2 amb. luminoso en Palermo Soho', 'venta', 'departamento', 'Palermo', 'Gurruchaga 1800', 145000, 1, 1, 48, 'Balcón, cocina integrada', 'Piso 6 al frente, a 3 cuadras de Plaza Serrano.'],
  ['PAL-102', 'Depto 3 amb. con amenities en Palermo Hollywood', 'venta', 'departamento', 'Palermo', 'Humboldt 1500', 235000, 2, 2, 75, 'Pileta, gimnasio, SUM, cochera', 'Edificio a estrenar con seguridad 24 h.'],
  ['BEL-201', 'Semipiso 4 amb. en Belgrano R', 'venta', 'departamento', 'Belgrano', 'Echeverría 3200', 320000, 3, 2, 110, 'Cochera, baulera, lavadero', 'Excelente estado, muy silencioso.'],
  ['BEL-202', 'Depto 2 amb. en Belgrano C', 'alquiler', 'departamento', 'Belgrano', 'Juramento 2100', 650, 1, 1, 45, 'Amoblado, balcón', 'Alquiler mensual en USD, cerca del subte D.'],
  ['REC-301', 'Piso 5 amb. de categoría en Recoleta', 'venta', 'departamento', 'Recoleta', 'Av. Alvear 1600', 590000, 4, 3, 190, 'Dependencia, cochera doble', 'Edificio francés, techos altos.'],
  ['REC-302', 'Monoambiente en Recoleta', 'alquiler', 'departamento', 'Recoleta', 'Ayacucho 1200', 480, 0, 1, 30, 'Amoblado', 'Ideal estudiantes, cerca de la UBA.'],
  ['CAB-401', 'Depto 3 amb. reciclado en Caballito', 'venta', 'departamento', 'Caballito', 'Av. Pedro Goyena 900', 158000, 2, 1, 68, 'Balcón aterrazado', 'Frente a Parque Rivadavia.'],
  ['CAB-402', 'PH 4 amb. con terraza en Caballito', 'venta', 'casa', 'Caballito', 'Senillosa 600', 210000, 3, 2, 120, 'Terraza propia, parrilla', 'PH sin expensas, al fondo.'],
  ['NUN-501', 'Depto 2 amb. a estrenar en Núñez', 'alquiler', 'departamento', 'Núñez', 'Av. del Libertador 7400', 750, 1, 1, 50, 'Pileta, gimnasio', 'Vista al río.'],
  ['VUR-601', 'Casa 4 amb. con jardín en Villa Urquiza', 'venta', 'casa', 'Villa Urquiza', 'Mendoza 5000', 280000, 3, 2, 160, 'Jardín, parrilla, cochera', 'Casa en lote propio, muy luminosa.'],
  ['VUR-602', 'Depto 3 amb. en Villa Urquiza', 'alquiler', 'departamento', 'Villa Urquiza', 'Av. Triunvirato 4500', 700, 2, 1, 65, 'Balcón, laundry', 'A 2 cuadras del subte B.'],
  ['SAN-701', 'Depto 2 amb. en San Telmo', 'venta', 'departamento', 'San Telmo', 'Defensa 900', 98000, 1, 1, 42, 'Balcón francés', 'Edificio histórico reciclado.'],
  ['PMA-801', 'Depto 3 amb. con vista en Puerto Madero', 'alquiler', 'departamento', 'Puerto Madero', 'Juana Manso 1100', 1800, 2, 2, 95, 'Pileta, gimnasio, cochera, seguridad', 'Vista a los diques.'],
  ['PAL-901', 'Local comercial a la calle en Palermo', 'alquiler', 'local', 'Palermo', 'Honduras 4800', 2200, 0, 1, 80, 'Vidriera, depósito', 'Zona gastronómica de alto tránsito.'],
  ['ALM-902', 'Local en Almagro sobre avenida', 'venta', 'local', 'Almagro', 'Av. Corrientes 4000', 185000, 0, 1, 90, 'Entrepiso, baño', 'Ideal para comercio o franquicia.'],
  ['TIG-951', 'Terreno 600 m² en Tigre (Nordelta)', 'venta', 'terreno', 'Tigre', 'Barrio Los Lagos, Nordelta', 120000, 0, 0, 600, 'Barrio cerrado, al lago', 'Listo para construir.'],
  ['PIL-952', 'Terreno 1000 m² en Pilar', 'venta', 'terreno', 'Pilar', 'Km 50, Panamericana', 75000, 0, 0, 1000, 'Barrio cerrado, seguridad', 'A 5 min del centro de Pilar.'],
];

/** Limpia conversaciones, leads, visitas y derivaciones, y recarga las 17 propiedades iniciales. */
export async function resetDatabase() {
  await getDb();
  const db = getRawDb();
  db.run('BEGIN');
  try {
    db.run('DELETE FROM messages');
    db.run('DELETE FROM leads');
    db.run('DELETE FROM visits');
    db.run('DELETE FROM handoffs');
    db.run('DELETE FROM properties');
    db.run(`DELETE FROM sqlite_sequence WHERE name IN ('messages','visits','handoffs','properties')`);
    const stmt = db.prepare(
      `INSERT INTO properties (code,title,operation,type,neighborhood,address,price_usd,bedrooms,bathrooms,area_m2,amenities,description)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const p of SAMPLE_PROPERTIES) stmt.run(p);
    stmt.free();
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  persist();
  return all('SELECT id FROM properties').length;
}

/** Borra y recarga las propiedades de ejemplo en una sola transacción. Devuelve la cantidad cargada. */
export async function seedProperties() {
  return resetDatabase();
}

const RESET_MARKER = path.resolve(path.dirname(DB_PATH), '.clean_slate_v1');

/** Garantiza que la base tenga las 17 propiedades y aplica el reinicio limpio inicial. */
export async function ensureSeeded() {
  await getDb();
  if (!fs.existsSync(RESET_MARKER)) {
    const count = await resetDatabase();
    fs.writeFileSync(RESET_MARKER, new Date().toISOString());
    return { seeded: true, reset: true, count };
  }
  const { n } = all('SELECT COUNT(*) AS n FROM properties')[0];
  if (n > 0) return { seeded: false, reset: false, count: n };
  return { seeded: true, reset: false, count: await seedProperties() };
}

// Ejecución directa: npm run seed
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = await seedProperties();
  console.log(`✅ ${n} propiedades cargadas en data/inmo.sqlite`);
}

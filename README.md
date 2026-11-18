# 🏠 Agente IA Inmobiliario (WhatsApp)

Agente conversacional para una inmobiliaria de Buenos Aires. Califica leads, busca propiedades **solo en la base de datos**, agenda visitas y deriva a un asesor humano. Incluye un simulador web estilo WhatsApp y un panel comercial.

**Stack:** Node.js 18+ · Express · Gemini API (`@google/genai`, function calling) · SQLite (`sql.js`, sin compilación nativa)

## 1. Instalación

```bash
npm install
```

## 2. Configurar la API key de Gemini

1. Conseguí una clave en https://aistudio.google.com/apikey
2. Copiá `.env.example` como `.env` en la raíz del proyecto:
   ```powershell
   Copy-Item .env.example .env
   ```
3. Editá `.env` y pegá tu clave:
   ```env
   GEMINI_API_KEY=tu_clave_aqui
   GEMINI_MODEL=gemini-2.5-flash
   PORT=3000
   ```

## 3. Ejecutar

```bash
npm run seed   # carga 17 propiedades de ejemplo (opcional, se hace solo si la base está vacía)
npm run dev    # o: npm start
```

Abrí **http://localhost:3000**.

## Qué probar
| Escenario | Mensaje de ejemplo |
|---|---|
| Compra | "Hola, quiero comprar un depto de 2 dormitorios en Palermo, hasta 250 mil dólares" |
| Alquiler | "Busco alquilar en Belgrano o Núñez, hasta USD 800" |
| Sin resultados | "Quiero una casa en Recoleta por 50 mil" (no debe inventar) |
| Venta | "Quiero vender mi casa en Caballito" (deriva a tasación) |
| Pedir un humano | "Quiero hablar con una persona" |
| Oferta en firme | "Ofrezco USD 140.000 por el PAL-101" |

El **Panel** muestra los leads, las visitas, las derivaciones (con botón "Resolver" para reactivar el bot) y las propiedades.

## Estructura
```
src/
  server.js              API Express + archivos estáticos
  agent/systemPrompt.js  Prompt de calificación y agenda
  agent/agent.js         Bucle Gemini + function calling + reglas de oro
  agent/tools.js         buscar_propiedades, consultar_disponibilidad, agendar_visita, guardar_lead, derivar_a_asesor
  db/db.js, db/seed.js   SQLite + datos de ejemplo
  channels/whatsapp.js   Adaptador para conectar WhatsApp más adelante
public/                  Simulador estilo WhatsApp + panel
data/inmo.sqlite         Base generada automáticamente
```
# Agente-IA-ws

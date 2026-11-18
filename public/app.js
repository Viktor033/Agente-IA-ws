const $ = (s) => document.querySelector(s);
const CONTACTS_KEY = 'contacts_clean_v1';
const state = {
  contacts: JSON.parse(localStorage.getItem(CONTACTS_KEY) || 'null') || [
    { phone: '5491111111111', name: 'Cliente 1 (comprador)' },
    { phone: '5491122222222', name: 'Cliente 2 (inquilino)' },
    { phone: '5491133333333', name: 'Cliente 3 (vendedor)' },
  ],
  active: null,
  busy: false,
};
const saveContacts = () => localStorage.setItem(CONTACTS_KEY, JSON.stringify(state.contacts));

const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Formato WhatsApp: *negrita*, _cursiva_, ~tachado~
const waFormat = (t) => esc(t)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<b>$1</b>')
  .replace(/(^|\s)_(.+?)_/g, '$1<i>$2</i>').replace(/~(.+?)~/g, '<s>$1</s>');
const now = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addMsg(text, cls, time = now()) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = `${waFormat(text)}<span class="time">${time}</span>`;
  $('#messages').appendChild(el);
  $('#messages').scrollTop = 1e9;
}
function addTool(t) {
  const el = document.createElement('div');
  el.className = 'tool';
  el.textContent = `🔧 ${t.name}(${JSON.stringify(t.args || {})})`;
  $('#messages').appendChild(el);
}
function typing(on) {
  $('#status').textContent = on ? 'escribiendo…' : 'en línea';
  const ex = $('#typing');
  if (on && !ex) {
    const el = document.createElement('div');
    el.id = 'typing'; el.className = 'msg in typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    $('#messages').appendChild(el); $('#messages').scrollTop = 1e9;
  } else if (!on && ex) ex.remove();
}

function renderContacts() {
  $('#contacts').innerHTML = '';
  state.contacts.forEach((c) => {
    const li = document.createElement('li');
    li.className = c.phone === state.active ? 'active' : '';
    li.innerHTML = `${esc(c.name)}<small>+${c.phone}</small>`;
    li.onclick = () => openChat(c.phone);
    $('#contacts').appendChild(li);
  });
}

async function openChat(phone) {
  state.active = phone;
  renderContacts();
  showView('chats');
  $('#messages').innerHTML = '';
  $('#banner').classList.add('hidden');
  const hist = await fetch(`/api/history/${phone}`).then((r) => r.json());
  if (!hist.length) addMsg('Simulador: escribí como si fueras el cliente. Probá "Hola, busco depto en Palermo".', 'system');
  hist.forEach((m) => {
    const t = m.created_at?.slice(11, 16);
    if (m.role === 'user') addMsg(m.content, 'out', t);
    else m.content.split(/\n\s*-{3,}\s*\n/).forEach((b) => addMsg(b.trim(), 'in', t));
  });
  $('#input').focus();
}

async function send(text) {
  if (state.busy || !state.active) return;
  state.busy = true;
  addMsg(text, 'out');
  typing(true);
  try {
    const [r] = await Promise.all([
      fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: state.active, text }),
      }).then((x) => x.json()),
      sleep(1000), // Pausa natural de 1 segundo ("escribiendo…") antes de la primera burbuja
    ]);
    typing(false);
    (r.tools || []).forEach(addTool);
    for (const [i, b] of (r.bubbles || []).entries()) {
      if (i > 0) {
        typing(true);
        await sleep(1000); // Pausa orgánica de 1 segundo entre burbujas
        typing(false);
      }
      addMsg(b, 'in');
    }
    if (r.note) addMsg(r.note, 'system');
    $('#banner').classList.toggle('hidden', !r.handedOff);
  } catch (e) {
    typing(false);
    addMsg('Error de conexión con el servidor.', 'system');
  }
  state.busy = false;
}

$('#composer').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#input').value.trim();
  if (!t) return;
  $('#input').value = '';
  send(t);
};
$('#reset').onclick = async () => {
  if (!state.active || !confirm('¿Reiniciar esta conversación?')) return;
  await fetch(`/api/reset/${state.active}`, { method: 'POST' });
  openChat(state.active);
};
$('#newContact').onclick = () => {
  const name = prompt('Nombre del contacto de prueba:');
  if (!name) return;
  const phone = '54911' + Math.floor(10000000 + Math.random() * 89999999);
  state.contacts.push({ phone, name }); saveContacts(); openChat(phone);
};

// ---------- Panel ----------
function table(rows, cols) {
  if (!rows.length) return '<p class="empty">Sin registros.</p>';
  return `<table><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr>${rows.map((r) =>
    `<tr>${cols.map((c) => `<td>${c[2] ? c[2](r) : esc(String(r[c[1]] ?? '—'))}</td>`).join('')}</tr>`).join('')}</table>`;
}
const pill = (s) => `<span class="pill ${s}">${s}</span>`;
const usd = (n) => n == null ? '—' : 'USD ' + Number(n).toLocaleString('es-AR');

async function loadAdmin() {
  const d = await fetch('/api/admin/summary').then((r) => r.json());
  $('#handoffs').innerHTML = table(d.handoffs, [
    ['Tel.', 'phone'], ['Motivo', 'reason'], ['Resumen', 'summary'], ['Estado', 'status', (r) => pill(r.status)],
    ['', '', (r) => r.status === 'pendiente' ? `<button class="small-btn" onclick="resolveH(${r.id})">Resolver</button>` : ''],
  ]);
  $('#visits').innerHTML = table(d.visits, [['Fecha', 'datetime'], ['Nombre', 'name'], ['Prop.', 'property_code'], ['Dirección', 'address']]);
  $('#leads').innerHTML = table(d.leads, [
    ['Tel.', 'phone'], ['Nombre', 'name'], ['Intención', 'intent'], ['Presupuesto', '', (r) => usd(r.budget_usd)],
    ['Zona', 'zone'], ['Tipo', 'property_type'], ['Dorm.', 'bedrooms'], ['Estado', '', (r) => pill(r.status)], ['Actualizado', 'updated_at'],
  ]);
  $('#props').innerHTML = table(d.properties, [
    ['Código', 'code'], ['Título', 'title'], ['Op.', 'operation'], ['Tipo', 'type'], ['Barrio', 'neighborhood'],
    ['Precio', '', (r) => usd(r.price_usd) + (r.operation === 'alquiler' ? '/mes' : '')], ['Dorm.', 'bedrooms'], ['m²', 'area_m2'],
  ]);
}
window.resolveH = async (id) => { await fetch(`/api/admin/handoffs/${id}/resolve`, { method: 'POST' }); loadAdmin(); };

function showView(v) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  $('#chatView').classList.toggle('hidden', v !== 'chats');
  $('#adminView').classList.toggle('hidden', v !== 'admin');
  if (v === 'admin') loadAdmin();
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.view)));

renderContacts();
(async () => {
  if (!localStorage.getItem('clean_slate_2026_11_10')) {
    await fetch('/api/reset-all', { method: 'POST' }).catch(() => {});
    for (const c of state.contacts) {
      await fetch(`/api/reset/${c.phone}`, { method: 'POST' }).catch(() => {});
    }
    localStorage.setItem('clean_slate_2026_11_10', '1');
  }
  openChat(state.contacts[0].phone);
})();

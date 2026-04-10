const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'turnos.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve the HTML files at /

// ── DB helpers ─────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = { turnos: [], counter: 1 };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function broadcast(clients, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(payload));
}

// ── SSE for real-time updates ───────────────────────────────────────────────
const sseClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  // Send a heartbeat comment every 25 s to keep the connection alive
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  sseClients.push(res);
  req.on('close', () => {
    clearInterval(hb);
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

// GET  /api/turnos  – list all turns (optional ?estado=pendiente)
app.get('/api/turnos', (req, res) => {
  const db = loadDB();
  const { estado } = req.query;
  const turnos = estado ? db.turnos.filter(t => t.estado === estado) : db.turnos;
  res.json(turnos);
});

// GET  /api/stats
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  res.json({
    total:      db.turnos.length,
    pendientes: db.turnos.filter(t => t.estado === 'pendiente').length,
    llamados:   db.turnos.filter(t => t.estado === 'llamado').length,
    atendidos:  db.turnos.filter(t => t.estado === 'atendido').length,
    saltados:   db.turnos.filter(t => t.estado === 'saltado').length,
  });
});

// POST /api/turnos – register new turn
app.post('/api/turnos', (req, res) => {
  const { nombre, institucion, servicio, documento } = req.body;
  if (!nombre?.trim() || !servicio)
    return res.status(400).json({ error: 'Nombre y servicio son obligatorios.' });

  const db = loadDB();
  const turno = {
    id:         db.counter++,
    numero:     db.counter - 1,
    nombre:     nombre.trim().toUpperCase(),
    institucion: institucion.trim().toUpperCase(),
    servicio,
    documento:  documento?.trim() || null,
    estado:     'pendiente',
    creadoEn:   new Date().toISOString(),
    llamadoEn:  null,
    atendidoEn: null,
  };
  db.turnos.push(turno);
  saveDB(db);
  broadcast(sseClients, 'nuevo', turno);
  res.status(201).json(turno);
});

// POST /api/siguiente – call next pending turn
app.post('/api/siguiente', (req, res) => {
  const db = loadDB();
  const siguiente = db.turnos.find(t => t.estado === 'pendiente');
  if (!siguiente) return res.status(404).json({ error: 'No hay turnos pendientes.' });
  siguiente.estado    = 'llamado';
  siguiente.llamadoEn = new Date().toISOString();
  saveDB(db);
  broadcast(sseClients, 'llamado', siguiente);
  res.json(siguiente);
});

// POST /api/turnos/:id/llamar – call a specific turn
app.post('/api/turnos/:id/llamar', (req, res) => {
  const db = loadDB();
  const turno = db.turnos.find(t => t.id === +req.params.id);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
  turno.estado    = 'llamado';
  turno.llamadoEn = new Date().toISOString();
  saveDB(db);
  broadcast(sseClients, 'llamado', turno);
  res.json(turno);
});

// POST /api/turnos/:id/atender – mark as attended
app.post('/api/turnos/:id/atender', (req, res) => {
  const db = loadDB();
  const turno = db.turnos.find(t => t.id === +req.params.id);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
  turno.estado      = 'atendido';
  turno.atendidoEn  = new Date().toISOString();
  saveDB(db);
  broadcast(sseClients, 'atendido', turno);
  res.json(turno);
});

// POST /api/turnos/:id/saltar – skip a turn
app.post('/api/turnos/:id/saltar', (req, res) => {
  const db = loadDB();
  const turno = db.turnos.find(t => t.id === +req.params.id);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
  turno.estado = 'saltado';
  saveDB(db);
  broadcast(sseClients, 'saltado', turno);
  res.json(turno);
});

// DELETE /api/turnos/:id
app.delete('/api/turnos/:id', (req, res) => {
  const db = loadDB();
  const i = db.turnos.findIndex(t => t.id === +req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Turno no encontrado.' });
  db.turnos.splice(i, 1);
  saveDB(db);
  broadcast(sseClients, 'eliminado', { id: +req.params.id });
  res.json({ message: 'Turno eliminado.' });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   FUBAM – Sistema de Gestión de Turnos   ║');
  console.log(`  ║   Servidor en http://localhost:${PORT}       ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});

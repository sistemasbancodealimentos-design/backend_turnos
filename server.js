const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Conexión MongoDB ────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('ERROR: La variable de entorno MONGODB_URI no está definida.');
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('  ✔ Conectado a MongoDB Atlas'))
  .catch(err => { console.error('  ✘ Error conectando a MongoDB:', err); process.exit(1); });

// ── Schema y Model ──────────────────────────────────────────────────────────
const turnoSchema = new mongoose.Schema({
  numero:      { type: Number },
  nombre:      { type: String, required: true },
  institucion: { type: String, default: '' },
  servicio:    { type: String, required: true },
  documento:   { type: String, default: null },
  estado:      { type: String, enum: ['pendiente', 'llamado', 'atendido', 'saltado'], default: 'pendiente' },
  creadoEn:    { type: Date, default: Date.now },
  llamadoEn:   { type: Date, default: null },
  atendidoEn:  { type: Date, default: null },
}, { versionKey: false });

const Turno = mongoose.model('Turno', turnoSchema);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Helpers ─────────────────────────────────────────────────────────────────
function broadcast(clients, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => c.write(payload));
}

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = [];

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  sseClients.push(res);
  req.on('close', () => {
    clearInterval(hb);
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── Rutas ────────────────────────────────────────────────────────────────────

// GET /api/turnos – listar todos (opcional ?estado=pendiente)
app.get('/api/turnos', async (req, res) => {
  try {
    const filter = req.query.estado ? { estado: req.query.estado } : {};
    const turnos = await Turno.find(filter).sort({ creadoEn: 1 });
    res.json(turnos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const [total, pendientes, llamados, atendidos, saltados] = await Promise.all([
      Turno.countDocuments(),
      Turno.countDocuments({ estado: 'pendiente' }),
      Turno.countDocuments({ estado: 'llamado' }),
      Turno.countDocuments({ estado: 'atendido' }),
      Turno.countDocuments({ estado: 'saltado' }),
    ]);
    res.json({ total, pendientes, llamados, atendidos, saltados });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos – registrar nuevo turno
app.post('/api/turnos', async (req, res) => {
  try {
    const { nombre, institucion, servicio, documento } = req.body;
    if (!nombre?.trim() || !servicio)
      return res.status(400).json({ error: 'Nombre y servicio son obligatorios.' });

    // Calcular el siguiente número correlativo
    const ultimo = await Turno.findOne().sort({ numero: -1 });
    const numero = (ultimo?.numero ?? 0) + 1;

    const turno = await Turno.create({
      numero,
      nombre:      nombre.trim().toUpperCase(),
      institucion: (institucion ?? '').trim().toUpperCase(),
      servicio,
      documento:   documento?.trim() || null,
    });

    broadcast(sseClients, 'nuevo', turno);
    res.status(201).json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/siguiente – llamar siguiente turno pendiente
app.post('/api/siguiente', async (req, res) => {
  try {
    const turno = await Turno.findOneAndUpdate(
      { estado: 'pendiente' },
      { estado: 'llamado', llamadoEn: new Date() },
      { sort: { numero: 1 }, new: true }
    );
    if (!turno) return res.status(404).json({ error: 'No hay turnos pendientes.' });
    broadcast(sseClients, 'llamado', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/llamar – llamar turno específico
app.post('/api/turnos/:id/llamar', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'llamado', llamadoEn: new Date() },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast(sseClients, 'llamado', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/atender – marcar como atendido
app.post('/api/turnos/:id/atender', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'atendido', atendidoEn: new Date() },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast(sseClients, 'atendido', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/saltar – saltar turno
app.post('/api/turnos/:id/saltar', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'saltado' },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast(sseClients, 'saltado', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/turnos/:id
app.delete('/api/turnos/:id', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndDelete(req.params.id);
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast(sseClients, 'eliminado', { id: req.params.id });
    res.json({ message: 'Turno eliminado.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   FUBAM – Sistema de Gestión de Turnos   ║');
  console.log(`  ║   Servidor en http://localhost:${PORT}       ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
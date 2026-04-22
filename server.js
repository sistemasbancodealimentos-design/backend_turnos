const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app  = express();
// Render asigna automáticamente un puerto; process.env.PORT lo captura correctamente
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Conexión MongoDB ────────────────────────────────────────────────────────
// IMPORTANTE: Asegúrate de configurar MONGODB_URI en las variables de entorno de Render
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ ERROR: La variable de entorno MONGODB_URI no está definida.');
  console.error('Configúrala en Render > Dashboard > Environment.');
} else {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
    .catch(err => {
      console.error('❌ Error crítico conectando a MongoDB:', err.message);
    });
}

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

// ── Manejo de Eventos (SSE) ──────────────────────────────────────────────────
let sseClients = [];
function broadcast(clients, type, data) {
  const payload = JSON.stringify({ type, data });
  clients.forEach(res => res.write(`data: ${payload}\n\n`));
}

// ── Rutas API ───────────────────────────────────────────────────────────────

// Endpoint SSE para actualizaciones en tiempo real
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// GET /api/turnos – obtener todos
app.get('/api/turnos', async (req, res) => {
  try {
    const turnos = await Turno.find().sort({ creadoEn: 1 });
    res.json(turnos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos – crear nuevo turno
app.post('/api/turnos', async (req, res) => {
  try {
    const ultimoTurno = await Turno.findOne().sort({ numero: -1 });
    const nuevoNumero = ultimoTurno && ultimoTurno.numero ? ultimoTurno.numero + 1 : 1;
    const nuevoTurno = new Turno({ ...req.body, numero: nuevoNumero });
    await nuevoTurno.save();
    broadcast(sseClients, 'nuevo', nuevoTurno);
    res.status(201).json(nuevoTurno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/llamar – llamar turno
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

// POST /api/turnos/:id/atender – atender turno
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

// DELETE /api/turnos/:id – eliminar un turno
app.delete('/api/turnos/:id', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndDelete(req.params.id);
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast(sseClients, 'eliminado', { id: req.params.id });
    res.json({ message: 'Turno eliminado.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Iniciar Servidor ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
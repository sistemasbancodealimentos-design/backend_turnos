const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Conexión MongoDB ────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ ERROR: La variable de entorno MONGODB_URI no está definida.');
} else {
  // Configuración de conexión optimizada para evitar timeouts
  mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
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
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  sseClients.forEach(res => res.write(`data: ${payload}\n\n`));
}

// ── Rutas API ───────────────────────────────────────────────────────────────

// Endpoint SSE
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

// GET /api/turnos
app.get('/api/turnos', async (req, res) => {
  try {
    const turnos = await Turno.find().sort({ creadoEn: 1 });
    res.json(turnos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos – Crear nuevo
app.post('/api/turnos', async (req, res) => {
  try {
    const ultimoTurno = await Turno.findOne().sort({ numero: -1 });
    const nuevoNumero = ultimoTurno && ultimoTurno.numero ? ultimoTurno.numero + 1 : 1;
    const nuevoTurno = new Turno({ ...req.body, numero: nuevoNumero });
    await nuevoTurno.save();
    broadcast('nuevo', nuevoTurno);
    res.status(201).json(nuevoTurno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/llamar
app.post('/api/turnos/:id/llamar', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'llamado', llamadoEn: new Date() },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast('llamado', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/turnos/:id/atender
app.post('/api/turnos/:id/atender', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'atendido', atendidoEn: new Date() },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast('atendido', turno);
    res.json(turno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Iniciar Servidor ────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});

// Manejo de error de puerto para Render
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('❌ Puerto en uso, reintentando...');
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, 1000);
  }
});
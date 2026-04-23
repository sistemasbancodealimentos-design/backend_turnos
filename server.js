const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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
  fecha:       { type: String, required: true }, // YYYY-MM-DD formato
  nombre:      { type: String, required: true },
  institucion: { type: String, default: '' },
  servicio:    { type: String, required: true },
  documento:   { type: String, default: null },
  estado:      { type: String, enum: ['pendiente', 'llamado', 'atendido', 'saltado'], default: 'pendiente' },
  creadoEn:    { type: Date, default: Date.now },
  llamadoEn:   { type: Date, default: null },
  atendidoEn:  { type: Date, default: null },
}, { versionKey: false });

// Índice compuesto para búsquedas rápidas por fecha
turnoSchema.index({ fecha: 1, numero: -1 });

const Turno = mongoose.model('Turno', turnoSchema);

// ── Helper: Obtener fecha actual en formato YYYY-MM-DD ──────────────────────
function obtenerFechaHoy() {
  const hoy = new Date();
  const year = hoy.getFullYear();
  const month = String(hoy.getMonth() + 1).padStart(2, '0');
  const day = String(hoy.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ── Manejo de Eventos (SSE) ──────────────────────────────────────────────────
let sseClients = [];
function broadcast(type, data) {
  const payload = JSON.stringify(data);
  sseClients.forEach((res) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${payload}\n\n`);
  });
}

async function buildStats() {
  const hoy = obtenerFechaHoy();
  const [total, pendientes, llamados, atendidos, saltados] = await Promise.all([
    Turno.countDocuments({ fecha: hoy }),
    Turno.countDocuments({ fecha: hoy, estado: 'pendiente' }),
    Turno.countDocuments({ fecha: hoy, estado: 'llamado' }),
    Turno.countDocuments({ fecha: hoy, estado: 'atendido' }),
    Turno.countDocuments({ fecha: hoy, estado: 'saltado' }),
  ]);

  return { total, pendientes, llamados, atendidos, saltados };
}

// ── Rutas API ───────────────────────────────────────────────────────────────

// Endpoint SSE
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Alias usado por los frontends
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// GET /api/turnos
app.get('/api/turnos', async (req, res) => {
  try {
    const hoy = obtenerFechaHoy();
    const turnos = await Turno.find({ fecha: hoy }).sort({ creadoEn: 1 });
    res.json(turnos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await buildStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/turnos – Crear nuevo
app.post('/api/turnos', async (req, res) => {
  try {
    const hoy = obtenerFechaHoy();
    const ultimoTurnoHoy = await Turno.findOne({ fecha: hoy }).sort({ numero: -1 });
    const nuevoNumero = ultimoTurnoHoy && ultimoTurnoHoy.numero ? ultimoTurnoHoy.numero + 1 : 1;
    const nuevoTurno = new Turno({ ...req.body, numero: nuevoNumero, fecha: hoy });
    await nuevoTurno.save();
    broadcast('nuevo', nuevoTurno);
    res.status(201).json(nuevoTurno);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/siguiente
app.post('/api/siguiente', async (req, res) => {
  try {
    const hoy = obtenerFechaHoy();
    const siguiente = await Turno.findOneAndUpdate(
      { fecha: hoy, estado: 'pendiente' },
      { estado: 'llamado', llamadoEn: new Date() },
      { sort: { creadoEn: 1 }, new: true }
    );

    if (!siguiente) {
      return res.status(404).json({ error: 'No hay turnos pendientes.' });
    }

    broadcast('llamado', siguiente);
    res.json(siguiente);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// POST /api/turnos/:id/saltar
app.post('/api/turnos/:id/saltar', async (req, res) => {
  try {
    const turno = await Turno.findByIdAndUpdate(
      req.params.id,
      { estado: 'saltado', atendidoEn: new Date() },
      { new: true }
    );
    if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });
    broadcast('saltado', turno);
    res.json(turno);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── REPORTES ────────────────────────────────────────────────────────────────

// GET /api/reportes/dia/:fecha – Reportes de un día específico
app.get('/api/reportes/dia/:fecha', async (req, res) => {
  try {
    const { fecha } = req.params; // Formato: YYYY-MM-DD
    const turnos = await Turno.find({ fecha }).sort({ numero: 1 });
    
    const stats = {
      fecha,
      total: turnos.length,
      atendidos: turnos.filter(t => t.estado === 'atendido').length,
      saltados: turnos.filter(t => t.estado === 'saltado').length,
      pendientes: turnos.filter(t => t.estado === 'pendiente').length,
      llamados: turnos.filter(t => t.estado === 'llamado').length,
      turnos
    };
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reportes/rango – Reportes de un rango de fechas
app.get('/api/reportes/rango', async (req, res) => {
  try {
    const { desde, hasta } = req.query; // Formato: YYYY-MM-DD
    
    if (!desde || !hasta) {
      return res.status(400).json({ error: 'Se requieren parámetros "desde" y "hasta" en formato YYYY-MM-DD' });
    }
    
    const turnos = await Turno.find({
      fecha: { $gte: desde, $lte: hasta }
    }).sort({ fecha: 1, numero: 1 });
    
    // Agrupar por fecha
    const porFecha = {};
    turnos.forEach(t => {
      if (!porFecha[t.fecha]) {
        porFecha[t.fecha] = [];
      }
      porFecha[t.fecha].push(t);
    });
    
    const stats = {
      desde,
      hasta,
      total: turnos.length,
      atendidos: turnos.filter(t => t.estado === 'atendido').length,
      saltados: turnos.filter(t => t.estado === 'saltado').length,
      pendientes: turnos.filter(t => t.estado === 'pendiente').length,
      llamados: turnos.filter(t => t.estado === 'llamado').length,
      porFecha
    };
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reportes/mes – Reportes de un mes completo
app.get('/api/reportes/mes', async (req, res) => {
  try {
    const { mes } = req.query; // Formato: YYYY-MM
    
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Se requiere parámetro "mes" en formato YYYY-MM' });
    }
    
    const turnos = await Turno.find({
      fecha: new RegExp(`^${mes}`)
    }).sort({ fecha: 1, numero: 1 });
    
    // Agrupar por fecha
    const porFecha = {};
    turnos.forEach(t => {
      if (!porFecha[t.fecha]) {
        porFecha[t.fecha] = [];
      }
      porFecha[t.fecha].push(t);
    });
    
    const stats = {
      mes,
      total: turnos.length,
      atendidos: turnos.filter(t => t.estado === 'atendido').length,
      saltados: turnos.filter(t => t.estado === 'saltado').length,
      pendientes: turnos.filter(t => t.estado === 'pendiente').length,
      llamados: turnos.filter(t => t.estado === 'llamado').length,
      porFecha
    };
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
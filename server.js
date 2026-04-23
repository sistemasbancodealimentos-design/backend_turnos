const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
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
  numero: { type: Number },
  nombre: { type: String, required: true },
  institucion: { type: String, default: '' },
  servicio: { type: String, required: true },
  documento: { type: String, default: null },
  estado: { type: String, enum: ['pendiente', 'llamado', 'atendido', 'saltado'], default: 'pendiente' },
  creadoEn: { type: Date, default: Date.now },
  llamadoEn: { type: Date, default: null },
  atendidoEn: { type: Date, default: null },
}, { versionKey: false });

const Turno = mongoose.model('Turno', turnoSchema);

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
  const [total, pendientes, llamados, atendidos, saltados] = await Promise.all([
    Turno.countDocuments(),
    Turno.countDocuments({ estado: 'pendiente' }),
    Turno.countDocuments({ estado: 'llamado' }),
    Turno.countDocuments({ estado: 'atendido' }),
    Turno.countDocuments({ estado: 'saltado' }),
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
    const turnos = await Turno.find().sort({ creadoEn: 1 });
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
// POST /api/turnos - Registro con reinicio diario
app.post('/api/turnos', async (req, res) => {
  try {
    const { nombre, institucion, servicio, documento } = req.body;

    // 1. Definir el inicio y fin del día actual
    const inicioDia = new Date();
    inicioDia.setHours(0, 0, 0, 0);

    const finDia = new Date();
    finDia.setHours(23, 59, 59, 999);

    // 2. Contar turnos de esta institución creados hoy
    const conteoHoy = await Turno.countDocuments({
      institucion: institucion,
      createdAt: { $gte: inicioDia, $lte: finDia }
    });

    // 3. El nuevo número es el conteo + 1
    const nuevoNumero = conteoHoy + 1;

    const nuevoTurno = new Turno({
      numero: nuevoNumero,
      nombre,
      institucion,
      servicio,
      documento,
      estado: 'pendiente'
    });

    await nuevoTurno.save();

    // Opcional: Emitir por socket si usas broadcast
    if (typeof broadcast === 'function') broadcast('nuevo', nuevoTurno);

    res.status(201).json(nuevoTurno);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// NUEVA RUTA: Endpoint para Reportes
app.get('/api/reportes', async (req, res) => {
  try {
    const { inicio, fin } = req.query;
    const filtro = {};

    if (inicio && fin) {
      filtro.createdAt = {
        $gte: new Date(inicio + "T00:00:00"),
        $lte: new Date(fin + "T23:59:59")
      };
    }

    const turnos = await Turno.find(filtro).sort({ createdAt: -1 });
    res.json(turnos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/siguiente
app.post('/api/siguiente', async (req, res) => {
  try {
    const siguiente = await Turno.findOneAndUpdate(
      { estado: 'pendiente' },
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
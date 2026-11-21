process.env.TZ = 'America/Mazatlan';

/*
  server.js - Servidor principal del Sistema de Turnos
  
  Aquí está concentrado todo el backend del proyecto usando Node.js, Express y SQLite.
  Básicamente se encarga de:
  1. Crear la base de datos local (turnos.db) y registrar las 7 ventanillas fijas.
  2. Servir las páginas de la carpeta "public/" (kiosco, pantalla, ventanilla y dashboard).
  3. Recibir las peticiones para sacar turno, abrir ventanilla, llamar al que sigue y cerrar turnos.
  4. Mandar avisos en tiempo real por Server-Sent Events (SSE) para que todas las pantallas
     se actualicen solas sin tener que recargar la página.
  5. Hacer el corte automático a las 6:00 PM (18:00 hrs) y cerrar las ventanillas que duren
     más de 2 horas sin moverle a nada.
*/

const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const PUERTO = Number(process.env.PORT) || 4782;
const RUTA_DB = path.join(__dirname, 'turnos.db');

// 2 horas en milisegundos para el límite de inactividad de las ventanillas
const DOS_HORAS_MS = 2 * 60 * 60 * 1000;

const PREFIJOS = {
  caja: 'C',
  ejecutivo: 'E',
  atencion: 'A'
};

const MOTIVOS_CIERRE = [
  'atendido',
  'no_atendido',
  'no_aparecio',
  'turno_equivocado'
];

// Las 7 ventanillas que maneja el negocio (4 de caja, 2 de ejecutivo y 1 de atención)
const LISTA_VENTANILLAS = [
  { numero: 1, ventanilla: 'Ventanilla 1', tipo_servicio: 'caja' },
  { numero: 2, ventanilla: 'Ventanilla 2', tipo_servicio: 'caja' },
  { numero: 3, ventanilla: 'Ventanilla 3', tipo_servicio: 'caja' },
  { numero: 4, ventanilla: 'Ventanilla 4', tipo_servicio: 'caja' },
  { numero: 5, ventanilla: 'Ventanilla 5', tipo_servicio: 'ejecutivo' },
  { numero: 6, ventanilla: 'Ventanilla 6', tipo_servicio: 'ejecutivo' },
  { numero: 7, ventanilla: 'Ventanilla 7', tipo_servicio: 'atencion' }
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Abrimos el archivo de SQLite. Activamos WAL para que no se trabe cuando varias pantallas
// leen al mismo tiempo y busy_timeout por si se empalman dos escrituras.
const db = new DatabaseSync(RUTA_DB);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

// Aquí guardamos las conexiones abiertas de SSE y los timers de inactividad de cada ventanilla
const pantallasConectadas = new Set();
const timersInactividad = new Map();
let timerCierre6pm = null;
let timerMedianoche = null;

// Objeto donde guardamos las consultas SQL preparadas una sola vez al iniciar
let sql = {};

// Clase sencilla para devolver errores con su código HTTP (400, 404, 409)
class ErrorTurnos extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

// --- Funciones auxiliares de fechas y base de datos ---

// Saca la fecha local en formato "YYYY-MM-DD" tomando el reloj del servidor (hora de Culiacán/Mazatlán).
// No usamos CURRENT_TIMESTAMP de SQLite porque ese sale en UTC y nos cambia de día a las 5 de la tarde.
function sacarFechaHoy(ms = Date.now()) {
  const f = new Date(ms);
  const anio = f.getFullYear();
  const mes = String(f.getMonth() + 1).padStart(2, '0');
  const dia = String(f.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

// Formatea una hora en milisegundos a "DD/MM/YY HH:mm" para los tickets y tablas
function formatearFechaHora(ms) {
  const f = new Date(ms);
  const dia = String(f.getDate()).padStart(2, '0');
  const mes = String(f.getMonth() + 1).padStart(2, '0');
  const anio = String(f.getFullYear()).slice(-2);
  const horas = String(f.getHours()).padStart(2, '0');
  const mins = String(f.getMinutes()).padStart(2, '0');
  return `${dia}/${mes}/${anio} ${horas}:${mins}`;
}

// Envuelve varios cambios de SQLite en una transacción (BEGIN IMMEDIATE ... COMMIT).
// Esto nos sirve para la atomicidad: o se guardan todos los pasos completos o, si algo truena
// a mitad del camino, el ROLLBACK deshace todo para no dejar turnos ni ventanillas a medias.
function hacerTransaccion(operacion) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = operacion();
    db.exec('COMMIT');
    return resultado;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Si ya se había cancelado sola, dejamos pasar el error original
    }
    throw error;
  }
}

// Calcula cuántos segundos activos acumulados lleva la ventanilla hasta el momento indicado
function sumarSegundosActivos(ventanilla, hastaMs) {
  if (ventanilla.estado !== 'activo' || !ventanilla.ultimo_inicio_activo) {
    return ventanilla.segundos_activos;
  }
  const segundosExtra = Math.max(
    0,
    Math.floor((hastaMs - ventanilla.ultimo_inicio_activo) / 1000)
  );
  return ventanilla.segundos_activos + segundosExtra;
}

// Si una ventanilla se cierra por inactividad o se reinician las ventanillas,
// regresamos a la fila de espera el turno que haya tenido asignado para que no se pierda.
function regresarTurnosAEspera(hoy, nombreVentanilla = null) {
  if (nombreVentanilla) {
    return sql.liberarTurnosDeVentanilla.run(hoy, nombreVentanilla).changes;
  }
  return sql.liberarTodosEnAtencion.run(hoy).changes;
}

// Busca una ventanilla por nombre; si no existe, lanza de una vez el error 404.
// Así nos ahorramos repetir esta validación en cada ruta.
function buscarVentanilla(nombre) {
  const fila = sql.obtenerVentanilla.get(nombre);
  if (!fila) {
    throw new ErrorTurnos(404, 'Ventanilla no encontrada');
  }
  return fila;
}

// Responde el error correspondiente en las rutas Express sin repetir el mismo try/catch largo
function mandarError(res, error, mensajePorDefecto) {
  if (error instanceof ErrorTurnos) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[Error en servidor]:', error);
  return res.status(500).json({ error: mensajePorDefecto });
}

// --- Creación de tablas y preparación de consultas SQL ---

// Crea las tablas si no existen, mete las 7 ventanillas iniciales y deja listas las consultas SQL
function iniciarBaseDatos() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ventanillas (
      numero INTEGER UNIQUE NOT NULL,
      ventanilla TEXT PRIMARY KEY,
      tipo_servicio TEXT NOT NULL CHECK (tipo_servicio IN ('caja', 'ejecutivo', 'atencion')),
      estado TEXT NOT NULL DEFAULT 'cerrado' CHECK (estado IN ('activo', 'pausa', 'cerrado')),
      segundos_activos INTEGER NOT NULL DEFAULT 0,
      ultimo_inicio_activo INTEGER,
      ultima_actividad INTEGER
    );

    CREATE TABLE IF NOT EXISTS turnos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha_jornada TEXT NOT NULL,
      numero_folio INTEGER NOT NULL,
      codigo TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('caja', 'ejecutivo', 'atencion')),
      estado TEXT NOT NULL CHECK (estado IN ('espera', 'atendiendo', 'cerrado')),
      resultado TEXT CHECK (resultado IN ('atendido', 'no_atendido', 'no_aparecio', 'turno_equivocado')),
      ventanilla TEXT,
      hora_creacion INTEGER NOT NULL,
      hora_llamado INTEGER,
      hora_fin INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_turnos_jornada_tipo_id
    ON turnos (fecha_jornada, tipo, id);

    CREATE INDEX IF NOT EXISTS idx_turnos_jornada_estado
    ON turnos (fecha_jornada, estado);
  `);

  // Preparamos las consultas una sola vez al arrancar para no estar compilándolas en cada clic
  sql = {
    insertarVentanilla: db.prepare(`
      INSERT OR IGNORE INTO ventanillas (numero, ventanilla, tipo_servicio)
      VALUES (?, ?, ?);
    `),
    listarVentanillas: db.prepare('SELECT * FROM ventanillas ORDER BY numero ASC;'),
    obtenerVentanilla: db.prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;'),
    listarTurnosDia: db.prepare(`
      SELECT *
      FROM turnos
      WHERE fecha_jornada = ?
      ORDER BY id ASC;
    `),
    obtenerTurnoPorId: db.prepare('SELECT * FROM turnos WHERE id = ?;'),
    siguienteEnEspera: db.prepare(`
      SELECT *
      FROM turnos
      WHERE fecha_jornada = ?
        AND tipo = ?
        AND estado = 'espera'
      ORDER BY id ASC
      LIMIT 1;
    `),
    asignarTurno: db.prepare(`
      UPDATE turnos
      SET estado = 'atendiendo',
          ventanilla = ?,
          hora_llamado = ?
      WHERE id = ?;
    `),
    ultimoFolioServicio: db.prepare(`
      SELECT numero_folio
      FROM turnos
      WHERE fecha_jornada = ?
        AND tipo = ?
      ORDER BY id DESC
      LIMIT 1;
    `),
    foliosActivosServicio: db.prepare(`
      SELECT numero_folio
      FROM turnos
      WHERE fecha_jornada = ?
        AND tipo = ?
        AND estado IN ('espera', 'atendiendo');
    `),
    buscarVentanillaLibre: db.prepare(`
      SELECT v.ventanilla
      FROM ventanillas v
      WHERE v.tipo_servicio = ?
        AND v.estado = 'activo'
        AND NOT EXISTS (
          SELECT 1
          FROM turnos t
          WHERE t.fecha_jornada = ?
            AND t.ventanilla = v.ventanilla
            AND t.estado = 'atendiendo'
        )
      ORDER BY v.numero ASC
      LIMIT 1;
    `),
    insertarTurno: db.prepare(`
      INSERT INTO turnos (
        fecha_jornada, numero_folio, codigo, tipo, estado,
        ventanilla, hora_creacion, hora_llamado
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `),
    actualizarActividadVentanilla: db.prepare(`
      UPDATE ventanillas
      SET ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    abrirVentanilla: db.prepare(`
      UPDATE ventanillas
      SET estado = 'activo',
          segundos_activos = ?,
          ultimo_inicio_activo = ?,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    reanudarVentanilla: db.prepare(`
      UPDATE ventanillas
      SET estado = 'activo',
          ultimo_inicio_activo = ?,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    pausarVentanilla: db.prepare(`
      UPDATE ventanillas
      SET estado = 'pausa',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    cerrarVentanilla: db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    reiniciarUnaVentanilla: db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = 0,
          ultimo_inicio_activo = NULL,
          ultima_actividad = NULL
      WHERE ventanilla = ?;
    `),
    reiniciarTodasVentanillas: db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = 0,
          ultimo_inicio_activo = NULL,
          ultima_actividad = NULL;
    `),
    turnoEnCursoVentanilla: db.prepare(`
      SELECT id
      FROM turnos
      WHERE fecha_jornada = ?
        AND ventanilla = ?
        AND estado = 'atendiendo'
      LIMIT 1;
    `),
    obtenerTurnoEnAtencion: db.prepare(`
      SELECT *
      FROM turnos
      WHERE id = ?
        AND fecha_jornada = ?
        AND ventanilla = ?
        AND estado = 'atendiendo';
    `),
    cerrarTurno: db.prepare(`
      UPDATE turnos
      SET estado = 'cerrado',
          resultado = ?,
          hora_fin = ?
      WHERE id = ?;
    `),
    mantenerVentanillaActiva: db.prepare(`
      UPDATE ventanillas
      SET ultimo_inicio_activo = COALESCE(ultimo_inicio_activo, ?),
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `),
    liberarTurnosDeVentanilla: db.prepare(`
      UPDATE turnos
      SET estado = 'espera',
          ventanilla = NULL,
          hora_llamado = NULL
      WHERE fecha_jornada = ?
        AND ventanilla = ?
        AND estado = 'atendiendo';
    `),
    liberarTodosEnAtencion: db.prepare(`
      UPDATE turnos
      SET estado = 'espera',
          ventanilla = NULL,
          hora_llamado = NULL
      WHERE fecha_jornada = ?
        AND estado = 'atendiendo';
    `),
    ventanillasAbiertas: db.prepare(`
      SELECT *
      FROM ventanillas
      WHERE estado IN ('activo', 'pausa');
    `),
    cerrarPendientesDia: db.prepare(`
      UPDATE turnos
      SET estado = 'cerrado',
          resultado = 'no_atendido',
          hora_fin = ?
      WHERE fecha_jornada = ?
        AND estado IN ('espera', 'atendiendo');
    `),
    cerrarPendientesDiasPasados: db.prepare(`
      UPDATE turnos
      SET estado = 'cerrado',
          resultado = 'no_atendido',
          hora_fin = ?
      WHERE fecha_jornada < ?
        AND estado IN ('espera', 'atendiendo');
    `),
    cerrarPendientesAntesCorte: db.prepare(`
      UPDATE turnos
      SET estado = 'cerrado',
          resultado = 'no_atendido',
          hora_fin = ?
      WHERE fecha_jornada = ?
        AND estado IN ('espera', 'atendiendo')
        AND hora_creacion < ?;
    `),
    borrarTurnosDia: db.prepare('DELETE FROM turnos WHERE fecha_jornada = ?;'),
    borrarTodosTurnos: db.prepare('DELETE FROM turnos;'),
    reiniciarSecuenciaTurnos: db.prepare("DELETE FROM sqlite_sequence WHERE name = 'turnos';")
  };

  hacerTransaccion(() => {
    for (const item of LISTA_VENTANILLAS) {
      sql.insertarVentanilla.run(item.numero, item.ventanilla, item.tipo_servicio);
    }
  });
}

// --- Lógica de atención, tiempos estimados y armado del estado ---

// Busca el turno más viejo en espera de ese servicio y se lo asigna a la ventanilla
function pasarSiguienteTurno(tipoServicio, nombreVentanilla, ahora, hoy) {
  const siguiente = sql.siguienteEnEspera.get(hoy, tipoServicio);
  if (!siguiente) {
    return null;
  }

  sql.asignarTurno.run(nombreVentanilla, ahora, siguiente.id);
  return sql.obtenerTurnoPorId.get(siguiente.id);
}

// Calcula cuántos segundos activos lleva la ventanilla en el día actual
function segundosActivosDeHoy(ventanilla, ahora, hoy) {
  if (
    ventanilla.estado === 'cerrado' &&
    ventanilla.ultima_actividad &&
    sacarFechaHoy(ventanilla.ultima_actividad) !== hoy
  ) {
    return 0;
  }
  return sumarSegundosActivos(ventanilla, ahora);
}

// Calcula el tiempo estimado de espera de un servicio usando los últimos 20 turnos atendidos hoy.
// Si hay menos de 3 atendidos hoy, regresa "5 min" por regla del proyecto.
// Si ya hay datos suficientes y hay fila acumulada, también toma en cuenta cuántos clientes
// hay formados y cuántas ventanillas están abiertas atendiendo ese servicio.
function calcularEsperaServicio(muestrasRecientes, personasEnFila, ventanillasActivas) {
  if (muestrasRecientes.length < 3) {
    return '5 min';
  }

  let sumaEsperaMs = 0;
  let sumaAtencionMs = 0;
  for (const t of muestrasRecientes) {
    sumaEsperaMs += Math.max(0, t.hora_llamado - t.hora_creacion);
    if (t.hora_fin) {
      sumaAtencionMs += Math.max(0, t.hora_fin - t.hora_llamado);
    }
  }

  const promedioEsperaMs = sumaEsperaMs / muestrasRecientes.length;
  const promedioAtencionMs = sumaAtencionMs > 0
    ? sumaAtencionMs / muestrasRecientes.length
    : promedioEsperaMs;

  let estimadoMs = promedioEsperaMs;

  // Si hay cola esperando, escalamos según el tamaño de la fila y las ventanillas activas
  if (personasEnFila > 0) {
    const divisores = Math.max(1, ventanillasActivas);
    const estimadoPorFilaMs = (personasEnFila / divisores) * promedioAtencionMs;
    estimadoMs = Math.max(promedioEsperaMs, estimadoPorFilaMs);
  }

  const minutos = Math.max(1, Math.round(estimadoMs / 60000));
  return `${minutos} min`;
}

// Arma el resumen completo del día para mandarlo por GET /api/estado o por SSE.
// Aprovechamos un solo recorrido de los turnos de hoy para sacar filas, promedios y tiempos estimados.
function armarEstado() {
  const ahora = Date.now();
  const hoy = sacarFechaHoy(ahora);

  const filasVentanillas = sql.listarVentanillas.all();
  const turnosHoy = sql.listarTurnosDia.all(hoy);

  const turnoPorVentanilla = {};
  const turnosAtendiendo = [];
  const filasEspera = { caja: [], ejecutivo: [], atencion: [] };
  const proximosEspera = [];
  const atendidosPorServicio = { caja: [], ejecutivo: [], atencion: [] };

  let totalCerrados = 0;
  let totalCerradosEnVentanilla = 0;
  let cerradosPorCorte = 0;
  let sumaEsperaMs = 0;
  let totalConEspera = 0;
  let sumaAtencionMs = 0;
  let totalAtencion = 0;

  const conteoMotivos = {
    atendido: 0,
    no_atendido: 0,
    no_aparecio: 0,
    turno_equivocado: 0
  };
  const atendidosPorHora = {};
  const cerradosPorVentanilla = {};
  const atendidosPorVentanilla = {};

  for (const turno of turnosHoy) {
    if (turno.hora_llamado !== null) {
      sumaEsperaMs += Math.max(0, turno.hora_llamado - turno.hora_creacion);
      totalConEspera += 1;
    }

    if (turno.estado === 'atendiendo') {
      turnosAtendiendo.push(turno);
      if (turno.ventanilla) {
        turnoPorVentanilla[turno.ventanilla] = turno;
      }
      continue;
    }

    if (turno.estado === 'espera') {
      filasEspera[turno.tipo].push(turno);
      proximosEspera.push(turno);
      continue;
    }

    if (turno.estado === 'cerrado') {
      totalCerrados += 1;

      // Si se cerró como "no_atendido" pero nunca fue llamado por ninguna ventanilla,
      // significa que lo cerró el corte automático de las 18:00 y no un cajero.
      // Lo contamos aparte para no ensuciar los porcentajes de motivos de los cajeros.
      const fuePorCorte = turno.resultado === 'no_atendido' && turno.hora_llamado === null;
      if (fuePorCorte) {
        cerradosPorCorte += 1;
      } else if (turno.resultado && conteoMotivos[turno.resultado] !== undefined) {
        conteoMotivos[turno.resultado] += 1;
        totalCerradosEnVentanilla += 1;
      }

      if (turno.ventanilla) {
        cerradosPorVentanilla[turno.ventanilla] =
          (cerradosPorVentanilla[turno.ventanilla] || 0) + 1;
      }

      if (turno.resultado === 'atendido') {
        if (turno.hora_llamado !== null) {
          atendidosPorServicio[turno.tipo].push(turno);
        }
        if (turno.ventanilla) {
          atendidosPorVentanilla[turno.ventanilla] =
            (atendidosPorVentanilla[turno.ventanilla] || 0) + 1;
        }
        if (turno.hora_llamado !== null && turno.hora_fin !== null) {
          sumaAtencionMs += Math.max(0, turno.hora_fin - turno.hora_llamado);
          totalAtencion += 1;
        }
        if (turno.hora_fin !== null) {
          const hora = new Date(turno.hora_fin).getHours();
          atendidosPorHora[hora] = (atendidosPorHora[hora] || 0) + 1;
        }
      }
    }
  }

  // En la pantalla de sala de espera ponemos hasta arriba el último turno que acaban de llamar
  turnosAtendiendo.sort((a, b) => (b.hora_llamado || 0) - (a.hora_llamado || 0) || b.id - a.id);

  const activasPorServicio = { caja: 0, ejecutivo: 0, atencion: 0 };
  const ventanillas = filasVentanillas.map((v) => {
    if (v.estado === 'activo') {
      activasPorServicio[v.tipo_servicio] += 1;
    }
    return {
      ...v,
      segundosActivos: segundosActivosDeHoy(v, ahora, hoy),
      turnoActual: turnoPorVentanilla[v.ventanilla] || null
    };
  });

  // Tomamos los últimos 20 atendidos de cada servicio para estimar la espera sin hacer 3 consultas extra
  const tiemposEstimados = {};
  for (const tipo of ['caja', 'ejecutivo', 'atencion']) {
    const lista = atendidosPorServicio[tipo];
    const ultimos20 = lista.slice(-20);
    tiemposEstimados[tipo] = calcularEsperaServicio(
      ultimos20,
      filasEspera[tipo].length,
      activasPorServicio[tipo]
    );
  }

  // Armamos la lista de horas corrida desde la primera hasta la última hora con clientes atendidos
  const horasConDatos = Object.keys(atendidosPorHora).map(Number);
  const clientesAtendidosPorHora = [];
  if (horasConDatos.length > 0) {
    const horaMin = Math.min(...horasConDatos);
    const horaMax = Math.max(...horasConDatos);
    for (let h = horaMin; h <= horaMax; h += 1) {
      clientesAtendidosPorHora.push({
        horaNum: h,
        etiqueta: `${String(h).padStart(2, '0')}:00`,
        total: atendidosPorHora[h] || 0
      });
    }
  }

  const motivos = {};
  for (const clave of MOTIVOS_CIERRE) {
    const cantidad = conteoMotivos[clave];
    motivos[clave] = {
      cantidad,
      porcentaje:
        totalCerradosEnVentanilla > 0
          ? Math.round((cantidad * 1000) / totalCerradosEnVentanilla) / 10
          : 0
    };
  }

  const rendimientoPorVentanilla = ventanillas.map((v) => ({
    numero: v.numero,
    ventanilla: v.ventanilla,
    tipo_servicio: v.tipo_servicio,
    estado: v.estado,
    turnosCerrados: cerradosPorVentanilla[v.ventanilla] || 0,
    turnosAtendidos: atendidosPorVentanilla[v.ventanilla] || 0,
    segundosActivos: v.segundosActivos
  }));

  return {
    fechaJornada: hoy,
    fechaServidor: formatearFechaHora(ahora),
    ahora,
    ventanillas,
    turnosAtendiendo,
    filasEspera,
    proximosEspera,
    tiemposEstimados,
    metricas: {
      totalTurnos: turnosHoy.length,
      enEspera: proximosEspera.length,
      enAtencion: turnosAtendiendo.length,
      totalCerrados,
      cerradosPorCorte,
      tiempoPromedioEsperaSeg:
        totalConEspera > 0 ? Math.round(sumaEsperaMs / totalConEspera / 1000) : 0,
      tiempoPromedioAtencionSeg:
        totalAtencion > 0 ? Math.round(sumaAtencionMs / totalAtencion / 1000) : 0,
      clientesAtendidosPorHora,
      motivos,
      rendimientoPorVentanilla
    }
  };
}

// Manda el estado nuevo a todas las pantallas que estén conectadas por SSE
function avisarPantallas(tipo, extra = {}) {
  if (pantallasConectadas.size === 0) {
    return;
  }

  const paquete = `data: ${JSON.stringify({
    tipo,
    ...extra,
    estado: armarEstado()
  })}\n\n`;

  for (const cliente of pantallasConectadas) {
    try {
      cliente.write(paquete);
    } catch (_) {
      pantallasConectadas.delete(cliente);
    }
  }
}

// --- Temporizadores: inactividad de 2 horas, corte de las 18:00 y cambio de día ---

function quitarTimerInactividad(nombreVentanilla) {
  const timer = timersInactividad.get(nombreVentanilla);
  if (timer) {
    clearTimeout(timer);
    timersInactividad.delete(nombreVentanilla);
  }
}

function quitarTodosLosTimersInactividad() {
  for (const timer of timersInactividad.values()) {
    clearTimeout(timer);
  }
  timersInactividad.clear();
}

// Si una ventanilla cumple 2 horas sin actividad, la cerramos y regresamos su turno a espera
function cerrarVentanillaPorInactividad(nombreVentanilla, ahora = Date.now()) {
  const hoy = sacarFechaHoy(ahora);

  const resultado = hacerTransaccion(() => {
    const fila = sql.obtenerVentanilla.get(nombreVentanilla);
    if (!fila || fila.estado === 'cerrado') {
      return { cerrada: false };
    }

    const inactivoMs = fila.ultima_actividad
      ? ahora - fila.ultima_actividad
      : DOS_HORAS_MS;

    if (inactivoMs < DOS_HORAS_MS) {
      return {
        cerrada: false,
        restanteMs: DOS_HORAS_MS - inactivoMs
      };
    }

    sql.cerrarVentanilla.run(sumarSegundosActivos(fila, ahora), ahora, nombreVentanilla);
    regresarTurnosAEspera(hoy, nombreVentanilla);
    return { cerrada: true };
  });

  if (resultado.restanteMs) {
    programarTimerInactividad(nombreVentanilla, resultado.restanteMs);
  } else if (resultado.cerrada) {
    quitarTimerInactividad(nombreVentanilla);
    console.log(`[Inactividad] Se cerró ${nombreVentanilla} por pasar 2 horas sin uso.`);
    avisarPantallas('ventanilla_inactiva_cerrada', { ventanilla: nombreVentanilla });
  }

  return resultado;
}

// Activa o reinicia la cuenta regresiva de 2 horas cada vez que una ventanilla hace algo
function programarTimerInactividad(nombreVentanilla, esperaMs = DOS_HORAS_MS) {
  quitarTimerInactividad(nombreVentanilla);

  const timer = setTimeout(() => {
    timersInactividad.delete(nombreVentanilla);
    cerrarVentanillaPorInactividad(nombreVentanilla);
  }, Math.max(0, esperaMs));

  timersInactividad.set(nombreVentanilla, timer);
}

// Corte diario de las 18:00 hrs: cierra las ventanillas abiertas guardando su tiempo activo
// y cierra los turnos que se hayan quedado sin atender.
function cerrarJornadaDiaria(ahora = Date.now()) {
  const hoy = sacarFechaHoy(ahora);

  const resultado = hacerTransaccion(() => {
    const abiertas = sql.ventanillasAbiertas.all();
    for (const v of abiertas) {
      sql.cerrarVentanilla.run(sumarSegundosActivos(v, ahora), ahora, v.ventanilla);
    }

    const turnosCerrados = sql.cerrarPendientesDia.run(ahora, hoy).changes;
    return {
      ok: true,
      ventanillasCerradas: abiertas.length,
      turnosCerrados
    };
  });

  quitarTodosLosTimersInactividad();
  console.log(
    `[Corte 18:00] Ventanillas cerradas: ${resultado.ventanillasCerradas}, turnos cerrados: ${resultado.turnosCerrados}`
  );
  avisarPantallas('jornada_cerrada');
  return resultado;
}

// Reinicia las 7 ventanillas a cero desde el dashboard.
// También permite borrar los turnos de hoy (limpiarTurnosHoy) o vaciar toda la base (eliminarTodo).
function reiniciarJornada({ limpiarTurnosHoy = false, eliminarTodo = false } = {}) {
  const hoy = sacarFechaHoy();

  const resultado = hacerTransaccion(() => {
    sql.reiniciarTodasVentanillas.run();

    let turnosEliminados = 0;
    let turnosLiberados = 0;

    if (eliminarTodo) {
      turnosEliminados = sql.borrarTodosTurnos.run().changes;
      sql.reiniciarSecuenciaTurnos.run();
    } else if (limpiarTurnosHoy) {
      turnosEliminados = sql.borrarTurnosDia.run(hoy).changes;
    } else {
      turnosLiberados = regresarTurnosAEspera(hoy);
    }

    return {
      ok: true,
      turnosEliminados,
      turnosLiberados,
      eliminarTodo: Boolean(eliminarTodo)
    };
  });

  quitarTodosLosTimersInactividad();
  avisarPantallas('jornada_reiniciada');
  return resultado;
}

// --- Saneamiento al iniciar el servidor (dividido en funciones pequeñas) ---

// 1. Cierra turnos viejos de días anteriores o previos al corte de las 18:00 de hoy
function cerrarTurnosAtrasados(ahora, hoy, corteHoyMs) {
  const deDiasPasados = sql.cerrarPendientesDiasPasados.run(ahora, hoy).changes;
  let deAntesDelCorte = 0;

  if (ahora >= corteHoyMs) {
    deAntesDelCorte = sql.cerrarPendientesAntesCorte.run(ahora, hoy, corteHoyMs).changes;
  }
  return deDiasPasados + deAntesDelCorte;
}

// 2. Revisa una ventanilla al encender el servidor por si quedó abierta de ayer o ya venció su tiempo
function revisarVentanillaAlArrancar(v, ahora, hoy, corteHoyMs) {
  const fechaUltima = v.ultima_actividad ? sacarFechaHoy(v.ultima_actividad) : null;

  // Si su última actividad fue de un día anterior, la dejamos cerrada y en cero para hoy
  if (fechaUltima && fechaUltima < hoy) {
    sql.reiniciarUnaVentanilla.run(v.ventanilla);
    return { tipo: 'reiniciada' };
  }

  if (v.estado === 'cerrado') {
    return { tipo: 'ok' };
  }

  // Si ya pasaron las 18:00 y seguía abierta desde antes de las 18:00, la cerramos al tope del corte
  if (ahora >= corteHoyMs && (!v.ultima_actividad || v.ultima_actividad < corteHoyMs)) {
    const tope2h = v.ultima_actividad ? v.ultima_actividad + DOS_HORAS_MS : corteHoyMs;
    const marcaFin = Math.min(corteHoyMs, tope2h);
    sql.cerrarVentanilla.run(sumarSegundosActivos(v, marcaFin), marcaFin, v.ventanilla);
    regresarTurnosAEspera(hoy, v.ventanilla);
    return { tipo: 'reiniciada' };
  }

  // Revisamos si ya pasaron sus 2 horas de inactividad mientras el servidor estuvo apagado
  const transcurridoMs = v.ultima_actividad ? Math.max(0, ahora - v.ultima_actividad) : 0;
  if (transcurridoMs >= DOS_HORAS_MS) {
    const marcaLimite = v.ultima_actividad
      ? Math.min(ahora, v.ultima_actividad + DOS_HORAS_MS)
      : ahora;
    sql.cerrarVentanilla.run(sumarSegundosActivos(v, marcaLimite), ahora, v.ventanilla);
    regresarTurnosAEspera(hoy, v.ventanilla);
    return { tipo: 'inactiva' };
  }

  return {
    tipo: 'activa',
    restanteMs: DOS_HORAS_MS - transcurridoMs
  };
}

// Revisa turnos y ventanillas pendientes cuando arranca el servidor o cuando cambia el día a medianoche
function sanearAlArranque(ahora = Date.now()) {
  const hoy = sacarFechaHoy(ahora);
  const corteHoy = new Date(ahora);
  corteHoy.setHours(18, 0, 0, 0);
  const corteHoyMs = corteHoy.getTime();

  const timersPorActivar = [];

  const resumen = hacerTransaccion(() => {
    const turnosAnterioresCerrados = cerrarTurnosAtrasados(ahora, hoy, corteHoyMs);
    const ventanillas = sql.listarVentanillas.all();
    let ventanillasReiniciadas = 0;
    let ventanillasInactivas = 0;

    for (const v of ventanillas) {
      const revision = revisarVentanillaAlArrancar(v, ahora, hoy, corteHoyMs);
      if (revision.tipo === 'reiniciada') {
        ventanillasReiniciadas += 1;
      } else if (revision.tipo === 'inactiva') {
        ventanillasInactivas += 1;
      } else if (revision.tipo === 'activa') {
        timersPorActivar.push({
          ventanilla: v.ventanilla,
          restanteMs: revision.restanteMs
        });
      }
    }

    return {
      turnosAnterioresCerrados,
      ventanillasReiniciadas,
      ventanillasInactivas
    };
  });

  quitarTodosLosTimersInactividad();
  for (const item of timersPorActivar) {
    programarTimerInactividad(item.ventanilla, item.restanteMs);
  }

  if (
    resumen.turnosAnterioresCerrados > 0 ||
    resumen.ventanillasReiniciadas > 0 ||
    resumen.ventanillasInactivas > 0
  ) {
    avisarPantallas('saneamiento_ejecutado');
  }

  return resumen;
}

// Programa el timer para que a las 18:00:00 en punto corra el cierre del día
function programarCierreDiario() {
  if (timerCierre6pm) {
    clearTimeout(timerCierre6pm);
  }

  const ahora = new Date();
  const proximoCorte = new Date(ahora);
  proximoCorte.setHours(18, 0, 0, 0);

  if (ahora.getTime() >= proximoCorte.getTime()) {
    proximoCorte.setDate(proximoCorte.getDate() + 1);
  }

  const faltaMs = Math.max(1, proximoCorte.getTime() - ahora.getTime());
  timerCierre6pm = setTimeout(() => {
    cerrarJornadaDiaria(Date.now());
    programarCierreDiario();
  }, faltaMs);

  return faltaMs;
}

// Programa el cambio de día a las 00:00:00 para limpiar los contadores del día anterior
function programarCambioDeDia() {
  if (timerMedianoche) {
    clearTimeout(timerMedianoche);
  }

  const ahora = new Date();
  const medianoche = new Date(ahora);
  medianoche.setHours(24, 0, 0, 0);

  const faltaMs = Math.max(1, medianoche.getTime() - ahora.getTime());
  timerMedianoche = setTimeout(() => {
    sanearAlArranque(Date.now());
    avisarPantallas('cambio_de_dia');
    programarCambioDeDia();
  }, faltaMs);

  return faltaMs;
}

function iniciarTareasProgramadas() {
  sanearAlArranque(Date.now());
  programarCierreDiario();
  programarCambioDeDia();
}

function detenerTareasProgramadas() {
  if (timerCierre6pm) {
    clearTimeout(timerCierre6pm);
    timerCierre6pm = null;
  }
  if (timerMedianoche) {
    clearTimeout(timerMedianoche);
    timerMedianoche = null;
  }
  quitarTodosLosTimersInactividad();
}

// --- Rutas del servidor (API REST + SSE) ---

// Menú principal en "/" para entrar rápido a cualquiera de las 4 pantallas
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sistema de Gestión de Turnos</title>
  <link rel="stylesheet" href="/estilos.css">
</head>
<body>
  <div class="contenedor">
    <header class="encabezado-vista">
      <div>
        <h1 class="encabezado-titulo">Sistema de Gestión de Turnos</h1>
        <p class="encabezado-subtitulo">Seleccione la pantalla que desea abrir en este equipo</p>
      </div>
    </header>
    <main>
      <nav aria-label="Pantallas del sistema" class="rejilla-auto">
        <a href="/kiosco.html" class="tarjeta-opcion">
          <span class="opcion-titulo">Kiosco de Turnos</span>
          <span class="etiqueta etiqueta--caja">Autoservicio</span>
          <span class="texto-suave">Impresión térmica de tickets para clientes</span>
        </a>
        <a href="/pantalla.html" class="tarjeta-opcion">
          <span class="opcion-titulo">Pantalla Pública</span>
          <span class="etiqueta etiqueta--ejecutivo">Sala de espera</span>
          <span class="texto-suave">Turnos llamados en vivo y tiempo estimado</span>
        </a>
        <a href="/ventanilla.html" class="tarjeta-opcion">
          <span class="opcion-titulo">Panel de Ventanilla</span>
          <span class="etiqueta etiqueta--atencion">Operación</span>
          <span class="texto-suave">Llamado, atención, pausas y cierre de turno</span>
        </a>
        <a href="/dashboard.html" class="tarjeta-opcion">
          <span class="opcion-titulo">Dashboard</span>
          <span class="etiqueta etiqueta--activo">Supervisión</span>
          <span class="texto-suave">Indicadores, gráficas y rendimiento diario</span>
        </a>
      </nav>
    </main>
  </div>
</body>
</html>`);
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Conexión SSE para avisar en menos de 1 segundo cuando se mueve un turno o una ventanilla
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  pantallasConectadas.add(res);
  res.write(`data: ${JSON.stringify({ tipo: 'conexion_inicial', estado: armarEstado() })}\n\n`);

  // Mandamos un comentario vacío cada 25 segundos para que el navegador no cierre la conexión
  const latido = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(latido);
      pantallasConectadas.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(latido);
    pantallasConectadas.delete(res);
  });
});

// Devuelve el estado completo de hoy (ventanillas, filas de espera, tiempos estimados y métricas)
app.get('/api/estado', (req, res) => {
  try {
    return res.json(armarEstado());
  } catch (error) {
    return mandarError(res, error, 'No se pudo consultar el estado del sistema');
  }
});

// Genera un turno nuevo (01 al 99). Si hay una ventanilla activa y desocupada de ese servicio,
// se lo asigna de una vez empezando por la de menor número.
app.post('/api/turnos', (req, res) => {
  const { tipo } = req.body || {};

  if (!PREFIJOS[tipo]) {
    return res.status(400).json({ error: 'Tipo de servicio inválido' });
  }

  try {
    const { turno, autoAsignado } = hacerTransaccion(() => {
      const ahora = Date.now();
      const hoy = sacarFechaHoy(ahora);

      const ultimo = sql.ultimoFolioServicio.get(hoy, tipo);
      const ocupados = new Set(
        sql.foliosActivosServicio.all(hoy, tipo).map((f) => f.numero_folio)
      );

      // Calculamos el folio del 01 al 99. Si da la vuelta al 99 y el 01 todavía sigue en espera
      // o atendiéndose, brincamos al siguiente número libre para no tener dos turnos iguales en pantalla.
      let folio = ((ultimo ? ultimo.numero_folio : 0) % 99) + 1;
      let intentos = 0;
      while (ocupados.has(folio) && intentos < 99) {
        folio = (folio % 99) + 1;
        intentos += 1;
      }

      if (intentos >= 99) {
        throw new ErrorTurnos(409, 'La fila de este servicio tiene los 99 folios ocupados en este momento');
      }

      const codigo = `${PREFIJOS[tipo]}-${String(folio).padStart(2, '0')}`;
      const libre = sql.buscarVentanillaLibre.get(tipo, hoy);

      const estadoInicial = libre ? 'atendiendo' : 'espera';
      const ventanillaAsignada = libre ? libre.ventanilla : null;
      const horaLlamado = libre ? ahora : null;

      const info = sql.insertarTurno.run(
        hoy,
        folio,
        codigo,
        tipo,
        estadoInicial,
        ventanillaAsignada,
        ahora,
        horaLlamado
      );

      if (libre) {
        sql.actualizarActividadVentanilla.run(ahora, libre.ventanilla);
      }

      const guardado = sql.obtenerTurnoPorId.get(info.lastInsertRowid);
      return {
        turno: {
          ...guardado,
          fechaHoraImpresion: formatearFechaHora(ahora)
        },
        autoAsignado: Boolean(libre)
      };
    });

    if (autoAsignado && turno.ventanilla) {
      programarTimerInactividad(turno.ventanilla);
    }

    console.log(
      `[Turno] Nuevo turno ${turno.codigo} (${tipo})${
        autoAsignado ? ` -> asignado directo a ${turno.ventanilla}` : ' -> en espera'
      }`
    );
    avisarPantallas('turno_creado', autoAsignado ? { turnoLlamado: turno } : {});
    return res.status(201).json({ turno });
  } catch (error) {
    return mandarError(res, error, 'No se pudo generar el turno');
  }
});

// Abre una ventanilla que esté cerrada. Si ya está abierta o en pausa, devuelve 409 Conflict.
app.post('/api/ventanillas/abrir', (req, res) => {
  const { ventanilla } = req.body || {};
  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe indicar qué ventanilla desea abrir' });
  }

  try {
    const resultado = hacerTransaccion(() => {
      const ahora = Date.now();
      const hoy = sacarFechaHoy(ahora);
      const fila = buscarVentanilla(ventanilla);

      if (fila.estado !== 'cerrado') {
        throw new ErrorTurnos(409, 'La ventanilla ya está en uso');
      }

      const eraDeOtroDia = fila.ultima_actividad && sacarFechaHoy(fila.ultima_actividad) !== hoy;
      const segundosPrevios = eraDeOtroDia ? 0 : fila.segundos_activos;

      sql.abrirVentanilla.run(segundosPrevios, ahora, ahora, ventanilla);

      const turnoActual = pasarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
      const actualizada = sql.obtenerVentanilla.get(ventanilla);

      return { ventanilla: actualizada, turnoActual };
    });

    programarTimerInactividad(ventanilla);
    avisarPantallas(
      'ventanilla_abierta',
      resultado.turnoActual ? { turnoLlamado: resultado.turnoActual } : {}
    );
    return res.json(resultado);
  } catch (error) {
    return mandarError(res, error, 'No se pudo abrir la ventanilla');
  }
});

// Llama al siguiente turno en espera cuando la ventanilla está activa y sin cliente
app.post('/api/ventanillas/llamar', (req, res) => {
  const { ventanilla } = req.body || {};
  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe indicar la ventanilla' });
  }

  try {
    const turno = hacerTransaccion(() => {
      const ahora = Date.now();
      const hoy = sacarFechaHoy(ahora);
      const fila = buscarVentanilla(ventanilla);

      if (fila.estado !== 'activo') {
        throw new ErrorTurnos(409, 'La ventanilla debe estar activa para llamar un turno');
      }

      if (sql.turnoEnCursoVentanilla.get(hoy, ventanilla)) {
        throw new ErrorTurnos(409, 'La ventanilla ya tiene un turno en atención');
      }

      sql.actualizarActividadVentanilla.run(ahora, ventanilla);
      return pasarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
    });

    programarTimerInactividad(ventanilla);
    if (turno) {
      avisarPantallas('turno_llamado', { turnoLlamado: turno });
    }
    return res.json({ turno });
  } catch (error) {
    return mandarError(res, error, 'No se pudo llamar al siguiente turno');
  }
});

// Cierra un turno con uno de los 4 motivos y pasa al siguiente (o pausa la ventanilla)
app.post('/api/turnos/cerrar', (req, res) => {
  const { turno_id, ventanilla, resultado, pausar } = req.body || {};

  if (!turno_id || !ventanilla) {
    return res.status(400).json({ error: 'Faltan el identificador del turno o la ventanilla' });
  }

  if (!MOTIVOS_CIERRE.includes(resultado)) {
    return res.status(400).json({ error: 'El motivo de cierre elegido no es válido' });
  }

  try {
    const { siguienteTurno } = hacerTransaccion(() => {
      const ahora = Date.now();
      const hoy = sacarFechaHoy(ahora);
      const filaVentanilla = buscarVentanilla(ventanilla);

      if (filaVentanilla.estado !== 'activo') {
        throw new ErrorTurnos(409, 'La ventanilla no está activa');
      }

      const filaTurno = sql.obtenerTurnoEnAtencion.get(Number(turno_id), hoy, ventanilla);
      if (!filaTurno) {
        throw new ErrorTurnos(409, 'Este turno ya no está asignado a la ventanilla');
      }

      sql.cerrarTurno.run(resultado, ahora, filaTurno.id);

      if (Boolean(pausar)) {
        sql.pausarVentanilla.run(
          sumarSegundosActivos(filaVentanilla, ahora),
          ahora,
          ventanilla
        );
        return { siguienteTurno: null };
      }

      sql.mantenerVentanillaActiva.run(ahora, ahora, ventanilla);
      const siguiente = pasarSiguienteTurno(
        filaVentanilla.tipo_servicio,
        ventanilla,
        ahora,
        hoy
      );
      return { siguienteTurno: siguiente };
    });

    programarTimerInactividad(ventanilla);
    avisarPantallas('turno_cerrado', siguienteTurno ? { turnoLlamado: siguienteTurno } : {});
    return res.json({ ok: true, siguienteTurno });
  } catch (error) {
    return mandarError(res, error, 'No se pudo cerrar el turno');
  }
});

// Reanuda una ventanilla que estaba en pausa o la cierra cuando el cajero termina su turno
app.post('/api/ventanillas/estado', (req, res) => {
  const { ventanilla, accion } = req.body || {};

  if (!ventanilla || (accion !== 'reanudar' && accion !== 'cerrar')) {
    return res.status(400).json({ error: 'Indique la ventanilla y una acción válida' });
  }

  try {
    const respuesta = hacerTransaccion(() => {
      const ahora = Date.now();
      const hoy = sacarFechaHoy(ahora);
      const fila = buscarVentanilla(ventanilla);

      if (accion === 'reanudar') {
        if (fila.estado !== 'pausa') {
          throw new ErrorTurnos(409, 'La ventanilla debe estar en pausa para volver a activarse');
        }

        sql.reanudarVentanilla.run(ahora, ahora, ventanilla);
        const siguienteTurno = pasarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
        return { ok: true, siguienteTurno };
      }

      if (fila.estado === 'cerrado') {
        throw new ErrorTurnos(409, 'La ventanilla ya estaba cerrada');
      }

      if (sql.turnoEnCursoVentanilla.get(hoy, ventanilla)) {
        throw new ErrorTurnos(
          409,
          'Cierre primero el turno en atención antes de cerrar la ventanilla'
        );
      }

      sql.cerrarVentanilla.run(sumarSegundosActivos(fila, ahora), ahora, ventanilla);
      return { ok: true, siguienteTurno: null };
    });

    if (accion === 'reanudar') {
      programarTimerInactividad(ventanilla);
      avisarPantallas(
        'ventanilla_reanudada',
        respuesta.siguienteTurno ? { turnoLlamado: respuesta.siguienteTurno } : {}
      );
    } else {
      quitarTimerInactividad(ventanilla);
      avisarPantallas('ventanilla_cerrada');
    }

    return res.json(respuesta);
  } catch (error) {
    return mandarError(res, error, 'No se pudo cambiar el estado de la ventanilla');
  }
});

// Ejecuta manualmente el corte de las 18:00 hrs
app.post('/api/jornada/cerrar', (req, res) => {
  try {
    return res.json(cerrarJornadaDiaria(Date.now()));
  } catch (error) {
    return mandarError(res, error, 'No se pudo cerrar la jornada');
  }
});

// Reinicia las ventanillas a cero, borra los turnos de hoy o elimina todos los datos desde el dashboard
app.post('/api/jornada/reiniciar', (req, res) => {
  const { limpiarTurnosHoy, eliminarTodo } = req.body || {};

  try {
    return res.json(
      reiniciarJornada({
        limpiarTurnosHoy: Boolean(limpiarTurnosHoy),
        eliminarTodo: Boolean(eliminarTodo)
      })
    );
  } catch (error) {
    return mandarError(res, error, 'No se pudo reiniciar la jornada');
  }
});

// --- Arranque del servidor ---

iniciarBaseDatos();
iniciarTareasProgramadas();

if (require.main === module) {
  app.listen(PUERTO, () => {
    console.log(`[Sistema de Turnos] Servidor corriendo en http://localhost:${PUERTO}`);
    console.log(`[Sistema de Turnos] Hora del servidor: ${formatearFechaHora(Date.now())}`);
  });
}

module.exports = {
  app,
  db,
  PUERTO,
  CATALOGO_VENTANILLAS: LISTA_VENTANILLAS,
  PREFIJOS_SERVICIO: PREFIJOS,
  MOTIVOS_VALIDOS: new Set(MOTIVOS_CIERRE),
  DOS_HORAS_MS,
  clientesEnVivo: pantallasConectadas,
  timersInactividad,
  ejecutarTransaccion: hacerTransaccion,
  inicializarBaseDeDatos: iniciarBaseDatos,
  obtenerEstadoCompleto: armarEstado,
  notificarPantallas: avisarPantallas,
  cerrarJornadaDiaria,
  reiniciarJornada,
  cerrarVentanillaPorInactividad,
  programarTimerInactividad,
  cancelarTimerInactividad: quitarTimerInactividad,
  sanearAlArranque,
  programarCierreDiario,
  programarCambioDeDia,
  iniciarTareasProgramadas,
  detenerTareasProgramadas
};

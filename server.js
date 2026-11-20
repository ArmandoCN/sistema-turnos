process.env.TZ = 'America/Mazatlan';

/**
 * ============================================================================
 * Archivo: server.js (Backend completo: SQLite, API REST, SSE y Tareas Programadas)
 * ----------------------------------------------------------------------------
 * Propósito general:
 *   Servidor monolítico ligero en Node.js + Express para el Sistema de Turnos.
 *   Incluye:
 *     1. Zona horaria local del servidor (America/Mazatlan).
 *     2. Conexión a SQLite (turnos.db) mediante node:sqlite con modo WAL,
 *        busy_timeout y transacciones atómicas BEGIN IMMEDIATE.
 *     3. Esquema de tablas (ventanillas y turnos), índices y seed obligatorio
 *        de las 7 ventanillas fijas.
 *     4. Rutas REST (creación/cierre de turnos, apertura/llamado/estado de
 *        ventanillas, estado general, cierre y reinicio de jornada) y canal SSE
 *        en tiempo real (GET /api/eventos).
 *     5. Tareas programadas mediante timers exactos (cierre diario a las 18:00,
 *        transición de medianoche 00:00, auto-cierre por inactividad de 2 horas
 *        y saneamiento al arranque sin polling periódico).
 *
 * Dependencias con otros módulos:
 *   - express: servidor HTTP, parseo JSON y servicio de estáticos en public/.
 *   - node:sqlite (DatabaseSync): persistencia transaccional síncrona en SQLite.
 *   - node:path: resolución segura de rutas locales en disco.
 *   - public/: interfaces HTML5/CSS3/JS conectadas vía fetch() y EventSource.
 * ============================================================================
 */

const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// ----------------------------------------------------------------------------
// 1. Configuración general del servidor Express
// ----------------------------------------------------------------------------

// Puerto poco común por defecto para evitar colisiones en entornos locales o de
// pruebas (puede sobreescribirse mediante la variable de entorno PORT).
const PUERTO = Number(process.env.PORT) || 4782;

// Ruta absoluta al archivo único de base de datos SQLite en la raíz del proyecto.
const RUTA_DB = path.join(__dirname, 'turnos.db');

// Instancia principal de Express y middlewares base.
const app = express();

// Permite recibir cuerpos JSON en las peticiones POST (POST /api/turnos, etc.).
app.use(express.json());

// Sirve las vistas HTML5 y hoja de estilos CSS3 ubicadas en la carpeta public/.
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// 2. Conexión a SQLite (turnos.db) y Control de Transacciones Atómicas
// ----------------------------------------------------------------------------

// Abre (o crea si no existe) el archivo único turnos.db con el módulo nativo node:sqlite.
const db = new DatabaseSync(RUTA_DB);

// Activa Write-Ahead Logging (WAL) para permitir lecturas concurrentes mientras
// se realizan escrituras atómicas, mejorando rendimiento y tolerancia a fallos.
db.exec('PRAGMA journal_mode = WAL;');

// Configura espera de hasta 5 segundos si SQLite encuentra un bloqueo momentáneo
// entre transacciones concurrentes (evita errores SQLITE_BUSY prematuros).
db.exec('PRAGMA busy_timeout = 5000;');

/**
 * Envuelve cualquier operación crítica de lectura-escritura dentro de una
 * transacción atómica BEGIN IMMEDIATE ... COMMIT (AGENTS.md §4 y RNF-02).
 *
 * Se utiliza BEGIN IMMEDIATE en lugar de BEGIN DEFERRED porque adquiere el
 * bloqueo de escritura desde el inicio de la transacción, impidiendo que dos
 * peticiones concurrentes lean el mismo turno en 'espera' o el mismo folio
 * antes de escribir. Ante cualquier error ejecuta ROLLBACK automáticamente.
 *
 * @template T
 * @param {() => T} fn - Función síncrona con las consultas SQL a ejecutar.
 * @returns {T} Valor retornado por la función fn tras el COMMIT exitoso.
 */
function ejecutarTransaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Si SQLite ya revirtió la transacción por un fallo interno, evitamos
      // enmascarar el error original al intentar otro ROLLBACK.
    }
    throw error;
  }
}

// ----------------------------------------------------------------------------
// 3. Definición de Esquema y Seed Obligatorio de las 7 Ventanillas
// ----------------------------------------------------------------------------

/**
 * Catálogo fijo obligatorio de las 7 ventanillas (AGENTS.md §4 y SPEC.md §14.B):
 *   - Ventanilla 1 a 4: servicio 'caja'
 *   - Ventanilla 5 a 6: servicio 'ejecutivo'
 *   - Ventanilla 7: servicio 'atencion'
 */
const CATALOGO_VENTANILLAS = [
  { numero: 1, ventanilla: 'Ventanilla 1', tipo_servicio: 'caja' },
  { numero: 2, ventanilla: 'Ventanilla 2', tipo_servicio: 'caja' },
  { numero: 3, ventanilla: 'Ventanilla 3', tipo_servicio: 'caja' },
  { numero: 4, ventanilla: 'Ventanilla 4', tipo_servicio: 'caja' },
  { numero: 5, ventanilla: 'Ventanilla 5', tipo_servicio: 'ejecutivo' },
  { numero: 6, ventanilla: 'Ventanilla 6', tipo_servicio: 'ejecutivo' },
  { numero: 7, ventanilla: 'Ventanilla 7', tipo_servicio: 'atencion' }
];

/**
 * Crea las tablas 'ventanillas' y 'turnos' exactamente con el esquema definido
 * en AGENTS.md §4, genera los índices necesarios para filtrar eficientemente
 * por fecha_jornada y siembra de forma idempotente las 7 ventanillas fijas.
 *
 * @returns {void}
 */
function inicializarBaseDeDatos() {
  // Creación de la tabla 'ventanillas' (estado operativo en vivo de los 7 módulos).
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
  `);

  // Creación de la tabla 'turnos' (sin UNIQUE en codigo porque la numeración
  // es cíclica del 01 al 99 dentro de la jornada y se reinicia cada día).
  db.exec(`
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
  `);

  // Índice compuesto para calcular rápidamente el último folio por servicio y día,
  // así como consultar colas FIFO en espera ordenadas por id.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turnos_jornada_tipo_id
    ON turnos (fecha_jornada, tipo, id);
  `);

  // Índice compuesto para consultas del estado actual del día y métricas del dashboard.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turnos_jornada_estado
    ON turnos (fecha_jornada, estado);
  `);

  // Inserción idempotente de las 7 ventanillas fijas dentro de una transacción.
  // INSERT OR IGNORE preserva cualquier estado o tiempo acumulado si ya existían.
  ejecutarTransaccion(() => {
    const insertarVentanilla = db.prepare(`
      INSERT OR IGNORE INTO ventanillas (numero, ventanilla, tipo_servicio)
      VALUES (?, ?, ?);
    `);

    for (const item of CATALOGO_VENTANILLAS) {
      insertarVentanilla.run(item.numero, item.ventanilla, item.tipo_servicio);
    }
  });
}

// ----------------------------------------------------------------------------
// 4. Reglas de Negocio, Canal SSE y Consulta de Estado (Paso 2)
// ----------------------------------------------------------------------------

// Prefijos oficiales de folio por tipo de servicio.
const PREFIJOS_SERVICIO = {
  caja: 'C',
  ejecutivo: 'E',
  atencion: 'A'
};

// Catálogo cerrado de los 4 motivos válidos al finalizar la atención de un turno.
const RESULTADOS_VALIDOS = new Set([
  'atendido',
  'no_atendido',
  'no_aparecio',
  'turno_equivocado'
]);

// Conjunto de respuestas HTTP activas suscritas al canal SSE (GET /api/eventos).
const clientesSSE = new Set();

// Puntos de enlace que el Paso 3 sobrescribirá para gestionar los timers de
// inactividad de 2 horas sin duplicar ni reescribir la lógica de las rutas REST.
const hooksTimers = {
  alActivarVentanilla: () => {},
  alCerrarVentanilla: () => {},
  alCerrarTodas: () => {}
};

/**
 * Error controlado de negocio HTTP para distinguir validaciones (400, 404, 409)
 * de fallos inesperados del servidor (500) y abortar limpiamente la transacción.
 */
class ErrorHttp extends Error {
  /**
   * @param {number} status - Código HTTP de respuesta (400, 404 o 409).
   * @param {string} mensaje - Descripción legible del error para el frontend.
   */
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

/**
 * Formatea una marca de tiempo numérica (Date.now()) al formato DD/MM/YY HH:mm
 * usando el reloj local configurado en el servidor (sin mostrar zonas horarias).
 *
 * @param {number} ms - Milisegundos devueltos por Date.now().
 * @returns {string} Fecha y hora formateadas como DD/MM/YY HH:mm.
 */
function formatearTicket(ms) {
  return new Date(ms)
    .toLocaleString('es-MX', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false
    })
    .replace(',', '');
}

/**
 * Desencola de forma atómica el turno más antiguo en 'espera' de la jornada
 * actual para el servicio indicado (principio FIFO: ORDER BY id ASC LIMIT 1)
 * y lo asigna en estado 'atendiendo' a la ventanilla solicitante.
 *
 * IMPORTANTE: Debe invocarse únicamente dentro de ejecutarTransaccion().
 *
 * @param {string} tipoServicio - 'caja', 'ejecutivo' o 'atencion'.
 * @param {string} nombreVentanilla - Nombre exacto de la ventanilla (ej. 'Ventanilla 1').
 * @param {number} ahora - Timestamp actual (Date.now()).
 * @param {string} hoy - Fecha de jornada local (YYYY-MM-DD).
 * @returns {object|null} Turno asignado o null si la fila estaba vacía.
 */
function desencolarSiguienteTurno(tipoServicio, nombreVentanilla, ahora, hoy) {
  const siguiente = db
    .prepare(`
      SELECT *
      FROM turnos
      WHERE fecha_jornada = ?
        AND tipo = ?
        AND estado = 'espera'
      ORDER BY id ASC
      LIMIT 1;
    `)
    .get(hoy, tipoServicio);

  if (!siguiente) {
    return null;
  }

  db.prepare(`
    UPDATE turnos
    SET estado = 'atendiendo',
        ventanilla = ?,
        hora_llamado = ?
    WHERE id = ?;
  `).run(nombreVentanilla, ahora, siguiente.id);

  // Devolvemos la fila ya actualizada desde SQLite como fuente única de verdad.
  return db.prepare('SELECT * FROM turnos WHERE id = ?;').get(siguiente.id);
}

/**
 * Calcula los segundos activos acumulados de una ventanilla en la jornada actual.
 * Si su última actividad pertenece a un día anterior y la ventanilla está cerrada,
 * devuelve 0 para no arrastrar tiempo de jornadas pasadas al tablero de hoy.
 *
 * @param {object} filaVentanilla - Registro de la tabla ventanillas.
 * @param {number} ahora - Timestamp actual (Date.now()).
 * @param {string} hoy - Fecha de jornada local (YYYY-MM-DD).
 * @returns {number} Segundos activos netos del día actual.
 */
function calcularSegundosActivosHoy(filaVentanilla, ahora, hoy) {
  if (
    filaVentanilla.estado === 'cerrado' &&
    filaVentanilla.ultima_actividad &&
    new Date(filaVentanilla.ultima_actividad).toLocaleDateString('en-CA') !== hoy
  ) {
    return 0;
  }

  const tiempoEnCurso =
    filaVentanilla.estado === 'activo' && filaVentanilla.ultimo_inicio_activo
      ? Math.max(0, Math.floor((ahora - filaVentanilla.ultimo_inicio_activo) / 1000))
      : 0;

  return filaVentanilla.segundos_activos + tiempoEnCurso;
}

/**
 * Calcula el tiempo estimado de espera para un servicio específico en la jornada:
 * promedia (hora_llamado - hora_creacion) de los últimos 20 turnos cerrados como
 * 'atendido' del día. Si hay menos de 3 muestras, retorna el valor base "5 min".
 *
 * @param {string} tipoServicio - 'caja', 'ejecutivo' o 'atencion'.
 * @param {string} hoy - Fecha de jornada local (YYYY-MM-DD).
 * @returns {string} Texto estimado listo para pantalla (ej. "5 min", "12 min").
 */
function calcularTiempoEstimadoServicio(tipoServicio, hoy) {
  const muestras = db
    .prepare(`
      SELECT hora_creacion, hora_llamado
      FROM turnos
      WHERE fecha_jornada = ?
        AND tipo = ?
        AND estado = 'cerrado'
        AND resultado = 'atendido'
        AND hora_llamado IS NOT NULL
      ORDER BY hora_fin DESC, id DESC
      LIMIT 20;
    `)
    .all(hoy, tipoServicio);

  // Regla de negocio: con menos de 3 turnos atendidos en el día se usa "5 min".
  if (muestras.length < 3) {
    return '5 min';
  }

  let sumaMs = 0;
  for (const turno of muestras) {
    sumaMs += Math.max(0, turno.hora_llamado - turno.hora_creacion);
  }

  const promedioMin = Math.round(sumaMs / muestras.length / 60000);
  return `${Math.max(1, promedioMin)} min`;
}

/**
 * Construye el estado completo e instantáneo de la jornada actual para servirlo
 * tanto en GET /api/estado como en las notificaciones en tiempo real vía SSE.
 *
 * @returns {object} Snapshot completo de ventanillas, filas, tiempos y métricas.
 */
function obtenerEstadoCompleto() {
  const ahora = Date.now();
  // Se usa 'en-CA' únicamente porque produce el formato ordenable YYYY-MM-DD
  // de forma nativa con Date, respetando process.env.TZ = 'America/Mazatlan'.
  const hoy = new Date(ahora).toLocaleDateString('en-CA');

  // 1. Consultar todas las ventanillas ordenadas numéricamente (1 a 7).
  const filasVentanillas = db
    .prepare('SELECT * FROM ventanillas ORDER BY numero ASC;')
    .all();

  // 2. Consultar todos los turnos creados en la jornada actual en orden de llegada.
  const turnosHoy = db
    .prepare(`
      SELECT *
      FROM turnos
      WHERE fecha_jornada = ?
      ORDER BY id ASC;
    `)
    .all(hoy);

  // Mapa auxiliar de turno actualmente en atención indexado por nombre de ventanilla.
  const turnoPorVentanilla = new Map();
  const turnosAtendiendo = [];
  const filasEspera = { caja: [], ejecutivo: [], atencion: [] };
  const proximosEspera = [];

  // Acumuladores para las métricas del dashboard del día.
  let totalCerrados = 0;
  let sumaEsperaMs = 0;
  let conteoConEspera = 0;
  let sumaAtencionMs = 0;
  let conteoAtencion = 0;

  const conteoMotivos = {
    atendido: 0,
    no_atendido: 0,
    no_aparecio: 0,
    turno_equivocado: 0
  };
  const atendidosPorHoraMap = new Map();
  const cerradosPorVentanilla = new Map();
  const atendidosPorVentanilla = new Map();

  for (const turno of turnosHoy) {
    if (turno.hora_llamado !== null) {
      sumaEsperaMs += Math.max(0, turno.hora_llamado - turno.hora_creacion);
      conteoConEspera += 1;
    }

    if (turno.estado === 'atendiendo') {
      turnosAtendiendo.push(turno);
      if (turno.ventanilla) {
        turnoPorVentanilla.set(turno.ventanilla, turno);
      }
    } else if (turno.estado === 'espera') {
      filasEspera[turno.tipo].push(turno);
      proximosEspera.push(turno);
    } else if (turno.estado === 'cerrado') {
      totalCerrados += 1;
      if (turno.resultado && Object.hasOwn(conteoMotivos, turno.resultado)) {
        conteoMotivos[turno.resultado] += 1;
      }

      if (turno.ventanilla) {
        cerradosPorVentanilla.set(
          turno.ventanilla,
          (cerradosPorVentanilla.get(turno.ventanilla) || 0) + 1
        );
      }

      if (turno.resultado === 'atendido') {
        if (turno.ventanilla) {
          atendidosPorVentanilla.set(
            turno.ventanilla,
            (atendidosPorVentanilla.get(turno.ventanilla) || 0) + 1
          );
        }

        if (turno.hora_llamado !== null && turno.hora_fin !== null) {
          sumaAtencionMs += Math.max(0, turno.hora_fin - turno.hora_llamado);
          conteoAtencion += 1;
        }

        if (turno.hora_fin !== null) {
          const hora = new Date(turno.hora_fin).getHours();
          atendidosPorHoraMap.set(hora, (atendidosPorHoraMap.get(hora) || 0) + 1);
        }
      }
    }
  }

  // Ordenar turnos en atención poniendo el llamado más reciente primero.
  turnosAtendiendo.sort((a, b) => (b.hora_llamado || 0) - (a.hora_llamado || 0) || b.id - a.id);

  // Enriquecer cada ventanilla con su tiempo activo actual y el turno que atiende.
  const ventanillas = filasVentanillas.map((v) => ({
    ...v,
    segundosActivos: calcularSegundosActivosHoy(v, ahora, hoy),
    turnoActual: turnoPorVentanilla.get(v.ventanilla) || null
  }));

  // Tiempos estimados por servicio según regla de los últimos 20 atendidos.
  const tiemposEstimados = {
    caja: calcularTiempoEstimadoServicio('caja', hoy),
    ejecutivo: calcularTiempoEstimadoServicio('ejecutivo', hoy),
    atencion: calcularTiempoEstimadoServicio('atencion', hoy)
  };

  // Construir arreglo ordenado cronológicamente de clientes atendidos por hora.
  const clientesAtendidosPorHora = Array.from(atendidosPorHoraMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([horaNum, total]) => ({
      horaNum,
      etiqueta: `${String(horaNum).padStart(2, '0')}:00`,
      total
    }));

  // Desglose de motivos con cantidad y porcentaje redondeado a 1 decimal.
  const motivos = {};
  for (const clave of RESULTADOS_VALIDOS) {
    const cantidad = conteoMotivos[clave];
    motivos[clave] = {
      cantidad,
      porcentaje: totalCerrados > 0 ? Math.round((cantidad * 1000) / totalCerrados) / 10 : 0
    };
  }

  const rendimientoPorVentanilla = ventanillas.map((v) => ({
    numero: v.numero,
    ventanilla: v.ventanilla,
    tipo_servicio: v.tipo_servicio,
    estado: v.estado,
    turnosCerrados: cerradosPorVentanilla.get(v.ventanilla) || 0,
    turnosAtendidos: atendidosPorVentanilla.get(v.ventanilla) || 0,
    segundosActivos: v.segundosActivos
  }));

  return {
    fechaJornada: hoy,
    fechaServidor: formatearTicket(ahora),
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
      tiempoPromedioEsperaSeg:
        conteoConEspera > 0 ? Math.round(sumaEsperaMs / conteoConEspera / 1000) : 0,
      tiempoPromedioAtencionSeg:
        conteoAtencion > 0 ? Math.round(sumaAtencionMs / conteoAtencion / 1000) : 0,
      clientesAtendidosPorHora,
      motivos,
      rendimientoPorVentanilla
    }
  };
}

/**
 * Envía una actualización en tiempo real (latencia < 1 s) a todas las pantallas
 * y paneles conectados mediante Server-Sent Events (SSE).
 *
 * @param {string} tipo - Nombre descriptivo del cambio ocurrido.
 * @param {object} [extra={}] - Metadatos adicionales (ej. turnoLlamado para audio).
 * @returns {void}
 */
function emitirEventoSSE(tipo, extra = {}) {
  if (clientesSSE.size === 0) {
    return;
  }

  const carga = JSON.stringify({
    tipo,
    ...extra,
    estado: obtenerEstadoCompleto()
  });

  const mensaje = `data: ${carga}\n\n`;
  for (const res of clientesSSE) {
    try {
      res.write(mensaje);
    } catch (_) {
      // Si un socket cliente falló abruptamente, se depura del conjunto activo.
      clientesSSE.delete(res);
    }
  }
}

/**
 * Cierra la jornada operativa: pasa ventanillas activas/en pausa a 'cerrado'
 * consolidando sus segundos activos y cierra los turnos residuales del día
 * como 'no_atendido'. Conserva todo el historial del día en SQLite.
 *
 * @param {number} [ahora=Date.now()] - Marca de tiempo de cierre.
 * @returns {{ ok: boolean, ventanillasCerradas: number, turnosCerrados: number }}
 */
function cerrarJornadaDiaria(ahora = Date.now()) {
  const hoy = new Date(ahora).toLocaleDateString('en-CA');

  const resultado = ejecutarTransaccion(() => {
    const abiertas = db
      .prepare(`
        SELECT *
        FROM ventanillas
        WHERE estado IN ('activo', 'pausa');
      `)
      .all();

    const stmtCerrarVentanilla = db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `);

    for (const v of abiertas) {
      const segundosExtra =
        v.estado === 'activo' && v.ultimo_inicio_activo
          ? Math.max(0, Math.floor((ahora - v.ultimo_inicio_activo) / 1000))
          : 0;
      stmtCerrarVentanilla.run(v.segundos_activos + segundosExtra, ahora, v.ventanilla);
    }

    const infoTurnos = db
      .prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = 'no_atendido',
            hora_fin = ?
        WHERE fecha_jornada = ?
          AND estado IN ('espera', 'atendiendo');
      `)
      .run(ahora, hoy);

    return {
      ok: true,
      ventanillasCerradas: abiertas.length,
      turnosCerrados: infoTurnos.changes
    };
  });

  hooksTimers.alCerrarTodas();
  emitirEventoSSE('jornada_cerrada');
  return resultado;
}

/**
 * Reinicia el estado operativo de las 7 ventanillas a cero ('cerrado',
 * segundos_activos = 0, marcas en NULL) para preparar el día siguiente o repetir
 * pruebas. Si limpiarTurnosHoy es true, borra únicamente los turnos de la fecha
 * actual para reiniciar folios a 01 sin tocar el historial de días anteriores.
 *
 * @param {{ limpiarTurnosHoy?: boolean }} [opciones={}] - Opciones de reinicio.
 * @returns {{ ok: boolean, turnosEliminados: number }}
 */
function reiniciarJornada({ limpiarTurnosHoy = false } = {}) {
  const hoy = new Date().toLocaleDateString('en-CA');

  const resultado = ejecutarTransaccion(() => {
    db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = 0,
          ultimo_inicio_activo = NULL,
          ultima_actividad = NULL;
    `).run();

    let turnosEliminados = 0;
    if (limpiarTurnosHoy) {
      const info = db
        .prepare('DELETE FROM turnos WHERE fecha_jornada = ?;')
        .run(hoy);
      turnosEliminados = info.changes;
    }

    return { ok: true, turnosEliminados };
  });

  hooksTimers.alCerrarTodas();
  emitirEventoSSE('jornada_reiniciada');
  return resultado;
}

// ----------------------------------------------------------------------------
// 5. Rutas REST y Canal SSE
// ----------------------------------------------------------------------------

// Evita errores 404 en consola cuando los navegadores solicitan /favicon.ico.
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Canal Server-Sent Events (SSE) para sincronizar pantallas en < 1 segundo.
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clientesSSE.add(res);

  // Enviar snapshot inicial inmediatamente al establecer la conexión.
  res.write(
    `data: ${JSON.stringify({ tipo: 'conexion_inicial', estado: obtenerEstadoCompleto() })}\n\n`
  );

  // Heartbeat cada 25 segundos para evitar cortes por inactividad en proxies o LAN.
  const intervaloHeartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(intervaloHeartbeat);
      clientesSSE.delete(res);
    }
  }, 25000);

  // Liberar recursos y eliminar el socket al desconectarse el cliente.
  req.on('close', () => {
    clearInterval(intervaloHeartbeat);
    clientesSSE.delete(res);
  });
});

// Retorna el estado completo de la jornada actual para carga inicial y recargas.
app.get('/api/estado', (req, res) => {
  try {
    res.json(obtenerEstadoCompleto());
  } catch (error) {
    console.error('[GET /api/estado] Error:', error);
    res.status(500).json({ error: 'Error al consultar el estado del sistema' });
  }
});

// Crea un nuevo turno con folio cíclico 01-99 y auto-asigna si hay ventanilla libre.
app.post('/api/turnos', (req, res) => {
  const { tipo } = req.body || {};

  if (!PREFIJOS_SERVICIO[tipo]) {
    return res.status(400).json({ error: 'Tipo de servicio inválido' });
  }

  try {
    const { turno, autoAsignado } = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = new Date(ahora).toLocaleDateString('en-CA');

      // Obtener el último folio insertado hoy para este servicio para mantener ciclo 01..99.
      const ultimo = db
        .prepare(`
          SELECT numero_folio
          FROM turnos
          WHERE fecha_jornada = ?
            AND tipo = ?
          ORDER BY id DESC
          LIMIT 1;
        `)
        .get(hoy, tipo);

      const ultimoFolio = ultimo ? ultimo.numero_folio : 0;
      const siguienteFolio = (ultimoFolio % 99) + 1;
      const codigo = `${PREFIJOS_SERVICIO[tipo]}-${String(siguienteFolio).padStart(2, '0')}`;

      // Buscar ventanilla activa de este servicio sin turno en curso,
      // priorizando estrictamente el menor número (ORDER BY numero ASC LIMIT 1).
      const ventanillaLibre = db
        .prepare(`
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
        `)
        .get(tipo, hoy);

      const estadoInicial = ventanillaLibre ? 'atendiendo' : 'espera';
      const ventanillaAsignada = ventanillaLibre ? ventanillaLibre.ventanilla : null;
      const horaLlamado = ventanillaLibre ? ahora : null;

      const info = db
        .prepare(`
          INSERT INTO turnos (
            fecha_jornada,
            numero_folio,
            codigo,
            tipo,
            estado,
            ventanilla,
            hora_creacion,
            hora_llamado
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `)
        .run(hoy, siguienteFolio, codigo, tipo, estadoInicial, ventanillaAsignada, ahora, horaLlamado);

      // Si se auto-asignó a una ventanilla libre, renovamos su ultima_actividad.
      if (ventanillaLibre) {
        db.prepare('UPDATE ventanillas SET ultima_actividad = ? WHERE ventanilla = ?;').run(
          ahora,
          ventanillaLibre.ventanilla
        );
      }

      const turnoCreado = db.prepare('SELECT * FROM turnos WHERE id = ?;').get(info.lastInsertRowid);
      return {
        turno: {
          ...turnoCreado,
          fechaHoraImpresion: formatearTicket(ahora)
        },
        autoAsignado: Boolean(ventanillaLibre)
      };
    });

    if (autoAsignado && turno.ventanilla) {
      hooksTimers.alActivarVentanilla(turno.ventanilla);
    }

    emitirEventoSSE('turno_creado', autoAsignado ? { turnoLlamado: turno } : {});
    return res.status(201).json({ turno });
  } catch (error) {
    console.error('[POST /api/turnos] Error:', error);
    return res.status(500).json({ error: 'Error al generar el turno' });
  }
});

// Abre una ventanilla validando bloqueo 409 y auto-asigna el primer turno en espera.
app.post('/api/ventanillas/abrir', (req, res) => {
  const { ventanilla } = req.body || {};

  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe especificar la ventanilla' });
  }

  try {
    const resultado = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = new Date(ahora).toLocaleDateString('en-CA');

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorHttp(404, 'Ventanilla no encontrada');
      }

      // Bloqueo atómico de ventanilla duplicada (AGENTS.md §5.1).
      if (fila.estado !== 'cerrado') {
        throw new ErrorHttp(409, 'La ventanilla ya está en uso');
      }

      // Si la última actividad fue de un día anterior, reiniciamos los segundos
      // acumulados para que el contador del día actual arranque en cero.
      const esOtroDia =
        fila.ultima_actividad &&
        new Date(fila.ultima_actividad).toLocaleDateString('en-CA') !== hoy;
      const segundosBase = esOtroDia ? 0 : fila.segundos_activos;

      db.prepare(`
        UPDATE ventanillas
        SET estado = 'activo',
            segundos_activos = ?,
            ultimo_inicio_activo = ?,
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(segundosBase, ahora, ahora, ventanilla);

      // Auto-asignar el turno más antiguo en espera si existe cola para su servicio.
      const turnoActual = desencolarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
      const ventanillaActualizada = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      return { ventanilla: ventanillaActualizada, turnoActual };
    });

    hooksTimers.alActivarVentanilla(ventanilla);
    emitirEventoSSE(
      'ventanilla_abierta',
      resultado.turnoActual ? { turnoLlamado: resultado.turnoActual } : {}
    );
    return res.json(resultado);
  } catch (error) {
    if (error instanceof ErrorHttp) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/abrir] Error:', error);
    return res.status(500).json({ error: 'Error al abrir la ventanilla' });
  }
});

// Llama manualmente el turno FIFO más antiguo en espera para una ventanilla activa libre.
app.post('/api/ventanillas/llamar', (req, res) => {
  const { ventanilla } = req.body || {};

  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe especificar la ventanilla' });
  }

  try {
    const turno = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = new Date(ahora).toLocaleDateString('en-CA');

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorHttp(404, 'Ventanilla no encontrada');
      }

      if (fila.estado !== 'activo') {
        throw new ErrorHttp(409, 'La ventanilla debe estar activa para llamar un turno');
      }

      const enCurso = db
        .prepare(`
          SELECT id
          FROM turnos
          WHERE fecha_jornada = ?
            AND ventanilla = ?
            AND estado = 'atendiendo'
          LIMIT 1;
        `)
        .get(hoy, ventanilla);

      if (enCurso) {
        throw new ErrorHttp(409, 'La ventanilla ya tiene un turno en atención');
      }

      db.prepare('UPDATE ventanillas SET ultima_actividad = ? WHERE ventanilla = ?;').run(
        ahora,
        ventanilla
      );

      return desencolarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
    });

    hooksTimers.alActivarVentanilla(ventanilla);
    if (turno) {
      emitirEventoSSE('turno_llamado', { turnoLlamado: turno });
    }
    return res.json({ turno });
  } catch (error) {
    if (error instanceof ErrorHttp) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/llamar] Error:', error);
    return res.status(500).json({ error: 'Error al llamar al siguiente turno' });
  }
});

// Cierra un turno con motivo obligatorio y pausa o desencola automáticamente el siguiente.
app.post('/api/turnos/cerrar', (req, res) => {
  const { turno_id, ventanilla, resultado, pausar } = req.body || {};

  if (!turno_id || !ventanilla) {
    return res.status(400).json({ error: 'Faltan turno_id o ventanilla' });
  }

  if (!RESULTADOS_VALIDOS.has(resultado)) {
    return res.status(400).json({ error: 'Motivo de cierre inválido' });
  }

  try {
    const { siguienteTurno } = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = new Date(ahora).toLocaleDateString('en-CA');

      const filaVentanilla = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!filaVentanilla) {
        throw new ErrorHttp(404, 'Ventanilla no encontrada');
      }

      if (filaVentanilla.estado !== 'activo') {
        throw new ErrorHttp(409, 'La ventanilla no está activa');
      }

      const filaTurno = db
        .prepare(`
          SELECT *
          FROM turnos
          WHERE id = ?
            AND fecha_jornada = ?
            AND ventanilla = ?
            AND estado = 'atendiendo';
        `)
        .get(Number(turno_id), hoy, ventanilla);

      if (!filaTurno) {
        throw new ErrorHttp(409, 'El turno no está siendo atendido en esta ventanilla');
      }

      // Cerrar el turno actual registrando su resultado y marca de fin.
      db.prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = ?,
            hora_fin = ?
        WHERE id = ?;
      `).run(resultado, ahora, filaTurno.id);

      if (Boolean(pausar)) {
        // Al pasar a pausa consolidamos los segundos activos acumulados hasta este instante.
        const segundosExtra = filaVentanilla.ultimo_inicio_activo
          ? Math.max(0, Math.floor((ahora - filaVentanilla.ultimo_inicio_activo) / 1000))
          : 0;

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'pausa',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(filaVentanilla.segundos_activos + segundosExtra, ahora, ventanilla);

        return { siguienteTurno: null };
      }

      // Si no se pausa, mantenemos la ventanilla activa y llamamos al siguiente en cola.
      db.prepare(`
        UPDATE ventanillas
        SET ultimo_inicio_activo = COALESCE(ultimo_inicio_activo, ?),
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(ahora, ahora, ventanilla);

      const siguiente = desencolarSiguienteTurno(
        filaVentanilla.tipo_servicio,
        ventanilla,
        ahora,
        hoy
      );
      return { siguienteTurno: siguiente };
    });

    hooksTimers.alActivarVentanilla(ventanilla);
    emitirEventoSSE(
      'turno_cerrado',
      siguienteTurno ? { turnoLlamado: siguienteTurno } : {}
    );
    return res.json({ ok: true, siguienteTurno });
  } catch (error) {
    if (error instanceof ErrorHttp) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/turnos/cerrar] Error:', error);
    return res.status(500).json({ error: 'Error al cerrar el turno' });
  }
});

// Cambia el estado operativo de una ventanilla ("reanudar" desde pausa o "cerrar").
app.post('/api/ventanillas/estado', (req, res) => {
  const { ventanilla, accion } = req.body || {};

  if (!ventanilla || (accion !== 'reanudar' && accion !== 'cerrar')) {
    return res.status(400).json({ error: 'Parámetros inválidos (ventanilla y accion requeridos)' });
  }

  try {
    const respuesta = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = new Date(ahora).toLocaleDateString('en-CA');

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorHttp(404, 'Ventanilla no encontrada');
      }

      if (accion === 'reanudar') {
        if (fila.estado !== 'pausa') {
          throw new ErrorHttp(409, 'La ventanilla debe estar en pausa para reanudar');
        }

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'activo',
              ultimo_inicio_activo = ?,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(ahora, ahora, ventanilla);

        // Auto-asigna el turno más antiguo en espera si existe fila para su servicio.
        const siguienteTurno = desencolarSiguienteTurno(fila.tipo_servicio, ventanilla, ahora, hoy);
        return { ok: true, siguienteTurno };
      }

      // Acción: cerrar ventanilla. Exigimos finalizar primero cualquier turno activo.
      if (fila.estado === 'cerrado') {
        throw new ErrorHttp(409, 'La ventanilla ya está cerrada');
      }

      const turnoEnCurso = db
        .prepare(`
          SELECT id
          FROM turnos
          WHERE fecha_jornada = ?
            AND ventanilla = ?
            AND estado = 'atendiendo'
          LIMIT 1;
        `)
        .get(hoy, ventanilla);

      if (turnoEnCurso) {
        throw new ErrorHttp(409, 'Debes cerrar el turno actual antes de cerrar la ventanilla');
      }

      const segundosExtra =
        fila.estado === 'activo' && fila.ultimo_inicio_activo
          ? Math.max(0, Math.floor((ahora - fila.ultimo_inicio_activo) / 1000))
          : 0;

      db.prepare(`
        UPDATE ventanillas
        SET estado = 'cerrado',
            segundos_activos = ?,
            ultimo_inicio_activo = NULL,
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(fila.segundos_activos + segundosExtra, ahora, ventanilla);

      return { ok: true, siguienteTurno: null };
    });

    if (accion === 'reanudar') {
      hooksTimers.alActivarVentanilla(ventanilla);
      emitirEventoSSE(
        'ventanilla_reanudada',
        respuesta.siguienteTurno ? { turnoLlamado: respuesta.siguienteTurno } : {}
      );
    } else {
      hooksTimers.alCerrarVentanilla(ventanilla);
      emitirEventoSSE('ventanilla_cerrada');
    }

    return res.json(respuesta);
  } catch (error) {
    if (error instanceof ErrorHttp) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/estado] Error:', error);
    return res.status(500).json({ error: 'Error al actualizar el estado de la ventanilla' });
  }
});

// Ejecuta manualmente o vía cron del servidor el cierre diario de la jornada.
app.post('/api/jornada/cerrar', (req, res) => {
  try {
    const resultado = cerrarJornadaDiaria(Date.now());
    return res.json(resultado);
  } catch (error) {
    console.error('[POST /api/jornada/cerrar] Error:', error);
    return res.status(500).json({ error: 'Error al cerrar la jornada' });
  }
});

// Restablece las 7 ventanillas a cero para preparar el día siguiente o repetir pruebas.
app.post('/api/jornada/reiniciar', (req, res) => {
  const { limpiarTurnosHoy } = req.body || {};

  try {
    const resultado = reiniciarJornada({ limpiarTurnosHoy: Boolean(limpiarTurnosHoy) });
    return res.json(resultado);
  } catch (error) {
    console.error('[POST /api/jornada/reiniciar] Error:', error);
    return res.status(500).json({ error: 'Error al reiniciar la jornada' });
  }
});

// Middleware defensivo para devolver JSON limpio si el cliente envía un cuerpo malformado.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Cuerpo JSON inválido' });
  }
  return next(err);
});

// ----------------------------------------------------------------------------
// 6. Tareas Programadas, Saneamiento y Auto-Cierre por Inactividad (Paso 3)
// ----------------------------------------------------------------------------

// Límite de inactividad permitido para una ventanilla abierta (2 horas = 7,200 s).
const TIEMPO_INACTIVIDAD_MS = 2 * 60 * 60 * 1000;

// Mapa de temporizadores individuales por ventanilla (máximo 7 activos en RAM),
// evitando cualquier polling periódico contra SQLite.
const timersInactividad = new Map();

// Referencias a los timers únicos de cierre diario (18:00) y cambio de día (00:00).
let timerCierreDiario = null;
let timerCambioDia = null;

/**
 * Cancela y elimina el timer de inactividad pendiente de una ventanilla.
 *
 * @param {string} nombreVentanilla - Nombre exacto de la ventanilla.
 * @returns {void}
 */
function cancelarTimerInactividad(nombreVentanilla) {
  const timer = timersInactividad.get(nombreVentanilla);
  if (timer) {
    clearTimeout(timer);
    timersInactividad.delete(nombreVentanilla);
  }
}

/**
 * Cancela todos los timers de inactividad activos (usado al cerrar o reiniciar jornada).
 *
 * @returns {void}
 */
function cancelarTodosLosTimersInactividad() {
  for (const timer of timersInactividad.values()) {
    clearTimeout(timer);
  }
  timersInactividad.clear();
}

/**
 * Cierra una ventanilla específica por superar 2 horas sin actividad (AGENTS.md §5.2):
 * consolida sus segundos activos si estaba 'activo', pasa su estado a 'cerrado',
 * devuelve a 'espera' cualquier turno que tuviera en 'atendiendo' y emite SSE.
 *
 * @param {string} nombreVentanilla - Nombre de la ventanilla a evaluar.
 * @param {number} [ahora=Date.now()] - Marca de tiempo actual.
 * @returns {{ cerrada: boolean, restanteMs?: number }}
 */
function cerrarVentanillaPorInactividad(nombreVentanilla, ahora = Date.now()) {
  const hoy = new Date(ahora).toLocaleDateString('en-CA');

  const resultado = ejecutarTransaccion(() => {
    const fila = db
      .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
      .get(nombreVentanilla);

    if (!fila || fila.estado === 'cerrado') {
      return { cerrada: false };
    }

    // Comprobar contra SQLite que realmente hayan transcurrido las 2 horas completas.
    const transcurridoMs = fila.ultima_actividad
      ? ahora - fila.ultima_actividad
      : TIEMPO_INACTIVIDAD_MS;

    if (transcurridoMs < TIEMPO_INACTIVIDAD_MS) {
      return {
        cerrada: false,
        restanteMs: TIEMPO_INACTIVIDAD_MS - transcurridoMs
      };
    }

    const segundosExtra =
      fila.estado === 'activo' && fila.ultimo_inicio_activo
        ? Math.max(0, Math.floor((ahora - fila.ultimo_inicio_activo) / 1000))
        : 0;

    db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `).run(fila.segundos_activos + segundosExtra, ahora, nombreVentanilla);

    // Regla AGENTS.md §5.2: devolver a 'espera' cualquier turno en 'atendiendo'.
    db.prepare(`
      UPDATE turnos
      SET estado = 'espera',
          ventanilla = NULL,
          hora_llamado = NULL
      WHERE fecha_jornada = ?
        AND ventanilla = ?
        AND estado = 'atendiendo';
    `).run(hoy, nombreVentanilla);

    return { cerrada: true };
  });

  if (resultado.restanteMs) {
    programarTimerInactividad(nombreVentanilla, resultado.restanteMs);
  } else if (resultado.cerrada) {
    cancelarTimerInactividad(nombreVentanilla);
    emitirEventoSSE('ventanilla_inactiva_cerrada', { ventanilla: nombreVentanilla });
  }

  return resultado;
}

/**
 * Programa (o reinicia) el timer exacto de 2 horas de inactividad para una ventanilla.
 * Usa .unref() para no impedir el cierre limpio del proceso al detener el servidor.
 *
 * @param {string} nombreVentanilla - Nombre de la ventanilla con actividad reciente.
 * @param {number} [esperaMs=TIEMPO_INACTIVIDAD_MS] - Milisegundos restantes hasta el cierre.
 * @returns {void}
 */
function programarTimerInactividad(nombreVentanilla, esperaMs = TIEMPO_INACTIVIDAD_MS) {
  cancelarTimerInactividad(nombreVentanilla);

  const timer = setTimeout(() => {
    timersInactividad.delete(nombreVentanilla);
    cerrarVentanillaPorInactividad(nombreVentanilla);
  }, Math.max(0, esperaMs));

  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  timersInactividad.set(nombreVentanilla, timer);
}

// Conectar las rutas REST del Paso 2 con los temporizadores de inactividad del Paso 3.
hooksTimers.alActivarVentanilla = (ventanilla) => programarTimerInactividad(ventanilla);
hooksTimers.alCerrarVentanilla = (ventanilla) => cancelarTimerInactividad(ventanilla);
hooksTimers.alCerrarTodas = () => cancelarTodosLosTimersInactividad();

/**
 * Rutina de saneamiento al arrancar server.js o al cambiar de día (medianoche):
 *   1. Cierra como 'no_atendido' cualquier turno abierto de jornadas anteriores.
 *   2. Reinicia a 'cerrado' y segundos_activos = 0 las ventanillas cuya última
 *      actividad pertenezca a una fecha anterior (conservando historial en turnos).
 *   3. Si ya pasaron las 18:00 hrs del día actual y quedaron sesiones/turnos previos
 *      a las 18:00 sin cerrar (p. ej. equipo apagado), aplica el corte pendiente.
 *   4. Para ventanillas abiertas del mismo día, cierra las que superaron 2 horas
 *      sin actividad y reprograma los timers exactos del tiempo restante.
 *
 * @param {number} [ahora=Date.now()] - Marca de tiempo de referencia.
 * @returns {{ turnosAnterioresCerrados: number, ventanillasReiniciadas: number, ventanillasInactivas: number }}
 */
function sanearAlArranque(ahora = Date.now()) {
  const fechaRef = new Date(ahora);
  const hoy = fechaRef.toLocaleDateString('en-CA');

  // Marca exacta de las 18:00:00 del día actual para detectar cortes pendientes si
  // el servidor estuvo apagado a la hora del cierre diario.
  const corteHoy = new Date(fechaRef);
  corteHoy.setHours(18, 0, 0, 0);
  const corteHoyMs = corteHoy.getTime();

  const timersPendientes = [];

  const resumen = ejecutarTransaccion(() => {
    // 1. Cerrar turnos abiertos que hayan quedado de jornadas anteriores (< hoy).
    const infoTurnosPrevios = db
      .prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = 'no_atendido',
            hora_fin = ?
        WHERE fecha_jornada < ?
          AND estado IN ('espera', 'atendiendo');
      `)
      .run(ahora, hoy);

    // 2. Si ya pasaron las 18:00 hrs hoy, cerrar únicamente turnos de hoy abiertos
    // antes de las 18:00:00 (respetando pruebas iniciadas después de las 18:00).
    let turnosPre18Cerrados = 0;
    if (ahora >= corteHoyMs) {
      const infoPre18 = db
        .prepare(`
          UPDATE turnos
          SET estado = 'cerrado',
               resultado = 'no_atendido',
              hora_fin = ?
          WHERE fecha_jornada = ?
            AND estado IN ('espera', 'atendiendo')
            AND hora_creacion < ?;
        `)
        .run(ahora, hoy, corteHoyMs);
      turnosPre18Cerrados = infoPre18.changes;
    }

    // 3. Evaluar el estado de las 7 ventanillas.
    const ventanillas = db.prepare('SELECT * FROM ventanillas ORDER BY numero ASC;').all();
    let ventanillasReiniciadas = 0;
    let ventanillasInactivas = 0;

    for (const v of ventanillas) {
      const fechaUltimaAct = v.ultima_actividad
        ? new Date(v.ultima_actividad).toLocaleDateString('en-CA')
        : null;

      // Si su actividad/acumulado viene de un día anterior, preparamos la nueva
      // jornada poniendo la ventanilla en cero (el historial ya está en turnos).
      if (fechaUltimaAct && fechaUltimaAct < hoy) {
        db.prepare(`
          UPDATE ventanillas
          SET estado = 'cerrado',
              segundos_activos = 0,
              ultimo_inicio_activo = NULL,
              ultima_actividad = NULL
          WHERE ventanilla = ?;
        `).run(v.ventanilla);
        ventanillasReiniciadas += 1;
        continue;
      }

      if (v.estado === 'cerrado') {
        continue;
      }

      // Si ya pasaron las 18:00 hoy y la ventanilla quedó abierta antes de las 18:00.
      if (ahora >= corteHoyMs && (!v.ultima_actividad || v.ultima_actividad < corteHoyMs)) {
        const segundosExtra =
          v.estado === 'activo' && v.ultimo_inicio_activo
            ? Math.max(0, Math.floor((ahora - v.ultimo_inicio_activo) / 1000))
            : 0;

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'cerrado',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(v.segundos_activos + segundosExtra, ahora, v.ventanilla);
        ventanillasReiniciadas += 1;
        continue;
      }

      // Ventanilla abierta hoy: validar límite de 2 horas de inactividad.
      const transcurridoMs = v.ultima_actividad
        ? Math.max(0, ahora - v.ultima_actividad)
        : 0;

      if (transcurridoMs >= TIEMPO_INACTIVIDAD_MS) {
        const segundosExtra =
          v.estado === 'activo' && v.ultimo_inicio_activo
            ? Math.max(0, Math.floor((ahora - v.ultimo_inicio_activo) / 1000))
            : 0;

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'cerrado',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(v.segundos_activos + segundosExtra, ahora, v.ventanilla);

        db.prepare(`
          UPDATE turnos
          SET estado = 'espera',
              ventanilla = NULL,
              hora_llamado = NULL
          WHERE fecha_jornada = ?
            AND ventanilla = ?
            AND estado = 'atendiendo';
        `).run(hoy, v.ventanilla);

        ventanillasInactivas += 1;
      } else {
        // Sigue dentro de su ventana de 2 horas: reconstruir tiempo restante.
        timersPendientes.push({
          ventanilla: v.ventanilla,
          restanteMs: TIEMPO_INACTIVIDAD_MS - transcurridoMs
        });
      }
    }

    return {
      turnosAnterioresCerrados: infoTurnosPrevios.changes + turnosPre18Cerrados,
      ventanillasReiniciadas,
      ventanillasInactivas
    };
  });

  cancelarTodosLosTimersInactividad();
  for (const item of timersPendientes) {
    programarTimerInactividad(item.ventanilla, item.restanteMs);
  }

  if (
    resumen.turnosAnterioresCerrados > 0 ||
    resumen.ventanillasReiniciadas > 0 ||
    resumen.ventanillasInactivas > 0
  ) {
    emitirEventoSSE('saneamiento_ejecutado');
  }

  return resumen;
}

/**
 * Programa un único setTimeout exacto para las 18:00:00 (6:00 PM) hora local.
 * Se ejecuta una sola vez al llegar las 18:00 y se reprograma automáticamente
 * para las 18:00:00 del día siguiente, sin interferir con pruebas nocturnas.
 *
 * @returns {number} Milisegundos programados hasta el próximo corte de las 18:00.
 */
function programarCierreDiario() {
  if (timerCierreDiario) {
    clearTimeout(timerCierreDiario);
  }

  const ahora = new Date();
  const proximoCierre = new Date(ahora);
  proximoCierre.setHours(18, 0, 0, 0);

  // Si ya son las 18:00:00 o más tarde, programar para mañana a las 18:00:00.
  if (ahora.getTime() >= proximoCierre.getTime()) {
    proximoCierre.setDate(proximoCierre.getDate() + 1);
  }

  const esperaMs = Math.max(1, proximoCierre.getTime() - ahora.getTime());

  timerCierreDiario = setTimeout(() => {
    cerrarJornadaDiaria(Date.now());
    programarCierreDiario();
  }, esperaMs);

  if (typeof timerCierreDiario.unref === 'function') {
    timerCierreDiario.unref();
  }

  return esperaMs;
}

/**
 * Programa un setTimeout exacto a medianoche (00:00:00) para limpiar el estado
 * operativo de las ventanillas al iniciar el siguiente día, conservando el
 * historial completo en la tabla turnos y notificando por SSE a vistas abiertas.
 *
 * @returns {number} Milisegundos programados hasta la próxima medianoche.
 */
function programarCambioDeDia() {
  if (timerCambioDia) {
    clearTimeout(timerCambioDia);
  }

  const ahora = new Date();
  const medianoche = new Date(ahora);
  medianoche.setHours(24, 0, 0, 0);

  const esperaMs = Math.max(1, medianoche.getTime() - ahora.getTime());

  timerCambioDia = setTimeout(() => {
    sanearAlArranque(Date.now());
    emitirEventoSSE('cambio_de_dia');
    programarCambioDeDia();
  }, esperaMs);

  if (typeof timerCambioDia.unref === 'function') {
    timerCambioDia.unref();
  }

  return esperaMs;
}

/**
 * Ejecuta el saneamiento inicial y activa los temporizadores automáticos del servidor.
 *
 * @returns {void}
 */
function iniciarTareasProgramadas() {
  sanearAlArranque(Date.now());
  programarCierreDiario();
  programarCambioDeDia();
}

/**
 * Detiene todos los temporizadores programados (útil para cierre ordenado o tests).
 *
 * @returns {void}
 */
function detenerTareasProgramadas() {
  if (timerCierreDiario) {
    clearTimeout(timerCierreDiario);
    timerCierreDiario = null;
  }
  if (timerCambioDia) {
    clearTimeout(timerCambioDia);
    timerCambioDia = null;
  }
  cancelarTodosLosTimersInactividad();
}

// ----------------------------------------------------------------------------
// 7. Inicialización y Arranque
// ----------------------------------------------------------------------------

// Ejecuta la creación de tablas, índices y seed obligatorio al cargar el servidor.
inicializarBaseDeDatos();

// Ejecuta saneamiento de arranque y activa los timers exactos (18:00, 00:00 e inactividad).
iniciarTareasProgramadas();

// Inicia la escucha HTTP únicamente si server.js se ejecuta directamente.
if (require.main === module) {
  app.listen(PUERTO, () => {
    console.log(`[Sistema de Turnos] Servidor escuchando en http://localhost:${PUERTO}`);
    console.log(
      `[Sistema de Turnos] Fecha y hora del servidor: ${new Date().toLocaleString('es-MX', {
        dateStyle: 'short',
        timeStyle: 'short',
        hour12: false
      })}`
    );
  });
}

module.exports = {
  app,
  db,
  PUERTO,
  CATALOGO_VENTANILLAS,
  PREFIJOS_SERVICIO,
  RESULTADOS_VALIDOS,
  TIEMPO_INACTIVIDAD_MS,
  clientesSSE,
  hooksTimers,
  timersInactividad,
  ejecutarTransaccion,
  inicializarBaseDeDatos,
  obtenerEstadoCompleto,
  emitirEventoSSE,
  cerrarJornadaDiaria,
  reiniciarJornada,
  cerrarVentanillaPorInactividad,
  programarTimerInactividad,
  cancelarTimerInactividad,
  sanearAlArranque,
  programarCierreDiario,
  programarCambioDeDia,
  iniciarTareasProgramadas,
  detenerTareasProgramadas
};

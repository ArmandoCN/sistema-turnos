process.env.TZ = 'America/Mazatlan';

/*
  Servidor principal del Sistema de Gestión de Turnos.

  Este archivo hace todo el trabajo central del sistema:
  - Guarda los turnos y el estado de las 7 ventanillas en un archivo SQLite (turnos.db).
  - Entrega las páginas web de la carpeta "public/" (kiosco, ventanillas, pantalla y tablero).
  - Recibe peticiones de las pantallas (pedir turno, llamar cliente, cerrar atención, pausar).
  - Avisa al instante a todas las pantallas conectadas cuando algo cambia.
  - Cierra la jornada automáticamente a las 18:00 hrs y libera ventanillas tras 2 horas sin uso.
*/

const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// --- 1. Configuración básica del servidor web y base de datos ---

const PUERTO = Number(process.env.PORT) || 4782;
const RUTA_DB = path.join(__dirname, 'turnos.db');

// Tiempo máximo sin actividad antes de cerrar una ventanilla abierta (2 horas en milisegundos).
const DOS_HORAS_MS = 2 * 60 * 60 * 1000;

const PREFIJOS_SERVICIO = {
  caja: 'C',
  ejecutivo: 'E',
  atencion: 'A'
};

const MOTIVOS_VALIDOS = new Set([
  'atendido',
  'no_atendido',
  'no_aparecio',
  'turno_equivocado'
]);

// Lista fija de las 7 ventanillas del comercio y el servicio que atiende cada una.
const CATALOGO_VENTANILLAS = [
  { numero: 1, ventanilla: 'Ventanilla 1', tipo_servicio: 'caja' },
  { numero: 2, ventanilla: 'Ventanilla 2', tipo_servicio: 'caja' },
  { numero: 3, ventanilla: 'Ventanilla 3', tipo_servicio: 'caja' },
  { numero: 4, ventanilla: 'Ventanilla 4', tipo_servicio: 'caja' },
  { numero: 5, ventanilla: 'Ventanilla 5', tipo_servicio: 'ejecutivo' },
  { numero: 6, ventanilla: 'Ventanilla 6', tipo_servicio: 'ejecutivo' },
  { numero: 7, ventanilla: 'Ventanilla 7', tipo_servicio: 'atencion' }
];

const app = express();

// Permite leer datos enviados en formato JSON y entregar los archivos HTML/CSS/JS de "public/".
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a la base de datos SQLite en un solo archivo local.
// WAL permite que varias pantallas lean al mismo tiempo mientras se guarda un cambio,
// y busy_timeout espera hasta 5 segundos si dos peticiones coinciden en el mismo instante.
const db = new DatabaseSync(RUTA_DB);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

// Lista de pantallas conectadas escuchando avisos en vivo.
const clientesEnVivo = new Set();

// Temporizadores activos en memoria (uno por ventanilla abierta, máximo 7).
const timersInactividad = new Map();
let timerCierreDiario = null;
let timerCambioDia = null;

// --- 2. Utilidades de fecha, errores y operaciones seguras en SQLite ---

// Error sencillo con código HTTP (por ejemplo 409 cuando una ventanilla ya está ocupada).
class ErrorNegocio extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

// Convierte una marca de tiempo a fecha local YYYY-MM-DD (usando la hora de Mazatlán).
function fechaLocal(ms = Date.now()) {
  return new Date(ms).toLocaleDateString('en-CA');
}

// Convierte una marca de tiempo a texto corto "DD/MM/YY HH:mm" para los tickets y registros.
function formatearFechaHora(ms) {
  return new Date(ms)
    .toLocaleString('es-MX', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
      hourCycle: 'h23'
    })
    .replace(',', '');
}

// Ejecuta varias consultas SQL como una sola operación protegida (BEGIN IMMEDIATE).
// Así evitamos que dos cajeros atiendan al mismo cliente o generen el mismo número si hacen clic juntos.
function ejecutarTransaccion(pasos) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = pasos();
    db.exec('COMMIT');
    return resultado;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Si SQLite ya canceló la operación internamente, conservamos el error original.
    }
    throw error;
  }
}

// Suma los segundos que una ventanilla ya tenía guardados hoy más los que lleva activa desde su última apertura.
function acumularSegundosActivos(ventanilla, hastaMs) {
  if (ventanilla.estado !== 'activo' || !ventanilla.ultimo_inicio_activo) {
    return ventanilla.segundos_activos;
  }
  const extra = Math.max(0, Math.floor((hastaMs - ventanilla.ultimo_inicio_activo) / 1000));
  return ventanilla.segundos_activos + extra;
}

// Devuelve a la fila de espera los turnos que quedaron asignados a una ventanilla que se cerró.
// Si no se indica nombre de ventanilla, libera todos los turnos en atención de hoy.
function liberarTurnosEnAtencion(hoy, nombreVentanilla = null) {
  if (nombreVentanilla) {
    return db
      .prepare(`
        UPDATE turnos
        SET estado = 'espera',
            ventanilla = NULL,
            hora_llamado = NULL
        WHERE fecha_jornada = ?
          AND ventanilla = ?
          AND estado = 'atendiendo';
      `)
      .run(hoy, nombreVentanilla).changes;
  }

  return db
    .prepare(`
      UPDATE turnos
      SET estado = 'espera',
          ventanilla = NULL,
          hora_llamado = NULL
      WHERE fecha_jornada = ?
        AND estado = 'atendiendo';
    `)
    .run(hoy).changes;
}

// --- 3. Creación inicial de tablas y guardado de las 7 ventanillas ---

function inicializarBaseDeDatos() {
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

  // Inserta las 7 ventanillas solo si todavía no existen en la base de datos.
  ejecutarTransaccion(() => {
    const insertar = db.prepare(`
      INSERT OR IGNORE INTO ventanillas (numero, ventanilla, tipo_servicio)
      VALUES (?, ?, ?);
    `);
    for (const item of CATALOGO_VENTANILLAS) {
      insertar.run(item.numero, item.ventanilla, item.tipo_servicio);
    }
  });
}

// --- 4. Reglas de turnos, filas de espera, estadísticas y avisos en vivo ---

// Toma el turno más antiguo en espera de un servicio (el primero que llegó) y lo asigna a la ventanilla.
function tomarSiguienteDeFila(tipoServicio, nombreVentanilla, ahora, hoy) {
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

  return db.prepare('SELECT * FROM turnos WHERE id = ?;').get(siguiente.id);
}

// Calcula cuántos segundos activos lleva hoy una ventanilla (si estaba cerrada desde ayer, empieza en 0).
function calcularSegundosActivosHoy(ventanilla, ahora, hoy) {
  if (
    ventanilla.estado === 'cerrado' &&
    ventanilla.ultima_actividad &&
    fechaLocal(ventanilla.ultima_actividad) !== hoy
  ) {
    return 0;
  }
  return acumularSegundosActivos(ventanilla, ahora);
}

// Estima el tiempo de espera promediando los últimos 20 turnos atendidos hoy para ese servicio.
// Si todavía hay menos de 3 atendidos en el día, devuelve "5 min" como referencia inicial.
function calcularTiempoEstimado(tipoServicio, hoy) {
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

  if (muestras.length < 3) {
    return '5 min';
  }

  let totalEsperaMs = 0;
  for (const turno of muestras) {
    totalEsperaMs += Math.max(0, turno.hora_llamado - turno.hora_creacion);
  }

  const minutos = Math.round(totalEsperaMs / muestras.length / 60000);
  return `${Math.max(1, minutos)} min`;
}

// Reúne toda la información del día en un solo objeto listo para cualquiera de las pantallas.
function obtenerEstadoCompleto() {
  const ahora = Date.now();
  const hoy = fechaLocal(ahora);

  const filasVentanillas = db
    .prepare('SELECT * FROM ventanillas ORDER BY numero ASC;')
    .all();

  const turnosHoy = db
    .prepare(`
      SELECT *
      FROM turnos
      WHERE fecha_jornada = ?
      ORDER BY id ASC;
    `)
    .all(hoy);

  const turnoPorVentanilla = new Map();
  const turnosAtendiendo = [];
  const filasEspera = { caja: [], ejecutivo: [], atencion: [] };
  const proximosEspera = [];

  let totalCerrados = 0;
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
  const atendidosPorHoraMap = new Map();
  const cerradosPorVentanilla = new Map();
  const atendidosPorVentanilla = new Map();

  for (const turno of turnosHoy) {
    if (turno.hora_llamado !== null) {
      sumaEsperaMs += Math.max(0, turno.hora_llamado - turno.hora_creacion);
      totalConEspera += 1;
    }

    if (turno.estado === 'atendiendo') {
      turnosAtendiendo.push(turno);
      if (turno.ventanilla) {
        turnoPorVentanilla.set(turno.ventanilla, turno);
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
          totalAtencion += 1;
        }
        if (turno.hora_fin !== null) {
          const hora = new Date(turno.hora_fin).getHours();
          atendidosPorHoraMap.set(hora, (atendidosPorHoraMap.get(hora) || 0) + 1);
        }
      }
    }
  }

  // Muestra primero en la sala de espera el turno que acaba de ser llamado más recientemente.
  turnosAtendiendo.sort((a, b) => (b.hora_llamado || 0) - (a.hora_llamado || 0) || b.id - a.id);

  const ventanillas = filasVentanillas.map((v) => ({
    ...v,
    segundosActivos: calcularSegundosActivosHoy(v, ahora, hoy),
    turnoActual: turnoPorVentanilla.get(v.ventanilla) || null
  }));

  const tiemposEstimados = {
    caja: calcularTiempoEstimado('caja', hoy),
    ejecutivo: calcularTiempoEstimado('ejecutivo', hoy),
    atencion: calcularTiempoEstimado('atencion', hoy)
  };

  // Crea una lista continua de horas desde la primera hasta la última atención del día.
  const horas = Array.from(atendidosPorHoraMap.keys());
  const clientesAtendidosPorHora = [];
  if (horas.length > 0) {
    const inicio = Math.min(...horas);
    const fin = Math.max(...horas);
    for (let h = inicio; h <= fin; h += 1) {
      clientesAtendidosPorHora.push({
        horaNum: h,
        etiqueta: `${String(h).padStart(2, '0')}:00`,
        total: atendidosPorHoraMap.get(h) || 0
      });
    }
  }

  const motivos = {};
  for (const clave of MOTIVOS_VALIDOS) {
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

// Envía la foto actualizada del sistema a todas las pantallas conectadas en ese momento.
function notificarPantallas(tipo, extra = {}) {
  if (clientesEnVivo.size === 0) {
    return;
  }

  const mensaje = `data: ${JSON.stringify({
    tipo,
    ...extra,
    estado: obtenerEstadoCompleto()
  })}\n\n`;

  for (const res of clientesEnVivo) {
    try {
      res.write(mensaje);
    } catch (_) {
      clientesEnVivo.delete(res);
    }
  }
}

// --- 5. Temporizadores automáticos (cierre a las 18:00, medianoche e inactividad de 2h) ---

function cancelarTimerInactividad(nombreVentanilla) {
  const timer = timersInactividad.get(nombreVentanilla);
  if (timer) {
    clearTimeout(timer);
    timersInactividad.delete(nombreVentanilla);
  }
}

function cancelarTodosLosTimersInactividad() {
  for (const timer of timersInactividad.values()) {
    clearTimeout(timer);
  }
  timersInactividad.clear();
}

// Si una ventanilla pasa 2 horas abierta sin registrar movimientos, se cierra sola
// y devuelve a espera cualquier turno que tuviera asignado sin terminar.
function cerrarVentanillaPorInactividad(nombreVentanilla, ahora = Date.now()) {
  const hoy = fechaLocal(ahora);

  const resultado = ejecutarTransaccion(() => {
    const fila = db
      .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
      .get(nombreVentanilla);

    if (!fila || fila.estado === 'cerrado') {
      return { cerrada: false };
    }

    const transcurridoMs = fila.ultima_actividad
      ? ahora - fila.ultima_actividad
      : DOS_HORAS_MS;

    if (transcurridoMs < DOS_HORAS_MS) {
      return {
        cerrada: false,
        restanteMs: DOS_HORAS_MS - transcurridoMs
      };
    }

    db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `).run(acumularSegundosActivos(fila, ahora), ahora, nombreVentanilla);

    liberarTurnosEnAtencion(hoy, nombreVentanilla);
    return { cerrada: true };
  });

  if (resultado.restanteMs) {
    programarTimerInactividad(nombreVentanilla, resultado.restanteMs);
  } else if (resultado.cerrada) {
    cancelarTimerInactividad(nombreVentanilla);
    notificarPantallas('ventanilla_inactiva_cerrada', { ventanilla: nombreVentanilla });
  }

  return resultado;
}

// Programa o reinicia la cuenta regresiva de 2 horas para una ventanilla específica.
function programarTimerInactividad(nombreVentanilla, esperaMs = DOS_HORAS_MS) {
  cancelarTimerInactividad(nombreVentanilla);

  const timer = setTimeout(() => {
    timersInactividad.delete(nombreVentanilla);
    cerrarVentanillaPorInactividad(nombreVentanilla);
  }, Math.max(0, esperaMs));

  // Permite que Node se apague limpiamente si cerramos el servidor manualmente.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  timersInactividad.set(nombreVentanilla, timer);
}

// Cierra la jornada del día: cierra ventanillas abiertas guardando su tiempo activo
// y marca como "no_atendido" los turnos que hayan quedado pendientes.
function cerrarJornadaDiaria(ahora = Date.now()) {
  const hoy = fechaLocal(ahora);

  const resultado = ejecutarTransaccion(() => {
    const abiertas = db
      .prepare("SELECT * FROM ventanillas WHERE estado IN ('activo', 'pausa');")
      .all();

    const stmtCerrar = db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = ?,
          ultimo_inicio_activo = NULL,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `);

    for (const v of abiertas) {
      stmtCerrar.run(acumularSegundosActivos(v, ahora), ahora, v.ventanilla);
    }

    const turnosCerrados = db
      .prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = 'no_atendido',
            hora_fin = ?
        WHERE fecha_jornada = ?
          AND estado IN ('espera', 'atendiendo');
      `)
      .run(ahora, hoy).changes;

    return {
      ok: true,
      ventanillasCerradas: abiertas.length,
      turnosCerrados
    };
  });

  cancelarTodosLosTimersInactividad();
  notificarPantallas('jornada_cerrada');
  return resultado;
}

// Deja las 7 ventanillas cerradas con reloj en cero. Si limpiarTurnosHoy es verdadero,
// borra además los turnos del día actual (útil para pruebas repetidas) sin tocar días anteriores.
function reiniciarJornada({ limpiarTurnosHoy = false } = {}) {
  const hoy = fechaLocal();

  const resultado = ejecutarTransaccion(() => {
    db.prepare(`
      UPDATE ventanillas
      SET estado = 'cerrado',
          segundos_activos = 0,
          ultimo_inicio_activo = NULL,
          ultima_actividad = NULL;
    `).run();

    let turnosEliminados = 0;
    let turnosLiberados = 0;

    if (limpiarTurnosHoy) {
      turnosEliminados = db
        .prepare('DELETE FROM turnos WHERE fecha_jornada = ?;')
        .run(hoy).changes;
    } else {
      turnosLiberados = liberarTurnosEnAtencion(hoy);
    }

    return { ok: true, turnosEliminados, turnosLiberados };
  });

  cancelarTodosLosTimersInactividad();
  notificarPantallas('jornada_reiniciada');
  return resultado;
}

// Al encender el servidor o al cambiar de día, limpia sesiones atrasadas si el equipo estuvo apagado.
function sanearAlArranque(ahora = Date.now()) {
  const fechaRef = new Date(ahora);
  const hoy = fechaLocal(ahora);

  const corteHoy = new Date(fechaRef);
  corteHoy.setHours(18, 0, 0, 0);
  const corteHoyMs = corteHoy.getTime();

  const timersPendientes = [];

  const resumen = ejecutarTransaccion(() => {
    const turnosPrevios = db
      .prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = 'no_atendido',
            hora_fin = ?
        WHERE fecha_jornada < ?
          AND estado IN ('espera', 'atendiendo');
      `)
      .run(ahora, hoy).changes;

    let turnosPre18 = 0;
    if (ahora >= corteHoyMs) {
      turnosPre18 = db
        .prepare(`
          UPDATE turnos
          SET estado = 'cerrado',
              resultado = 'no_atendido',
              hora_fin = ?
          WHERE fecha_jornada = ?
            AND estado IN ('espera', 'atendiendo')
            AND hora_creacion < ?;
        `)
        .run(ahora, hoy, corteHoyMs).changes;
    }

    const ventanillas = db.prepare('SELECT * FROM ventanillas ORDER BY numero ASC;').all();
    let ventanillasReiniciadas = 0;
    let ventanillasInactivas = 0;

    for (const v of ventanillas) {
      const fechaUltima = v.ultima_actividad ? fechaLocal(v.ultima_actividad) : null;

      // Si su última actividad fue de un día pasado, reiniciamos su contador de hoy a cero.
      if (fechaUltima && fechaUltima < hoy) {
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

      // Si ya pasaron las 18:00 y la ventanilla quedó abierta desde antes de las 18:00,
      // topamos los segundos acumulados hasta la hora real del corte o su límite de 2h.
      if (ahora >= corteHoyMs && (!v.ultima_actividad || v.ultima_actividad < corteHoyMs)) {
        const topeInactividad = v.ultima_actividad
          ? v.ultima_actividad + DOS_HORAS_MS
          : corteHoyMs;
        const marcaFin = Math.min(corteHoyMs, topeInactividad);

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'cerrado',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(acumularSegundosActivos(v, marcaFin), marcaFin, v.ventanilla);

        liberarTurnosEnAtencion(hoy, v.ventanilla);
        ventanillasReiniciadas += 1;
        continue;
      }

      const transcurridoMs = v.ultima_actividad ? Math.max(0, ahora - v.ultima_actividad) : 0;

      if (transcurridoMs >= DOS_HORAS_MS) {
        // Si estuvo apagado más de 2 horas, solo contamos hasta el límite real de 2 horas.
        const marcaLimite = v.ultima_actividad
          ? Math.min(ahora, v.ultima_actividad + DOS_HORAS_MS)
          : ahora;

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'cerrado',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(acumularSegundosActivos(v, marcaLimite), ahora, v.ventanilla);

        liberarTurnosEnAtencion(hoy, v.ventanilla);
        ventanillasInactivas += 1;
      } else {
        timersPendientes.push({
          ventanilla: v.ventanilla,
          restanteMs: DOS_HORAS_MS - transcurridoMs
        });
      }
    }

    return {
      turnosAnterioresCerrados: turnosPrevios + turnosPre18,
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
    notificarPantallas('saneamiento_ejecutado');
  }

  return resumen;
}

// Programa un único aviso exacto para las 18:00:00 (6:00 PM) de hoy o mañana.
function programarCierreDiario() {
  if (timerCierreDiario) {
    clearTimeout(timerCierreDiario);
  }

  const ahora = new Date();
  const proximo = new Date(ahora);
  proximo.setHours(18, 0, 0, 0);

  if (ahora.getTime() >= proximo.getTime()) {
    proximo.setDate(proximo.getDate() + 1);
  }

  const esperaMs = Math.max(1, proximo.getTime() - ahora.getTime());

  timerCierreDiario = setTimeout(() => {
    cerrarJornadaDiaria(Date.now());
    programarCierreDiario();
  }, esperaMs);

  if (typeof timerCierreDiario.unref === 'function') {
    timerCierreDiario.unref();
  }
  return esperaMs;
}

// Programa el reinicio automático de medianoche (00:00:00) para comenzar limpio cada día.
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
    notificarPantallas('cambio_de_dia');
    programarCambioDeDia();
  }, esperaMs);

  if (typeof timerCambioDia.unref === 'function') {
    timerCambioDia.unref();
  }
  return esperaMs;
}

function iniciarTareasProgramadas() {
  sanearAlArranque(Date.now());
  programarCierreDiario();
  programarCambioDeDia();
}

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

// --- 6. Rutas de la aplicación web y canal de actualizaciones en vivo ---

// Portal sencillo en la página principal "/" para abrir cualquiera de los 4 módulos.
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
        <p class="encabezado-subtitulo">Elija qué pantalla desea abrir en este dispositivo</p>
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

// Evita avisos 404 en el navegador cuando pide el ícono de pestaña.
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// Canal abierto en vivo (SSE): envía cambios al instante y un pulso cada 25 s para mantener viva la conexión.
app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clientesEnVivo.add(res);
  res.write(`data: ${JSON.stringify({ tipo: 'conexion_inicial', estado: obtenerEstadoCompleto() })}\n\n`);

  const pulso = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(pulso);
      clientesEnVivo.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(pulso);
    clientesEnVivo.delete(res);
  });
});

// Entrega el resumen completo del día actual.
app.get('/api/estado', (req, res) => {
  try {
    res.json(obtenerEstadoCompleto());
  } catch (error) {
    console.error('[GET /api/estado]', error);
    res.status(500).json({ error: 'No se pudo consultar el estado del sistema' });
  }
});

// Crea un turno nuevo con numeración cíclica del 01 al 99 y lo asigna directo si hay ventanilla libre.
app.post('/api/turnos', (req, res) => {
  const { tipo } = req.body || {};

  if (!PREFIJOS_SERVICIO[tipo]) {
    return res.status(400).json({ error: 'Tipo de servicio inválido' });
  }

  try {
    const { turno, autoAsignado } = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = fechaLocal(ahora);

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

      // Si llega al 99 en el mismo día, el siguiente turno vuelve a empezar en 01.
      const siguienteFolio = ((ultimo ? ultimo.numero_folio : 0) % 99) + 1;
      const codigo = `${PREFIJOS_SERVICIO[tipo]}-${String(siguienteFolio).padStart(2, '0')}`;

      // Busca la ventanilla activa con número más bajo (1 antes que 2, etc.) que no esté atendiendo.
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
            fecha_jornada, numero_folio, codigo, tipo, estado,
            ventanilla, hora_creacion, hora_llamado
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `)
        .run(hoy, siguienteFolio, codigo, tipo, estadoInicial, ventanillaAsignada, ahora, horaLlamado);

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
          fechaHoraImpresion: formatearFechaHora(ahora)
        },
        autoAsignado: Boolean(ventanillaLibre)
      };
    });

    if (autoAsignado && turno.ventanilla) {
      programarTimerInactividad(turno.ventanilla);
    }

    notificarPantallas('turno_creado', autoAsignado ? { turnoLlamado: turno } : {});
    return res.status(201).json({ turno });
  } catch (error) {
    console.error('[POST /api/turnos]', error);
    return res.status(500).json({ error: 'No se pudo generar el turno' });
  }
});

// Abre una ventanilla cerrada; si alguien más ya la abrió, responde con error 409.
app.post('/api/ventanillas/abrir', (req, res) => {
  const { ventanilla } = req.body || {};

  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe indicar qué ventanilla desea abrir' });
  }

  try {
    const resultado = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = fechaLocal(ahora);

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorNegocio(404, 'Ventanilla no encontrada');
      }

      if (fila.estado !== 'cerrado') {
        throw new ErrorNegocio(409, 'La ventanilla ya está en uso');
      }

      const esOtroDia = fila.ultima_actividad && fechaLocal(fila.ultima_actividad) !== hoy;
      const segundosBase = esOtroDia ? 0 : fila.segundos_activos;

      db.prepare(`
        UPDATE ventanillas
        SET estado = 'activo',
            segundos_activos = ?,
            ultimo_inicio_activo = ?,
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(segundosBase, ahora, ahora, ventanilla);

      const turnoActual = tomarSiguienteDeFila(fila.tipo_servicio, ventanilla, ahora, hoy);
      const ventanillaActualizada = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      return { ventanilla: ventanillaActualizada, turnoActual };
    });

    programarTimerInactividad(ventanilla);
    notificarPantallas(
      'ventanilla_abierta',
      resultado.turnoActual ? { turnoLlamado: resultado.turnoActual } : {}
    );
    return res.json(resultado);
  } catch (error) {
    if (error instanceof ErrorNegocio) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/abrir]', error);
    return res.status(500).json({ error: 'No se pudo abrir la ventanilla' });
  }
});

// Llama manualmente al siguiente turno en espera cuando la ventanilla está activa y libre.
app.post('/api/ventanillas/llamar', (req, res) => {
  const { ventanilla } = req.body || {};

  if (!ventanilla) {
    return res.status(400).json({ error: 'Debe indicar la ventanilla' });
  }

  try {
    const turno = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = fechaLocal(ahora);

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorNegocio(404, 'Ventanilla no encontrada');
      }

      if (fila.estado !== 'activo') {
        throw new ErrorNegocio(409, 'La ventanilla debe estar activa para llamar un turno');
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
        throw new ErrorNegocio(409, 'La ventanilla ya tiene un turno en atención');
      }

      db.prepare('UPDATE ventanillas SET ultima_actividad = ? WHERE ventanilla = ?;').run(
        ahora,
        ventanilla
      );

      return tomarSiguienteDeFila(fila.tipo_servicio, ventanilla, ahora, hoy);
    });

    programarTimerInactividad(ventanilla);
    if (turno) {
      notificarPantallas('turno_llamado', { turnoLlamado: turno });
    }
    return res.json({ turno });
  } catch (error) {
    if (error instanceof ErrorNegocio) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/llamar]', error);
    return res.status(500).json({ error: 'No se pudo llamar al siguiente turno' });
  }
});

// Cierra el turno actual con uno de los 4 motivos y decide si pausar o llamar al siguiente.
app.post('/api/turnos/cerrar', (req, res) => {
  const { turno_id, ventanilla, resultado, pausar } = req.body || {};

  if (!turno_id || !ventanilla) {
    return res.status(400).json({ error: 'Faltan el identificador del turno o la ventanilla' });
  }

  if (!MOTIVOS_VALIDOS.has(resultado)) {
    return res.status(400).json({ error: 'El motivo de cierre elegido no es válido' });
  }

  try {
    const { siguienteTurno } = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = fechaLocal(ahora);

      const filaVentanilla = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!filaVentanilla) {
        throw new ErrorNegocio(404, 'Ventanilla no encontrada');
      }

      if (filaVentanilla.estado !== 'activo') {
        throw new ErrorNegocio(409, 'La ventanilla no está activa');
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
        throw new ErrorNegocio(409, 'Este turno ya no está asignado a la ventanilla');
      }

      db.prepare(`
        UPDATE turnos
        SET estado = 'cerrado',
            resultado = ?,
            hora_fin = ?
        WHERE id = ?;
      `).run(resultado, ahora, filaTurno.id);

      if (Boolean(pausar)) {
        db.prepare(`
          UPDATE ventanillas
          SET estado = 'pausa',
              segundos_activos = ?,
              ultimo_inicio_activo = NULL,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(acumularSegundosActivos(filaVentanilla, ahora), ahora, ventanilla);

        return { siguienteTurno: null };
      }

      db.prepare(`
        UPDATE ventanillas
        SET ultimo_inicio_activo = COALESCE(ultimo_inicio_activo, ?),
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(ahora, ahora, ventanilla);

      const siguiente = tomarSiguienteDeFila(
        filaVentanilla.tipo_servicio,
        ventanilla,
        ahora,
        hoy
      );
      return { siguienteTurno: siguiente };
    });

    programarTimerInactividad(ventanilla);
    notificarPantallas('turno_cerrado', siguienteTurno ? { turnoLlamado: siguienteTurno } : {});
    return res.json({ ok: true, siguienteTurno });
  } catch (error) {
    if (error instanceof ErrorNegocio) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/turnos/cerrar]', error);
    return res.status(500).json({ error: 'No se pudo cerrar el turno' });
  }
});

// Cambia una ventanilla de pausa a activa ("reanudar") o la cierra definitivamente ("cerrar").
app.post('/api/ventanillas/estado', (req, res) => {
  const { ventanilla, accion } = req.body || {};

  if (!ventanilla || (accion !== 'reanudar' && accion !== 'cerrar')) {
    return res.status(400).json({ error: 'Indique la ventanilla y una acción válida' });
  }

  try {
    const respuesta = ejecutarTransaccion(() => {
      const ahora = Date.now();
      const hoy = fechaLocal(ahora);

      const fila = db
        .prepare('SELECT * FROM ventanillas WHERE ventanilla = ?;')
        .get(ventanilla);

      if (!fila) {
        throw new ErrorNegocio(404, 'Ventanilla no encontrada');
      }

      if (accion === 'reanudar') {
        if (fila.estado !== 'pausa') {
          throw new ErrorNegocio(409, 'La ventanilla debe estar en pausa para volver a activarse');
        }

        db.prepare(`
          UPDATE ventanillas
          SET estado = 'activo',
              ultimo_inicio_activo = ?,
              ultima_actividad = ?
          WHERE ventanilla = ?;
        `).run(ahora, ahora, ventanilla);

        const siguienteTurno = tomarSiguienteDeFila(fila.tipo_servicio, ventanilla, ahora, hoy);
        return { ok: true, siguienteTurno };
      }

      if (fila.estado === 'cerrado') {
        throw new ErrorNegocio(409, 'La ventanilla ya estaba cerrada');
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
        throw new ErrorNegocio(409, 'Cierre primero el turno en atención antes de cerrar la ventanilla');
      }

      db.prepare(`
        UPDATE ventanillas
        SET estado = 'cerrado',
            segundos_activos = ?,
            ultimo_inicio_activo = NULL,
            ultima_actividad = ?
        WHERE ventanilla = ?;
      `).run(acumularSegundosActivos(fila, ahora), ahora, ventanilla);

      return { ok: true, siguienteTurno: null };
    });

    if (accion === 'reanudar') {
      programarTimerInactividad(ventanilla);
      notificarPantallas(
        'ventanilla_reanudada',
        respuesta.siguienteTurno ? { turnoLlamado: respuesta.siguienteTurno } : {}
      );
    } else {
      cancelarTimerInactividad(ventanilla);
      notificarPantallas('ventanilla_cerrada');
    }

    return res.json(respuesta);
  } catch (error) {
    if (error instanceof ErrorNegocio) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[POST /api/ventanillas/estado]', error);
    return res.status(500).json({ error: 'No se pudo cambiar el estado de la ventanilla' });
  }
});

// Permite ejecutar manualmente (o desde una tarea cron del servidor) el cierre de las 18:00.
app.post('/api/jornada/cerrar', (req, res) => {
  try {
    return res.json(cerrarJornadaDiaria(Date.now()));
  } catch (error) {
    console.error('[POST /api/jornada/cerrar]', error);
    return res.status(500).json({ error: 'No se pudo cerrar la jornada' });
  }
});

// Reinicia las ventanillas a cero desde el dashboard (y opcionalmente los turnos de prueba de hoy).
app.post('/api/jornada/reiniciar', (req, res) => {
  const { limpiarTurnosHoy } = req.body || {};

  try {
    return res.json(reiniciarJornada({ limpiarTurnosHoy: Boolean(limpiarTurnosHoy) }));
  } catch (error) {
    console.error('[POST /api/jornada/reiniciar]', error);
    return res.status(500).json({ error: 'No se pudo reiniciar la jornada' });
  }
});

// Devuelve un mensaje JSON claro si alguna petición llega con texto mal formado.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Los datos enviados no tienen un formato JSON válido' });
  }
  return next(err);
});

// --- 7. Arranque inicial ---

inicializarBaseDeDatos();
iniciarTareasProgramadas();

if (require.main === module) {
  app.listen(PUERTO, () => {
    console.log(`[Sistema de Turnos] Servidor listo en http://localhost:${PUERTO}`);
    console.log(`[Sistema de Turnos] Reloj local: ${formatearFechaHora(Date.now())}`);
  });
}

module.exports = {
  app,
  db,
  PUERTO,
  CATALOGO_VENTANILLAS,
  PREFIJOS_SERVICIO,
  MOTIVOS_VALIDOS,
  DOS_HORAS_MS,
  clientesEnVivo,
  timersInactividad,
  ejecutarTransaccion,
  inicializarBaseDeDatos,
  obtenerEstadoCompleto,
  notificarPantallas,
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

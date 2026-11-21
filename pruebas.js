/*
  pruebas.js - Script sencillo para verificar que las reglas del servidor funcionen bien

  Se ejecuta con: npm test
  Guarda una copia temporal de los datos actuales antes de probar y los restaura al terminar,
  así podemos correr las pruebas sin borrar los turnos reales que ya tengamos en turnos.db.
*/

const assert = require('node:assert');
const http = require('node:http');
const {
  app,
  db,
  DOS_HORAS_MS,
  cerrarJornadaDiaria,
  reiniciarJornada,
  cerrarVentanillaPorInactividad,
  detenerTareasProgramadas
} = require('./server.js');

// Función auxiliar para hacer peticiones HTTP rápidas al servidor de prueba
function hacerPeticion(puerto, metodo, ruta, datos = null) {
  return new Promise((resolve, reject) => {
    const cuerpo = datos ? JSON.stringify(datos) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: puerto,
        path: ruta,
        method: metodo,
        headers: cuerpo
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(cuerpo)
            }
          : {}
      },
      (res) => {
        let texto = '';
        res.on('data', (chunk) => {
          texto += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(texto) });
          } catch (_) {
            resolve({ status: res.statusCode, body: texto });
          }
        });
      }
    );
    req.on('error', reject);
    if (cuerpo) req.write(cuerpo);
    req.end();
  });
}

async function correrPruebas() {
  console.log('Iniciando pruebas del Sistema de Turnos...');

  // Respaldamos los datos actuales en memoria para dejar la base igual al terminar
  const respaldoVentanillas = db.prepare('SELECT * FROM ventanillas ORDER BY numero ASC;').all();
  const respaldoTurnos = db.prepare('SELECT * FROM turnos ORDER BY id ASC;').all();

  const servidor = app.listen(0);
  const puerto = servidor.address().port;

  try {
    // 1. Limpiamos todo para empezar desde cero
    let r = await hacerPeticion(puerto, 'POST', '/api/jornada/reiniciar', {
      limpiarTurnosHoy: true,
      eliminarTodo: true
    });
    assert.strictEqual(r.status, 200);

    // 2. Si abrimos Ventanilla 2 y Ventanilla 1 (ambas de caja), el primer turno debe irse a Ventanilla 1
    await hacerPeticion(puerto, 'POST', '/api/ventanillas/abrir', { ventanilla: 'Ventanilla 2' });
    await hacerPeticion(puerto, 'POST', '/api/ventanillas/abrir', { ventanilla: 'Ventanilla 1' });

    r = await hacerPeticion(puerto, 'POST', '/api/turnos', { tipo: 'caja' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.turno.codigo, 'C-01');
    assert.strictEqual(r.body.turno.ventanilla, 'Ventanilla 1');

    // 3. No debe dejar abrir una ventanilla que ya está abierta (409 Conflict)
    r = await hacerPeticion(puerto, 'POST', '/api/ventanillas/abrir', { ventanilla: 'Ventanilla 1' });
    assert.strictEqual(r.status, 409);

    // 4. Folios cíclicos (99 -> 01) brincando los que siguen activos (C-01 sigue en Ventanilla 1)
    await hacerPeticion(puerto, 'POST', '/api/ventanillas/estado', {
      ventanilla: 'Ventanilla 2',
      accion: 'cerrar'
    });
    const hoy = r.body.turno ? r.body.turno.fecha_jornada : new Date().toLocaleDateString('en-CA');
    const estadoHoy = (await hacerPeticion(puerto, 'GET', '/api/estado')).body.fechaJornada;

    db.prepare(`
      INSERT INTO turnos (fecha_jornada, numero_folio, codigo, tipo, estado, resultado, hora_creacion, hora_fin)
      VALUES (?, 99, 'C-99', 'caja', 'cerrado', 'atendido', ?, ?);
    `).run(estadoHoy, Date.now() - 2000, Date.now() - 1000);

    // Como C-01 sigue atendiéndose en Ventanilla 1, el que sigue después del 99 debe brincar a C-02
    r = await hacerPeticion(puerto, 'POST', '/api/turnos', { tipo: 'caja' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.turno.codigo, 'C-02');
    assert.strictEqual(r.body.turno.estado, 'espera');

    // 5. Cerrar C-01 en Ventanilla 1 debe jalar automáticamente a C-02
    const estadoAntes = (await hacerPeticion(puerto, 'GET', '/api/estado')).body;
    const turnoV1 = estadoAntes.ventanillas.find((v) => v.ventanilla === 'Ventanilla 1').turnoActual;
    r = await hacerPeticion(puerto, 'POST', '/api/turnos/cerrar', {
      turno_id: turnoV1.id,
      ventanilla: 'Ventanilla 1',
      resultado: 'atendido',
      pausar: false
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.siguienteTurno.codigo, 'C-02');

    // 6. Si una ventanilla pasa 2 horas sin actividad, se cierra y regresa su turno a espera
    const haceDosHoras = Date.now() - DOS_HORAS_MS - 5000;
    db.prepare('UPDATE ventanillas SET ultima_actividad = ? WHERE ventanilla = ?;').run(
      haceDosHoras,
      'Ventanilla 1'
    );
    cerrarVentanillaPorInactividad('Ventanilla 1');

    const estadoInactiva = (await hacerPeticion(puerto, 'GET', '/api/estado')).body;
    const v1 = estadoInactiva.ventanillas.find((v) => v.ventanilla === 'Ventanilla 1');
    assert.strictEqual(v1.estado, 'cerrado');
    assert.strictEqual(estadoInactiva.filasEspera.caja[0].codigo, 'C-02');

    // 7. El corte de las 18:00 cierra pendientes pero los separa de los motivos del cajero
    cerrarJornadaDiaria(Date.now());
    const estadoFinal = (await hacerPeticion(puerto, 'GET', '/api/estado')).body;
    assert.strictEqual(estadoFinal.metricas.enEspera, 0);
    assert.strictEqual(estadoFinal.metricas.cerradosPorCorte, 1);
    assert.strictEqual(estadoFinal.metricas.motivos.no_atendido.cantidad, 0);

    console.log('Todas las pruebas pasaron correctamente.');
  } finally {
    detenerTareasProgramadas();
    servidor.close();

    // Restauramos los datos originales que tenía turnos.db antes de correr npm test
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM turnos;').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'turnos';").run();

    const insTurno = db.prepare(`
      INSERT INTO turnos (
        id, fecha_jornada, numero_folio, codigo, tipo, estado,
        resultado, ventanilla, hora_creacion, hora_llamado, hora_fin
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const t of respaldoTurnos) {
      insTurno.run(
        t.id,
        t.fecha_jornada,
        t.numero_folio,
        t.codigo,
        t.tipo,
        t.estado,
        t.resultado,
        t.ventanilla,
        t.hora_creacion,
        t.hora_llamado,
        t.hora_fin
      );
    }

    const actVentanilla = db.prepare(`
      UPDATE ventanillas
      SET estado = ?,
          segundos_activos = ?,
          ultimo_inicio_activo = ?,
          ultima_actividad = ?
      WHERE ventanilla = ?;
    `);
    for (const v of respaldoVentanillas) {
      actVentanilla.run(
        v.estado,
        v.segundos_activos,
        v.ultimo_inicio_activo,
        v.ultima_actividad,
        v.ventanilla
      );
    }
    db.exec('COMMIT');
  }
}

correrPruebas().catch((err) => {
  console.error('Falló una prueba:', err);
  process.exit(1);
});

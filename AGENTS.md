# AGENTS.md — Sistema de Gestión de Turnos

Este documento define las reglas técnicas, arquitectónicas y operativas para el **Sistema de Gestión de Turnos** (complementando la especificación completa en `docs/SPEC.md`).

---

## 1. Principios de Arquitectura (Anti-Sobreingeniería)

* **Stack obligatorio:**
  * **Backend:** Node.js (`>= 22.13.0`) con `express` y SQLite en un solo archivo (`turnos.db`) usando el módulo nativo `node:sqlite`.
  * **Frontend:** HTML5, CSS3 y JavaScript puro (`ES6+` Vanilla).
  * **Gráficas:** `Chart.js` cargado vía CDN únicamente en `dashboard.html` (con respaldo en barras HTML si no hay salida a internet en la red LAN).
  * **Tiempo real:** `fetch()` para peticiones HTTP y `EventSource` (Server-Sent Events / SSE) en `GET /api/eventos` con latencia menor a 1 segundo.
* **Prohibiciones explícitas:**
  * **NO** usar frameworks o librerías frontend (React, Vue, Angular, Svelte, Tailwind, Bootstrap, jQuery).
  * **NO** usar bundlers ni transpiladores (Vite, Webpack, Babel, TypeScript).
  * **NO** implementar login, usuarios, contraseñas, JWT ni sesiones de autenticación.
  * **NO** agregar botón o endpoint de "volver a llamar" (rellamado) de turnos.
  * **NO** integrar SMS, WhatsApp, facturación ni notificaciones externas.

---

## 2. Estructura de Carpetas

```text
sistema-turnos/
├── AGENTS.md
├── README.md
├── docs/
│   └── SPEC.md
├── package.json
├── pruebas.js
├── server.js
├── turnos.db
└── public/
    ├── comun.js
    ├── estilos.css
    ├── kiosco.html
    ├── pantalla.html
    ├── ventanilla.html
    └── dashboard.html
```

---

## 3. Zona Horaria del Servidor, Corte Diario y Numeración Cíclica

* **Zona horaria del servidor (`America/Mazatlan`):**
  * Configurar `process.env.TZ = 'America/Mazatlan';` en la primera línea de `server.js` para usar la hora local de Sinaloa (UTC-7).
  * **Prohibido** usar `CURRENT_TIMESTAMP` o `datetime('now')` en SQLite (operan en UTC).
  * Todas las marcas de tiempo (`hora_creacion`, `hora_llamado`, `hora_fin`, `ultimo_inicio_activo`, `ultima_actividad`) se generan desde Node.js con `Date.now()`, acompañadas de `fecha_jornada` en formato local `YYYY-MM-DD`.
  * En el frontend las fechas se muestran en formato `DD/MM/YY HH:mm` (sin etiquetas de zona horaria).
* **Cierre automático diario (18:00 hrs / 6:00 PM):**
  * `server.js` ejecuta el cierre diario automáticamente a las `18:00` hrs (y expone `POST /api/jornada/cerrar` para ejecución manual).
  * Al alcanzar las `18:00` hrs hora local:
    1. Pasa todas las ventanillas en estado `activo` o `pausa` a estado `cerrado`, consolidando sus `segundos_activos`.
    2. Cierra cualquier turno residual que haya quedado en `espera` o `atendiendo` en la jornada (`estado = 'cerrado'`, `resultado = 'no_atendido'`, `hora_fin` actual). Los turnos cerrados por corte que nunca fueron llamados (`hora_llamado IS NULL`) se reportan en `metricas.cerradosPorCorte` sin distorsionar los porcentajes de motivos de los cajeros.
    3. Emite actualización por SSE.
  * **Saneamiento al arranque:** Al iniciar `server.js`, verifica y cierra cualquier ventanilla o turno abierto cuya jornada sea anterior a la fecha local actual o previo al corte de las 18:00.
* **Numeración cíclica de turnos (`01` al `99`):**
  * Prefijos por servicio: `caja` → `C`, `ejecutivo` → `E`, `atencion` → `A`.
  * Formato de código: dos dígitos con cero a la izquierda (`C-01` hasta `C-99`).
  * Al llegar al `99` dentro de la misma `fecha_jornada`, el siguiente turno reinicia en `01` (`(ultimoFolio % 99) + 1`), saltando cualquier folio que siga activo en `espera` o `atendiendo` para evitar códigos duplicados en pantalla.

---

## 4. Esquema de Base de Datos SQLite (`turnos.db`)

Activar `PRAGMA journal_mode = WAL;` y `PRAGMA busy_timeout = 5000;` al conectar. Toda operación de escritura múltiple se envuelve en transacciones atómicas (`BEGIN IMMEDIATE ... COMMIT`).

### Tabla `ventanillas`
```sql
CREATE TABLE IF NOT EXISTS ventanillas (
  numero INTEGER UNIQUE NOT NULL,
  ventanilla TEXT PRIMARY KEY,
  tipo_servicio TEXT NOT NULL CHECK (tipo_servicio IN ('caja', 'ejecutivo', 'atencion')),
  estado TEXT NOT NULL DEFAULT 'cerrado' CHECK (estado IN ('activo', 'pausa', 'cerrado')),
  segundos_activos INTEGER NOT NULL DEFAULT 0,
  ultimo_inicio_activo INTEGER,
  ultima_actividad INTEGER
);
```

**Seed obligatorio (7 ventanillas fijas en orden numérico):**
1. `numero: 1`, `ventanilla: 'Ventanilla 1'`, `tipo_servicio: 'caja'`
2. `numero: 2`, `ventanilla: 'Ventanilla 2'`, `tipo_servicio: 'caja'`
3. `numero: 3`, `ventanilla: 'Ventanilla 3'`, `tipo_servicio: 'caja'`
4. `numero: 4`, `ventanilla: 'Ventanilla 4'`, `tipo_servicio: 'caja'`
5. `numero: 5`, `ventanilla: 'Ventanilla 5'`, `tipo_servicio: 'ejecutivo'`
6. `numero: 6`, `ventanilla: 'Ventanilla 6'`, `tipo_servicio: 'ejecutivo'`
7. `numero: 7`, `ventanilla: 'Ventanilla 7'`, `tipo_servicio: 'atencion'`

### Tabla `turnos`
```sql
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
```

---

## 5. Reglas de Negocio

1. **Bloqueo de ventanilla duplicada:**
   * Al recibir `POST /api/ventanillas/abrir`, validar que `estado === 'cerrado'`. Si la ventanilla está en `activo` o `pausa`, responder `HTTP 409 Conflict` con `{ error: "La ventanilla ya está en uso" }`.
2. **Auto-cierre por inactividad (2 horas / 7,200 segundos):**
   * Actualizar `ultima_actividad` cada vez que una ventanilla se abre, llama turno, cierra turno o vuelve de pausa.
   * Cerrar automáticamente cualquier ventanilla en estado `activo` o `pausa` cuya `ultima_actividad` supere los 120 minutos, acumulando sus `segundos_activos`, devolviendo a `espera` cualquier turno que tuviera en `atendiendo` y notificando por SSE.
3. **Cola vacía y despacho automático por orden numérico:**
   * Si al abrir una ventanilla o al cerrar un turno con `pausar: false` no existen turnos en `espera` de su servicio, la ventanilla permanece en `estado = 'activo'`.
   * Cuando `POST /api/turnos` crea un nuevo turno, busca si existe una ventanilla con `tipo_servicio = tipo`, `estado = 'activo'` y sin turno en `atendiendo`, seleccionando la de menor `numero` (`ORDER BY numero ASC LIMIT 1`). Si existe, asigna el turno de inmediato.
4. **Cálculo de tiempo estimado de espera:**
   * Si existen menos de 3 turnos cerrados como `atendido` en el día para ese servicio, devolver `"5 min"`.
   * Con 3 o más turnos atendidos, tomar los últimos 20 turnos atendidos del día para ese servicio y considerar tanto el promedio de espera como la fila actual (`(enEspera / max(1, ventanillasActivas)) * promedioAtencion`).
5. **Cálculo de tiempo activo por ventanilla:**
   * `segundos_activos + (estado === 'activo' ? diferenciaEnSegundos(ahora, ultimo_inicio_activo) : 0)`.

---

## 6. Contrato de Endpoints (`API REST + SSE`)

* **`POST /api/turnos`** — Genera folio cíclico (`01`–`99`), auto-asigna si hay ventanilla libre del servicio (`ORDER BY numero ASC`), emite SSE y responde `201` con `{ turno }`.
* **`POST /api/ventanillas/abrir`** — Valida que esté `cerrado` (`409` si está en uso), pasa a `activo`, asigna el turno más antiguo en `espera` si existe, emite SSE y responde `{ ventanilla, turnoActual }`.
* **`POST /api/ventanillas/llamar`** — Si la ventanilla está `activo` y libre, desencola el turno más antiguo en `espera` de su servicio, emite SSE y responde `{ turno }`.
* **`POST /api/turnos/cerrar`** — Valida `resultado` (`atendido`, `no_atendido`, `no_aparecio`, `turno_equivocado`). Marca el turno como `cerrado` con `hora_fin`. Si `pausar === true`, acumula `segundos_activos` y pasa a `pausa`. Si `pausar === false`, desencola el siguiente turno en `espera` si existe. Emite SSE y responde `{ ok: true, siguienteTurno }`.
* **`POST /api/ventanillas/estado`** — Recibe `{ ventanilla, accion: "reanudar" | "cerrar" }`, actualiza el estado de la ventanilla, emite SSE y responde `{ ok: true }`.
* **`POST /api/jornada/cerrar`** — Ejecuta el corte diario de las 18:00 hrs.
* **`POST /api/jornada/reiniciar`** — Recibe `{ limpiarTurnosHoy, eliminarTodo }`, reinicia ventanillas a cero y opcionalmente limpia los turnos del día o elimina todos los registros de `turnos`.
* **`GET /api/estado`** — Retorna el resumen completo del día (`ventanillas`, `turnosAtendiendo`, `filasEspera`, `proximosEspera`, `tiemposEstimados` y `metricas`).
* **`GET /api/eventos`** — Canal SSE con heartbeat cada 25 segundos.

---

## 7. Reglas de Interfaz y Hardware

* **`kiosco.html` + Impresión térmica Epson 58 mm (`estilos.css`):**
  * Botones grandes para `Caja`, `Ejecutivo` y `Atención a Cliente`.
  * Al recibir respuesta de `POST /api/turnos`, rellena `#ticket-impresion`, llama a `window.print()` y regresa automáticamente a la pantalla principal tras `SEGUNDOS_REGRESO` (`3` segundos).
  * Regla `@media print`: ocultar todo el `body` excepto `#ticket-impresion`, configurar `@page { size: 58mm auto; margin: 0; }` y ancho útil de `48mm` en blanco y negro.
* **`pantalla.html` (Sala de Espera):**
  * Muestra turno(s) llamado(s) con su ventanilla, próximos turnos en espera y tiempo estimado por servicio.
  * Audio de notificación generado con **Web Audio API** al recibir un nuevo llamado por SSE (diseñado para Chrome con `--autoplay-policy=no-user-gesture-required`).
* **`ventanilla.html`:**
  * Persiste la ventanilla seleccionada en `localStorage` y recupera su estado al recargar consultando `GET /api/estado`.
* **`dashboard.html`:**
  * Muestra promedios de espera y atención, gráficas por hora y motivos de cierre (con respaldo offline), tabla de rendimiento por ventanilla y botones para reiniciar jornada o eliminar todos los datos.

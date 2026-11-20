# AGENTS.md — Sistema de Gestión de Turnos

Este documento define las reglas técnicas, arquitectónicas y operativas obligatorias para el desarrollo del **Sistema de Gestión de Turnos** (complementando la especificación funcional completa en `docs/SPEC.md`). Todo agente o colaborador debe cumplir estrictamente estas especificaciones sin introducir dependencias ni funcionalidades fuera de alcance.

---

## 1. Principios de Arquitectura (Anti-Sobreingeniería)

* **Stack obligatorio:**
  * **Backend:** Node.js (v18 o superior) con `express` y SQLite en un solo archivo (`turnos.db`) usando `better-sqlite3` (o módulo nativo `node:sqlite`).
  * **Frontend:** HTML5, CSS3 y JavaScript puro (`ES6+` Vanilla).
  * **Gráficas:** `Chart.js` cargado vía CDN únicamente en `dashboard.html` (con manejo seguro si no hay salida a internet en la red LAN).
  * **Tiempo real:** `fetch()` para peticiones HTTP y `EventSource` (Server-Sent Events / SSE) en `GET /api/eventos` con latencia menor a 1 segundo.
* **Prohibiciones explícitas:**
  * **NO** usar frameworks o librerías frontend (React, Vue, Angular, Svelte, Tailwind, Bootstrap, jQuery).
  * **NO** usar bundlers ni transpiladores (Vite, Webpack, Babel, TypeScript).
  * **NO** implementar login, usuarios, contraseñas, JWT ni sesiones de autenticación.
  * **NO** agregar botón o endpoint de "volver a llamar" (rellamado) de turnos.
  * **NO** integrar SMS, WhatsApp, facturación ni notificaciones externas.

---

## 2. Estructura Exacta de Carpetas

```text
sistema-turnos/
├── AGENTS.md
├── docs/
│   └── SPEC.md
├── package.json
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
  * Configurar `process.env.TZ = 'America/Mazatlan';` en la primera línea de `server.js` para que el reloj del proceso use la hora local correcta.
  * **Prohibido** usar `CURRENT_TIMESTAMP` o `datetime('now')` en SQLite (operan en UTC).
  * Todas las marcas de tiempo (`hora_creacion`, `hora_llamado`, `hora_fin`, `ultimo_inicio_activo`, `ultima_actividad`) se generan desde Node.js con `Date.now()` (milisegundos del reloj del servidor), acompañadas de `fecha_jornada` en formato local `YYYY-MM-DD` para filtrar/agrupar la jornada.
  * En el frontend las fechas se muestran en formato `DD/MM/YY` (sin mostrar zonas horarias ni `GMT -7`), tomando la fecha y hora enviadas por el servidor.
* **Cierre automático diario (18:00 hrs / 6:00 PM):**
  * `server.js` ejecutará el cierre diario automáticamente a las `18:00` hrs (y expondrá endpoint reutilizable para ejecución manual/cron).
  * Al alcanzar las `18:00` hrs hora local del servidor:
    1. Pasa todas las ventanillas en estado `activo` o `pausa` a estado `cerrado`, consolidando sus `segundos_activos`.
    2. Cierra cualquier turno residual que haya quedado en `espera` o `atendiendo` en la jornada (`estado = 'cerrado'`, `resultado = 'no_atendido'`, `hora_fin` actual).
    3. Emite actualización por SSE.
  * **Saneamiento al arranque:** Al iniciar `server.js`, debe verificar y cerrar cualquier ventanilla o turno abierto cuya jornada sea anterior a la fecha local actual.
* **Numeración cíclica de turnos (`01` al `99`):**
  * Prefijos por servicio: `caja` → `C`, `ejecutivo` → `E`, `atencion` → `A`.
  * Formato de código: dos dígitos con cero a la izquierda (`C-01` hasta `C-99`).
  * Al llegar al `99` dentro de la misma `fecha_jornada`, el siguiente turno reinicia en `01` (`C-99` → `C-01`), calculando `siguienteFolio = (ultimoFolio % 99) + 1` según el último registro insertado para ese servicio en el día.

---

## 4. Esquema de Base de Datos SQLite (`turnos.db`)

Activar `PRAGMA journal_mode = WAL;` y `PRAGMA busy_timeout = 5000;` al conectar. Toda operación de lectura-escritura crítica debe envolverse en transacciones atómicas (`BEGIN IMMEDIATE ... COMMIT`).

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

## 5. Reglas de Negocio y Concurrencia

1. **Bloqueo de ventanilla duplicada:**
   * Al recibir `POST /api/ventanillas/abrir`, validar atómicamente que `estado === 'cerrado'`. Si la ventanilla está en `activo` o `pausa`, responder `HTTP 409 Conflict` con `{ error: "La ventanilla ya está en uso" }`.
2. **Auto-cierre por inactividad (2 horas / 7,200 segundos):**
   * Actualizar `ultima_actividad` cada vez que una ventanilla se abre, llama turno, cierra turno o vuelve de pausa.
   * El verificador periódico de `server.js` cerrará automáticamente cualquier ventanilla en estado `activo` o `pausa` cuya `ultima_actividad` supere los 120 minutos, acumulando sus `segundos_activos` (si estaba en `activo`), devolviendo a `espera` cualquier turno que tuviera en `atendiendo` y notificando por SSE.
3. **Cola vacía y despacho automático por orden numérico:**
   * Si al abrir una ventanilla o al cerrar un turno con `pausar: false` no existen turnos en `espera` de su servicio, la ventanilla permanece en `estado = 'activo'` (libre en espera de cliente).
   * Cuando `POST /api/turnos` crea un nuevo turno, dentro de la misma transacción `BEGIN IMMEDIATE`, el servidor busca si existe una ventanilla con `tipo_servicio = tipo`, `estado = 'activo'` y sin ningún turno actualmente en `estado = 'atendiendo'`, seleccionando la de menor `numero` (`ORDER BY numero ASC LIMIT 1`). Si existe, asigna el turno de inmediato (`estado = 'atendiendo'`, `ventanilla`, `hora_llamado = hora_creacion`).
4. **Cálculo de tiempo estimado de espera:**
   * Por cada servicio (`caja`, `ejecutivo`, `atencion`), calcular el promedio de `(hora_llamado - hora_creacion)` de los últimos 20 turnos de `fecha_jornada` con `estado = 'cerrado'` y `resultado = 'atendido'`.
   * Si existen menos de 3 turnos cerrados como `atendido` en el día para ese servicio, devolver `"5 min"`.
5. **Cálculo de tiempo activo por ventanilla:**
   * `segundos_activos + (estado === 'activo' ? diferenciaEnSegundos(ahora, ultimo_inicio_activo) : 0)`.

---

## 6. Contrato de Endpoints (`API REST + SSE`)

* **`POST /api/turnos`**
  * **Body:** `{ "tipo": "caja" | "ejecutivo" | "atencion" }`
  * **Acción:** Genera folio cíclico (`01`–`99`), auto-asigna si hay ventanilla libre del servicio (`ORDER BY numero ASC`), emite evento SSE y responde `201` con `{ turno }`.
* **`POST /api/ventanillas/abrir`**
  * **Body:** `{ "ventanilla": "Ventanilla 1" }`
  * **Acción:** Valida que esté `cerrado` (`409` si ya está abierta/pausada), cambia a `activo`, registra `ultimo_inicio_activo` y `ultima_actividad`, asigna automáticamente el turno más antiguo en `espera` (`ORDER BY id ASC`) si existe, emite SSE y responde `{ ventanilla, turnoActual }`.
* **`POST /api/ventanillas/llamar`**
  * **Body:** `{ "ventanilla": "Ventanilla 1" }`
  * **Acción:** Si la ventanilla está `activo` y sin turno en curso, desencola el turno más antiguo en `espera` de su `tipo_servicio`, lo pasa a `atendiendo`, actualiza `ultima_actividad`, emite SSE y responde `{ turno }`.
* **`POST /api/turnos/cerrar`**
  * **Body:** `{ "turno_id": 1, "ventanilla": "Ventanilla 1", "resultado": "atendido", "pausar": false }`
  * **Acción:** Valida `resultado` (`atendido`, `no_atendido`, `no_aparecio`, `turno_equivocado`). Marca el turno como `cerrado` con `hora_fin`. Si `pausar === true`, acumula `segundos_activos` y pasa la ventanilla a `pausa`. Si `pausar === false`, mantiene `activo` y desencola automáticamente el siguiente turno en `espera` si existe. Actualiza `ultima_actividad`, emite SSE y responde `{ ok: true, siguienteTurno }`.
* **`POST /api/ventanillas/estado`**
  * **Body:** `{ "ventanilla": "Ventanilla 1", "accion": "reanudar" | "cerrar" }`
  * **Acción:**
    * `reanudar`: pasa de `pausa` a `activo`, registra `ultimo_inicio_activo` y `ultima_actividad`, y asigna el siguiente turno en `espera` si existe.
    * `cerrar`: consolida `segundos_activos` (si estaba en `activo`), limpia `ultimo_inicio_activo` y pasa a `cerrado`.
    * Emite SSE y responde `{ ok: true }`.
* **`GET /api/estado`**
  * **Acción:** Retorna JSON completo de `fecha_jornada` con: `ventanillas` (incluyendo su `turnoActual` si está en `atendiendo`), `turnosAtendiendo`, `filasEspera` por servicio, `tiemposEstimados` por servicio y `metricas` del día (tiempo promedio espera, tiempo promedio atención, clientes atendidos por hora, desglose de motivos y rendimiento por ventanilla).
* **`GET /api/eventos`**
  * **Acción:** Endpoint SSE (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) con heartbeat cada 25 segundos que notifica a todas las vistas conectadas ante cualquier mutación.

---

## 7. Reglas de Interfaz y Hardware

* **`kiosco.html` + Impresión térmica Epson 58 mm (`estilos.css`):**
  * Botones táctiles grandes para `Caja`, `Ejecutivo` y `Atención a Cliente`.
  * Al recibir respuesta de `POST /api/turnos`, rellena el contenedor `#ticket-impresion`, llama a `window.print()` y regresa automáticamente a la pantalla principal tras 3 segundos.
  * Regla `@media print`: ocultar todo el `body` excepto `#ticket-impresion`, configurar `@page { size: 58mm auto; margin: 0; }` y ancho útil de `48mm`. El ticket impreso debe mostrar **exclusivamente** el código de turno (ej. `C-01`) en tipografía grande en negrita y la fecha/hora de impresión (`DD/MM/YY HH:mm`).
* **`pantalla.html` (Sala de Espera sin teclado ni mouse):**
  * Tipografía de alto contraste legible a distancia: turno(s) llamado(s) con su ventanilla, lista de próximos turnos en espera y tiempo estimado por servicio.
  * Audio de notificación generado mediante **Web Audio API** (`AudioContext` con timbre sintetizado) al detectar un nuevo turno llamado por SSE, diseñado para operar en navegador lanzado con `--autoplay-policy=no-user-gesture-required` sin requerir clics previos.
* **`ventanilla.html` (Recuperación de sesión tras recarga):**
  * Persistir el nombre de la ventanilla seleccionada en `localStorage`.
  * Al cargar/recargar la página, consultar `GET /api/estado`: si esa ventanilla sigue en `activo` o `pausa` en el servidor, restaurar automáticamente su panel operativo, contador de tiempo activo y el turno que tenga en `atendiendo` con los controles de cierre. Si en el servidor aparece como `cerrado` (por cierre manual, corte de las 18:00 hrs o timeout de 2 horas), limpiar `localStorage` y mostrar el selector de las 7 ventanillas (bloqueando visualmente las que ya estén ocupadas).
* **`dashboard.html`:**
  * Mostrar tiempo promedio de espera, tiempo promedio de atención, gráfica de clientes atendidos por hora, gráfica/porcentajes de los 4 motivos de cierre y tabla de rendimiento por ventanilla (turnos cerrados y tiempo activo neto).

---

## 8. Modo Pair Programming y Estándar de Comentarios

* **Entrega incremental (un bloque/archivo por turno):** Nunca generes todos los archivos de golpe. Escribe o modifica **un solo archivo (o sección lógica de `server.js`) por turno** y detente para que el desarrollador revise línea por línea en el Review Pane y apruebe antes de continuar con el siguiente paso.
* **Orden estricto de construcción:**
  1. `package.json` + inicialización de `server.js` (zona horaria `America/Mazatlan`, conexión SQLite WAL, creación de tablas y seed de las 7 ventanillas).
  2. Rutas REST y canal SSE en `server.js` (transacciones atómicas, folio cíclico 01–99 y despacho por orden numérico).
  3. Tareas programadas en `server.js` (cierre diario a las 18:00 hrs, saneamiento al arranque y auto-cierre por inactividad de 2 horas).
  4. `public/estilos.css` (variables, diseño responsivo y reglas `@media print` para ticket térmico de 58 mm).
  5. `public/kiosco.html`
  6. `public/ventanilla.html`
  7. `public/pantalla.html`
  8. `public/dashboard.html`
* **Comentarios exhaustivos y didácticos en español:** Todo el código debe estar detalladamente comentado en español para facilitar la auditoría línea por línea:
  * **Cabecera por archivo:** Propósito general del archivo y dependencias con otros módulos.
  * **Bloques y funciones:** Comentario descriptivo antes de cada función, ruta Express, transacción SQL o temporizador explicando qué hace, qué parámetros espera y qué regla del documento cumple.
  * **Comentarios en línea:** Explicar el porqué de cada validación, cálculo de fechas y tiempos, manejo de `localStorage`, eventos `EventSource` (SSE) y síntesis de audio.

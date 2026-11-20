# **Definición de Proyecto: Sistema de Gestión de Turnos**

# **1\. Definición del proyecto**

El **Sistema de Gestión de Turnos** es una aplicación web ligera diseñada para organizar el flujo de atención a clientes dentro de un comercio bajo el principio FIFO (primero en entrar, primero en salir). Conecta cuatro interfaces web independientes —terminal impresora de turnos, pantalla pública de espera, panel de ventanilla y dashboard estadístico en tiempo real— desarrolladas con HTML5, CSS3 y JavaScript puro, respaldadas por un servidor en Node.js con Express y SQLite.

# **2\. Descripción del proyecto**

* **Problemática actual:** Las filas físicas sin control generan desorden, incertidumbre sobre el tiempo de espera, distribución desigual de trabajo entre ventanillas y ausencia de métricas sobre la velocidad y calidad de atención.  
* **Solución tecnológica propuesta:** Una aplicación web centralizada en un solo servidor (`server.js`) con API REST en Node.js (Express), base de datos local SQLite en modo WAL (`turnos.db`) y notificaciones en tiempo real mediante Server-Sent Events (SSE). El sistema asigna turnos por tipo de servicio, notifica en vivo el llamado a ventanilla y registra los eventos del día para calcular tiempos de espera y estadísticas al instante.

# **3\. Justificación**

Implementar una arquitectura ligera y sin sobreingeniería permite resolver el control de filas de forma económica, confiable y fácil de mantener, evitando dependencias complejas o licencias externas.

## **Beneficios y ventajas que se lograrán**

* Atención ordenada bajo el esquema FIFO y segmentada según el servicio requerido por el cliente.  
* Actualización automática de todas las pantallas en tiempo real sin necesidad de recargar el navegador.  
* Apertura rápida de ventanillas sin gestión compleja de cuentas ni contraseñas, con control de pausas operativas.  
* Visibilidad inmediata del desempeño operativo, tiempos promedio y carga de trabajo durante toda la jornada.

## **Problemas que resolverá**

* Confusiones en la fila, demoras innecesarias e incertidumbre de los clientes respecto a su turno.  
* Pérdida de trazabilidad cuando un cliente toma un turno equivocado o abandona la fila antes de ser atendido.  
* Falta de indicadores reales sobre tiempos de espera, duración de atención, horas pico y tiempo activo por ventanilla.

# **4\. Objetivos (General y Específicos)**

* **Objetivo general:** Desarrollar un sistema web eficiente y en tiempo real para administrar la cola de clientes, coordinar la atención en ventanillas y visualizar métricas operativas diarias en un comercio.  
* **Objetivos específicos:**  
  * Desarrollar cuatro vistas web ligeras y responsivas en HTML, CSS y JavaScript unificadas en un tema oscuro azulado adaptable a pantallas horizontales, verticales y celulares.  
  * Implementar una API REST en Node.js con Express y base de datos SQLite para gestionar los turnos por tipo de servicio (Caja, Ejecutivo y Atención a Cliente).  
  * Permitir que cada operador active su ventanilla con un solo clic, atienda turnos, cierre con un solo toque llamando al siguiente cliente o gestione pausas con motivo obligatorio.  
  * Calcular automáticamente el tiempo estimado de espera a partir de los últimos 20 turnos atendidos y desplegar las estadísticas del día en tiempo real.

# **5\. Actores o roles del sistema**

* **Cliente:** Selecciona el servicio deseado en la terminal de entrada, recoge su ticket impreso, consulta el tiempo estimado en la pantalla pública y acude a la ventanilla asignada.  
* **Cajero / Ejecutivo / Asesor:** Selecciona su ventanilla al iniciar turno, atiende al cliente llamado, finaliza cada atención eligiendo uno de los 4 motivos (llamando de inmediato al siguiente o pausando) y controla su pausa o cierre.  
* **Supervisor / Encargado:** Monitorea el dashboard en tiempo real para evaluar tiempos de espera, duración de atención, clientes atendidos por hora y tiempo activo de cada ventanilla, pudiendo también reiniciar la jornada o las pruebas del día.

# **6\. Alcance y limitaciones**

| Dimensión | Detalles del Proyecto |
| :---- | :---- |
| **Alcance (lo que sí hará)** | Portal raíz `/` de acceso rápido; emisión e impresión térmica 58 mm de turnos por servicio (Caja, Ejecutivo, Atención a Cliente) con numeración cíclica `01`–`99`; pantalla pública con llamado destacado, hasta 7 ventanillas simultáneas, próximos turnos y tiempo estimado de espera; panel de ventanilla con selección rápida y bloqueo por uso, 4 botones directos de cierre y llamado al siguiente, modal para "Cerrar y pausar...", reanudación y cierre; sincronización en tiempo real mediante SSE; cierre diario automatizado a las 18:00 y dashboard con métricas, gráficas y reinicio de jornada. |
| **Limitaciones (lo que no hará)** | No incluirá autenticación con usuarios y contraseñas; no tendrá función ni botón de rellamado de turnos; no realizará cobros ni facturación; no enviará notificaciones por SMS o WhatsApp; no contará con aplicaciones móviles nativas; y operará en red local sobre un único servidor. |

# **7\. Funcionalidades básicas**

* **Portal de acceso (`/`):** Página inicial servida desde `server.js` con enlaces directos a las cuatro interfaces del sistema.  
* **Terminal de turnos (`kiosco.html`):** Permite elegir entre Caja, Ejecutivo o Atención a Cliente, genera el código secuencial cíclico del día (`C-01`, `E-01`, `A-01`), imprime el ticket en formato térmico de 58 mm y vuelve a la vista inicial tras 3 segundos.  
* **Pantalla pública de espera (`pantalla.html`):** Muestra en formato legible a distancia los turnos actualmente llamados con su ventanilla (destacando el más reciente), los próximos en espera, el tiempo estimado por servicio y emite un timbre sintetizado en el navegador al llamar un turno nuevo.  
* **Panel de ventanilla (`ventanilla.html`):** Permite seleccionar una de las 7 ventanillas (bloqueando las ya ocupadas), recupera sesión y turno en curso al recargar mediante `localStorage`, dispone de 4 botones grandes de cierre directo con llamado automático al siguiente (`Atendido`, `No atendido`, `No apareció`, `Turno equivocado`), opción `"Cerrar y pausar..."` con selección de motivo en modal, y controles para `"Llamar siguiente"`, `"Volver de pausa"` y `"Cerrar ventanilla"`.  
* **Dashboard en tiempo real (`dashboard.html`):** Presenta indicadores acumulados del día (espera promedio, atención promedio, emitidos, en espera/atendiendo, cerrados), gráfica de clientes atendidos por hora, gráfica y tabla de los 4 motivos de cierre, tabla de rendimiento por ventanilla con cronómetro vivo y botón `"Reiniciar"` en el encabezado.

# **8\. Productos y resultados a obtener (entregables)**

* **Documentación:** Definición del proyecto y especificación técnica (`docs/SPEC.md`) junto con reglas de arquitectura y operación (`AGENTS.md`).  
* **Software:** Código fuente funcional del frontend (HTML5, CSS3 y JavaScript puro reutilizando `public/comun.js`), servidor backend en Node.js con Express (`server.js`), base de datos SQLite (`turnos.db`) y operación autónoma en entorno local.  
* **Resultados esperados:** Control estricto de turnos sin duplicados, sincronización de pantallas en menos de un segundo, estimación precisa del tiempo de espera, diseño unificado oscuro azulado adaptable a cualquier tamaño de pantalla y código limpio, modular y libre de sobreingeniería.

---

# **9\. Requerimientos del cliente (Necesidades del negocio)**

* Contar con una terminal autoservicio en la entrada donde el cliente elija entre Caja, Ejecutivo o Atención a Cliente e imprima su ticket físico.  
* Disponer de una pantalla en sala de espera que muestre el turno actual, los siguientes en fila y un tiempo estimado de espera realista basado en el comportamiento reciente de la fila.  
* Evitar sistemas complejos de inicio de sesión o gestión de cuentas para el personal; cada empleado solo debe seleccionar su número de ventanilla al comenzar, y esa selección determinará el tipo de servicio que atiende.  
* Agilizar la operación en mostrador cerrando un turno y llamando inmediatamente al siguiente con un solo toque en el motivo de cierre, manteniendo además la opción de pausar la atención cuando sea necesario y reanudar o cerrar la ventanilla en cualquier momento.  
* Registrar obligatoriamente el desenlace de cada turno (`Atendido`, `No atendido`, `No apareció` o `Turno equivocado`).  
* Visualizar en un dashboard en tiempo real el rendimiento diario del comercio: tiempos de espera y atención, clientes atendidos por hora, tiempo activo de cada ventanilla y distribución de resultados, además de reiniciar el estado cuando se realicen pruebas.

# **10\. Requisitos Funcionales (RF)**

## **Módulo Kiosco (`kiosco.html`)**

* **RF-01 Selección de servicio:** Permitir al cliente elegir entre tres tipos de trámite: Caja, Ejecutivo o Atención a Cliente.  
* **RF-02 Generación secuencial cíclica de turnos:** Asignar un código diario con prefijo por servicio (`C-01`–`C-99`, `E-01`–`E-99`, `A-01`–`A-99`) reiniciando en `01` tras el `99` y respetando estrictamente el orden de llegada (FIFO).  
* **RF-03 Impresión de ticket:** Mostrar confirmación en pantalla con número de turno, servicio y fecha/hora, garantizar el pintado previo y disparar el diálogo de impresión para rollo térmico de 58 mm regresando al inicio tras 3 segundos.

## **Módulo Pantalla Pública (`pantalla.html`)**

* **RF-04 Visualización de llamados activos:** Mostrar de forma destacada el último turno llamado con su ventanilla (con pulso visual sutil en novedades) y acomodar simultáneamente los demás llamados en atención de hasta 7 ventanillas sin requerir scroll.  
* **RF-05 Lista de turnos siguientes:** Desplegar hasta los próximos 10 turnos en espera ordenados cronológicamente por llegada (indicando si existen turnos adicionales en cola).  
* **RF-06 Tiempo estimado de espera:** Mostrar el tiempo aproximado de espera por cada servicio, calculado a partir del promedio real de espera de los últimos 20 turnos atendidos (`"5 min"` cuando hay menos de 3 muestras).

## **Módulo Panel de Ventanilla (`ventanilla.html`)**

* **RF-07 Apertura de ventanilla por selección única:** Permitir iniciar la operación seleccionando únicamente una de las 7 ventanillas (que define automáticamente su servicio `caja`, `ejecutivo` o `atencion`), bloqueando las ya ocupadas (`HTTP 409`) sin usuarios ni contraseñas.  
* **RF-08 Llamado y auto-asignación FIFO:** Desencolar automáticamente al abrir, reanudar o cerrar turno (o manualmente con `"Llamar siguiente"` si la ventanilla quedó libre con fila disponible) el turno más antiguo en espera de su servicio.  
* **RF-09 Cierre directo con motivo obligatorio:** Presentar los cuatro resultados (`Atendido`, `No atendido`, `No apareció`, `Turno equivocado`) como botones grandes de acción directa que cierran el turno actual y llaman de inmediato al siguiente cliente disponible.  
* **RF-10 Control de pausas y cierre de módulo:** Disponer del botón `"Cerrar y pausar..."` (que solicita el motivo de cierre mediante ventana modal antes de pasar la ventanilla a `pausa` y detener el contador activo), además de `"Volver de pausa"` y `"Cerrar ventanilla"`.

## **Módulo Dashboard en Tiempo Real (`dashboard.html`)**

* **RF-11 Indicadores de tiempos y totales:** Mostrar tiempo promedio de espera, tiempo promedio de atención, turnos emitidos hoy, turnos en espera / en atención y total de turnos cerrados.  
* **RF-12 Productividad por hora y motivos:** Mostrar una serie horaria continua desde la primera hasta la última atención del día (incluyendo horas intermedias en cero) y el conteo y porcentaje exacto de los 4 motivos de cierre, ocultando las gráficas cuando existan 0 registros y degradando a barras HTML locales si Chart.js no está accesible.  
* **RF-13 Rendimiento por ventanilla y reinicio:** Mostrar por cada una de las 7 ventanillas sus turnos cerrados, atendidos y tiempo total activo neto (descontando pausas, incrementado en vivo cada segundo cuando está activa), además de un botón `"Reiniciar"` en el encabezado para restablecer únicamente ventanillas o reiniciar también los turnos de prueba del día actual.

## **Núcleo y Sincronización**

* **RF-14 Actualización en vivo:** Reflejar cualquier cambio (nuevo turno, llamado, cierre, pausa, apertura o reinicio) en todas las pantallas abiertas en menos de 1 segundo mediante Server-Sent Events (`/api/eventos`).  
* **RF-15 Reinicio lógico diario y saneamiento:** Filtrar folios y métricas por `fecha_jornada` local (`YYYY-MM-DD`) conservando el historial de días previos en SQLite, ejecutar el cierre diario automático a las 18:00 hrs, preparar ventanillas en cero a medianoche (`00:00`) y sanear sesiones atrasadas al arrancar el servidor.

# **11\. Requisitos No Funcionales (RNF)**

* **RNF-01 Latencia en tiempo real:** Las notificaciones hacia la pantalla pública, ventanillas y dashboard se reflejan en menos de 1 segundo mediante Server-Sent Events (SSE) con heartbeat cada 25 segundos.  
* **RNF-02 Integridad ante concurrencia:** Dos ventanillas o dos peticiones simultáneas no pueden abrir el mismo módulo ni tomar el mismo turno gracias a transacciones atómicas `BEGIN IMMEDIATE` en SQLite con `busy_timeout = 5000`.  
* **RNF-03 Persistencia ante fallos:** Ante un reinicio del servidor o recarga del navegador, los turnos permanecen en SQLite y `ventanilla.html` recupera automáticamente su ventanilla y turno activo vía `localStorage` + `GET /api/estado` (o limpia `localStorage` si fue cerrada en servidor).  
* **RNF-04 Usabilidad, tema oscuro unificado y diseño responsivo:** Todas las vistas comparten un esquema visual **oscuro azulado** (`color-scheme: dark`) de alto contraste WCAG AA, con áreas táctiles mínimas accesibles (`44–48 px`) y rejillas adaptables a monitores horizontales, pantallas verticales (`orientation: portrait`) y teléfonos celulares desde `320 px` sin desbordamiento horizontal.  
* **RNF-05 Simplicidad y mantenibilidad:** Arquitectura monolítica ligera sin frameworks frontend, sin bundlers ni transpiladores, con utilidades compartidas en `public/comun.js` y código comentado de forma clara en español.  
* **RNF-06 Operación en red local:** Funcionamiento autónomo dentro de la red LAN/Wi-Fi del comercio sin requerir conexión a internet (incluyendo respaldo visual offline para las gráficas de `dashboard.html`).

# **12\. Requerimientos técnicos y de entorno**

* **Backend:** Node.js (`>= 22.13.0`) con `express` para la API REST y SQLite en un solo archivo (`turnos.db`) usando el módulo nativo `node:sqlite` (`DatabaseSync`).  
* **Frontend:** Páginas independientes en HTML5, CSS3 compartido (`public/estilos.css`) y JavaScript puro (`ES6+` Vanilla) apoyado en `public/comun.js`, utilizando `fetch()` para peticiones y `EventSource` para tiempo real.  
* **Herramientas complementarias ligeras:** Chart.js (`v4.4.7` vía CDN, cargado de forma asíncrona con `onload`/`onerror`) únicamente en `dashboard.html`, con respaldo automático mediante barras HTML/CSS si no hay salida a internet en la red LAN.  
* **Hardware requerido:** Un equipo servidor local para ejecutar Node.js (puerto por defecto `4782`, configurable vía `PORT`), una terminal/tableta con impresora térmica de 58 mm para el kiosco, una pantalla o televisor para sala de espera y equipos cliente o móviles para las ventanillas y supervisión.

# **13\. Definiciones técnicas del desarrollo**

## **A. Reglas de negocio y fórmulas de cálculo**

* **Cálculo de espera estimada:** Para cada servicio (`caja`, `ejecutivo`, `atencion`), se promedia la diferencia `(hora_llamado - hora_creacion)` de los últimos 20 turnos de `fecha_jornada` con estado `'cerrado'` y resultado `'atendido'`. Si existen menos de 3 muestras en el día para ese servicio, se muestra `"5 min"`.  
* **Cálculo de tiempo activo por ventanilla:** Al abrir una ventanilla o volver de pausa se registra `ultimo_inicio_activo = Date.now()`. Al pausar o cerrar la ventanilla se acumulan los segundos transcurridos en `segundos_activos`. Al consultar el estado o calcular el reloj en vivo, si la ventanilla sigue en `'activo'`, se suma `segundos_activos + Math.floor((ahora - ultimo_inicio_activo) / 1000)`. En recuperaciones tras cortes o inactividad durante apagado del servidor (`sanearAlArranque`), el cálculo se topa al instante real del corte de las 18:00 o al límite de 2 horas de tolerancia.  
* **Métricas del dashboard:** El promedio de espera promedia `(hora_llamado - hora_creacion)` de todos los turnos llamados del día; el promedio de atención promedia `(hora_fin - hora_llamado)` de los turnos cerrados como `'atendido'`.

## **B. Esquema de base de datos (SQLite WAL — 2 tablas)**

* **Tabla `ventanillas`:**  
  * `numero` (`INTEGER UNIQUE NOT NULL`), `ventanilla` (`TEXT PRIMARY KEY`, ej. `"Ventanilla 1"`), `tipo_servicio` (`'caja' | 'ejecutivo' | 'atencion'`), `estado` (`'activo' | 'pausa' | 'cerrado'`, por defecto `'cerrado'`), `segundos_activos` (`INTEGER NOT NULL DEFAULT 0`), `ultimo_inicio_activo` (`INTEGER`), `ultima_actividad` (`INTEGER`).  
  * Sembrada automáticamente al arranque con `INSERT OR IGNORE` para las 7 ventanillas fijas.
* **Tabla `turnos`:**  
  * `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`), `fecha_jornada` (`TEXT NOT NULL`, formato local `YYYY-MM-DD`), `numero_folio` (`INTEGER NOT NULL`), `codigo` (`TEXT NOT NULL`: `C-01`..`C-99`, `E-01`..`E-99`, `A-01`..`A-99`), `tipo` (`'caja' | 'ejecutivo' | 'atencion'`), `estado` (`'espera' | 'atendiendo' | 'cerrado'`), `resultado` (`'atendido' | 'no_atendido' | 'no_aparecio' | 'turno_equivocado'` o `NULL`), `ventanilla` (`TEXT`), `hora_creacion` (`INTEGER NOT NULL`), `hora_llamado` (`INTEGER`), `hora_fin` (`INTEGER`).  
  * Índices compuestos en `(fecha_jornada, tipo, id)` y `(fecha_jornada, estado)`.

## **C. Contrato de rutas y API (`API REST + SSE`)**

* **`GET /`:** Devuelve un portal ligero con enlaces directos a `/kiosco.html`, `/pantalla.html`, `/ventanilla.html` y `/dashboard.html`.  
* **`POST /api/turnos`:** Recibe `{ tipo }`, genera el siguiente folio cíclico (`01`–`99`), auto-asigna si existe una ventanilla `'activo'` libre de ese servicio (`ORDER BY numero ASC LIMIT 1`), emite actualización SSE y responde `201` con `{ turno }` (incluyendo `fechaHoraImpresion` en `DD/MM/YY HH:mm`).  
* **`POST /api/ventanillas/abrir`:** Recibe `{ ventanilla }`, valida atómicamente que esté `'cerrado'` (responde `409` si ya está abierta o en pausa), pasa a `'activo'`, auto-asigna el turno más antiguo en `'espera'` si existe, emite SSE y responde `{ ventanilla, turnoActual }`.  
* **`POST /api/ventanillas/llamar`:** Recibe `{ ventanilla }`, valida que esté `'activo'` y sin turno en curso, desencola el turno más antiguo en `'espera'` de su servicio, actualiza actividad y timer de 2 horas, emite SSE y responde `{ turno }`.  
* **`POST /api/turnos/cerrar`:** Recibe `{ turno_id, ventanilla, resultado, pausar }`, valida el motivo y que el turno siga en `'atendiendo'` en esa ventanilla, cierra el turno con `hora_fin`; si `pausar` es `true`, acumula `segundos_activos` y pasa la ventanilla a `'pausa'`; si `pausar` es `false`, la mantiene `'activo'` y desencola automáticamente el siguiente turno en `'espera'` si existe; emite SSE y responde `{ ok: true, siguienteTurno }`.  
* **`POST /api/ventanillas/estado`:** Recibe `{ ventanilla, accion }` (`"reanudar"` o `"cerrar"`): `"reanudar"` pasa de `'pausa'` a `'activo'` y auto-asigna siguiente turno si hay cola; `"cerrar"` exige no tener turno activo en atención, consolida `segundos_activos` y pasa a `'cerrado'`; ambos emiten SSE.  
* **`GET /api/estado`:** Devuelve el snapshot completo de `fecha_jornada` (`ahora`, `fechaServidor`, `ventanillas` con `segundosActivos` y `turnoActual`, `turnosAtendiendo`, `filasEspera`, `proximosEspera`, `tiemposEstimados` y `metricas` del día).  
* **`GET /api/eventos`:** Canal abierto SSE (`text/event-stream`) con snapshot inicial (`conexion_inicial`), heartbeat cada 25 segundos y notificaciones instantáneas ante cualquier mutación.  
* **`POST /api/jornada/cerrar`:** Ejecuta manualmente o vía cron la rutina de cierre de las 18:00 hrs (cierra ventanillas consolidando `segundos_activos` y cierra turnos residuales del día como `'no_atendido'`).  
* **`POST /api/jornada/reiniciar`:** Recibe `{ limpiarTurnosHoy }` (booleano opcional). Pone las 7 ventanillas en `'cerrado'` con tiempo activo en `0`; si `limpiarTurnosHoy` es `false`, devuelve a `'espera'` cualquier turno que hubiera quedado en `'atendiendo'`; si es `true`, elimina únicamente los turnos de la fecha actual manteniendo intacto el historial de jornadas anteriores.

## **D. Estructura de carpetas del proyecto**

```text
sistema-turnos/
├── AGENTS.md
├── docs/
│   └── SPEC.md
├── package.json
├── package-lock.json
├── server.js
├── turnos.db              (generado automáticamente al iniciar)
└── public/
    ├── comun.js           (catálogos, reloj sincronizado, formato horario Mazatlán, fetch, modales y SSE)
    ├── estilos.css        (tema oscuro azulado unificado, diseño responsivo y @media print 58 mm)
    ├── kiosco.html        (selección de servicio e impresión térmica)
    ├── pantalla.html      (tablero público en sala de espera con timbre Web Audio API)
    ├── ventanilla.html    (selector, recuperación localStorage, 4 botones directos y pausa/cierre)
    └── dashboard.html     (métricas en vivo, Chart.js con respaldo offline y reinicio)
```

# **14\. Notas Operativas y Reglas Técnicas Implementadas**

## **A. Zona Horaria y Automatización sin Polling (`America/Mazatlan`)**

* **Zona horaria local (`America/Mazatlan`):** `server.js` configura `process.env.TZ = 'America/Mazatlan'` en su primera línea. Las marcas de tiempo (`hora_creacion`, `hora_llamado`, `hora_fin`, `ultimo_inicio_activo`, `ultima_actividad`) se almacenan como enteros en milisegundos (`Date.now()`) junto con `fecha_jornada` (`YYYY-MM-DD`), evitando `CURRENT_TIMESTAMP` en UTC. En el navegador, `public/comun.js` formatea fechas con `timeZone: 'America/Mazatlan'` y `hourCycle: 'h23'` para mostrar `DD/MM/YY HH:mm` sin etiquetas de zona horaria sin importar la configuración local del dispositivo cliente.  
* **Temporizadores exactos (`setTimeout`) y saneamiento al arranque:** En lugar de hacer consultas periódicas cada 30 segundos, `server.js` programa temporizadores exactos para el cierre diario de las `18:00:00`, el cambio de día a medianoche (`00:00:00`) y la inactividad individual de cada ventanilla abierta. Al arrancar `server.js`, `sanearAlArranque` cierra sesiones o turnos pendientes de días anteriores o previos al corte de las 18:00 sin exceder el tiempo real hasta el corte ni la tolerancia de 2 horas.  
* **Numeración cíclica (`01` al `99`):** Los folios diarios por servicio (`C`, `E`, `A`) operan de `01` a `99`; al llegar al `99` dentro del mismo día, el siguiente continúa en `01` (`(ultimoFolio % 99) + 1`).

## **B. Configuración de Ventanillas, Bloqueo y Auto-Cierre por Inactividad**

* **Catálogo fijo de 7 ventanillas:** Ventanillas 1 a 4 (`caja`), Ventanillas 5 y 6 (`ejecutivo`) y Ventanilla 7 (`atencion`).  
* **Bloqueo de ventanilla en uso:** Al intentar abrir una ventanilla ya en `'activo'` o `'pausa'`, `POST /api/ventanillas/abrir` responde `HTTP 409 Conflict` y `ventanilla.html` lo notifica mediante ventana modal accesible (`<dialog>`).  
* **Cierre automático por inactividad (2 horas):** Cada ventanilla abierta (`'activo'` o `'pausa'`) cuenta con un `setTimeout` de 7,200 segundos reiniciado ante cualquier operación (`abrir`, `llamar`, `cerrar` turno o `reanudar`). Al vencer sin actividad, pasa a `'cerrado'`, acumula `segundos_activos`, devuelve a `'espera'` cualquier turno que tuviera en `'atendiendo'` y notifica por SSE.

## **C. Flujo de Cola Vacía, Auto-Asignación y Sesión Persistente**

* **Despacho automático por orden numérico:** Si una o más ventanillas del servicio están `'activo'` libres sin cliente asignado, al crearse un turno en el kiosco el servidor selecciona dentro de la misma transacción SQLite la de menor `numero` (`ORDER BY numero ASC LIMIT 1`), le asigna el turno directo en `'atendiendo'` y lo emite por SSE.  
* **Sin rellamado:** No existe funcionalidad ni botón para volver a llamar un turno ya asignado.  
* **Cierre ágil en mostrador:** Cuando la ventanilla atiende un turno, los 4 motivos aparecen como botones grandes de acción inmediata ("Cerrar y llamar siguiente"), mientras `"Cerrar y pausar..."` pregunta primero el motivo en un modal antes de pausar.  
* **Recuperación tras recarga:** `ventanilla.html` persiste su ventanilla en `localStorage` (`turnos_ventanilla_seleccionada`) y al recargar contrasta contra `GET /api/estado`; si sigue `'activo'` o `'pausa'`, restaura su operación y turno; si aparece `'cerrado'`, limpia `localStorage` y muestra el selector.

## **D. Hardware de Impresión (58 mm), Audio Sin Interacción y Apariencia Unificada**

* **Ticket térmico Epson 58 mm (`estilos.css` + `kiosco.html`):** Las reglas `@media print` configuran `@page { size: 58mm auto; margin: 0; }`, ancho útil de `48 mm` y colores blanco y negro forzados (anulando el tema oscuro al imprimir), mostrando exclusivamente el código de turno en negrita grande y la fecha/hora (`DD/MM/YY HH:mm`). `kiosco.html` espera dos `requestAnimationFrame` antes de invocar `window.print()` y retorna al menú principal a los 3 segundos.  
* **Pantalla de sala de espera sin periféricos:** Pensada para navegador en modo kiosco con `--autoplay-policy=no-user-gesture-required`; `pantalla.html` sintetiza un timbre de dos tonos (`659.25 Hz` → `880 Hz`) mediante Web Audio API al recibir un llamado nuevo por SSE y organiza los llamados en tarjeta principal destacada más sub-rejilla compacta para visualizar hasta 7 ventanillas sin scroll.  
* **Normalización visual multi-pantalla:** Todas las vistas comparten un diseño **oscuro azulado** (`#090f1d` fondo, `#111b30` paneles, `#172542` bloques internos, `#38bdf8` y `#facc15` acentos) adaptable a pantallas horizontales, verticales y móviles desde `320 px`.

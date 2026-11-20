# **Definición de Proyecto: Sistema de Gestión de Turnos**

# **1\. Definición del proyecto**

El **Sistema de Gestión de Turnos** es una aplicación web ligera diseñada para organizar el flujo de atención a clientes dentro de un comercio bajo el principio FIFO (primero en entrar, primero en salir). Conecta cuatro interfaces web independientes —terminal impresora de turnos, pantalla pública de espera, panel de ventanilla y dashboard estadístico en tiempo real— desarrolladas con HTML, CSS, JavaScript y un servidor en Node.js con SQLite.

# **2\. Descripción del proyecto**

* **Problemática actual:** Las filas físicas sin control generan desorden, incertidumbre sobre el tiempo de espera, distribución desigual de trabajo entre ventanillas y ausencia de métricas sobre la velocidad y calidad de atención.  
* **Solución tecnológica propuesta:** Una aplicación web centralizada en un solo servidor con API REST en Node.js (Express), base de datos local SQLite y notificaciones Push mediante Server-Sent Events (SSE). El sistema asigna turnos por tipo de servicio, notifica en vivo el llamado a ventanilla y registra los eventos del día para calcular tiempos de espera y estadísticas al instante.

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
  * Desarrollar cuatro vistas web ligeras y responsivas en HTML, CSS y JavaScript para el kiosco de turnos, la sala de espera, las ventanillas y el dashboard de métricas.  
  * Implementar una API REST en Node.js con Express y base de datos SQLite para gestionar los turnos por tipo de servicio (Caja, Ejecutivo y Atención a Cliente).  
  * Permitir que cada operador active su ventanilla con un solo clic, llame turnos, gestione pausas y cierre cada atención registrando el motivo final.  
  * Calcular automáticamente el tiempo estimado de espera a partir de los últimos 20 turnos atendidos y desplegar las estadísticas del día en tiempo real.

# **5\. Actores o roles del sistema**

* **Cliente:** Selecciona el servicio deseado en la terminal de entrada, recoge su ticket impreso, consulta el tiempo estimado en la pantalla pública y acude a la ventanilla asignada.  
* **Cajero / Ejecutivo / Asesor:** Selecciona su ventanilla al iniciar turno, llama al siguiente cliente de su fila, registra el resultado al finalizar la atención y decide si continúa atendiendo o toma una pausa.  
* **Supervisor / Encargado:** Monitorea el dashboard en tiempo real para evaluar tiempos de espera, duración de atención, clientes atendidos por hora y tiempo activo de cada ventanilla.

# **6\. Alcance y limitaciones**

| Dimensión | Detalles del Proyecto |
| :---- | :---- |
| **Alcance (lo que sí hará)** | Emisión e impresión de turnos por servicio (Caja, Ejecutivo, Atención a Cliente); pantalla pública con turno actual, próximos turnos y tiempo estimado de espera; panel de ventanilla con selección rápida de módulo, pausa/reanudación y cierre con 4 motivos (atendido, no atendido, no apareció, turno equivocado); sincronización en tiempo real mediante SSE; y dashboard con métricas del día. |
| **Limitaciones (lo que no hará)** | No incluirá autenticación con usuarios y contraseñas; no realizará cobros ni facturación; no enviará notificaciones por SMS o WhatsApp; no contará con aplicaciones móviles nativas; y operará en red local sobre un único servidor. |

# **7\. Funcionalidades básicas**

* **Terminal de turnos (kiosco.html):** Permite elegir entre Caja, Ejecutivo o Atención a Cliente, genera el código secuencial diario correspondiente y lanza la impresión del ticket.  
* **Pantalla pública de espera (pantalla.html):** Muestra en formato de alta visibilidad el turno llamado con su ventanilla, la lista de turnos siguientes y el tiempo estimado de espera por servicio.  
* **Panel de ventanilla (ventanilla.html):** Permite seleccionar la ventanilla a operar (lo que define automáticamente el servicio que atiende), llamar al siguiente turno, cerrar la atención con uno de los cuatro motivos establecidos y elegir entre atender al siguiente o pausar la ventanilla.  
* **Dashboard en tiempo real (dashboard.html):** Presenta los indicadores acumulados del día: tiempo promedio de espera, tiempo promedio de atención, clientes atendidos por hora, tiempo activo por ventanilla y desglose de motivos de cierre.

# **8\. Productos y resultados a obtener (entregables)**

* **Documentación:** Definición del proyecto, especificación de requisitos, diagramas de arquitectura y base de datos, manual técnico y manual de usuario.  
* **Software:** Código fuente funcional del frontend (HTML, CSS y JavaScript), servidor backend en Node.js con Express, base de datos estructurada en SQLite y sistema operativo en entorno local.  
* **Resultados esperados:** Control estricto de turnos sin duplicados, sincronización de pantallas en menos de un segundo, estimación precisa del tiempo de espera y código limpio, modular y libre de sobreingeniería.

---

# **9\. Requerimientos del cliente (Necesidades del negocio)**

* Contar con una terminal autoservicio en la entrada donde el cliente elija entre Caja, Ejecutivo o Atención a Cliente e imprima su ticket físico.  
* Disponer de una pantalla en sala de espera que muestre el turno actual, los siguientes en fila y un tiempo estimado de espera realista basado en el comportamiento reciente de la fila.  
* Evitar sistemas complejos de inicio de sesión o gestión de cuentas para el personal; cada empleado solo debe seleccionar su número de ventanilla al comenzar, y esa selección determinará el tipo de servicio que atiende.  
* Permitir que el personal decida al cerrar un turno si atiende de inmediato al siguiente cliente o pone su ventanilla en pausa, pudiendo reanudar su actividad en cualquier momento.  
* Registrar obligatoriamente el desenlace de cada turno (si se atendió, no se atendió, no apareció el cliente o tomó un turno equivocado).  
* Visualizar en un dashboard en tiempo real el rendimiento diario del comercio: tiempos de espera y atención, clientes atendidos por hora, tiempo activo de cada ventanilla y distribución de resultados.

# **10\. Requisitos Funcionales (RF)**

## **Módulo Kiosco (kiosco.html)**

* **RF-01 Selección de servicio:** Permitir al cliente elegir entre tres tipos de trámite: Caja, Ejecutivo o Atención a Cliente.  
* **RF-02 Generación secuencial de turnos:** Asignar un código único diario con prefijo por servicio (C-01, E-01, A-01) respetando strictly el orden de llegada (FIFO).  
* **RF-03 Impresión de ticket:** Mostrar el comprobante en pantalla con número de turno, servicio, fecha y hora, y ejecutar el diálogo de impresión del navegador.

## **Módulo Pantalla Pública (pantalla.html)**

* **RF-04 Visualización de llamado actual:** Mostrar en tamaño destacado el turno que está siendo llamado junto con la ventanilla asignada.  
* **RF-05 Lista de turnos siguientes:** Desplegar los próximos turnos en espera ordenados cronológicamente por llegada.  
* **RF-06 Tiempo estimado de espera:** Mostrar el tiempo aproximado de espera por cada servicio, calculado a partir del promedio real de espera de los últimos 20 turnos atendidos.

## **Módulo Panel de Ventanilla (ventanilla.html)**

* **RF-07 Apertura de ventanilla por selección única:** Permitir iniciar la operación seleccionando únicamente la ventanilla asignada, la cual ya tiene predefinido el tipo de servicio que brinda (Caja, Ejecutivo o Atención a Cliente), sin requerir usuarios ni contraseñas.  
* **RF-08 Llamado del siguiente turno:** Desencolar automáticamente el turno más antiguo en espera correspondiente al servicio de la ventanilla activa.  
* **RF-09 Cierre con motivo obligatorio:** Finalizar el turno actual seleccionando uno de cuatro resultados: Atendido, No atendido, No apareció o Turno equivocado.  
* **RF-10 Control de flujo y pausas:** Al cerrar un turno, permitir elegir entre "Cerrar y llamar siguiente" o "Cerrar y pausar", además de disponer de botones para "Volver de pausa" y "Cerrar ventanilla".

## **Módulo Dashboard en Tiempo Real (dashboard.html)**

* **RF-11 Indicadores de tiempos:** Mostrar el tiempo promedio de espera en fila y el tiempo promedio de atención en ventanilla del día actual.  
* **RF-12 Productividad por hora y motivos:** Mostrar la cantidad de clientes atendidos por hora y el conteo y porcentaje de cada motivo de cierre.  
* **RF-13 Rendimiento por ventanilla:** Mostrar el total de turnos cerrados y el tiempo total activo (descontando pausas) de cada ventanilla durante la jornada.

## **Núcleo y Sincronización**

* **RF-14 Actualización en vivo:** Reflejar cualquier cambio (nuevo turno, llamado, cierre o pausa) en todas las pantallas abiertas sin recargar la página.  
* **RF-15 Reinicio lógico diario:** Reiniciar cada día la numeración de tickets (01) y las métricas del dashboard filtrando por la fecha actual, conservando el historial previo en la base de datos.

# **11\. Requisitos No Funcionales (RNF)**

* **RNF-01 Latencia en tiempo real:** Las notificaciones hacia la pantalla pública y el dashboard deben reflejarse en menos de 1 segundo mediante Server-Sent Events (SSE).  
* **RNF-02 Integridad ante concurrencia:** Dos ventanillas del mismo servicio no deben poder tomar el mismo turno simultáneamente mediante operaciones atómicas en SQLite.  
* **RNF-03 Persistencia ante fallos:** Ante un reinicio del servidor o recarga accidental del navegador, los turnos del día y la ventanilla seleccionada (localStorage) deben conservarse intactos.  
* **RNF-04 Usabilidad y diseño responsivo:** Tipografía de alto contraste legible a distancia en la pantalla pública e interfaz adaptable a monitores, tabletas y dispositivos móviles.  
* **RNF-05 Simplicidad y mantenibilidad:** Arquitectura monolítica ligera sin sobreingeniería, con código limpio, modular y eficiente basado en tecnologías web estándar.  
* **RNF-06 Operación en red local:** Funcionamiento autónomo dentro de la red LAN/Wi-Fi del comercio sin requerir conexión a internet.

# **12\. Requerimientos técnicos y de entorno**

* **Backend:** Node.js (v18 o superior) con Express para la API REST y SQLite (módulo nativo node:sqlite o better-sqlite3) como base de datos en un solo archivo.  
* **Frontend:** Páginas independientes en HTML5, CSS3 y JavaScript puro (ES6+), utilizando la API nativa fetch() para peticiones y EventSource para tiempo real.  
* **Herramientas complementarias ligeras:** Chart.js (vía CDN) para renderizar las gráficas estadísticas del dashboard de forma directa y sin configuraciones de compilación.  
* **Hardware requerido:** Un equipo servidor local para ejecutar Node.js, una terminal/tableta con impresora configurada para el kiosco, una pantalla o televisor para sala de espera y equipos cliente para las ventanillas.

# **13\. Definiciones técnicas previas al desarrollo**

## **A. Reglas de negocio y fórmulas de cálculo**

* **Cálculo de espera estimada:** Para cada servicio (caja, ejecutivo, atencion), se promedia la diferencia (hora\_llamado \- hora\_creacion) de los últimos 20 turnos del día con estado "cerrado" y resultado "atendido". Si existen menos de 3 turnos cerrados en la jornada, se muestra un valor inicial de referencia ("5 min").  
* **Cálculo de tiempo activo por ventanilla:** Al abrir una ventanilla o volver de pausa se registra la marca de tiempo en ultimo\_inicio\_activo. Al pausar o cerrar la ventanilla se acumulan los segundos transcurridos en segundos\_activos. Al consultar el dashboard, si la ventanilla sigue activa, se suma segundos\_activos \+ (ahora \- ultimo\_inicio\_activo).

## **B. Esquema de base de datos (SQLite — 2 tablas)**

* **Tabla turnos:** id (INTEGER PRIMARY KEY), codigo (TEXT: C-01, E-01, A-01), tipo (TEXT: caja, ejecutivo, atencion), estado (TEXT: espera, atendiendo, cerrado), resultado (TEXT: atendido, no\_atendido, no\_aparecio, turno\_equivocado o NULL), ventanilla (TEXT), hora\_creacion (DATETIME), hora\_llamado (DATETIME), hora\_fin (DATETIME).  
* **Tabla ventanillas:** ventanilla (TEXT PRIMARY KEY, ej. "Ventanilla 1"), tipo\_servicio (TEXT: caja, ejecutivo, atencion), estado (TEXT: activo, pausa, cerrado), segundos\_activos (INTEGER), ultimo\_inicio\_activo (DATETIME). Las ventanillas y su tipo de servicio asociado se inicializan automáticamente al arrancar el servidor.

## **C. Contrato de endpoints (API REST \+ SSE)**

* **POST /api/turnos:** Recibe { tipo }, crea un nuevo turno en espera con el siguiente consecutivo del día y notifica por SSE.  
* **POST /api/ventanillas/abrir:** Recibe { ventanilla }, activa la ventanilla seleccionada (usando su servicio preconfigurado), inicia su contador de tiempo activo y notifica por SSE.  
* **POST /api/ventanillas/llamar:** Recibe { ventanilla }, asigna el turno más antiguo en espera del servicio de esa ventanilla, lo pasa a atendiendo y notifica por SSE.  
* **POST /api/turnos/cerrar:** Recibe { turno\_id, ventanilla, resultado, pausar }, cierra el turno con su motivo; si pausar es true pasa la ventanilla a pausa, si es false llama automáticamente al siguiente turno libre y notifica por SSE.  
* **POST /api/ventanillas/estado:** Recibe { ventanilla, accion } ("reanudar" o "cerrar"), actualiza el estado operativo y el acumulado de segundos activos, y notifica por SSE.  
* **GET /api/estado:** Devuelve el estado completo del día: turnos en atención, filas en espera, tiempos estimados por servicio, estado de ventanillas y métricas del dashboard.  
* **GET /api/eventos:** Canal abierto SSE (text/event-stream) que emite actualizaciones instantáneas a todas las vistas conectadas ante cualquier cambio.

## **D. Estructura de carpetas del proyecto**

* **sistema-turnos/**  
  * **package.json** (dependencias mínimas: express y driver SQLite)  
  * **server.js** (servidor HTTP, archivos estáticos, API REST, consultas SQL y canal SSE)  
  * **turnos.db** (archivo único de base de datos SQLite generado automáticamente)  
  * **public/**  
    * **estilos.css** (hoja de estilos compartida, responsiva y con reglas @media print para tickets)  
    * **kiosco.html** (interfaz de selección de servicio e impresión de ticket)  
    * **pantalla.html** (tablero público de llamado actual, próximos turnos y tiempo estimado)  
    * **ventanilla.html** (panel operativo para activar ventanilla, llamar, cerrar con motivo y pausar)  
    * **dashboard.html** (tablero estadístico en tiempo real con métricas y gráficas)

# **14\. Notas de Actualización y Ajustes Técnicos Previos al Desarrollo**

Se incorporan las siguientes definiciones operativas y reglas técnicas que complementan y ajustan la especificación original antes de iniciar la codificación:

## **A. Zona Horaria y Corte Diario Automatizado (UTC-7 Mazatlán)**

* **Zona horaria estricta (UTC-7):** El servidor Node.js operará configurado en America/Mazatlan (UTC-7). Todas las marcas de tiempo (hora\_creacion, hora\_llamado, hora\_fin, ultima\_actividad) se generarán desde el backend con desplazamiento explícito \-07:00 y una columna/filtro de fecha local (fecha\_jornada en formato YYYY-MM-DD), evitando el uso de CURRENT\_TIMESTAMP en UTC de SQLite.  
* **Tarea programada de cierre diario (18:00 hrs):** El servidor ejecutará un verificador interno (cron/intervalo en server.js) que, al cumplirse las 18:00 hrs (6:00 PM) hora de Mazatlán, cerrará automáticamente todas las ventanillas activas o en pausa, consolidará sus segundos\_activos y cerrará cualquier turno residual pendiente de la jornada. Además, al iniciar server.js se ejecutará una rutina de saneamiento para cerrar sesiones de días anteriores si el equipo estuvo apagado a la hora de cierre.  
* **Numeración cíclica (01 al 99):** Los consecutivos diarios por servicio (C, E, A) operarán en rango de 01 a 99\. Si un servicio supera el turno 99 en una misma jornada, el contador continuará automáticamente en 01 (C-99 \-\> C-01), calculando el siguiente folio a partir del último registro insertado en la jornada actual.

## **B. Configuración de Ventanillas, Bloqueo y Auto-Cierre por Inactividad**

* **Catálogo inicial de 7 ventanillas:** Al inicializar la base de datos se crearán exactamente 7 módulos con orden numérico fijo:  
  * Ventanilla 1 a Ventanilla 4: servicio caja (4 cajas).  
  * Ventanilla 5 y Ventanilla 6: servicio ejecutivo (2 módulos de servicio al cliente / ejecutivos).  
  * Ventanilla 7: servicio atencion (1 módulo de atención a clientes).  
* **Bloqueo de ventanilla en uso:** Al abrir una ventanilla (POST /api/ventanillas/abrir), el servidor validará de forma atómica que su estado sea cerrado. Si ya está en estado activo o pausa, bloqueará la apertura devolviendo un error de conflicto (HTTP 409\) para evitar duplicidad de operadores en el mismo módulo.  
* **Cierre automático por inactividad (2 horas):** Cada ventanilla registrará su marca de tiempo ultima\_actividad (actualizada al abrir, llamar, cerrar turno o volver de pausa). Si una ventanilla permanece abierta (activa o en pausa) por más de 2 horas (120 minutos) sin registrar actividad, el verificador del servidor la pasará automáticamente a estado cerrado, acumulará sus segundos\_activos y notificará por SSE para liberar su interfaz.

## **C. Flujo de Cola Vacía, Auto-Asignación y Sesión Persistente**

* **Estado de espera en ventanilla y despacho automático por orden numérico:** Si al abrir una ventanilla o al cerrar un turno sin pausar (pausar: false) no existen turnos en fila para su servicio, la ventanilla quedará en estado activo libre (en espera de cliente). Cuando un cliente genere un nuevo turno en el kiosco (POST /api/turnos), el servidor consultará dentro de la misma transacción SQLite si hay ventanillas activas libres de ese servicio, seleccionará la de menor número (orden numérico ascendente, ej. Ventanilla 1 antes que Ventanilla 2\) y le asignará el turno directamente en estado atendiendo, emitiendo el llamado por SSE.  
* **Eliminación de rellamado:** No existirá funcionalidad ni botón para volver a llamar un turno ya asignado; el operador únicamente podrá cerrarlo mediante uno de los 4 motivos establecidos.  
* **Recuperación tras recarga con turno activo:** ventanilla.html almacenará el identificador de la ventanilla en localStorage. Al recargar la página, consultará GET /api/estado para verificar si dicha ventanilla sigue activa o en pausa en el servidor; de ser así, restaurará automáticamente la sesión operativa, el tiempo activo y el turno que tenga actualmente en estado atendiendo con sus controles de cierre. Si la ventanilla ya fue cerrada por el servidor (cierre manual, corte de las 18:00 hrs o timeout de 2 horas), limpiará localStorage y mostrará el selector de ventanillas.

## **D. Hardware de Impresión (58 mm) y Audio Sin Interacción**

* **Formato de ticket térmico (Epson Mini Printer 58 mm):** Las reglas @media print de estilos.css se ajustarán a rollo térmico de 58 mm (ancho útil de 48 mm, márgenes en cero). El comprobante impreso contendrá exclusivamente dos datos: el código del turno (ej. C-01) en tipografía destacada y la fecha y hora exacta de impresión (DD/MM/YYYY HH:mm).  
* **Desbloqueo de audio en pantalla pública sin periféricos:** Dado que el equipo de sala de espera opera sin teclado ni mouse, se configurará el navegador en modo kiosco con la bandera \--autoplay-policy=no-user-gesture-required. Adicionalmente, pantalla.html generará el timbre de notificación mediante Web Audio API al recibir el evento SSE de llamado, eliminando la necesidad de interacción física del personal.
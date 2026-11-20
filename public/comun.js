/*
  Funciones compartidas por todas las pantallas del Sistema de Turnos.

  Aquí guardamos lo que necesitan en común el kiosco, las ventanillas, la
  pantalla pública y el dashboard para no repetir código en cada página:
  - Nombres bonitos para servicios, estados y motivos de cierre.
  - Formato de fechas y horas según el reloj de Mazatlán (DD/MM/YY HH:mm).
  - Reloj sincronizado con el servidor.
  - Envío y lectura de datos al servidor (usando fetch).
  - Conexión abierta en vivo para actualizar las pantallas al instante (SSE).
  - Creación sencilla de etiquetas y tarjetas en pantalla.
*/

(function iniciarModuloCompartido() {
  // Catálogo legible de servicios mostrados al usuario.
  const SERVICIOS = {
    caja: 'Caja',
    ejecutivo: 'Ejecutivo',
    atencion: 'Atención a Cliente'
  };

  // Textos claros para el estado actual de cada ventanilla.
  const ESTADOS_VENTANILLA = {
    activo: 'Activa',
    pausa: 'En pausa',
    cerrado: 'Cerrada'
  };

  // Los 4 motivos obligatorios al finalizar la atención de un cliente.
  const MOTIVOS_CIERRE = [
    { clave: 'atendido', nombre: 'Atendido', claseBoton: 'btn-exito', color: '#10b981' },
    { clave: 'no_atendido', nombre: 'No atendido', claseBoton: 'btn-alerta', color: '#f59e0b' },
    { clave: 'no_aparecio', nombre: 'No apareció', claseBoton: 'btn-peligro', color: '#ef4444' },
    { clave: 'turno_equivocado', nombre: 'Turno equivocado', claseBoton: 'btn-neutro', color: '#64748b' }
  ];

  // Convierte una marca de tiempo numérica al formato "DD/MM/YY HH:mm" en horario de Mazatlán.
  function formatearFechaHora(ms) {
    if (!ms) return '--/--/-- --:--';

    const opciones = {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: false,
      hourCycle: 'h23',
      timeZone: 'America/Mazatlan'
    };

    try {
      return new Date(ms).toLocaleString('es-MX', opciones).replace(',', '');
    } catch (_) {
      // Respaldo por si algún dispositivo antiguo no reconoce el nombre de zona horaria.
      delete opciones.timeZone;
      return new Date(ms).toLocaleString('es-MX', opciones).replace(',', '');
    }
  }

  // Convierte una fecha "AAAA-MM-DD" del servidor a "DD/MM/AA" para mostrar en títulos.
  function formatearFechaCorta(fechaTexto) {
    if (!fechaTexto || !fechaTexto.includes('-')) return '--/--/--';
    const partes = fechaTexto.split('-');
    return `${partes[2]}/${partes[1]}/${partes[0].slice(-2)}`;
  }

  // Convierte una cantidad de segundos a reloj "HH:MM:SS" (por ejemplo 01:05:30).
  function formatearCronometro(totalSegundos) {
    const segs = Math.max(0, Math.floor(totalSegundos || 0));
    const horas = String(Math.floor(segs / 3600)).padStart(2, '0');
    const minutos = String(Math.floor((segs % 3600) / 60)).padStart(2, '0');
    const segundos = String(segs % 60).padStart(2, '0');
    return `${horas}:${minutos}:${segundos}`;
  }

  // Convierte segundos a un texto fácil de leer en las tarjetas de promedio ("45 s", "2 min 10 s").
  function formatearPromedio(totalSegundos) {
    const segs = Math.max(0, Math.round(totalSegundos || 0));
    if (segs < 60) {
      return `${segs} s`;
    }
    const minutos = Math.floor(segs / 60);
    const resto = segs % 60;
    return resto > 0 ? `${minutos} min ${resto} s` : `${minutos} min`;
  }

  // Controla el reloj superior de cada pantalla calculando la diferencia contra el servidor,
  // así todas las computadoras muestran exactamente la misma hora aunque su reloj local esté desajustado.
  function crearReloj(elementoReloj) {
    let diferenciaMs = 0;

    function actualizar() {
      if (elementoReloj) {
        elementoReloj.textContent = formatearFechaHora(Date.now() + diferenciaMs);
      }
    }

    function sincronizar(ahoraServidorMs) {
      if (typeof ahoraServidorMs === 'number') {
        diferenciaMs = ahoraServidorMs - Date.now();
      }
      actualizar();
    }

    function ahoraMs() {
      return Date.now() + diferenciaMs;
    }

    return { sincronizar, actualizar, ahoraMs };
  }

  // Consulta al servidor el resumen completo del día (turnos, ventanillas y métricas).
  async function obtenerEstado() {
    const respuesta = await fetch('/api/estado');
    if (!respuesta.ok) {
      throw new Error('No se pudo obtener la información del servidor.');
    }
    return respuesta.json();
  }

  // Envía datos al servidor usando JSON y devuelve su respuesta. Si algo falla, lanza un mensaje claro.
  async function enviarDatos(ruta, datos) {
    const respuesta = await fetch(ruta, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });

    const cuerpo = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok) {
      throw new Error(cuerpo.error || `Error del servidor (${respuesta.status}).`);
    }
    return cuerpo;
  }

  // Abre una ventana de aviso (<dialog>) con el mensaje de error si no estaba abierta ya.
  function mostrarAviso(dialogo, elementoMensaje, texto) {
    if (!dialogo || !elementoMensaje) return;
    elementoMensaje.textContent = texto;
    if (!dialogo.open) {
      dialogo.showModal();
    }
  }

  // Mantiene una conexión en vivo con el servidor (/api/eventos) para recibir cambios al instante
  // y actualizar el indicador verde/rojo ("En vivo" / "Reconectando...") del encabezado.
  function conectarEnVivo({ cajaEstado, textoEstado, alRecibir }) {
    let canal = null;

    function iniciar() {
      if (canal) {
        canal.close();
      }

      canal = new EventSource('/api/eventos');

      canal.onopen = () => {
        if (cajaEstado) cajaEstado.className = 'estado-sse estado-sse--conectado';
        if (textoEstado) textoEstado.textContent = 'En vivo';
      };

      canal.onmessage = (evento) => {
        try {
          const aviso = JSON.parse(evento.data);
          if (aviso && aviso.estado && typeof alRecibir === 'function') {
            alRecibir(aviso);
          }
        } catch (_) {
          // Si llega un mensaje incompleto, lo ignoramos sin cortar la conexión.
        }
      };

      canal.onerror = () => {
        if (cajaEstado) cajaEstado.className = 'estado-sse estado-sse--error';
        if (textoEstado) textoEstado.textContent = 'Reconectando...';
      };
    }

    iniciar();
    return {
      cerrar: () => {
        if (canal) canal.close();
      }
    };
  }

  // Ayudante corto para crear etiquetas HTML de forma segura (siempre usando textContent).
  function crearElemento(etiqueta, { clase, texto, atributos, hijos } = {}) {
    const nodo = document.createElement(etiqueta);
    if (clase) nodo.className = clase;
    if (texto !== undefined && texto !== null) nodo.textContent = String(texto);
    if (atributos) {
      for (const [clave, valor] of Object.entries(atributos)) {
        nodo.setAttribute(clave, valor);
      }
    }
    if (hijos) {
      nodo.append(...hijos);
    }
    return nodo;
  }

  // Dejamos disponibles todas las funciones compartidas bajo un solo nombre global.
  window.TurnosUI = {
    SERVICIOS,
    ESTADOS_VENTANILLA,
    MOTIVOS_CIERRE,
    formatearFechaHora,
    formatearFechaCorta,
    formatearCronometro,
    formatearPromedio,
    crearReloj,
    obtenerEstado,
    enviarDatos,
    mostrarAviso,
    conectarEnVivo,
    crearElemento
  };
})();

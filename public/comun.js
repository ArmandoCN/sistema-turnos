/*
  comun.js - Funciones que comparten las 4 pantallas del sistema

  Para no estar copiando y pegando lo mismo en el kiosco, la ventanilla,
  la pantalla de espera y el dashboard, aquí juntamos:
  - Los nombres de los 3 servicios, estados de ventanilla y motivos de cierre.
  - Funciones para darle formato a las fechas, horas y cronómetro.
  - El reloj de la barra de arriba sincronizado con la hora del servidor.
  - Funciones para pedir y mandar datos por fetch() y escuchar eventos SSE.
*/

(function () {
  const SERVICIOS = {
    caja: 'Caja',
    ejecutivo: 'Ejecutivo',
    atencion: 'Atención a Cliente'
  };

  const ESTADOS_VENTANILLA = {
    activo: 'Activa',
    pausa: 'En pausa',
    cerrado: 'Cerrada'
  };

  const MOTIVOS_CIERRE = [
    { clave: 'atendido', nombre: 'Atendido', color: '#10b981' },
    { clave: 'no_atendido', nombre: 'No atendido', color: '#f59e0b' },
    { clave: 'no_aparecio', nombre: 'No apareció', color: '#ef4444' },
    { clave: 'turno_equivocado', nombre: 'Turno equivocado', color: '#64748b' }
  ];

  // Convierte milisegundos a "DD/MM/YY HH:mm" con el horario de Sinaloa (UTC-7 fijo todo el año)
  function formatearFechaHora(ms) {
    if (!ms) return '--/--/-- --:--';

    // Restamos 7 horas a UTC para sacar la hora local de Culiacán/Mazatlán sin importar
    // cómo tenga configurada la zona horaria la compu o el celular que abre la página.
    const ajusteSinaloaMs = Number(ms) - 7 * 60 * 60 * 1000;
    const f = new Date(ajusteSinaloaMs);

    const dia = String(f.getUTCDate()).padStart(2, '0');
    const mes = String(f.getUTCMonth() + 1).padStart(2, '0');
    const anio = String(f.getUTCFullYear()).slice(-2);
    const horas = String(f.getUTCHours()).padStart(2, '0');
    const mins = String(f.getUTCMinutes()).padStart(2, '0');

    return `${dia}/${mes}/${anio} ${horas}:${mins}`;
  }

  // Pasa una fecha "YYYY-MM-DD" a formato corto "DD/MM/YY"
  function formatearFechaCorta(fechaTexto) {
    if (!fechaTexto || !fechaTexto.includes('-')) return '--/--/--';
    const partes = fechaTexto.split('-');
    return `${partes[2]}/${partes[1]}/${partes[0].slice(-2)}`;
  }

  // Convierte segundos a formato de reloj "HH:MM:SS" para el tiempo activo de ventanilla
  function formatearCronometro(totalSegundos) {
    const segs = Math.max(0, Math.floor(totalSegundos || 0));
    const horas = String(Math.floor(segs / 3600)).padStart(2, '0');
    const minutos = String(Math.floor((segs % 3600) / 60)).padStart(2, '0');
    const segundos = String(segs % 60).padStart(2, '0');
    return `${horas}:${minutos}:${segundos}`;
  }

  // Da formato legible a los promedios del dashboard ("35 s", "4 min 15 s")
  function formatearPromedio(totalSegundos) {
    const segs = Math.max(0, Math.round(totalSegundos || 0));
    if (segs < 60) {
      return `${segs} s`;
    }
    const minutos = Math.floor(segs / 60);
    const resto = segs % 60;
    return resto > 0 ? `${minutos} min ${resto} s` : `${minutos} min`;
  }

  // Maneja el reloj del encabezado tomando como base la hora que manda el servidor
  function crearReloj(elementoReloj) {
    let desfaseMs = 0;

    function actualizar() {
      if (elementoReloj) {
        elementoReloj.textContent = formatearFechaHora(Date.now() + desfaseMs);
      }
    }

    function sincronizar(horaServidorMs) {
      if (typeof horaServidorMs === 'number') {
        desfaseMs = horaServidorMs - Date.now();
      }
      actualizar();
    }

    function ahoraMs() {
      return Date.now() + desfaseMs;
    }

    return { sincronizar, actualizar, ahoraMs };
  }

  // Pide el estado general del día al servidor
  async function obtenerEstado() {
    const respuesta = await fetch('/api/estado');
    if (!respuesta.ok) {
      throw new Error('No se pudo obtener la información del servidor.');
    }
    return respuesta.json();
  }

  // Manda una petición POST en JSON al servidor y regresa la respuesta o lanza el error
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

  // Muestra un cuadro <dialog> con un mensaje de aviso o error
  function mostrarAviso(dialogo, elementoMensaje, texto) {
    if (!dialogo || !elementoMensaje) return;
    elementoMensaje.textContent = texto;
    if (!dialogo.open) {
      dialogo.showModal();
    }
  }

  // Abre el canal de Server-Sent Events (/api/eventos) para recibir cambios al momento
  function conectarEnVivo({ cajaEstado, textoEstado, alRecibir }) {
    const canal = new EventSource('/api/eventos');

    canal.onopen = () => {
      if (cajaEstado) cajaEstado.className = 'estado-sse estado-sse--conectado';
      if (textoEstado) textoEstado.textContent = 'En vivo';
    };

    canal.onmessage = (evento) => {
      try {
        const datos = JSON.parse(evento.data);
        if (datos && datos.estado && typeof alRecibir === 'function') {
          alRecibir(datos);
        }
      } catch (_) {
        // Si algún mensaje llega cortado lo ignoramos
      }
    };

    canal.onerror = () => {
      if (cajaEstado) cajaEstado.className = 'estado-sse estado-sse--error';
      if (textoEstado) textoEstado.textContent = 'Reconectando...';
    };
  }

  // Crea un elemento HTML de forma rápida y segura usando textContent
  function crearElemento(etiqueta, { clase, texto, atributos, hijos } = {}) {
    const el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto !== undefined && texto !== null) el.textContent = String(texto);
    if (atributos) {
      for (const [clave, valor] of Object.entries(atributos)) {
        el.setAttribute(clave, valor);
      }
    }
    if (hijos) {
      for (const hijo of hijos) {
        if (hijo) el.appendChild(hijo);
      }
    }
    return el;
  }

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

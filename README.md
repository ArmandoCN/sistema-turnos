# Sistema de Gestión de Turnos

Proyecto de sistema web en tiempo real para administrar la fila de clientes por tipo de servicio (**Caja**, **Ejecutivo** y **Atención a Cliente**), coordinar la atención en **7 ventanillas** y consultar estadísticas del día en vivo.

Desarrollado con **Node.js**, **Express**, **SQLite** (`node:sqlite`) y **HTML5 / CSS3 / JavaScript puro** (sin frameworks pesados).

---

## Requisitos

* **Node.js** `v22.13.0` o superior (incluye el módulo nativo `node:sqlite`).

---

## Instalación y arranque

1. Instalar dependencias:
   ```bash
   npm install
   ```

2. Iniciar el servidor (corre en el puerto `4782` con horario `America/Mazatlan`):
   ```bash
   npm start
   ```

3. Ejecutar las pruebas automáticas del servidor:
   ```bash
   npm test
   ```

---

## Pantallas del sistema

Una vez encendido el servidor, puedes abrir cualquiera de las vistas desde el navegador:

* **Menú principal:** `http://localhost:4782/`
* **Kiosco de Turnos (Autoservicio):** `http://localhost:4782/kiosco.html`
* **Pantalla Pública (Sala de espera):** `http://localhost:4782/pantalla.html`
* **Panel de Ventanilla (Cajeros y ejecutivos):** `http://localhost:4782/ventanilla.html`
* **Dashboard en Tiempo Real (Supervisión):** `http://localhost:4782/dashboard.html`

---

## Configuración recomendada en sucursal (Chrome)

* **Terminal del Kiosco con impresora térmica Epson de 58 mm:**
  Configura la impresora térmica de 58 mm como predeterminada y abre Chrome con `--kiosk-printing` para que `window.print()` mande el ticket directo al papel sin mostrar la ventana de confirmación:
  ```bash
  google-chrome --kiosk --kiosk-printing http://localhost:4782/kiosco.html
  ```

* **Televisor o monitor de Sala de Espera:**
  Abre Chrome con el permiso de audio automático activado para que el timbre suene desde el primer llamado sin necesidad de hacer clic en la pantalla:
  ```bash
  google-chrome --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4782/pantalla.html
  ```

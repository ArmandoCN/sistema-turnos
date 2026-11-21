# Sistema de Gestión de Turnos — Guía para correr el proyecto desde cero

Esta guía explica paso a paso cómo hacer funcionar el proyecto en tu computadora **suponiendo que solo tienes instalado Visual Studio Code y nada más**.

---

## Paso 1: Instalar Node.js (obligatorio)

Como el servidor y la base de datos funcionan con **Node.js**, lo primero es instalarlo:

1. Entra a la página oficial: [https://nodejs.org/](https://nodejs.org/)
2. Descarga el instalador de la versión **22 LTS (22.13.0 o superior)** o la más reciente disponible.
   > **Importante:** Tiene que ser mínimo la versión **22.13.0** porque el proyecto usa `node:sqlite` (la base de datos que ya viene integrada dentro de Node, para no batallar instalando programas extra de bases de datos).
3. Abre el instalador que descargaste y dale en **Next → Next → Install** dejando todas las opciones como vienen por defecto.
4. **Muy importante:** Si ya tenías abierto Visual Studio Code, **ciérralo por completo y vuélvelo a abrir** para que detecte que ya instalaste Node.js.

---

## Paso 2: Tener la carpeta del proyecto en tu computadora

Si no tienes Git instalado, la forma más rápida es:

1. Si bajaste el proyecto como archivo **`.zip`** (desde GitHub en el botón verde **Code → Download ZIP** o si te lo pasaron por USB/Drive):
   * Haz clic derecho sobre el archivo `.zip` y selecciona **Extraer todo...** (no abras los archivos desde adentro del zip sin descomprimir).
2. Guarda la carpeta descomprimida en un lugar fácil de encontrar, por ejemplo en tu **Escritorio** o en **Documentos**.

---

## Paso 3: Abrir el proyecto en Visual Studio Code

1. Abre **Visual Studio Code**.
2. Arriba a la izquierda haz clic en **Archivo → Abrir carpeta...** (*File → Open Folder...*).
3. Busca y selecciona la carpeta del proyecto (donde están los archivos `server.js` y `package.json`) y dale en **Seleccionar carpeta**.
4. Si VS Code te pregunta *"¿Confías en los autores de los archivos de esta carpeta?"*, marca que **Sí, confío**.

---

## Paso 4: Abrir la terminal dentro de VS Code

1. En el menú de arriba de VS Code haz clic en **Terminal → Nueva terminal** (también puedes usar el atajo `Ctrl + Ñ` o `` Ctrl + ` ``).
2. En la parte de abajo se abrirá un panel de consola.
3. Para comprobar que Node.js se instaló bien en el Paso 1, escribe esto y presiona **Enter**:
   ```bash
   node -v
   ```
   Te debe responder algo como `v22.13.0` (o un número mayor).

> **¿Te salió un error rojo en Windows al usar `npm`?**  
> A veces Windows bloquea comandos en PowerShell y dice *"la ejecución de scripts está deshabilitada en este sistema"*. Si te pasa, tienes dos opciones muy fáciles:
> * **Opción rápida:** En la esquina derecha de la terminal de VS Code, junto al signo **`+`**, haz clic en la flechita **`v`** y elige **Command Prompt (cmd)** en lugar de PowerShell.
> * **O bien:** Escribe este comando en la terminal de PowerShell, dale Enter y listo:
>   ```powershell
>   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
>   ```

---

## Paso 5: Instalar dependencias y encender el servidor

Dentro de la terminal de VS Code escribe estos dos comandos:

1. **Instalar Express (solo se hace la primera vez):**
   ```bash
   npm install
   ```
   *(Espera unos segundos a que termine de crear la carpeta `node_modules`).*

2. **Encender el servidor:**
   ```bash
   npm start
   ```

Cuando veas este mensaje en la terminal, el sistema ya está corriendo y la base de datos `turnos.db` ya se creó sola:
```text
[Sistema de Turnos] Servidor corriendo en http://localhost:4782
```

*(Nota: No cierres la terminal mientras estés usando el sistema. Cuando quieras apagar el servidor, haz clic en la terminal y presiona `Ctrl + C`).*

---

## Paso 6: Cómo abrir y probar las 4 pantallas del sistema

Con el servidor encendido, abre tu navegador (Chrome o Edge) y entra a **`http://localhost:4782`** (o mantén presionado `Ctrl` y dale clic al enlace directo en la terminal de VS Code).

Ahí verás el menú con las 4 pantallas. Para probar cómo funciona todo en tiempo real, abre cada una en una pestaña distinta:

1. **Kiosco (`http://localhost:4782/kiosco.html`):**  
   Toca cualquiera de los 3 botones (**Caja**, **Ejecutivo** o **Atención a Cliente**) para sacar un par de turnos. *(Si te sale la ventana de imprimir del navegador, solo ciérrala o dale Cancelar si no tienes impresora conectada).*
2. **Pantalla de Sala de Espera (`http://localhost:4782/pantalla.html`):**  
   Aquí verás en vivo los turnos que acabas de sacar formados en la lista de espera y el tiempo estimado.
3. **Panel de Ventanilla (`http://localhost:4782/ventanilla.html`):**  
   Elige por ejemplo **Ventanilla 1** (que atiende Caja). Verás que automáticamente jala el primer turno de Caja, en la pestaña de Sala de Espera suena el timbre y aparece el turno llamado, y empieza a correr tu cronómetro.  
   Desde aquí puedes cerrarlo con los 4 botones grandes (**Atendido**, **No atendido**, **No apareció**, **Turno equivocado**) o usar **Cerrar y pausar...**.
4. **Dashboard (`http://localhost:4782/dashboard.html`):**  
   Aquí verás cómo se actualizan solos los promedios, las gráficas del día y la tabla de las 7 ventanillas. Arriba a la derecha tienes los botones **Reiniciar jornada** y **Eliminar todos los datos** por si quieres dejar todo limpio en cero después de hacer tus pruebas.

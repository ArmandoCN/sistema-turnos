# Sistema de Gestión de Turnos — Guía para correr el proyecto desde cero

Esta guía explica paso a paso cómo preparar las herramientas, jalar el repositorio y correr el proyecto **suponiendo que solo tienes instalado Visual Studio Code y nada más**.

---

## Paso 1: Revisar e instalar Git y Node.js desde la terminal de VS Code

1. Abre **Visual Studio Code**.
2. En el menú superior haz clic en **Terminal → Nueva terminal** (o usa el atajo `Ctrl + Ñ` / `` Ctrl + ` ``). Abajo se abrirá la consola.

---

### 1.1 Revisar si tienes Git
Escribe en la terminal de VS Code:
```bash
git --version
```
* **Si te muestra una versión** (ej. `git version 2.x.x`), ya lo tienes listo.
* **Si te marca error** diciendo que no se reconoce `git`, puedes instalarlo ahí mismo desde la terminal o bajando el instalador:

  * **Opción A — Instalar Git desde la terminal de VS Code:**
    * En **Windows (10 / 11)**:
      ```powershell
      winget install --id Git.Git -e --source winget
      ```
    * En **Linux (Ubuntu / Debian)**:
      ```bash
      sudo apt update && sudo apt install -y git
      ```
  * **Opción B — Descargar el instalador desde el navegador:**
    * Entra a [https://git-scm.com/](https://git-scm.com/), descarga el instalador y dale en **Next → Next → Install**.

---

### 1.2 Revisar si tienes Node.js (v22.13.0 o superior)
Escribe en la terminal de VS Code:
```bash
node -v
```
* **Si te responde `v22.13.0` o un número mayor**, ya tienes Node listo.
* **Si no lo tienes instalado o tienes una versión más vieja (como v18 o v20):**
  > **Importante:** Se ocupa mínimo la versión **22.13.0** porque el proyecto usa `node:sqlite` (la base de datos que ya viene integrada dentro de Node).

  * **Opción A — Instalar Node.js desde la terminal de VS Code:**
    * En **Windows (10 / 11)**:
      ```powershell
      winget install OpenJS.NodeJS.LTS
      ```
    * En **Linux (Ubuntu / Debian)**:
      ```bash
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt install -y nodejs
      ```
  * **Opción B — Descargar el instalador desde el navegador:**
    * Entra a [https://nodejs.org/](https://nodejs.org/), descarga la versión **22 LTS (22.13.0 o superior)** y dale en **Next → Next → Install**.

> **Muy importante:** Si acabas de instalar Git o Node.js, **cierra Visual Studio Code por completo y vuélvelo a abrir** para que la terminal reconozca los comandos `git`, `node` y `npm`.

---

## Paso 2: Jalar (clonar) el repositorio desde GitHub

Ya con Git instalado, puedes jalar el proyecto desde la terminal o con los botones de VS Code:

### Opción A: Desde la terminal de VS Code
1. Abre la terminal (`Terminal → Nueva terminal`) y escribe:
   ```bash
   git clone https://github.com/ArmandoCN/sistema-turnos.git
   ```
2. Luego abre la carpeta recién descargada en VS Code: ve arriba a **Archivo → Abrir carpeta...** (*File → Open Folder...*), selecciona la carpeta **`sistema-turnos`** y dale en **Seleccionar carpeta**.

### Opción B: Con el botón de VS Code (sin comandos)
1. En la barra izquierda de VS Code haz clic en el ícono de **Control de código fuente** (el de la ramita, o presiona `Ctrl + Shift + G`).
2. Haz clic en **Clonar repositorio** (*Clone Repository*).
3. Pega la dirección del repositorio arriba y presiona **Enter**:
   ```text
   https://github.com/ArmandoCN/sistema-turnos.git
   ```
   *(Si te pide iniciar sesión con tu cuenta de GitHub, dale en **Allow / Permitir**).*
4. Elige dónde guardarlo (por ejemplo en **Escritorio** o **Documentos**) y cuando termine dale clic al botón **Abrir** (*Open*).

*(Nota: Cuando quieras jalar los últimos cambios que se hayan subido a GitHub, solo abre la terminal en VS Code y escribe **`git pull`**).*

---

## Paso 3: Instalar Express y encender el servidor desde la terminal

Con la carpeta `sistema-turnos` abierta en VS Code, abre la terminal (**Terminal → Nueva terminal**):

> **¿Te salió un error rojo en Windows al usar `npm`?**  
> A veces PowerShell en Windows bloquea `npm` y dice *"la ejecución de scripts está deshabilitada en este sistema"*. Si te pasa:
> * **Solución en 1 clic:** En la esquina derecha de la terminal de VS Code, junto al signo **`+`**, haz clic en la flechita **`v`** y elige **Command Prompt (cmd)** en vez de PowerShell.
> * **O ejecuta esto en PowerShell:**
>   ```powershell
>   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
>   ```

1. **Instalar Express desde la terminal de VS Code (solo se hace la primera vez):**
   ```bash
   npm install
   ```
   *(O si prefieres instalar el paquete directamente: `npm install express`).*

2. **Encender el servidor:**
   ```bash
   npm start
   ```
   *(También puedes arrancarlo escribiendo `node server.js`).*

Cuando veas este mensaje en la terminal, el servidor ya está corriendo y la base de datos `turnos.db` ya se creó sola:
```text
[Sistema de Turnos] Servidor corriendo en http://localhost:4782
```

*(Para apagar el servidor cuando termines, haz clic en la terminal y presiona `Ctrl + C`).*

---

## Paso 4: Cómo abrir y probar las 4 pantallas del sistema

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

# Bazar Bonito — Aplicación Móvil Android

Aplicación móvil nativa para Android de **Bazar Bonito**, optimizada específicamente para la gestión ágil de subastas, administración de prendas y captura directa desde **WhatsApp**.

---

## Características Principales

1. **Captura Rápida desde WhatsApp (Share Target)**:
   - Estando en cualquier chat de WhatsApp, pulsa **Compartir** en cualquier imagen de prenda y selecciona **"Agregar prenda a Bazar Bonito"**.
   - La aplicación se abrirá (o pasará al frente) automáticamente, procesará la imagen (corrigiendo la orientación EXIF de la cámara, redimensionándola y comprimiéndola en JPEG a máx 850px) y la cargará directamente en el formulario de nueva prenda.
   - El teclado se abrirá automáticamente en el campo **Nombre del producto**, listo para que solo escribas el nombre, precio y selecciones la talla.

2. **Diseñada para Gestión Rápida y Ágil en Teléfono**:
   - **Chips de Talla Rápida**: Botones táctiles (`Ch`, `M`, `L`, `XL`, `Sin Talla`) para adjudicar la talla con un solo toque sin abrir menús desplegables.
   - **Botón Flotante (FAB)**: Botón `+` siempre accesible en la esquina inferior derecha mientras navegas la lista para crear prendas al instante.
   - **Optimizada para pantalla móvil**: Visualización en 2 columnas, scroll suave, soporte háptico (vibraciones suaves al capturar y guardar) y controles táctiles generosos.

3. **Autenticación de Administrador con Google**:
   - Soporte completo para el inicio de sesión como Administrador (`toledooscar96@gmail.com`) a través de Firebase Auth.
   - Integración con ventanas emergentes seguras gestionadas a través del `WebChromeClient` nativo y User-Agent compatible con OAuth.

4. **Sincronización en Tiempo Real con Firestore**:
   - Todas las prendas, listas, entregas y compradoras se sincronizan en vivo con la misma base de datos de la versión web.

---

## Estructura del Proyecto

```
android_app/
├── app/
│   ├── build.gradle.kts          # Configuración del módulo de la app (SDK 34)
│   ├── proguard-rules.pro        # Reglas para Proguard / R8
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml   # Permisos y filtros de Intent (ACTION_SEND image/*)
│           ├── assets/
│           │   └── www/              # Aplicación web bundleada localmente (HTML, CSS, JS)
│           ├── java/com/bazarbonito/app/
│           │   ├── MainActivity.kt   # Actividad principal, WebView y recepción de WhatsApp
│           │   ├── AndroidBridge.kt  # Puente JavascriptInterface y hápticos
│           │   └── ImageUtils.kt     # Procesamiento, rotación EXIF y compresión de fotos
│           └── res/                  # Iconos adaptativos, temas y colores
├── gradle/wrapper/               # Wrapper de Gradle (8.7)
├── build.gradle.kts              # Configuración de compilación raíz
└── settings.gradle.kts           # Módulos del proyecto
```

---

## Cómo compilar o abrir en Android Studio

1. Abre **Android Studio**.
2. Selecciona **Open** y navega a la carpeta `android_app`.
3. Espera a que Gradle sincronice las dependencias automáticamente.
4. Conecta tu teléfono Android por USB (con Depuración USB activada) o inicia un emulador.
5. Haz clic en **Run** (`Shift + F10`) o ve a **Build > Build Bundle(s) / APK(s) > Build APK(s)** para generar el instalador `.apk`.

package com.bazarbonito.app

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    var pendingSharedImage: String? = null
    private var isWebAppLoaded: Boolean = false
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (fileChooserCallback == null) return@registerForActivityResult
        val results = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        fileChooserCallback?.onReceiveValue(results)
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Contenedor principal
        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(rootLayout)

        initWebView(rootLayout)
        setupBackNavigation()

        // Procesar intent inicial (por si fue abierta desde Compartir en WhatsApp)
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Procesar si la app ya estaba abierta y se comparte otra foto desde WhatsApp
        handleShareIntent(intent)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWebView(container: FrameLayout) {
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        container.addView(webView)

        // Configuración de AssetLoader para servir assets locales de manera segura en HTTPS
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.setSupportMultipleWindows(true)
        settings.javaScriptCanOpenWindowsAutomatically = true

        // User-Agent adaptado para permitir autenticación de Google sin bloqueo por WebView
        val defaultUa = settings.userAgentString
        val cleanUa = defaultUa
            .replace("; wv", "")
            .replace(Regex("Version/[0-9.]+"), "")
        settings.userAgentString = cleanUa

        // Habilitar cookies y almacenamiento de sesión
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        // Bridge JS <-> Android
        webView.addJavascriptInterface(AndroidBridge(this), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("whatsapp://") || url.startsWith("https://wa.me/") || url.startsWith("https://api.whatsapp.com/")) {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, request.url)
                        intent.setPackage("com.whatsapp")
                        try {
                            startActivity(intent)
                        } catch (e: Exception) {
                            startActivity(Intent(Intent.ACTION_VIEW, request.url))
                        }
                        return true
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                isWebAppLoaded = true
                pendingSharedImage?.let { base64 ->
                    injectSharedImage(base64)
                    pendingSharedImage = null
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // Manejador de selector de archivos para agregar imágenes manualmente o tomar fotos
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                return try {
                    val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        type = "image/*"
                    }
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    false
                }
            }

            // Manejador de ventanas popup (crucial para Google Sign-In)
            override fun onCreateWindow(
                view: WebView?,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: Message?
            ): Boolean {
                val popupWebView = WebView(this@MainActivity).apply {
                    this.settings.javaScriptEnabled = true
                    this.settings.domStorageEnabled = true
                    this.settings.userAgentString = cleanUa
                }

                val dialog = Dialog(this@MainActivity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
                dialog.setContentView(popupWebView)
                dialog.show()

                popupWebView.webChromeClient = object : WebChromeClient() {
                    override fun onCloseWindow(window: WebView?) {
                        dialog.dismiss()
                    }
                }

                popupWebView.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        // Si regresó a la app o completó OAuth de Firebase, cerrar popup
                        if (url?.contains("__/__auth/handler") == true || url?.contains("bonitobazar-6adcc.firebaseapp.com") == true) {
                            dialog.dismiss()
                        }
                    }
                }

                val transport = resultMsg?.obj as? WebView.WebViewTransport
                transport?.webView = popupWebView
                resultMsg?.sendToTarget()
                return true
            }
        }

        // Cargar aplicación local bundleada con HTTPS seguro
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    /**
     * Procesa intents entrantes de compartir imagen (desde WhatsApp, Galería, etc.)
     */
    private fun handleShareIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.action
        val type = intent.type

        if (Intent.ACTION_SEND == action && type != null && type.startsWith("image/")) {
            val imageUri: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }

            if (imageUri != null) {
                processSharedImage(imageUri)
            }
        }
    }

    /**
     * Procesa la imagen en background (optimización, orientación EXIF, redimensionado a 850px y JPEG)
     */
    private fun processSharedImage(uri: Uri) {
        lifecycleScope.launch(Dispatchers.IO) {
            val base64Data = ImageUtils.uriToBase64DataUrl(applicationContext, uri)
            withContext(Dispatchers.Main) {
                if (base64Data != null) {
                    if (isWebAppLoaded) {
                        injectSharedImage(base64Data)
                    } else {
                        pendingSharedImage = base64Data
                    }
                }
            }
        }
    }

    private fun injectSharedImage(base64Data: String) {
        val safeBase64 = base64Data.replace("'", "\\'")
        webView.evaluateJavascript(
            "if (typeof window.onSharedImageReceived === 'function') { window.onSharedImageReceived('$safeBase64'); }",
            null
        )
    }

    fun onWebAppReady() {
        pendingSharedImage?.let { base64 ->
            injectSharedImage(base64)
            pendingSharedImage = null
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}

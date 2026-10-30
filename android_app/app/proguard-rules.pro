# Reglas de Proguard para Bazar Bonito
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.bazarbonito.app.AndroidBridge { *; }

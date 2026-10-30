package com.bazarbonito.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min

object ImageUtils {

    /**
     * Convierte una Uri de imagen (de WhatsApp, galería o cámara) en una cadena Data URL en Base64
     * optimizada (máximo 850px, orientación corregida y compresión JPEG 75%).
     */
    fun uriToBase64DataUrl(context: Context, uri: Uri, maxDimension: Int = 850, quality: Int = 75): String? {
        return try {
            // 1. Obtener orientación EXIF si está disponible
            val orientation = getOrientation(context, uri)

            // 2. Obtener dimensiones de la imagen sin cargarla completa en memoria
            val options = BitmapFactory.Options().apply {
                inJustDecodeBounds = true
            }
            context.contentResolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, options)
            }

            if (options.outWidth <= 0 || options.outHeight <= 0) {
                return null
            }

            // 3. Calcular sample size para evitar OutOfMemory
            var sampleSize = 1
            val maxOriginal = max(options.outWidth, options.outHeight)
            while ((maxOriginal / (sampleSize * 2)) >= maxDimension) {
                sampleSize *= 2
            }

            // 4. Decodificar imagen con downsampling
            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.RGB_565
            }

            val decodedBitmap = context.contentResolver.openInputStream(uri)?.use { stream ->
                BitmapFactory.decodeStream(stream, null, decodeOptions)
            } ?: return null

            // 5. Aplicar rotación y redimensionado final
            val finalBitmap = adjustBitmap(decodedBitmap, orientation, maxDimension)

            // 6. Comprimir a JPEG
            val outputStream = ByteArrayOutputStream()
            finalBitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
            val byteArray = outputStream.toByteArray()

            if (finalBitmap != decodedBitmap && !decodedBitmap.isRecycled) {
                decodedBitmap.recycle()
            }
            if (!finalBitmap.isRecycled) {
                finalBitmap.recycle()
            }

            // 7. Retornar Data URL Base64 listo para usar en img.src y Firestore
            val base64 = Base64.encodeToString(byteArray, Base64.NO_WRAP)
            "data:image/jpeg;base64,$base64"
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    private fun getOrientation(context: Context, uri: Uri): Int {
        return try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                val exif = ExifInterface(stream)
                exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
    }

    private fun adjustBitmap(bitmap: Bitmap, orientation: Int, maxDimension: Int): Bitmap {
        val matrix = Matrix()

        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
        }

        val currentMax = max(bitmap.width, bitmap.height)
        if (currentMax > maxDimension) {
            val scale = maxDimension.toFloat() / currentMax.toFloat()
            matrix.postScale(scale, scale)
        }

        return Bitmap.createBitmap(
            bitmap,
            0,
            0,
            bitmap.width,
            bitmap.height,
            matrix,
            true
        )
    }
}

package com.nospoon.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.io.FileDescriptor
import java.io.InputStreamReader

class NospoonVpnService : VpnService() {

    companion object {
        const val TAG = "NospoonVPN"
        const val ACTION_START = "com.nospoon.vpn.START"
        const val ACTION_STOP = "com.nospoon.vpn.STOP"
        const val EXTRA_CONFIG_JSON = "configJson"
        const val NOTIFICATION_ID = 1
        const val CHANNEL_ID = "nospoon_vpn"
        const val ACTION_STATUS = "com.nospoon.vpn.STATUS"
        const val ACTION_QUERY = "com.nospoon.vpn.QUERY"
        const val EXTRA_STATUS_TEXT = "statusText"
        const val EXTRA_CONNECTED = "connected"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var vpnInterface: ParcelFileDescriptor? = null
    private var nospoonProcess: Process? = null
    private var stdoutReader: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    // Tracked state so Activity can query on resume
    private var currentStatusText = "Disconnected"
    private var currentConnected = false

    // TUN fd passed to the binary — must be closed explicitly on cleanup
    private var tunFdForBinary: Int = -1

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val configJson = intent.getStringExtra(EXTRA_CONFIG_JSON) ?: return START_NOT_STICKY
                val config = try {
                    JSONObject(configJson)
                } catch (e: Exception) {
                    Log.e(TAG, "Invalid config JSON: ${e.message}")
                    return START_NOT_STICKY
                }
                if (!config.has("server")) return START_NOT_STICKY
                startVpn(config)
                return START_STICKY
            }
            ACTION_STOP -> {
                stopVpn()
                return START_NOT_STICKY
            }
            ACTION_QUERY -> {
                broadcastStatus(currentStatusText, currentConnected)
                return START_NOT_STICKY
            }
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(text: String): Notification {
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 0,
            Intent(this, NospoonVpnService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("nospoon VPN")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(tapIntent)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_LOW)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disconnect", stopIntent)
            .build()
    }

    private fun startForegroundNotification() {
        val channel = NotificationChannel(
            CHANNEL_ID, "VPN Status", NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows VPN connection status"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        startForeground(NOTIFICATION_ID, buildNotification("Connecting..."))
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun startVpn(config: JSONObject) {
        // Tear down any existing connection before starting a new one
        if (nospoonProcess != null) {
            Log.d(TAG, "Cleaning up previous connection before restart")
            cleanup()
        }

        startForegroundNotification()

        // Keep CPU awake so DHT keepalives aren't killed by Doze
        if (wakeLock == null) {
            val pm = getSystemService(PowerManager::class.java)
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nospoon:vpn").apply {
                acquire()
            }
        }

        // Establish VPN interface
        val ipFull = config.optString("ip", "10.0.0.2/24")
        val parts = ipFull.split("/")
        val ip = parts[0]
        val prefix = if (parts.size > 1) parts[1].toInt() else 24
        val mtu = config.optInt("mtu", 1400)
        val fullTunnel = config.optBoolean("fullTunnel", false)

        val builder = Builder()
            .setSession("nospoon")
            .setMtu(mtu)
            .addAddress(ip, prefix)

        if (fullTunnel) {
            builder.addRoute("0.0.0.0", 0)
            builder.addDisallowedApplication(packageName)
            builder.addDnsServer("1.1.1.1")
            builder.addDnsServer("8.8.8.8")
            Log.d(TAG, "Full tunnel mode")
        } else {
            builder.addRoute(subnetAddress(ip, prefix), prefix)
            Log.d(TAG, "Subnet mode: ${subnetAddress(ip, prefix)}/$prefix")
        }

        vpnInterface = builder.establish()
        if (vpnInterface == null) {
            Log.e(TAG, "Failed to establish VPN interface")
            broadcastStatus("Error: VPN permission denied", false)
            stopSelf()
            return
        }

        // Get a blocking TUN fd for the binary
        val origFd = vpnInterface!!.fileDescriptor
        val fdField = FileDescriptor::class.java.getDeclaredField("descriptor")
        fdField.isAccessible = true
        val origFdNum = fdField.getInt(origFd)
        val tunFd = try {
            val openedFd = Os.open("/proc/self/fd/$origFdNum", OsConstants.O_RDWR, 0)
            fdField.getInt(openedFd)
        } catch (e: ErrnoException) {
            Log.w(TAG, "/proc/self/fd open failed, falling back to dup: ${e.message}")
            val dupPfd = vpnInterface!!.dup()
            val fd = dupPfd.detachFd()
            val tmpFd = FileDescriptor()
            fdField.setInt(tmpFd, fd)
            val flags = Os.fcntlInt(tmpFd, OsConstants.F_GETFL, 0)
            Os.fcntlInt(tmpFd, OsConstants.F_SETFL, flags and OsConstants.O_NONBLOCK.inv())
            fd
        }

        tunFdForBinary = tunFd

        // Write config to a temp file for the binary
        val configFile = File(cacheDir, "nospoon-config.jsonc")
        configFile.writeText(config.toString())

        // Find the nospoon binary (shipped as libnospoon.so via jniLibs)
        val binaryPath = applicationInfo.nativeLibraryDir + "/libnospoon.so"
        if (!File(binaryPath).exists()) {
            Log.e(TAG, "nospoon binary not found at $binaryPath")
            broadcastStatus("Error: binary not found", false)
            cleanup()
            return
        }

        // Spawn the nospoon binary with the TUN fd
        // Child process inherits the fd and the app's VPN-exempt UID
        Log.i(TAG, "Spawning nospoon binary: --tun-fd=$tunFd")
        val pb = ProcessBuilder(
            binaryPath, "up", "--tun-fd=$tunFd", configFile.absolutePath
        )
        pb.redirectErrorStream(true) // merge stderr into stdout
        nospoonProcess = pb.start()

        // Read stdout for status messages (JSON lines)
        stdoutReader = Thread {
            try {
                val reader = BufferedReader(InputStreamReader(nospoonProcess!!.inputStream))
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val l = line!!.trim()
                    Log.d(TAG, "nospoon: $l")

                    // Try to parse as JSON status message
                    try {
                        val msg = JSONObject(l)
                        handler.post { handleBinaryMessage(msg) }
                    } catch (_: Exception) {
                        // Plain text log line — check for known strings
                        if (l.contains("Connected to server")) {
                            handler.post {
                                updateNotification("Connected")
                                broadcastStatus("Connected", true)
                            }
                        } else if (l.contains("Connection lost") || l.contains("Reconnecting")) {
                            handler.post {
                                updateNotification("Reconnecting...")
                                broadcastStatus("Reconnecting...", false)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.d(TAG, "stdout reader ended: ${e.message}")
            }

            // Process exited
            handler.post {
                Log.i(TAG, "nospoon process exited")
                broadcastStatus("Disconnected", false)
                cleanup()
            }
        }.apply {
            isDaemon = true
            start()
        }

        broadcastStatus("Connecting...", false)
    }

    private fun handleBinaryMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "status" -> {
                val connected = msg.getBoolean("connected")
                val text = if (connected) "Connected" else "Reconnecting..."
                updateNotification(text)
                broadcastStatus(text, connected)
            }
            "error" -> {
                Log.e(TAG, "nospoon error: ${msg.getString("message")}")
                broadcastStatus("Error: ${msg.getString("message")}", false)
            }
        }
    }

    private fun broadcastStatus(text: String, connected: Boolean) {
        currentStatusText = text
        currentConnected = connected
        sendBroadcast(Intent(ACTION_STATUS).apply {
            setPackage(packageName)
            putExtra(EXTRA_STATUS_TEXT, text)
            putExtra(EXTRA_CONNECTED, connected)
        })
    }

    private fun subnetAddress(hostIp: String, prefix: Int): String {
        val parts = hostIp.split(".").map { it.toInt() }
        val ipInt = (parts[0] shl 24) or (parts[1] shl 16) or (parts[2] shl 8) or parts[3]
        val mask = if (prefix == 0) 0 else (-1 shl (32 - prefix))
        val network = ipInt and mask
        return "${(network shr 24) and 0xFF}.${(network shr 16) and 0xFF}.${(network shr 8) and 0xFF}.${network and 0xFF}"
    }

    private fun stopVpn() {
        nospoonProcess?.destroy()
        // cleanup() will be called when stdout reader detects process exit
        // Force cleanup after 2s if process doesn't die
        handler.postDelayed({ cleanup() }, 2000)
    }

    private fun cleanup() {
        nospoonProcess?.destroyForcibly()
        nospoonProcess = null
        stdoutReader = null

        // Close the TUN fd before the VPN interface
        if (tunFdForBinary >= 0) {
            try {
                Os.close(FileDescriptor().also {
                    val f = FileDescriptor::class.java.getDeclaredField("descriptor")
                    f.isAccessible = true
                    f.setInt(it, tunFdForBinary)
                })
            } catch (_: ErrnoException) {}
            tunFdForBinary = -1
        }
        vpnInterface?.close()
        vpnInterface = null
        if (wakeLock?.isHeld == true) wakeLock?.release()
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    override fun onRevoke() {
        broadcastStatus("Disconnected", false)
        cleanup()
        super.onRevoke()
    }
}

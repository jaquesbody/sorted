package com.jaquesbody.sorted;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads a published APK and opens Android's installer.
 *
 * The web layer cannot install anything: a WebView that opens an APK URL only
 * hands it to the browser, which saves the file and leaves a notification
 * sitting there. That is the "always pending" update — the download finished,
 * but nothing ever asked Android to install it.
 *
 * So the download happens here, into the app's own cache, and the result is
 * handed to ACTION_VIEW as a FileProvider content URI. Android then shows its
 * normal install/update prompt, signed with the same key as the installed app,
 * so the data stays. Silent installation is deliberately not attempted: it
 * needs device-owner privileges or a Play-store install, and a finance app
 * replacing itself without a tap is not a thing to do to someone.
 *
 * Android 8 and later also gate this behind "install unknown apps". When that
 * is off the plugin opens that one settings screen and, on the way back, opens
 * the installer if the person allowed it — rather than sending them hunting
 * through Settings themselves.
 */
@CapacitorPlugin(name = "SortedUpdater")
public class SortedUpdaterPlugin extends Plugin {

    private static final String APK_NAME = "sorted-update.apk";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;

    /** The file between the download and the installer reading it. */
    private File apkFile;

    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("There is no update file to download.");
            return;
        }

        // Network and disk work never belongs on the UI thread. The answer to
        // the call is sent from whichever thread is ready, which Capacitor
        // handles.
        getBridge().execute(() -> {
            try {
                apkFile = download(url);
            } catch (Exception ex) {
                call.reject("Could not download the update: " + friendly(ex));
                return;
            }
            getBridge().executeOnMainThread(() -> beginInstall(call));
        });
    }

    /**
     * Android 8+ keeps a per-app "install unknown apps" switch. Opening the
     * installer without it just shows a refusal, so the switch is offered
     * first and the install continues when the person comes back.
     */
    private void beginInstall(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Sorted is not open, so the installer could not be shown.");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName()));
            try {
                startActivityForResult(call, settings, "onPermissionResult");
                return;
            } catch (ActivityNotFoundException ex) {
                // Some builds have no such screen. The installer itself will
                // ask, so fall through rather than failing the update.
            }
        }
        launchInstaller(call);
    }

    @ActivityCallback
    private void onPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Activity activity = getActivity();
        if (activity != null
            && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || activity.getPackageManager().canRequestPackageInstalls())) {
            launchInstaller(call);
            return;
        }
        JSObject out = new JSObject();
        out.put("needsPermission", true);
        call.resolve(out);
    }

    private void launchInstaller(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null || apkFile == null || !apkFile.exists()) {
            call.reject("The update file is no longer there. Tap Update again.");
            return;
        }

        Uri apk;
        try {
            apk = FileProvider.getUriForFile(
                activity,
                activity.getPackageName() + ".fileprovider",
                apkFile);
        } catch (IllegalArgumentException ex) {
            call.reject("Android could not read the downloaded update.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(apk, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_ACTIVITY_NEW_TASK);
        // The package installer reads the file through the content URI. On a
        // few OEM builds the read grant is honoured only when the URI is also
        // in the clip data, so the same grant is placed there as well.
        intent.setClipData(ClipData.newRawUri("update", apk));
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException ex) {
            call.reject("Android has no installer available for this file.");
            return;
        } catch (SecurityException ex) {
            call.reject("Android refused to open the installer. Allow installs from Sorted, then tap Update again.");
            return;
        }

        JSObject out = new JSObject();
        out.put("launched", true);
        call.resolve(out);
    }

    /**
     * Downloads to a temporary file and only then puts it in place, so a
     * half-finished download can never be mistaken for an APK. GitHub answers
     * an asset URL with a redirect, which HttpURLConnection follows on its own
     * for HTTPS.
     */
    private File download(String source) throws IOException {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("the cache folder could not be made");
        }
        File target = new File(dir, APK_NAME);
        File temp = new File(dir, APK_NAME + ".part");

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(source).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("User-Agent", "Sorted-Updater");
            connection.setRequestProperty("Accept", "application/octet-stream");

            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("the download server said " + status);
            }

            try (InputStream in = connection.getInputStream();
                 FileOutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
            }
        } finally {
            if (connection != null) connection.disconnect();
        }

        // An error page saved under .apk would fail at install time with a
        // message no one can act on. An APK is a ZIP, so it starts with PK.
        try (FileInputStream in = new FileInputStream(temp)) {
            byte[] magic = new byte[2];
            if (in.read(magic) != 2 || magic[0] != 'P' || magic[1] != 'K') {
                throw new IOException("the file that arrived was not an APK");
            }
        }
        if (temp.length() < 1024) {
            throw new IOException("the downloaded file was too small");
        }

        if (target.exists() && !target.delete()) {
            throw new IOException("the previous update file could not be replaced");
        }
        if (!temp.renameTo(target)) {
            throw new IOException("the update file could not be put in place");
        }
        return target;
    }

    /** Keeps the note in the app readable when the cause is technical. */
    private String friendly(Exception ex) {
        String message = ex.getMessage();
        return message == null || message.isEmpty() ? "the download failed" : message;
    }
}

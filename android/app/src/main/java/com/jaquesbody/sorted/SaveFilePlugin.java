package com.jaquesbody.sorted;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves a finished export wherever the person chooses.
 *
 * Android's answer to "write a document into shared storage" has been the
 * Storage Access Framework since KitKat, and it is the one route that asks for
 * no permission at all — which matters here, because Sorted holds four and a
 * storage permission would also mean a runtime dialog standing between someone
 * and their own file.
 *
 * ACTION_CREATE_DOCUMENT opens the system save screen with the name already
 * filled in. Whatever they pick comes back as a content:// URI this app is
 * granted write access to for that file only, so there is no folder to
 * hard-code and no path that differs between manufacturers.
 *
 * The alternative — writing straight into Download/ with a File path — is
 * deprecated as of API 29 and behaves differently depending on the Android
 * version underneath, which is exactly the kind of thing that can only be
 * disproved by someone holding the phone.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    /** Held between launching the screen and getting the answer back. */
    private byte[] pending;

    @PluginMethod
    public void save(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data");
        String encoding = call.getString("encoding", "utf8");

        if (name == null || name.isEmpty()) {
            call.reject("There is no file name to save as.");
            return;
        }
        if (data == null) {
            call.reject("There is nothing to save.");
            return;
        }

        byte[] bytes;
        try {
            bytes = "base64".equals(encoding)
                ? Base64.decode(data, Base64.DEFAULT)
                : data.getBytes(StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            call.reject("The file contents could not be read.");
            return;
        }
        pending = bytes;

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime)
            .putExtra(Intent.EXTRA_TITLE, name);

        startActivityForResult(call, intent, "onSaveResult");
    }

    @ActivityCallback
    private void onSaveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        // Backing out of the save screen is a decision rather than a failure,
        // so it resolves with a flag instead of rejecting — a rejected call
        // would be reported to the person as an export that went wrong.
        if (result.getResultCode() != Activity.RESULT_OK
            || result.getData() == null
            || result.getData().getData() == null) {
            JSObject out = new JSObject();
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }

        byte[] bytes = pending;
        pending = null;
        if (bytes == null) {
            call.reject("There is nothing to save.");
            return;
        }

        Uri uri = result.getData().getData();
        try {
            write(uri, bytes);
        } catch (Exception ex) {
            call.reject("Could not save the file: " + ex.getMessage());
            return;
        }

        JSObject out = new JSObject();
        out.put("uri", uri.toString());
        call.resolve(out);
    }

    /**
     * "wt" truncates rather than overwriting in place, so a shorter file saved
     * over a longer one cannot leave the old tail behind. Not every document
     * provider accepts the mode, and the plain one is fine where it does.
     */
    private void write(Uri uri, byte[] bytes) throws IOException {
        OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt");
        if (out == null) {
            out = getContext().getContentResolver().openOutputStream(uri);
        }
        if (out == null) {
            throw new IOException("the chosen location refused the file");
        }
        try {
            out.write(bytes);
        } finally {
            out.close();
        }
    }
}

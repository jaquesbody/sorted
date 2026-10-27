package com.jaquesbody.sorted;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * A folder the person chooses, and one file inside it.
 *
 * This is the piece that makes "choose a folder and sync" possible. Nothing in
 * the web layer can read a folder on Android — a WebView has no filesystem — and
 * the platform only lets an app reach a folder the user picked through the
 * system picker, with the grant remembered. So: ACTION_OPEN_DOCUMENT_TREE, then
 * takePersistableUriPermission, and after that this app can read and write that
 * one folder for as long as the folder exists.
 *
 * The folder is the transport. Anything that keeps two devices' folders in step
 * — Syncthing, Google Drive's offline files, Dropbox, a USB stick — becomes a
 * sync route without Sorted knowing it exists, which is why this replaces two
 * separate "coming soon" entries rather than adding a mechanism per provider.
 *
 * Deliberately no androidx.documentfile dependency: it is one more artifact to
 * resolve for four calls that DocumentsContract answers directly, and this app
 * builds on a machine that is not always online.
 */
@CapacitorPlugin(name = "SortedFolder")
public class SortedFolderPlugin extends Plugin {

    /** The one file Sorted reads and writes. Kept in step with SYNC_FILE in sync.js. */
    private static final String FILE_NAME = "sorted-snapshot.json";
    private static final String MIME_JSON = "application/json";
    private static final String[] NAME_COLUMN =
        new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME };

    /**
     * The system folder picker. Whatever comes back is held on to across
     * reboots, which is the whole reason this is the picker rather than a path:
     * a folder chosen today still works after the phone restarts, and no
     * storage permission is asked for at any point.
     */
    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "onPickResult");
    }

    @ActivityCallback
    private void onPickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        // Backing out of the picker is a decision, not a failure — the same
        // reading SaveFile takes for its own screen. Reporting it as an error
        // would tell someone their sync is broken when they simply changed
        // their mind.
        if (result.getResultCode() != Activity.RESULT_OK
            || result.getData() == null
            || result.getData().getData() == null) {
            JSObject out = new JSObject();
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }

        Uri tree = result.getData().getData();
        int flags = result.getData().getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

        // Some providers hand back a folder they will not hold open — Drive
        // without a signed-in account is the common one. Resolving without the
        // grant would hand the app a folder that works until the app restarts,
        // which is worse than saying so now.
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, flags);
        } catch (SecurityException ex) {
            call.reject("Android would not let Sorted keep access to that folder. Try another one.");
            return;
        }

        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        out.put("name", folderName(tree));
        call.resolve(out);
    }

    /**
     * An existing snapshot file, chosen through the system's Open list.
     *
     * The Cloud route uses a document rather than a folder because a folder
     * tree only works with providers that publish a browseable tree through
     * the picker. Google Drive and OneDrive do; Proton does not, which is
     * exactly the "Proton appears in Save to but not in My Files" report. A
     * document is a shape every provider in that list can answer.
     *
     * The type is a wildcard rather than application/json on purpose: providers
     * disagree about what a .json file is, and hiding the file someone just
     * saved is worse than showing a few extra ones. The content is validated
     * when it is read.
     */
    @PluginMethod
    public void pickFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onFileResult");
    }

    /**
     * A new snapshot file, created through the system's Save-to list.
     *
     * Creating it here, rather than asking someone to make an empty file in a
     * file manager first, is what makes the first device and the second device
     * the same two taps: Save new copy on one, Choose file on the other.
     */
    @PluginMethod
    public void createFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(MIME_JSON)
            .putExtra(Intent.EXTRA_TITLE, FILE_NAME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onFileResult");
    }

    @ActivityCallback
    private void onFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK
            || result.getData() == null
            || result.getData().getData() == null) {
            JSObject out = new JSObject();
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }

        Uri file = result.getData().getData();
        int flags = result.getData().getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            getContext().getContentResolver().takePersistableUriPermission(file, flags);
        } catch (SecurityException ex) {
            call.reject("Android would not let Sorted keep access to that file. Try another one.");
            return;
        }

        JSObject out = new JSObject();
        out.put("uri", file.toString());
        out.put("name", displayName(file));
        call.resolve(out);
    }

    /**
     * The one document the Cloud route was pointed at.
     *
     * A file made by ACTION_CREATE_DOCUMENT is empty until the first sync writes
     * to it, so an empty string is a value rather than a fault; the web layer
     * treats it as "nothing there yet" and writes the first snapshot. A document
     * that has been deleted or unmounted is the failure, and says so in words
     * that tell someone to pick it again.
     */
    @PluginMethod
    public void readFile(PluginCall call) {
        Uri file = documentOrReject(call);
        if (file == null) return;
        JSObject out = new JSObject();
        try {
            // Ask the provider to bring its copy up to date first. A provider is
            // allowed to answer a read from a cache, and Proton's Android
            // provider does: after another device uploads, a phone can return a
            // document hours old while its Modified column still carries the old
            // time. That is indistinguishable from "the copies match" in the web
            // layer, so the nudge is worth trying here rather than deciding on
            // stale bytes.
            refreshDocument(file);
            // Asking for the document's own metadata before its content is
            // deliberate. Providers that keep a local copy of a cloud document
            // refresh it on a query more readily than on a bare open, and the
            // time is worth having on the card: "Already up to date" with the
            // file's age beside it is a fact, rather than a mystery.
            long modified = modifiedAt(file);
            out.put("exists", true);
            out.put("modified", modified);
            out.put("data", readText(file));
            call.resolve(out);
        } catch (Exception ex) {
            call.reject(readableFile(ex));
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        Uri file = documentOrReject(call);
        if (file == null) return;
        String data = call.getString("data");
        if (data == null) {
            call.reject("There is nothing to save.");
            return;
        }
        try {
            writeText(file, data);
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("uri", file.toString());
            call.resolve(out);
        } catch (Exception ex) {
            call.reject(readableFile(ex));
        }
    }

    /**
     * The snapshot as text, or a flag saying there is not one yet.
     *
     * "No file" is the ordinary first-run answer rather than an error: the first
     * sync creates it. Returning it as a distinguishable value — rather than
     * throwing — is what stops the app reporting a working folder as broken.
     */
    @PluginMethod
    public void read(PluginCall call) {
        Uri tree = treeOrReject(call);
        if (tree == null) return;
        JSObject out = new JSObject();
        try {
            Uri file = findFile(tree);
            if (file == null) {
                out.put("exists", false);
                call.resolve(out);
                return;
            }
            out.put("exists", true);
            out.put("data", readText(file));
            call.resolve(out);
        } catch (Exception ex) {
            call.reject(readable(ex));
        }
    }

    /**
     * Writes the snapshot, creating the file the first time.
     *
     * Creating rather than requiring the file to exist first matters: it is the
     * difference between the first device having to be set up in a particular
     * order and either device being able to go first.
     */
    @PluginMethod
    public void write(PluginCall call) {
        Uri tree = treeOrReject(call);
        if (tree == null) return;
        String data = call.getString("data");
        if (data == null) {
            call.reject("There is nothing to save.");
            return;
        }
        try {
            ContentResolver resolver = getContext().getContentResolver();
            Uri file = findFile(tree);
            if (file == null) {
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
                file = DocumentsContract.createDocument(resolver, parent, MIME_JSON, FILE_NAME);
                if (file == null) {
                    call.reject("That folder would not accept a new file.");
                    return;
                }
            }
            writeText(file, data);
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("uri", file.toString());
            call.resolve(out);
        } catch (Exception ex) {
            call.reject(readable(ex));
        }
    }

    /**
     * Lets go of the folder, for when the person picks a different one.
     *
     * Releasing the grant is not tidiness: Android keeps persisted grants for a
     * limited number of folders per app, and leaving one held for every folder
     * ever chosen is how an app ends up unable to take a new one.
     */
    @PluginMethod
    public void forget(PluginCall call) {
        String uriText = call.getString("uri");
        if (uriText != null && !uriText.isEmpty()) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                    Uri.parse(uriText),
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                // Already gone, or never held. Nothing to undo either way.
            }
        }
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    // ------------------------------------------------------------------ inside

    /** The one file, if the folder holds it. Null is "nothing there yet". */
    private Uri findFile(Uri tree) {
        ContentResolver resolver = getContext().getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
            tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor cursor = resolver.query(children,
            new String[] {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME
            }, null, null, null)) {
            if (cursor == null) return null;
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                if (FILE_NAME.equals(name)) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0));
                }
            }
        } catch (Exception ex) {
            // A folder that cannot be listed is the provider's business, not a
            // separate outcome: the caller gets the same "choose it again".
            throw new IllegalStateException(readable(ex), ex);
        }
        return null;
    }

    private String folderName(Uri tree) {
        Uri document = DocumentsContract.buildDocumentUriUsingTree(
            tree, DocumentsContract.getTreeDocumentId(tree));
        try (Cursor cursor = getContext().getContentResolver()
            .query(document, NAME_COLUMN, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // A provider that will not name the folder still handed us one.
        }
        return "the folder you chose";
    }

    /**
     * Asks the provider to reconcile the document with its source before a read.
     *
     * A content provider is allowed to serve a cached copy, and Proton's Android
     * provider does: a phone can answer with a document that is hours old while
     * the file has already been replaced elsewhere. `refresh` is the one call
     * the platform offers for exactly this, and it exists from API 31. It is
     * advisory — a provider may ignore it — so this is best effort and its
     * failure must never stop the read. The read still happens either way, and
     * the web layer's pending clock covers the case where the refresh was not
     * honoured.
     */
    private void refreshDocument(Uri file) {
        if (Build.VERSION.SDK_INT < 31) return;
        try {
            getContext().getContentResolver().refresh(file, null, null);
        } catch (Exception ignored) {
            // Best effort: the content is still worth reading as it stands.
        }
    }

    /**
     * When the provider says the document was last changed, in milliseconds, or
     * zero when it will not say. A provider that does not keep the column is not
     * a fault here; it only means the card cannot show a time.
     */
    private long modifiedAt(Uri file) {
        try (Cursor cursor = getContext().getContentResolver().query(
            file, new String[] { DocumentsContract.Document.COLUMN_LAST_MODIFIED },
            null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getLong(0);
            }
        } catch (Exception ignored) {
            // The content is still worth reading without a timestamp.
        }
        return 0;
    }

    /** The document's own display name, for the row on the card. */
    private String displayName(Uri file) {
        try (Cursor cursor = getContext().getContentResolver()
            .query(file, NAME_COLUMN, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // The file was handed to us; the picker said what it was called.
        }
        return "the file you chose";
    }

    private String readText(Uri file) throws IOException {
        InputStream in = getContext().getContentResolver().openInputStream(file);
        if (in == null) throw new IOException("that file could not be opened");
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) != -1) buffer.write(chunk, 0, read);
            return buffer.toString(StandardCharsets.UTF_8.name());
        } finally {
            in.close();
        }
    }

    /**
     * Overwriting in place, truncated, trying every shape the provider might
     * accept before calling it a failure.
     *
     * Truncation is not a nicety: a snapshot is one JSON document and a shorter
     * one written over a longer one leaves the old tail behind, which is a file
     * nothing can read.
     *
     * The shapes are tried on the file rather than on the open. That is the
     * whole point of this method: a provider can hand back a stream that opens
     * happily and then dies on the first write. The old code only moved to the
     * next mode when *opening* failed, so a document that opened "rwt" and then
     * answered EBADF was retried as "rwt" forever, which is the message about
     * the drive losing hold of the file that kept coming back after a second
     * device had written to it.
     */
    private void writeText(Uri file, String data) throws IOException {
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        IOException last = null;
        for (int round = 0; round < 2; round++) {
            try {
                writeBytes(file, bytes);
                return;
            } catch (IOException ex) {
                last = ex;
            }
            // A provider can accept every byte and then fail the close, which is
            // what Proton does after its uploader has taken the content. The
            // file itself is the only authority on whether the write landed, so
            // read it before calling the write a failure.
            if (readBackMatches(file, data)) return;
            if (round == 0) {
                try {
                    Thread.sleep(700);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw last;
                }
            }
        }
        throw last;
    }

    /**
     * One write, in every shape the provider offers.
     *
     * A shape that dies is not the end of the attempt: the next one truncates
     * the file and starts again. A provider that answers the first shape with a
     * dead descriptor often accepts the second, and the cost of trying is one
     * open rather than a failed sync.
     *
     * The catch is deliberately broad. A provider is entitled to answer an
     * unsupported mode with a runtime exception rather than an IOException, and
     * Proton does: asking for "wt" on a document it will only open for "r"
     * throws "wt is not supported, only r". Catching only IOException there
     * ended the whole attempt at the second shape, so "w" and the seekable
     * fallback were never tried and the reader was shown the provider's mode
     * jargon. Every shape is now tried whatever it throws, and only the last
     * failure leaves this method.
     */
    private void writeBytes(Uri file, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        IOException last = null;
        for (String mode : new String[] { "rwt", "wt", "w" }) {
            try {
                writeThrough(resolver.openOutputStream(file, mode), bytes);
                return;
            } catch (Exception ex) {
                last = writeFailure(ex);
            }
        }
        try {
            writeThrough(resolver.openOutputStream(file), bytes);
            return;
        } catch (Exception ex) {
            last = writeFailure(ex);
        }
        // Last resort: a descriptor opened read/write and truncated by hand.
        // Some providers will not open a document for truncation at all but
        // will hand out a seekable descriptor.
        try {
            writeSeekable(file, bytes);
            return;
        } catch (Exception ex) {
            last = writeFailure(ex);
        }
        // No shape throws nothing, so this is only a guard for the compiler and
        // for the one case where a provider returns without opening anything.
        if (last == null) last = new IOException("that file could not be written to");
        throw last;
    }

    /**
     * The failure from one write shape, as an IOException the caller can report.
     *
     * A provider's own IOException is kept as it is, because its words are
     * sometimes the only explanation there is. Anything else is wrapped, so a
     * rejected mode cannot escape as an unchecked exception and take the rest of
     * the attempt with it.
     */
    private IOException writeFailure(Exception ex) {
        if (ex instanceof IOException) return (IOException) ex;
        String message = ex.getMessage();
        return new IOException(message == null || message.isEmpty()
            ? "that file could not be written to" : message, ex);
    }

    /** One stream, written and closed, with a close that failed after the bytes still a success. */
    private void writeThrough(OutputStream out, byte[] bytes) throws IOException {
        if (out == null) throw new IOException("that file could not be opened for writing");
        boolean complete = false;
        IOException failure = null;
        try {
            out.write(bytes);
            out.flush();
            complete = true;
        } catch (IOException ex) {
            failure = ex;
        } finally {
            try {
                out.close();
            } catch (IOException closeError) {
                if (failure == null) failure = closeError;
            }
        }
        if (failure == null) return;
        // Every byte was accepted before the failure, so what the provider is
        // complaining about is the close of a descriptor it has already taken
        // the content from.
        if (complete && deadDescriptor(failure)) return;
        throw failure;
    }

    private void writeSeekable(Uri file, byte[] bytes) throws IOException {
        ParcelFileDescriptor descriptor =
            getContext().getContentResolver().openFileDescriptor(file, "rw");
        if (descriptor == null) throw new IOException("that file could not be opened for writing");
        FileOutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor);
        // Truncating first is what makes a shorter snapshot safe on a real file:
        // without it, a shorter document leaves the old tail behind and nothing
        // can read it.
        //
        // A provider that hands back a pipe cannot truncate, and Proton does
        // exactly that: the descriptor opens for "rw", then answers "Invalid
        // argument" (EINVAL) on truncate. That is not the write being refused. A
        // pipe carries the whole document to the provider, which replaces the
        // file when the stream closes, so there is no old tail to remove.
        // Aborting there was why every Android write ended in "Invalid
        // argument" while the same file could still be read.
        try {
            try {
                out.getChannel().truncate(0);
            } catch (IOException ex) {
                if (!notSeekable(ex)) throw ex;
            }
        } catch (IOException ex) {
            try {
                out.close();
            } catch (IOException ignored) {
                // The failure that matters is the one being thrown.
            }
            throw ex;
        }
        // writeThrough closes the stream, and a close that fails after every
        // byte was accepted is the case it already knows how to read.
        writeThrough(out, bytes);
    }

    /** The descriptor is a pipe rather than a seekable file. */
    private boolean notSeekable(IOException ex) {
        String message = String.valueOf(ex.getMessage()).toLowerCase(Locale.US);
        return message.contains("invalid argument") || message.contains("illegal seek")
            || message.contains("not seekable") || message.contains("espipe");
    }

    /** Whether the file already holds exactly this text, whatever the stream said. */
    private boolean readBackMatches(Uri file, String expected) {
        try {
            return expected.equals(readText(file));
        } catch (Exception ex) {
            return false;
        }
    }

    /** The descriptor died under us, rather than the provider refusing the file. */
    private boolean deadDescriptor(IOException ex) {
        String message = String.valueOf(ex.getMessage()).toLowerCase(Locale.US);
        return message.contains("ebadf") || message.contains("bad file descriptor")
            || message.contains("epipe") || message.contains("broken pipe");
    }

    private Uri treeOrReject(PluginCall call) {
        String uriText = call.getString("uri");
        if (uriText == null || uriText.isEmpty()) {
            call.reject("No folder has been chosen yet.");
            return null;
        }
        return Uri.parse(uriText);
    }

    private Uri documentOrReject(PluginCall call) {
        String uriText = call.getString("uri");
        if (uriText == null || uriText.isEmpty()) {
            call.reject("No file has been chosen yet.");
            return null;
        }
        return Uri.parse(uriText);
    }

    /**
     * What went wrong, in words someone can act on. The two that actually happen
     * are a grant that has lapsed and a folder that has been deleted or
     * unmounted; everything else is passed on rather than flattened, because a
     * provider's own wording beats a guess.
     */
    private String readable(Exception ex) {
        if (ex instanceof SecurityException) {
            return "Sorted can no longer use that folder. Choose it again.";
        }
        if (ex instanceof FileNotFoundException) {
            return "That folder is no longer there. Choose it again.";
        }
        String message = ex.getMessage();
        return message == null || message.isEmpty()
            ? "That folder could not be used."
            : message;
    }

    private String readableFile(Exception ex) {
        if (ex instanceof SecurityException) {
            return "Sorted can no longer use that file. Choose it again.";
        }
        if (ex instanceof FileNotFoundException) {
            return "That file is no longer there. Choose it again.";
        }
        String message = ex.getMessage();
        // A provider that will only open a document for reading says so in the
        // vocabulary of file modes ("wt is not supported, only r"). That is not
        // a sentence for the person holding the phone, and it reads as a Sorted
        // fault when it is a permission the drive gave.
        if (message != null && message.toLowerCase(Locale.US).matches(".*(only r\\b|read-only|readonly).*")) {
            return "Android only gave Sorted read access to that file, so it cannot save to it.";
        }
        return message == null || message.isEmpty()
            ? "That file could not be used."
            : message;
    }
}

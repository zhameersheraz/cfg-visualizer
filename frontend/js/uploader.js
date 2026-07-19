/**
 * uploader.js — drag-and-drop + click-to-browse file input glue.
 *
 * The dropzone DOM is owned by index.html. This module just wires up events
 * and fires `onFile(file)` when the user picks something.
 */

export function wireDropzone(zoneEl, fileInputEl, onFile) {
    if (!zoneEl) return;

    zoneEl.addEventListener("click", () => fileInputEl?.click());
    zoneEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputEl?.click();
        }
    });

    if (fileInputEl) {
        fileInputEl.addEventListener("change", () => {
            const f = fileInputEl.files?.[0];
            if (f) onFile(f);
        });
    }

    ["dragenter", "dragover"].forEach((evt) => {
        zoneEl.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zoneEl.classList.add("dragover");
        });
    });

    ["dragleave", "drop"].forEach((evt) => {
        zoneEl.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            zoneEl.classList.remove("dragover");
        });
    });

    zoneEl.addEventListener("drop", (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile(f);
    });

    // The page itself also receives drops — redirect them to the dropzone
    // if the user missed the box. Avoids the browser navigating to the file.
    ["dragover", "drop"].forEach((evt) => {
        window.addEventListener(evt, (e) => {
            if (e.target.closest("#dropZone")) return;
            e.preventDefault();
        });
    });
}

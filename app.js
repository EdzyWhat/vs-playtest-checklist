// Renders a project's TESTING.md items as clickable pass/fail/unsure cards with a notes
// field per item, plus one general-notes field. "Submit" POSTs the whole report to
// /api/submit, which queues it as a JSON file (under that project's own
// .playtest-submissions/) for an agent or teammate to read and review in a later
// session -- this page never writes to TESTING.md itself (that file's checked boxes are
// meant to be written only from confirmed, first-hand evidence).
//
// Detailed mode swaps an item's single freeform note for a separate Expected/Actual
// pair -- worth the extra typing for a tricky check, overkill for routine ones. It can
// be turned on two ways, independently: the page-wide toggle (persisted via
// localStorage, applies to every item by default) and a per-item "Detailed" button
// (applies to just that one item, on top of whatever the page-wide toggle is set to).
// An item is rendered as detailed if EITHER is on -- see isItemDetailed().

const pageTitleEl = document.getElementById("pageTitle");
const groupsEl = document.getElementById("groups");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const generalNotesEl = document.getElementById("generalNotes");
const detailedModeEl = document.getElementById("detailedMode");
const generalScreenshotsEl = document.getElementById("generalScreenshots");

const DETAILED_MODE_KEY = "playtest-checklist-detailed-mode";

let loadedGroups = [];

// Screenshots not tied to a specific checklist item (pasted into the general-notes
// field) collect here. Mirrors each item's own `_screenshots` array -- see
// attachPasteHandler/uploadScreenshot, which both work off a generic {fingerprint,
// screenshots, container} "target" rather than assuming a checklist item.
const generalScreenshots = [];

function applyDetailedMode(enabled) {
  document.body.classList.toggle("detailed-mode", enabled);
  // Per-item toggle buttons read as "active" if either the global mode or their own
  // item-level override is on, so the button never looks inactive while its field is
  // actually showing.
  document.querySelectorAll(".item-detail-toggle").forEach((btn) => {
    const itemEl = btn.closest(".item");
    btn.classList.toggle("active", enabled || itemEl.classList.contains("detailed"));
  });
}

detailedModeEl.checked = localStorage.getItem(DETAILED_MODE_KEY) === "1";
applyDetailedMode(detailedModeEl.checked);

detailedModeEl.addEventListener("change", () => {
  localStorage.setItem(DETAILED_MODE_KEY, detailedModeEl.checked ? "1" : "0");
  applyDetailedMode(detailedModeEl.checked);
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadMeta() {
  try {
    const res = await fetch("/api/meta");
    const data = await res.json();
    if (data.projectName) {
      pageTitleEl.textContent = `${data.projectName} — Playtest checklist`;
      document.title = `${data.projectName} — Playtest checklist`;
    }
    return data;
  } catch (err) {
    return { found: false };
  }
}

function renderGroups(groups, metaFound) {
  groupsEl.innerHTML = "";

  if (!groups.length) {
    const message = metaFound === false
      ? "No TESTING.md found. Run this from a project root that has one, or pass --testing-file to server.py."
      : "TESTING.md has no items yet.";
    groupsEl.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    submitBtn.disabled = true;
    return;
  }

  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "group";
    const heading = document.createElement("h2");
    heading.textContent = group.name;
    groupEl.appendChild(heading);

    for (const item of group.items) {
      const itemEl = document.createElement("div");
      itemEl.className = "item" + (item.annotation ? " already-confirmed" : "");
      itemEl.dataset.fingerprint = item.fingerprint;
      itemEl.dataset.taskId = item.taskId || "";
      itemEl.dataset.text = item.text;
      // Screenshots attach as soon as they're pasted/captured (not held until Submit --
      // see the module comment on why). `target` is the shared shape uploadScreenshot/
      // renderScreenshotThumbnail/attachPasteHandler operate on -- see the comment above
      // those functions. `itemEl._screenshots` also stays a direct reference so
      // collectReport() can read it back off the element without threading `target`
      // through the whole render tree.
      itemEl._screenshots = [];
      const target = {
        fingerprint: item.fingerprint,
        screenshots: itemEl._screenshots,
        get container() { return itemEl.querySelector(".screenshots"); },
      };

      const topEl = document.createElement("div");
      topEl.className = "item-top";

      const textEl = document.createElement("div");
      textEl.className = "item-text";
      textEl.innerHTML = `${escapeHtml(item.text)} <code>${item.fingerprint}</code>`;
      topEl.appendChild(textEl);

      const detailToggleBtn = document.createElement("button");
      detailToggleBtn.type = "button";
      detailToggleBtn.className = "item-detail-toggle";
      detailToggleBtn.textContent = "Detailed";
      detailToggleBtn.title = "Split this item's note into Expected vs. Actual (just for this item).";
      detailToggleBtn.addEventListener("click", () => {
        const nowDetailed = !itemEl.classList.contains("detailed");
        itemEl.classList.toggle("detailed", nowDetailed);
        detailToggleBtn.classList.toggle("active", nowDetailed || detailedModeEl.checked);
      });
      topEl.appendChild(detailToggleBtn);

      const captureBtn = document.createElement("button");
      captureBtn.type = "button";
      captureBtn.className = "item-detail-toggle screenshot-btn";
      captureBtn.textContent = "\u{1F4F7} Screenshot";
      captureBtn.title = "Opens the macOS screenshot selector (same as Cmd+Shift+Ctrl+4) and copies the result to your clipboard -- then paste (Cmd+V) it into the note field below to attach it here.";
      captureBtn.addEventListener("click", () => triggerCapture(captureBtn));
      topEl.appendChild(captureBtn);

      itemEl.appendChild(topEl);

      if (item.annotation) {
        const annoEl = document.createElement("div");
        annoEl.className = "existing-annotation";
        const label = item.annotation.kind === "confirmed" ? "Already confirmed" : "Already flagged broken";
        annoEl.textContent = `${label}: ${item.annotation.text}`;
        itemEl.appendChild(annoEl);
      }

      const verdictsEl = document.createElement("div");
      verdictsEl.className = "verdicts";
      const VERDICT_BUTTONS = [
        ["pass", "Looks good", "Behaves as expected -- no issues seen"],
        ["fail", "Still broken", "Reproduces the problem, or behaves wrong in some way"],
        ["unsure", "Not sure", "Tried it but couldn't tell, or hit an unrelated snag"],
      ];
      for (const [verdict, label, hint] of VERDICT_BUTTONS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "verdict-btn";
        btn.dataset.verdict = verdict;
        btn.textContent = label;
        btn.title = hint;
        btn.addEventListener("click", () => {
          const alreadyActive = btn.classList.contains("active");
          verdictsEl.querySelectorAll(".verdict-btn").forEach((b) => b.classList.remove("active"));
          if (!alreadyActive) btn.classList.add("active");
        });
        verdictsEl.appendChild(btn);
      }
      itemEl.appendChild(verdictsEl);

      // Simple mode: one freeform note.
      const noteEl = document.createElement("textarea");
      noteEl.className = "item-note simple-note";
      noteEl.placeholder = "What did you actually see? (optional, but helps review) -- paste a screenshot here with ⌘V";
      noteEl.title = "Freeform -- describe what happened. Switch on Detailed mode above to split this into Expected vs. Actual instead. Paste (⌘V) a clipboard image to attach a screenshot.";
      itemEl.appendChild(noteEl);

      // Detailed mode: Expected vs. Actual, only shown when toggled on.
      const eaGroup = document.createElement("div");
      eaGroup.className = "expected-actual-group";

      const expectedLabel = document.createElement("div");
      expectedLabel.className = "field-label";
      expectedLabel.textContent = "Expected";
      eaGroup.appendChild(expectedLabel);
      const expectedEl = document.createElement("textarea");
      expectedEl.className = "item-note expected-actual expected-note";
      expectedEl.placeholder = "What the item says should happen";
      expectedEl.title = "What you expected to see, based on the checklist item's own description.";
      eaGroup.appendChild(expectedEl);

      const actualLabel = document.createElement("div");
      actualLabel.className = "field-label";
      actualLabel.textContent = "Actual";
      eaGroup.appendChild(actualLabel);
      const actualEl = document.createElement("textarea");
      actualEl.className = "item-note expected-actual actual-note";
      actualEl.placeholder = "What actually happened -- paste a screenshot here with ⌘V";
      actualEl.title = "What you actually observed -- call out anything that differed from Expected. Paste (⌘V) a clipboard image to attach a screenshot.";
      eaGroup.appendChild(actualEl);

      itemEl.appendChild(eaGroup);

      // Any note field on this item accepts a pasted clipboard image (Cmd+V), whether
      // it came from a manual screenshot or the "Screenshot" button above triggering
      // macOS's own capture-to-clipboard tool server-side.
      [noteEl, expectedEl, actualEl].forEach((el) => attachPasteHandler(el, target));

      const screenshotsEl = document.createElement("div");
      screenshotsEl.className = "screenshots";
      itemEl.appendChild(screenshotsEl);

      groupEl.appendChild(itemEl);
    }

    groupsEl.appendChild(groupEl);
  }
}

// A "target" is either a checklist item (fingerprint = item's own fingerprint,
// screenshots array = itemEl._screenshots, container = its ".screenshots" div, built in
// renderGroups()) or the page-wide general-notes field (fingerprint "general",
// screenshots array = module-level generalScreenshots, container = generalScreenshotsEl,
// built as generalTarget near triggerCapture() below) -- either way, upload/render/
// paste-handling code below just needs {fingerprint, screenshots, container}.

// Uploads a pasted clipboard image to the server immediately (not held until Submit --
// see the module comment for why) and renders a small thumbnail so the tester gets
// visual confirmation the attach worked.
async function uploadScreenshot(target, blob) {
  try {
    const res = await fetch(`/api/screenshot?fingerprint=${encodeURIComponent(target.fingerprint)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/png" },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "upload failed");
    target.screenshots.push(data.file);
    renderScreenshotThumbnail(target, data.file);
  } catch (err) {
    statusEl.textContent = `Failed to attach screenshot: ${String(err)}`;
  }
}

function renderScreenshotThumbnail(target, filename) {
  const thumbEl = document.createElement("div");
  thumbEl.className = "screenshot-thumb";

  const img = document.createElement("img");
  img.src = `/api/screenshots/${encodeURIComponent(filename)}`;
  img.alt = filename;
  img.title = "Click to open full size";
  img.addEventListener("click", () => window.open(img.src, "_blank"));
  thumbEl.appendChild(img);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "screenshot-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "Remove from this report (the uploaded file itself is left on disk)";
  removeBtn.addEventListener("click", () => {
    const idx = target.screenshots.indexOf(filename);
    if (idx !== -1) target.screenshots.splice(idx, 1);
    thumbEl.remove();
  });
  thumbEl.appendChild(removeBtn);

  target.container.appendChild(thumbEl);
}

// Shared by every note/expected/actual/general-notes textarea: a native `paste` event
// carries clipboardData.items, which includes a "file" kind + image/* type whenever the
// clipboard holds an image (from a manual macOS screenshot, the "Screenshot" button
// above, or any other image-to-clipboard source) -- no special permission prompt needed,
// unlike navigator.clipboard.read().
function attachPasteHandler(textareaEl, target) {
  textareaEl.addEventListener("paste", (event) => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (const dataItem of items) {
      if (dataItem.kind === "file" && dataItem.type.startsWith("image/")) {
        event.preventDefault(); // don't also drop garbage/filename text into the field
        const blob = dataItem.getAsFile();
        if (blob) uploadScreenshot(target, blob);
        return;
      }
    }
    // No image found -- fall through to the default paste behavior (plain text).
  });
}

// Wired to each item's "Screenshot" button: asks the server to run macOS's own
// interactive screenshot-to-clipboard tool (screencapture -i -c) so the user doesn't
// need to remember the Cmd+Shift+Ctrl+4 shortcut. Leaves the result on the clipboard --
// the user still pastes (Cmd+V) into a note field afterward, same as a manual capture,
// so there's exactly one attach path to reason about.
async function triggerCapture(btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "Selecting…";
  try {
    const res = await fetch("/api/capture", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "capture failed");
    if (data.cancelled) {
      statusEl.textContent = "Screenshot selection cancelled.";
    } else {
      statusEl.textContent = "Screenshot copied -- paste (⌘V) it into a note field to attach it.";
    }
  } catch (err) {
    statusEl.textContent = `Screenshot capture failed: ${String(err)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// General-notes field (not tied to a specific checklist item) gets the same paste
// support as item notes, using the "general" fingerprint bucket on the server.
const generalTarget = {
  fingerprint: "general",
  screenshots: generalScreenshots,
  container: generalScreenshotsEl,
};
attachPasteHandler(generalNotesEl, generalTarget);

async function load() {
  const meta = await loadMeta();
  try {
    const res = await fetch("/api/checklist");
    const data = await res.json();
    loadedGroups = data.groups || [];
    renderGroups(loadedGroups, meta.found);
  } catch (err) {
    groupsEl.innerHTML = `<div class="empty">Failed to load checklist: ${escapeHtml(String(err))}</div>`;
  }
}

function collectReport() {
  const globalDetailed = detailedModeEl.checked;
  const items = [];
  document.querySelectorAll(".item").forEach((itemEl) => {
    const activeBtn = itemEl.querySelector(".verdict-btn.active");
    const detailed = globalDetailed || itemEl.classList.contains("detailed");

    let note = null, expected = null, actual = null;
    if (detailed) {
      expected = itemEl.querySelector(".expected-note").value.trim() || null;
      actual = itemEl.querySelector(".actual-note").value.trim() || null;
    } else {
      note = itemEl.querySelector(".simple-note").value.trim() || null;
    }

    const screenshots = itemEl._screenshots || [];
    if (!activeBtn && !note && !expected && !actual && !screenshots.length) return; // untouched item, nothing to report
    items.push({
      fingerprint: itemEl.dataset.fingerprint,
      taskId: itemEl.dataset.taskId || null,
      text: itemEl.dataset.text,
      verdict: activeBtn ? activeBtn.dataset.verdict : null,
      detailed,
      note,
      expected,
      actual,
      screenshots,
    });
  });

  return {
    items,
    detailedMode: globalDetailed,
    generalNotes: generalNotesEl.value.trim() || null,
    generalScreenshots: generalScreenshots.slice(),
  };
}

submitBtn.addEventListener("click", async () => {
  const report = collectReport();
  if (!report.items.length && !report.generalNotes && !report.generalScreenshots.length) {
    statusEl.textContent = "Nothing marked or noted yet -- check off at least one item or add a note.";
    return;
  }

  submitBtn.disabled = true;
  statusEl.textContent = "Submitting...";
  try {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "submit failed");
    statusEl.textContent = `Submitted (${data.file}). Bring this up with your agent/teammate to have it reviewed.`;
  } catch (err) {
    statusEl.textContent = `Failed to submit: ${String(err)}`;
  } finally {
    submitBtn.disabled = false;
  }
});

load();

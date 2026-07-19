// Renders a project's TESTING.md items as clickable pass/fail/unsure cards with a notes
// field per item, plus one general-notes field. "Submit" POSTs the whole report to
// /api/submit, which queues it as a JSON file (under that project's own
// .playtest-submissions/) for an agent or teammate to read and review in a later
// session -- this page never writes to TESTING.md itself (that file's checked boxes are
// meant to be written only from confirmed, first-hand evidence).
//
// Detailed mode (toggle, persisted via localStorage) swaps each item's single freeform
// note for a separate Expected/Actual pair -- worth the extra typing for a tricky check,
// overkill for routine ones, hence the toggle rather than always-on.

const pageTitleEl = document.getElementById("pageTitle");
const groupsEl = document.getElementById("groups");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const generalNotesEl = document.getElementById("generalNotes");
const detailedModeEl = document.getElementById("detailedMode");

const DETAILED_MODE_KEY = "playtest-checklist-detailed-mode";

let loadedGroups = [];

function applyDetailedMode(enabled) {
  document.body.classList.toggle("detailed-mode", enabled);
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

      const textEl = document.createElement("div");
      textEl.className = "item-text";
      textEl.innerHTML = `${escapeHtml(item.text)} <code>${item.fingerprint}</code>`;
      itemEl.appendChild(textEl);

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
      noteEl.placeholder = "What did you actually see? (optional, but helps review)";
      noteEl.title = "Freeform -- describe what happened. Switch on Detailed mode above to split this into Expected vs. Actual instead.";
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
      actualEl.placeholder = "What actually happened";
      actualEl.title = "What you actually observed -- call out anything that differed from Expected.";
      eaGroup.appendChild(actualEl);

      itemEl.appendChild(eaGroup);

      groupEl.appendChild(itemEl);
    }

    groupsEl.appendChild(groupEl);
  }
}

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
  const detailed = detailedModeEl.checked;
  const items = [];
  document.querySelectorAll(".item").forEach((itemEl) => {
    const activeBtn = itemEl.querySelector(".verdict-btn.active");

    let note = null, expected = null, actual = null;
    if (detailed) {
      expected = itemEl.querySelector(".expected-note").value.trim() || null;
      actual = itemEl.querySelector(".actual-note").value.trim() || null;
    } else {
      note = itemEl.querySelector(".simple-note").value.trim() || null;
    }

    if (!activeBtn && !note && !expected && !actual) return; // untouched item, nothing to report
    items.push({
      fingerprint: itemEl.dataset.fingerprint,
      taskId: itemEl.dataset.taskId || null,
      text: itemEl.dataset.text,
      verdict: activeBtn ? activeBtn.dataset.verdict : null,
      note,
      expected,
      actual,
    });
  });

  return {
    items,
    detailedMode: detailed,
    generalNotes: generalNotesEl.value.trim() || null,
  };
}

submitBtn.addEventListener("click", async () => {
  const report = collectReport();
  if (!report.items.length && !report.generalNotes) {
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

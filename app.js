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
const tocEl = document.getElementById("toc");
const groupsEl = document.getElementById("groups");
const submitBtn = document.getElementById("submitBtn");
const statusEl = document.getElementById("status");
const generalNotesEl = document.getElementById("generalNotes");
const detailedModeEl = document.getElementById("detailedMode");
const generalScreenshotsEl = document.getElementById("generalScreenshots");
const tabBarEl = document.getElementById("tabBar");
const reviewBannerEl = document.getElementById("reviewBanner");

// When served over the LAN the server requires a token on /api/* requests (see
// server.py's --lan mode). It's carried in the page URL (?token=...), so we read it once
// here and re-attach it to every API call. Empty for plain localhost use, where apiUrl()
// leaves URLs untouched and no token is required. Relative URLs mean the page never needs
// to know its own host -- fetches resolve against whatever machine served the page.
const API_TOKEN = new URLSearchParams(location.search).get("token") || "";
function apiUrl(path) {
  if (!API_TOKEN) return path;
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(API_TOKEN);
}

const DETAILED_MODE_KEY = "playtest-checklist-detailed-mode";
// Collapsed groups are fully manual (no auto-collapse based on progress) and persist by
// group *name*, not position -- so reordering/editing TESTING.md elsewhere doesn't
// silently reset what you'd already tucked away. Stored as an array of names rather
// than one key per group so there's a single localStorage entry to reason about.
const COLLAPSED_GROUPS_KEY = "playtest-checklist-collapsed-groups";

// Which lifecycle tab is showing. Persisted so a reload keeps you where you were.
const ACTIVE_TAB_KEY = "playtest-checklist-active-tab";

// The tabs, in display order. Each item maps to exactly one bucket via bucketForItem():
//   totest    -- untested items AND items flagged "Still broken" (they need a retest, so
//                they belong on the working list, badged; see bucketForItem)
//   completed -- items with a **Confirmed** verdict
//   backlog   -- items with a **Backlogged** verdict (deferred; not ready to test)
//   obsolete  -- items with an **Obsolete** verdict (feature changed; test no longer applies)
const TABS = [
  { id: "totest", label: "To Test" },
  { id: "completed", label: "Completed" },
  { id: "backlog", label: "Backlog" },
  { id: "obsolete", label: "Obsolete" },
];
const DEFAULT_TAB = "totest";

let activeTab = localStorage.getItem(ACTIVE_TAB_KEY) || DEFAULT_TAB;
if (!TABS.some((t) => t.id === activeTab)) activeTab = DEFAULT_TAB;

// Derive an item's tab bucket from its latest verdict annotation (parsed server-side into
// item.latestKind -- the kind of the most recent verdict-bearing entry, ignoring freeform
// progress notes). No verdict -> it's still to test. "broken" also lands in "totest" -- a
// still-broken item stays on the working list for a retest rather than being tucked away as
// done. Only "confirmed"/"backlog"/"obsolete" are terminal buckets.
function bucketForItem(item) {
  const kind = item.latestKind;
  if (kind === "confirmed") return "completed";
  if (kind === "backlog") return "backlog";
  if (kind === "obsolete") return "obsolete";
  return "totest"; // null (untested) or "broken" (needs retest)
}

function loadCollapsedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || "[]"));
  } catch (err) {
    return new Set();
  }
}

function saveCollapsedGroups(set) {
  localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
}

const collapsedGroups = loadCollapsedGroups();

// Turns a group heading into a stable id for anchor links (`#group-...`). Two groups
// with the same name (unusual, but TESTING.md doesn't forbid it) get distinct ids by
// suffixing the second occurrence, so anchors/collapse-state never collide silently.
function slugifyGroupName(name, seenSlugs) {
  const base = "group-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = base;
  let n = 2;
  while (seenSlugs.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  seenSlugs.add(slug);
  return slug;
}

let loadedGroups = [];
// Slugs for loadedGroups, index-aligned -- computed once in renderGroups (from the full
// group set, so ids stay stable) and reused when a tab switch rebuilds the filtered TOC.
let loadedGroupSlugs = [];

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

// A deliberately tiny inline-markdown renderer for the little bit of markup TESTING.md
// prose actually uses: `code`, **bold**, and *italic*. Everything HTML-dangerous is escaped
// FIRST; then we re-inject only these three tags, so this never opens an injection path via
// TESTING.md content (backticks/asterisks survive escaping as literals). Code spans are
// pulled out before bold/italic so a `*` INSIDE code (e.g. `PinnedRowTint*`) is never
// mistaken for an italic marker. Block-level markdown (lists, headings, links) is out of
// scope on purpose -- these fields are single runs of prose, not documents.
function renderInlineMarkdown(text) {
  const escaped = escapeHtml(text);
  // split() with a capture group interleaves the non-code parts (even indices) with the
  // captured code-span contents (odd indices).
  return escaped
    .split(/`([^`]+)`/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${part}</code>`; // inside a code span: no further markup
      // Bold before italic so `**x**` is consumed by the double-star rule rather than
      // leaving a stray `*` for the single-star rule to trip over.
      return part
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    })
    .join("");
}

// Optional convention (see this repo's README / the authoring skill that writes
// TESTING.md): an item's text may lead with a `**Up to four words.**` summary -- a
// quick "what to actually do" flag before the fuller description. The lead-in gets a
// distinct treatment (bold + slight size bump); the rest of the description renders through
// the shared inline-markdown renderer above, so `code`/**bold**/*italic* in a description
// come out formatted rather than as literal asterisks/backticks.
const LEAD_IN_RE = /^\*\*([^*]+)\*\*\s*/;

function formatItemText(text) {
  const match = text.match(LEAD_IN_RE);
  if (!match) return renderInlineMarkdown(text);
  const rest = text.slice(match[0].length);
  return `<strong class="item-lead-in">${escapeHtml(match[1])}</strong> ${renderInlineMarkdown(rest)}`;
}

// An item accumulates a timeline of agent-written annotation entries (one per
// `- **label:** body` bullet under it in TESTING.md -- see server.py). Rather than mashing
// the whole history into one paragraph (the old behavior, which produced an unreadable wall
// of text during a long iteration), render each entry on its own line: older entries
// collapse to just their bold label (click to expand the body), and the LATEST entry is
// always expanded and visually focused -- that's the guidance that matters right now.
//
// Each entry carries an optional `kind` (a recognized verdict: confirmed/broken/backlog/
// obsolete) which colors its dot; freeform progress notes (kind=null, e.g. "Deferred") get
// a neutral dot. `.dataset.kind` is set so CSS can color per kind.
function renderAnnotationTimeline(annotations) {
  const wrap = document.createElement("div");
  wrap.className = "annotation-timeline";
  const lastIndex = annotations.length - 1;

  annotations.forEach((entry, i) => {
    const isLatest = i === lastIndex;
    const entryEl = document.createElement("div");
    entryEl.className = "annotation-entry" + (isLatest ? " latest" : " collapsed");
    if (entry.kind) entryEl.dataset.kind = entry.kind;

    // A header row: a status dot, the bold label, and (for older entries) a chevron
    // affording expand/collapse. The whole header toggles collapse on click.
    const headerEl = document.createElement("div");
    headerEl.className = "annotation-header";

    const dot = document.createElement("span");
    dot.className = "annotation-dot";
    headerEl.appendChild(dot);

    const labelEl = document.createElement("span");
    labelEl.className = "annotation-label";
    labelEl.textContent = entry.label;
    headerEl.appendChild(labelEl);

    if (isLatest) {
      const tag = document.createElement("span");
      tag.className = "annotation-latest-tag";
      tag.textContent = "Latest";
      headerEl.appendChild(tag);
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "annotation-body";
    // innerHTML is safe here: renderInlineMarkdown escapes first, then re-injects only
    // code/bold/italic tags -- so `code`/**bold**/*italic* in the note render formatted.
    bodyEl.innerHTML = renderInlineMarkdown(entry.text);

    // The latest entry is fixed-open (nothing to toggle). Older entries collapse/expand on
    // a header click; if an older entry somehow has no body, there's nothing to reveal so
    // don't make it look clickable.
    if (!isLatest && entry.text) {
      headerEl.classList.add("clickable");
      headerEl.title = "Click to expand/collapse this note";
      headerEl.addEventListener("click", () => {
        entryEl.classList.toggle("collapsed");
      });
    }

    entryEl.appendChild(headerEl);
    if (entry.text) entryEl.appendChild(bodyEl);
    wrap.appendChild(entryEl);
  });

  return wrap;
}

async function loadMeta() {
  try {
    const res = await fetch(apiUrl("/api/meta"));
    const data = await res.json();
    if (data.projectName) {
      pageTitleEl.textContent = `${data.projectName} — Playtest checklist`;
      document.title = `${data.projectName} — Playtest checklist`;
    }
    renderReviewBanner(data.pendingSubmissions || 0);
    return data;
  } catch (err) {
    return { found: false };
  }
}

// Accountability backstop: while submitted reports sit unreviewed (loose JSON in
// .playtest-submissions/, before an agent moves them to reviewed/), show a reminder so a
// forgotten submission is visible to the human rather than silently lost. Count comes
// from /api/meta (server.py count_pending_submissions).
function renderReviewBanner(pending) {
  if (!pending) {
    reviewBannerEl.style.display = "none";
    return;
  }
  const n = pending === 1 ? "1 submission" : `${pending} submissions`;
  reviewBannerEl.style.display = "";
  reviewBannerEl.textContent =
    `📥 ${n} awaiting review. Ask your agent to review the queue in ` +
    `.playtest-submissions/ and record a verdict for each item (see REVIEW.md).`;
}

// Pinned rail on the right edge of the viewport (see .toc in index.html): collapsed,
// it's just one small tick per group; hovering anywhere over the rail expands a panel
// with the full clickable list. Skipped entirely for a single-group checklist -- one
// tick/link would just repeat the one heading already visible below.
function renderToc(groups, groupSlugs) {
  if (groups.length < 2) {
    tocEl.innerHTML = "";
    tocEl.style.display = "none";
    return;
  }
  tocEl.style.display = "";
  // One tick per ITEM (not per group), so the collapsed rail advances as you scroll
  // through individual items, not just between sections. The first tick of each group
  // after the first gets a group-start marker for a little extra spacing, so the rail
  // still reads as grouped rather than one undifferentiated column.
  const ticks = groups.map((group, gi) =>
    group.items.map((item, ii) =>
      `<div class="toc-tick${gi > 0 && ii === 0 ? " toc-tick-group-start" : ""}" data-fingerprint="${item.fingerprint}"></div>`
    ).join("")
  ).join("");
  const items = groups.map((group, i) => {
    const confirmed = group.items.filter((it) => it.latestKind === "confirmed").length;
    const subItems = group.items.map((item) => {
      // Tooltip shows the plain text (lead-in markers stripped) since a title attribute
      // can't render the bolding formatItemText applies to the visible link text.
      const plainText = item.text.replace(LEAD_IN_RE, "$1 — ");
      return `<li class="toc-subitem" data-fingerprint="${item.fingerprint}"><a href="#item-${item.fingerprint}" title="${escapeHtml(plainText)}">${formatItemText(item.text)}</a></li>`;
    }).join("");
    return `<li><a href="#${groupSlugs[i]}" class="toc-group-link" data-group-index="${i}">${escapeHtml(group.name)}</a><span class="count">${confirmed}/${group.items.length}</span><ul class="toc-subitems">${subItems}</ul></li>`;
  }).join("");
  tocEl.innerHTML = `${ticks}<div class="toc-panel"><div class="toc-title">Jump to</div><ul>${items}</ul></div>`;
}

// Scroll-spy: keep the rail's active tick and the panel's active link in sync with
// whichever ITEM is currently in view, so both the collapsed rail and the expanded panel
// read as a "you are here" indicator at item granularity (scrolling 6.6 -> 7.6 advances
// the highlight), not just between sections. An IntersectionObserver tracks each item
// card; the topmost item intersecting the viewport wins, and its parent group link is
// lit too for section context. Re-created on every renderToc since the item set (and
// their DOM nodes) can change on re-render.
let tocObserver = null;
function observeGroupsForToc(groups) {
  if (tocObserver) tocObserver.disconnect();

  // Flat, in-document-order list of item fingerprints, plus a fingerprint -> group-index
  // map so the active item can also light its section's group link.
  const orderedFps = [];
  const fpGroupIndex = new Map();
  groups.forEach((group, gi) => {
    group.items.forEach((item) => {
      orderedFps.push(item.fingerprint);
      fpGroupIndex.set(item.fingerprint, gi);
    });
  });
  const fpOrder = new Map(orderedFps.map((fp, i) => [fp, i]));

  const setActive = (fp) => {
    tocEl.querySelectorAll(".active").forEach((el) => el.classList.remove("active"));
    if (fp == null) return;
    tocEl.querySelector(`.toc-tick[data-fingerprint="${fp}"]`)?.classList.add("active");
    tocEl.querySelector(`.toc-subitem[data-fingerprint="${fp}"]`)?.classList.add("active");
    const gi = fpGroupIndex.get(fp);
    if (gi != null) tocEl.querySelector(`.toc-group-link[data-group-index="${gi}"]`)?.classList.add("active");
  };

  // Track visibility per item so we can always pick the topmost visible one, rather
  // than react to whichever entry fired last (which flip-flops when scrolling fast).
  const visible = new Set();

  const pickTopmost = () => {
    if (!visible.size) return; // keep the last active when nothing's intersecting
    const topFp = [...visible].reduce((a, b) => (fpOrder.get(a) <= fpOrder.get(b) ? a : b));
    setActive(topFp);
  };

  tocObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const fp = entry.target.dataset.fingerprint;
      if (entry.isIntersecting) visible.add(fp);
      else visible.delete(fp);
    }
    pickTopmost();
  // Bias the "in view" band toward the top of the viewport so the active item is the
  // one you're reading near the top, not one barely peeking in from the bottom.
  }, { rootMargin: "0px 0px -70% 0px" });

  orderedFps.forEach((fp) => {
    const el = document.getElementById(`item-${fp}`);
    if (el) tocObserver.observe(el);
  });

  // Seed an initial active state (top item) before any scroll happens.
  if (orderedFps.length) setActive(orderedFps[0]);
}

function renderGroups(groups, metaFound) {
  groupsEl.innerHTML = "";

  if (!groups.length) {
    const message = metaFound === false
      ? "No TESTING.md found. Run this from a project root that has one, or pass --testing-file to server.py."
      : "TESTING.md has no items yet.";
    groupsEl.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
    tocEl.innerHTML = "";
    tocEl.style.display = "none";
    tabBarEl.style.display = "none";
    submitBtn.disabled = true;
    return;
  }

  const seenSlugs = new Set();
  const groupSlugs = groups.map((group) => slugifyGroupName(group.name, seenSlugs));
  loadedGroupSlugs = groupSlugs;

  groups.forEach((group, groupIndex) => {
    const groupEl = document.createElement("div");
    const slug = groupSlugs[groupIndex];
    groupEl.id = slug;
    groupEl.className = "group" + (collapsedGroups.has(group.name) ? " collapsed" : "");

    const headerEl = document.createElement("div");
    headerEl.className = "group-header";
    headerEl.title = "Click to collapse/expand this section (remembered next time you open the checklist).";

    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.textContent = "▾";
    headerEl.appendChild(chevron);

    const heading = document.createElement("h2");
    heading.textContent = group.name;
    headerEl.appendChild(heading);

    const confirmedCount = group.items.filter((it) => it.latestKind === "confirmed").length;
    const countEl = document.createElement("span");
    countEl.className = "group-count";
    countEl.textContent = `${confirmedCount}/${group.items.length}`;
    headerEl.appendChild(countEl);

    headerEl.addEventListener("click", () => {
      const nowCollapsed = !groupEl.classList.contains("collapsed");
      groupEl.classList.toggle("collapsed", nowCollapsed);
      if (nowCollapsed) collapsedGroups.add(group.name);
      else collapsedGroups.delete(group.name);
      saveCollapsedGroups(collapsedGroups);
    });
    groupEl.appendChild(headerEl);

    for (const item of group.items) {
      const itemEl = document.createElement("div");
      const bucket = bucketForItem(item);
      // Terminal buckets (a done/parked record) render dimmed; a still-broken item is
      // NOT terminal -- it sits on the To Test list awaiting a retest, so it stays at
      // full strength and gets a "broken" badge instead (below).
      const terminal = bucket !== "totest";
      itemEl.className = "item" + (terminal ? " terminal-status" : "");
      // The bucket drives which tab this item shows under -- read back by applyActiveTab
      // when toggling tab-hidden, so tab switching never has to re-parse annotations.
      itemEl.dataset.bucket = bucket;
      // Anchor target for the TOC panel's per-item sub-links (see renderToc) -- keyed by
      // fingerprint since it's already guaranteed unique and stable across re-renders.
      itemEl.id = `item-${item.fingerprint}`;
      itemEl.dataset.fingerprint = item.fingerprint;
      itemEl.dataset.taskId = item.taskId || "";
      itemEl.dataset.text = item.text;
      // Screenshots attach as soon as they're pasted (not held until Submit -- see the
      // module comment on why). `target` is the shared shape uploadScreenshot/
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
      // A still-broken item is kept on the To Test list; badge it so it's visibly "retest
      // this", not a fresh untested item.
      const brokenBadge = item.latestKind === "broken"
        ? ` <span class="item-badge broken" title="Flagged still broken on a prior pass -- retest after the fix">broken · retest</span>`
        : "";
      textEl.innerHTML = `${formatItemText(item.text)} <code>${item.fingerprint}</code>${brokenBadge}`;
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

      itemEl.appendChild(topEl);

      if (item.annotations && item.annotations.length) {
        itemEl.appendChild(renderAnnotationTimeline(item.annotations));
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

      // Any note field on this item accepts a pasted clipboard image (Cmd+V).
      [noteEl, expectedEl, actualEl].forEach((el) => attachPasteHandler(el, target));

      const screenshotsEl = document.createElement("div");
      screenshotsEl.className = "screenshots";
      itemEl.appendChild(screenshotsEl);

      groupEl.appendChild(itemEl);
    }

    groupsEl.appendChild(groupEl);
  });

  // Build the tab bar, then show only the active tab's items. applyActiveTab handles the
  // TOC (rail + observer) for the filtered set, so -- unlike before -- the rail only ever
  // reflects the items actually visible under the current tab.
  renderTabBar();
  applyActiveTab();
}

// Counts per bucket across all loaded items -- drives the little count pill on each tab.
function bucketCounts() {
  const counts = { totest: 0, completed: 0, backlog: 0, obsolete: 0 };
  loadedGroups.forEach((group) => {
    group.items.forEach((item) => { counts[bucketForItem(item)] += 1; });
  });
  return counts;
}

function renderTabBar() {
  if (!loadedGroups.length) {
    tabBarEl.style.display = "none";
    return;
  }
  const counts = bucketCounts();
  tabBarEl.style.display = "";
  tabBarEl.innerHTML = "";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (tab.id === activeTab ? " active" : "");
    btn.dataset.tab = tab.id;
    btn.innerHTML = `${tab.label} <span class="tab-count">${counts[tab.id]}</span>`;
    btn.addEventListener("click", () => {
      if (activeTab === tab.id) return;
      activeTab = tab.id;
      localStorage.setItem(ACTIVE_TAB_KEY, activeTab);
      tabBarEl.querySelectorAll(".tab-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.tab === activeTab));
      applyActiveTab();
    });
    tabBarEl.appendChild(btn);
  }
}

// Show only the items whose bucket matches the active tab; hide the rest (kept in the DOM
// so marks survive a tab switch). A group with no visible items is hidden whole. Then
// rebuild the TOC for just the visible subset. Called on first render and every tab switch.
function applyActiveTab() {
  const visibleGroups = [];
  const visibleSlugs = [];
  loadedGroups.forEach((group, groupIndex) => {
    const groupEl = document.getElementById(loadedGroupSlugs[groupIndex]);
    if (!groupEl) return;
    let anyVisible = false;
    group.items.forEach((item) => {
      const itemEl = groupEl.querySelector(`.item[data-fingerprint="${item.fingerprint}"]`);
      if (!itemEl) return;
      const show = itemEl.dataset.bucket === activeTab;
      itemEl.classList.toggle("tab-hidden", !show);
      if (show) anyVisible = true;
    });
    groupEl.classList.toggle("tab-hidden", !anyVisible);
    if (anyVisible) {
      // The filtered group carries only its visible items into the TOC.
      visibleGroups.push({
        name: group.name,
        items: group.items.filter((it) => bucketForItem(it) === activeTab),
      });
      visibleSlugs.push(loadedGroupSlugs[groupIndex]);
    }
  });

  if (!visibleGroups.length) {
    // Nothing in this bucket -- show a per-tab empty note in the (otherwise all-hidden)
    // groups area, and clear the rail. Reuses the shared .empty styling.
    let emptyEl = groupsEl.querySelector(".empty.tab-empty");
    if (!emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.className = "empty tab-empty";
      groupsEl.appendChild(emptyEl);
    }
    const label = TABS.find((t) => t.id === activeTab).label;
    emptyEl.textContent = `Nothing in "${label}" yet.`;
    emptyEl.style.display = "";
    tocEl.innerHTML = "";
    tocEl.style.display = "none";
    return;
  }
  const existingEmpty = groupsEl.querySelector(".empty.tab-empty");
  if (existingEmpty) existingEmpty.style.display = "none";

  renderToc(visibleGroups, visibleSlugs);
  observeGroupsForToc(visibleGroups);
}

// A "target" is either a checklist item (fingerprint = item's own fingerprint,
// screenshots array = itemEl._screenshots, container = its ".screenshots" div, built in
// renderGroups()) or the page-wide general-notes field (fingerprint "general",
// screenshots array = module-level generalScreenshots, container = generalScreenshotsEl,
// built as generalTarget near the bottom of this file) -- either way, upload/render/
// paste-handling code below just needs {fingerprint, screenshots, container}.

// Uploads a pasted clipboard image to the server immediately (not held until Submit --
// see the module comment for why) and renders a small thumbnail so the tester gets
// visual confirmation the attach worked.
async function uploadScreenshot(target, blob) {
  try {
    const res = await fetch(apiUrl(`/api/screenshot?fingerprint=${encodeURIComponent(target.fingerprint)}`), {
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
  img.src = apiUrl(`/api/screenshots/${encodeURIComponent(filename)}`);
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
    const res = await fetch(apiUrl("/api/checklist"));
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
    const res = await fetch(apiUrl("/api/submit"), {
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

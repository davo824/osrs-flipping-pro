(async function () {
  const $ = (id) => document.getElementById(id);
  
  const manualToggle = document.getElementById("osrsManualToggle");
const manualPanel  = document.getElementById("osrsManualPanel");
const manualJsonEl = document.getElementById("osrsManualJson");


  const proposeBtn = $("osrsPropose");
  const genBtn     = $("osrsGenerate");
  const commitBtn  = $("osrsCommit");
  const diagBtn    = $("osrsDiagnostics");

  const statusEl   = $("osrsStatus");
  const previewEl  = $("osrsPreview");
  const changesEl  = $("osrsChanges");
  const heardEl    = $("osrsHeard");
  const planEl     = $("osrsPlan");

  let proposalId = null;
  let hasGenerated = false;
  
  
  function getManualTemplateJson() {
  return JSON.stringify({
    changes: {
      "index.html": { modified: false, summary: "", snippet: "", ops: [] },
      "style.css":  { modified: false, summary: "", snippet: "", ops: [] },
      "script.js":  { modified: false, summary: "", snippet: "", ops: [] }
    }
  }, null, 2);
}

manualToggle?.addEventListener("change", () => {
  const on = !!manualToggle.checked;
  manualPanel.style.display = on ? "block" : "none";

  // Pre-fill template once
  if (on && (!manualJsonEl.value || !manualJsonEl.value.trim())) {
    manualJsonEl.value = getManualTemplateJson();
  }
});


  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function esc(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function getRestRoot() {
    const root = window.wpApiSettings && window.wpApiSettings.root;
    if (typeof root === "string" && root.length) return root;
    return "/wp-json/";
  }

  function getNonce() {
    return (window.wpApiSettings && window.wpApiSettings.nonce) || "";
  }

  async function wpRest(path, body, method = "POST") {
    const root = getRestRoot();
    const url = `${root}osrs-agent/v1/${path}`;

    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-WP-Nonce": getNonce()
      },
      body: method === "GET" ? undefined : JSON.stringify(body || {})
    });

    const text = await res.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch (e) {
      if (!res.ok) throw new Error(text || `Request failed (${res.status})`);
      return { raw: text };
    }

    if (!res.ok) {
  const msg = (json && json.message) ? json.message : `Request failed (${res.status})`;
  const details = (json && json.data) ? ("\n\n" + JSON.stringify(json.data, null, 2)) : "";
  throw new Error(msg + details);
}


    return json;
  }

  function renderChanges(changes) {
    const files = Object.keys(changes || {});
    if (!files.length) {
      changesEl.innerHTML = `<div class="osrs-file"><em>No change data returned.</em></div>`;
      return;
    }

    changesEl.innerHTML = files.map((file) => {
      const c = changes[file] || {};
      const modified = !!c.modified;
      return `
        <div class="osrs-file">
          <h4>${esc(file)} ${modified ? "✅" : "—"}</h4>
          <div><strong>Summary:</strong> ${esc(c.summary || "")}</div>
          <div style="margin-top:8px;"><strong>Snippet:</strong></div>
          <div class="osrs-snippet">${esc(c.snippet || "")}</div>
        </div>
      `;
    }).join("");
  }

  function renderWillModify(willModify) {
    const obj = willModify || {};
    const files = ["index.html", "style.css", "script.js"];
    changesEl.innerHTML = files.map((f) => {
      const yes = !!obj[f];
      return `
        <div class="osrs-file">
          <h4>${esc(f)} ${yes ? "🟩 will change" : "⬜ no change"}</h4>
        </div>
      `;
    }).join("");
  }

  // Basic guard
  if (!proposeBtn || !genBtn || !commitBtn || !statusEl || !previewEl || !changesEl || !heardEl || !planEl) {
    return;
  }

  // Diagnostics (still useful)
  if (diagBtn) {
    diagBtn.addEventListener("click", async () => {
      try {
        setStatus("Running diagnostics...");
        const data = await wpRest("diagnostics", null, "GET");
        setStatus("Diagnostics:\n" + JSON.stringify(data, null, 2));
      } catch (e) {
        setStatus("Diagnostics error: " + e.message);
      }
    });
  }

  // Step 1: Plan only
  proposeBtn.addEventListener("click", async () => {
    proposalId = null;
    hasGenerated = false;

    genBtn.disabled = true;
    commitBtn.disabled = true;
    previewEl.style.display = "none";
    changesEl.innerHTML = "";

    const instruction = ($("osrsInstruction")?.value || "").trim();
    if (!instruction) {
      setStatus("Enter an instruction first.");
      return;
    }

    try {
      setStatus("Fetching repo files + generating plan...");
      const data = await wpRest("propose", { instruction });

      proposalId = data.proposal_id || null;
      heardEl.textContent = data.requirements_heard || "(none)";
      planEl.textContent  = data.plan || "(none)";

      renderWillModify(data.will_modify || {});

      previewEl.style.display = "block";

      if (!proposalId) {
        setStatus("Plan returned, but no proposal_id was provided (cannot proceed).");
        return;
      }

      genBtn.disabled = false;
      setStatus("Plan ready. Click Generate Files to prepare the exact code changes.");
    } catch (e) {
      setStatus("Error: " + (e && e.message ? e.message : String(e)));
      genBtn.disabled = true;
      commitBtn.disabled = true;
    }
  });

  // Step 2: Generate full file contents (still pre-commit)
genBtn.addEventListener("click", async () => {
  if (!proposalId) {
    setStatus("No plan to generate from. Click Propose Plan first.");
    return;
  }

  genBtn.disabled = true;
  commitBtn.disabled = true;

  try {
    const useManual = !!manualToggle?.checked;

    if (useManual) {
      setStatus("Applying manual ops JSON...");
      const raw = (manualJsonEl?.value || "").trim();
      if (!raw) throw new Error("Manual JSON is empty.");

      // Validate JSON client-side for nicer errors
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { throw new Error("Manual JSON is invalid: " + e.message); }

      const data = await wpRest("generate-manual", {
        proposal_id: proposalId,
        manual: parsed
      });

      renderChanges(data.changes || {});
      hasGenerated = true;
      commitBtn.disabled = false;
      setStatus("Manual generate applied. Review, then Confirm & Push.");
      return;
    }

    // Default: automatic generate (your existing path)
    setStatus("Generating file changes...");
    const data = await wpRest("generate", { proposal_id: proposalId });

    renderChanges(data.changes || {});
    hasGenerated = true;
    commitBtn.disabled = false;
    setStatus("Generated changes ready. Review, then Confirm & Push.");

  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)));
    genBtn.disabled = false;
    commitBtn.disabled = true;
  }
});


  // Step 3: Commit
  commitBtn.addEventListener("click", async () => {
    if (!proposalId) {
      setStatus("No proposal to commit.");
      return;
    }
    if (!hasGenerated) {
      setStatus("You must Generate Files before committing.");
      return;
    }

    commitBtn.disabled = true;

    try {
      setStatus("Committing to GitHub...");
      const data = await wpRest("commit", { proposal_id: proposalId });

      const commits = (data.commits || [])
        .map(c => `${c.file}: ${c.commit_sha || "(no sha returned)"}`)
        .join("\n");

      setStatus("✅ Pushed!\n" + (commits || "(No commits returned)"));

      proposalId = null;
      hasGenerated = false;
      genBtn.disabled = true;
      commitBtn.disabled = true;
    } catch (e) {
      setStatus("Error: " + (e && e.message ? e.message : String(e)));
      commitBtn.disabled = false;
    }
  });
})();
